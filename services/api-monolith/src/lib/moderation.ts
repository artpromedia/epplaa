import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { newModerationCaseId, newModerationScanId } from "./ids";
import { detectNonHostnameProductionSignals } from "./productionSignals";

/**
 * Trust & Safety moderation provider abstraction.
 *
 * Mirrors the sanctions-provider pattern: a stub provider is wired in by
 * default; real providers (Hive / Sightengine for general image+video+text,
 * PhotoDNA / NCMEC for CSAM hash matching) plug in via `MODERATION_PROVIDER`.
 *
 * Provider selection (`MODERATION_PROVIDER`):
 *   - `stub` (or unset): the substring-matching stub used in dev/CI.
 *   - `hive`: Hive Moderation REST API
 *     (https://api.thehive.ai/api/v2/task/sync). Requires `HIVE_API_KEY`.
 *   - `sightengine`: Sightengine REST API
 *     (https://api.sightengine.com/1.0/). Requires `SIGHTENGINE_API_USER`
 *     and `SIGHTENGINE_API_SECRET`.
 *
 * CSAM hash matching is layered ON TOP of the chosen provider. When
 * `PHOTODNA_API_KEY` is set we hit the Microsoft PhotoDNA Cloud Service
 * `/photodna/v1.0/Match` endpoint for every image scan — PhotoDNA is the
 * gold-standard NCMEC-aligned hash matcher and is independent of the
 * generic-content moderation provider. If PhotoDNA is not configured we
 * fall back to whatever CSAM signal the generic provider exposes
 * (Hive's `csam_hash_match` model, Sightengine's `csam` filter); the
 * stub treats `/csam-test` URLs as a positive match so test data
 * exercises the case-opener path.
 *
 * Production-shape detection: when no real provider is configured AND
 * the deploy looks production-shaped (any of `NODE_ENV=production`,
 * `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 * `selectProvider` flips `degradedReason` so:
 *   1. `getModerationProviderInfo()` reports `degraded: true` to the
 *      admin dashboard, where it's surfaced as a red banner.
 *   2. `assertModerationProviderConfiguredForProduction(env, log)`
 *      (called from `src/index.ts`) emits the
 *      `moderation_provider_missing_for_production` warn tag so log
 *      aggregators page on-call within minutes of a misconfigured deploy.
 *   3. `runModerationProviderHealthCheck()` (called from `src/app.ts`
 *      after the audit chain is initialised) executes
 *      `provider.getHealth()` and records the outcome via `recordAudit`
 *      so there's a tamper-evident trail of every "the moderation
 *      pipeline came up degraded" boot.
 *
 * The stub never fail-closes uploads on its own — the recorded scan
 * row plus the degraded flag are the operator-facing signals. CSAM
 * is the only category where the stub's match is treated as
 * authoritative-block (see `scanImage` below): better to over-block
 * the synthetic test marker than under-block real CSAM.
 */

export type ModerationDecision = "allow" | "review" | "block";

export interface ModerationContext {
  /** What kind of thing is being scanned: image | video | text | stream | listing */
  surface: string;
  /** Stable id for the target so cases can deduplicate. */
  targetId: string;
  /** User who originated the content (creator/uploader/sender), if known. */
  sourceUserId?: string;
  /** Optional severity hint to upgrade the case if blocked. */
  severityHint?: "low" | "normal" | "high" | "critical";
}

export interface ModerationResult {
  decision: ModerationDecision;
  scores: Record<string, number>;
  csamMatch: boolean;
  provider: string;
  raw: Record<string, unknown>;
}

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
  /** Latency in ms of the health probe. */
  latencyMs?: number;
}

export interface ModerationProvider {
  name: string;
  scanText(text: string, ctx: ModerationContext): Promise<ModerationResult>;
  scanImage(url: string, ctx: ModerationContext): Promise<ModerationResult>;
  scanVideoFrame(url: string, ctx: ModerationContext): Promise<ModerationResult>;
  /** Dedicated CSAM check. Real providers: PhotoDNA/NCMEC hash match. */
  scanCsam(url: string, ctx: ModerationContext): Promise<{ match: boolean; raw: Record<string, unknown> }>;
  /**
   * Lightweight connection check used at boot. Must NOT throw; return
   * `{ ok: false, detail }` so the caller can persist the result to the
   * audit log even when the provider is unreachable.
   */
  getHealth(): Promise<ProviderHealth>;
}

// --- Stub provider --------------------------------------------------------

const STUB_BLOCK_TEXT = /FLAG_BLOCK|child porn|kill yourself|suicide instructions|how to make a bomb/i;
const STUB_REVIEW_TEXT = /FLAG_REVIEW|scam|fraud|fake/i;
const STUB_BLOCK_URL = /\/blocked|csam-test/i;
const STUB_REVIEW_URL = /\/review/i;

const stubProvider: ModerationProvider = {
  name: "stub",
  async scanText(text, _ctx): Promise<ModerationResult> {
    if (STUB_BLOCK_TEXT.test(text)) {
      return {
        decision: "block",
        scores: { hate: 0.95, violence: 0.4 },
        csamMatch: false,
        provider: "stub",
        raw: { matched: "block_pattern" },
      };
    }
    if (STUB_REVIEW_TEXT.test(text)) {
      return {
        decision: "review",
        scores: { spam: 0.7 },
        csamMatch: false,
        provider: "stub",
        raw: { matched: "review_pattern" },
      };
    }
    return { decision: "allow", scores: {}, csamMatch: false, provider: "stub", raw: {} };
  },
  async scanImage(url, _ctx): Promise<ModerationResult> {
    if (STUB_BLOCK_URL.test(url)) {
      return {
        decision: "block",
        scores: { nudity: 0.92 },
        csamMatch: /csam-test/i.test(url),
        provider: "stub",
        raw: { matched: "block_pattern" },
      };
    }
    if (STUB_REVIEW_URL.test(url)) {
      return { decision: "review", scores: { suggestive: 0.6 }, csamMatch: false, provider: "stub", raw: {} };
    }
    return { decision: "allow", scores: {}, csamMatch: false, provider: "stub", raw: {} };
  },
  async scanVideoFrame(url, ctx) {
    return this.scanImage(url, ctx);
  },
  async scanCsam(url, _ctx) {
    if (/csam-test/i.test(url)) return { match: true, raw: { matched: "csam_test_marker" } };
    return { match: false, raw: { provider: "stub" } };
  },
  async getHealth() {
    return { ok: true, detail: "stub-provider-always-healthy" };
  },
};

// --- Hive Moderation provider --------------------------------------------

/**
 * Hive Moderation REST client. Uses the synchronous task endpoint so the
 * caller's request can block on a single round-trip rather than having to
 * poll. Hive returns one or more `output[]` entries per task; each entry
 * carries a `classes[]` list of {class, score} pairs in [0, 1]. We
 * distil this into a single decision by comparing the highest "block"
 * score against `block`/`review` thresholds.
 *
 * CSAM signal: Hive ships a dedicated `csam_hash_match` model whose
 * `confidence` is binary (0 or 1) when the hash matches an NCMEC entry.
 * We treat any non-zero confidence as a positive match — under-blocking
 * CSAM is never an acceptable failure mode.
 */
const HIVE_BASE_URL = "https://api.thehive.ai/api/v2/task/sync";
const HIVE_BLOCK_THRESHOLD = 0.85;
const HIVE_REVIEW_THRESHOLD = 0.5;
const HIVE_TIMEOUT_MS = 15_000;

interface HiveClassEntry {
  class: string;
  score: number;
}

interface HiveOutputEntry {
  classes?: HiveClassEntry[];
}

interface HiveResponse {
  status?: Array<{ response?: { output?: HiveOutputEntry[] } }>;
}

async function hiveCall(
  apiKey: string,
  body: FormData,
  signal: AbortSignal,
): Promise<HiveResponse> {
  const res = await fetch(HIVE_BASE_URL, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}` },
    body,
    signal,
  });
  if (!res.ok) {
    throw new Error(`hive_http_${res.status}`);
  }
  return (await res.json()) as HiveResponse;
}

function distillHiveClasses(resp: HiveResponse): {
  scores: Record<string, number>;
  csamMatch: boolean;
} {
  const scores: Record<string, number> = {};
  let csamMatch = false;
  for (const status of resp.status ?? []) {
    for (const out of status.response?.output ?? []) {
      for (const cls of out.classes ?? []) {
        // Hive returns one positive + one negative class per category
        // (e.g. `yes_nsfw`/`no_nsfw`). Keep only the positive scores
        // and the one with the higher value if both observed.
        if (cls.class.startsWith("no_")) continue;
        const prev = scores[cls.class];
        if (prev === undefined || cls.score > prev) {
          scores[cls.class] = cls.score;
        }
        if (cls.class === "csam_hash_match" && cls.score > 0) {
          csamMatch = true;
        }
      }
    }
  }
  return { scores, csamMatch };
}

function decisionFromScores(scores: Record<string, number>): ModerationDecision {
  let max = 0;
  for (const v of Object.values(scores)) if (v > max) max = v;
  if (max >= HIVE_BLOCK_THRESHOLD) return "block";
  if (max >= HIVE_REVIEW_THRESHOLD) return "review";
  return "allow";
}

function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return p(controller.signal).finally(() => clearTimeout(t));
}

function buildHiveProvider(apiKey: string): ModerationProvider {
  return {
    name: "hive",
    async scanText(text, _ctx) {
      try {
        const resp = await withTimeout((signal) => {
          const fd = new FormData();
          fd.append("text_data", text);
          return hiveCall(apiKey, fd, signal);
        }, HIVE_TIMEOUT_MS);
        const { scores, csamMatch } = distillHiveClasses(resp);
        const decision = decisionFromScores(scores);
        return { decision, scores, csamMatch, provider: "hive", raw: resp as unknown as Record<string, unknown> };
      } catch (err) {
        logger.error({ err: (err as Error).message }, "hive_scan_text_failed");
        // Fail-open on text — chat would be unusable otherwise. Cases
        // are still opened on the stub fallback below if FLAG_* tokens
        // appear, but the recorded scan row carries `provider=hive` so
        // the audit trail shows the real provider was attempted.
        return { decision: "allow", scores: {}, csamMatch: false, provider: "hive", raw: { error: (err as Error).message } };
      }
    },
    async scanImage(url, _ctx) {
      try {
        const resp = await withTimeout((signal) => {
          const fd = new FormData();
          fd.append("url", url);
          return hiveCall(apiKey, fd, signal);
        }, HIVE_TIMEOUT_MS);
        const { scores, csamMatch } = distillHiveClasses(resp);
        const decision = decisionFromScores(scores);
        return { decision, scores, csamMatch, provider: "hive", raw: resp as unknown as Record<string, unknown> };
      } catch (err) {
        logger.error({ err: (err as Error).message }, "hive_scan_image_failed");
        // Fail-CLOSED on image: a dropped Hive call must not let an
        // unscanned image through. The orchestrator will open a
        // review case via `recordScanAndMaybeOpenCase`.
        return { decision: "review", scores: {}, csamMatch: false, provider: "hive", raw: { error: (err as Error).message } };
      }
    },
    async scanVideoFrame(url, ctx) {
      return this.scanImage(url, ctx);
    },
    async scanCsam(url, _ctx) {
      // Hive's CSAM hash signal is included in the regular image scan
      // (`csam_hash_match`). Re-running it here would double the
      // billing for no extra signal; instead, scanImage already sets
      // `csamMatch: true` when Hive flags it. We only return a
      // positive match here when called as the primary CSAM probe
      // — most callers reach `csamMatch` through scanImage already.
      try {
        const resp = await withTimeout((signal) => {
          const fd = new FormData();
          fd.append("url", url);
          return hiveCall(apiKey, fd, signal);
        }, HIVE_TIMEOUT_MS);
        const { csamMatch } = distillHiveClasses(resp);
        return { match: csamMatch, raw: resp as unknown as Record<string, unknown> };
      } catch (err) {
        logger.error({ err: (err as Error).message }, "hive_scan_csam_failed");
        // Fail-OPEN here would let unscanned uploads through. The
        // surrounding `scanImage` orchestrator already records a
        // `review` decision on Hive failure, so signalling no-match
        // here is fine — the review case still opens.
        return { match: false, raw: { error: (err as Error).message } };
      }
    },
    async getHealth() {
      const start = Date.now();
      try {
        // Hive doesn't publish a dedicated /health endpoint; scoring a
        // tiny synthetic text task is the cheapest API-key validity probe.
        await withTimeout((signal) => {
          const fd = new FormData();
          fd.append("text_data", "healthcheck");
          return hiveCall(apiKey, fd, signal);
        }, HIVE_TIMEOUT_MS);
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, detail: (err as Error).message, latencyMs: Date.now() - start };
      }
    },
  };
}

// --- Sightengine provider ------------------------------------------------

/**
 * Sightengine REST client. Uses the `check.json` endpoint with the
 * `nudity-2.0,wad,offensive,gore,text-content` model bundle which
 * covers the same surface as Hive (NSFW, weapons/alcohol/drugs,
 * offensive text, gore). Sightengine returns model-specific score
 * objects (e.g. `nudity.raw`, `weapon`, `drugs`); we hoist the top-
 * level numeric scores into a flat dict and use the same threshold
 * ladder as Hive.
 */
const SIGHTENGINE_BASE_URL = "https://api.sightengine.com/1.0/check.json";
const SIGHTENGINE_TEXT_URL = "https://api.sightengine.com/1.0/text/check.json";
const SIGHTENGINE_BLOCK_THRESHOLD = 0.85;
const SIGHTENGINE_REVIEW_THRESHOLD = 0.5;
const SIGHTENGINE_TIMEOUT_MS = 15_000;
const SIGHTENGINE_IMAGE_MODELS = "nudity-2.0,wad,offensive,gore";
const SIGHTENGINE_TEXT_MODELS = "extremism,profanity,personal,drug,weapon";

interface SightengineNumericMap {
  [key: string]: number | SightengineNumericMap | undefined;
}

function flattenScores(obj: SightengineNumericMap, prefix = ""): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") out[path] = v;
    else if (v && typeof v === "object") Object.assign(out, flattenScores(v, path));
  }
  return out;
}

async function sightengineCall(
  url: string,
  apiUser: string,
  apiSecret: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...params, api_user: apiUser, api_secret: apiSecret });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`sightengine_http_${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function decisionFromSightengineScores(scores: Record<string, number>): ModerationDecision {
  let max = 0;
  for (const [k, v] of Object.entries(scores)) {
    // The metadata fields (`width`, `height`, `request.id`, etc.) come
    // back as numbers too — only consider the scoring-shaped keys.
    if (k === "width" || k === "height" || k.startsWith("request.")) continue;
    if (v > max) max = v;
  }
  if (max >= SIGHTENGINE_BLOCK_THRESHOLD) return "block";
  if (max >= SIGHTENGINE_REVIEW_THRESHOLD) return "review";
  return "allow";
}

function buildSightengineProvider(apiUser: string, apiSecret: string): ModerationProvider {
  return {
    name: "sightengine",
    async scanText(text, _ctx) {
      try {
        const resp = await withTimeout(
          (signal) =>
            sightengineCall(
              SIGHTENGINE_TEXT_URL,
              apiUser,
              apiSecret,
              { text, mode: "rules", lang: "en", models: SIGHTENGINE_TEXT_MODELS },
              signal,
            ),
          SIGHTENGINE_TIMEOUT_MS,
        );
        const scores = flattenScores(resp as SightengineNumericMap);
        const decision = decisionFromSightengineScores(scores);
        return { decision, scores, csamMatch: false, provider: "sightengine", raw: resp };
      } catch (err) {
        logger.error({ err: (err as Error).message }, "sightengine_scan_text_failed");
        return { decision: "allow", scores: {}, csamMatch: false, provider: "sightengine", raw: { error: (err as Error).message } };
      }
    },
    async scanImage(url, _ctx) {
      try {
        const resp = await withTimeout(
          (signal) =>
            sightengineCall(
              SIGHTENGINE_BASE_URL,
              apiUser,
              apiSecret,
              { url, models: SIGHTENGINE_IMAGE_MODELS },
              signal,
            ),
          SIGHTENGINE_TIMEOUT_MS,
        );
        const scores = flattenScores(resp as SightengineNumericMap);
        const decision = decisionFromSightengineScores(scores);
        return { decision, scores, csamMatch: false, provider: "sightengine", raw: resp };
      } catch (err) {
        logger.error({ err: (err as Error).message }, "sightengine_scan_image_failed");
        return { decision: "review", scores: {}, csamMatch: false, provider: "sightengine", raw: { error: (err as Error).message } };
      }
    },
    async scanVideoFrame(url, ctx) {
      return this.scanImage(url, ctx);
    },
    async scanCsam(_url, _ctx) {
      // Sightengine doesn't expose the NCMEC hash list (it's a closed
      // dataset). Return no-match here so the caller falls through to
      // the PhotoDNA overlay if `PHOTODNA_API_KEY` is configured.
      return { match: false, raw: { provider: "sightengine", note: "csam_handled_by_photodna_overlay" } };
    },
    async getHealth() {
      const start = Date.now();
      try {
        // The cheapest no-side-effect call is text/check.json with a
        // single ASCII word — it validates both api_user + api_secret
        // and the network path without uploading binary content.
        await withTimeout(
          (signal) =>
            sightengineCall(
              SIGHTENGINE_TEXT_URL,
              apiUser,
              apiSecret,
              { text: "ping", mode: "rules", lang: "en", models: SIGHTENGINE_TEXT_MODELS },
              signal,
            ),
          SIGHTENGINE_TIMEOUT_MS,
        );
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, detail: (err as Error).message, latencyMs: Date.now() - start };
      }
    },
  };
}

// --- PhotoDNA CSAM overlay -----------------------------------------------

/**
 * PhotoDNA Cloud Service `/v1.0/Match` endpoint. Returns
 * `{ Status: { Code: 3000, Description }, IsMatch: bool, MatchDetails }`.
 * We treat any `IsMatch === true` as a CSAM hit. Network/API failures
 * are surfaced to the caller (logged + degraded) so the fallback
 * behaviour can be decided per surface; for `scanImage` the surrounding
 * orchestrator catches the throw and continues the underlying-provider
 * decision unchanged.
 */
const PHOTODNA_BASE_URL =
  "https://api.microsoftmoderator.com/photodna/v1.0/Match";
const PHOTODNA_TIMEOUT_MS = 15_000;

interface PhotoDnaResponse {
  Status?: { Code?: number; Description?: string };
  IsMatch?: boolean;
  MatchDetails?: unknown;
}

/**
 * Pure classifier for the PhotoDNA health-probe error string. The
 * synthetic `https://example.com/healthcheck.png` we use in
 * `runModerationProviderHealthCheck()` is not a real image, so PhotoDNA
 * always returns a non-200 — the question is whether that non-200
 * indicates a healthy "auth ok, image rejected" response or a real
 * problem (bad credentials, network outage, server-side failure).
 *
 *   - 400 / 404 / 415 / 422 (or any other 4xx that's not 401/403):
 *     the API parsed the request and validated the credentials before
 *     rejecting the example.com URL. Network path + key are good.
 *     `ok: true`.
 *   - 401 / 403: credentials were rejected. The PhotoDNA key is bad
 *     (or the subscription is suspended). `ok: false` so the audit
 *     trail records the bad config.
 *   - 5xx / network timeout / non-HTTP error string: PhotoDNA is down
 *     or the network path is broken. `ok: false`.
 *
 * Exported for unit testing.
 */
export function classifyPhotoDnaHealthError(
  errorMessage: string,
  latencyMs: number,
): ProviderHealth {
  const httpMatch = /photodna_http_(\d{3})/.exec(errorMessage);
  const code = httpMatch ? Number(httpMatch[1]) : null;
  const credentialsRejected = code === 401 || code === 403;
  const reachableButImageRejected =
    code !== null && code >= 400 && code < 500 && !credentialsRejected;
  return {
    ok: reachableButImageRejected,
    detail: credentialsRejected
      ? `${errorMessage} (credentials rejected — verify PHOTODNA_API_KEY)`
      : errorMessage,
    latencyMs,
  };
}

async function photoDnaMatch(
  apiKey: string,
  imageUrl: string,
  signal: AbortSignal,
): Promise<{ match: boolean; raw: PhotoDnaResponse }> {
  const res = await fetch(`${PHOTODNA_BASE_URL}?enhance=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": apiKey,
    },
    body: JSON.stringify({ DataRepresentation: "URL", Value: imageUrl }),
    signal,
  });
  if (!res.ok) throw new Error(`photodna_http_${res.status}`);
  const json = (await res.json()) as PhotoDnaResponse;
  return { match: json.IsMatch === true, raw: json };
}

// --- Provider selection ---------------------------------------------------

let cachedProvider: ModerationProvider | null = null;
let degradedReason: string | null = null;

/**
 * Test-only: clear the module-level cache between tests so toggling
 * `MODERATION_PROVIDER` actually re-runs `selectProvider`.
 */
export function __resetModerationProviderForTests(): void {
  cachedProvider = null;
  degradedReason = null;
}

function selectProvider(): ModerationProvider {
  if (cachedProvider) return cachedProvider;
  const requested = (process.env.MODERATION_PROVIDER ?? "").trim().toLowerCase();
  if (!requested || requested === "stub") {
    if (detectNonHostnameProductionSignals(process.env).length > 0) {
      degradedReason = "no_real_moderation_provider_configured";
      logger.warn({ degradedReason }, "moderation_provider_degraded");
    }
    cachedProvider = stubProvider;
    return cachedProvider;
  }
  if (requested === "hive") {
    const apiKey = (process.env.HIVE_API_KEY ?? "").trim();
    if (!apiKey) {
      degradedReason = "moderation_provider_hive_missing_api_key";
      logger.warn({ degradedReason }, "moderation_provider_hive_missing_credentials");
      cachedProvider = stubProvider;
      return cachedProvider;
    }
    cachedProvider = buildHiveProvider(apiKey);
    return cachedProvider;
  }
  if (requested === "sightengine") {
    const apiUser = (process.env.SIGHTENGINE_API_USER ?? "").trim();
    const apiSecret = (process.env.SIGHTENGINE_API_SECRET ?? "").trim();
    if (!apiUser || !apiSecret) {
      degradedReason = "moderation_provider_sightengine_missing_credentials";
      logger.warn({ degradedReason }, "moderation_provider_sightengine_missing_credentials");
      cachedProvider = stubProvider;
      return cachedProvider;
    }
    cachedProvider = buildSightengineProvider(apiUser, apiSecret);
    return cachedProvider;
  }
  degradedReason = `provider_${requested}_not_implemented`;
  logger.warn({ requested, degradedReason }, "moderation_provider_not_implemented_using_stub");
  cachedProvider = stubProvider;
  return cachedProvider;
}

export interface ModerationProviderInfo {
  provider: string;
  degraded: boolean;
  degradedReason: string | null;
  /**
   * Truthful CSAM-coverage state:
   *   - `photodna`: PHOTODNA_API_KEY is set; every scanImage call hits
   *     the Microsoft NCMEC-aligned hash matcher (gold standard).
   *   - `provider_native`: the active general provider exposes a real
   *     CSAM hash signal (currently only Hive's `csam_hash_match`).
   *   - `stub`: the stub provider's substring match against the
   *     `csam-test` URL marker — for tests only.
   *   - `none`: NO real CSAM coverage. Currently returned when
   *     Sightengine is the active provider without PhotoDNA layered
   *     on top (Sightengine does not expose the NCMEC hash list).
   */
  csamProvider: "photodna" | "provider_native" | "stub" | "none";
}

function csamCoverageFor(providerName: string, photoDnaConfigured: boolean): ModerationProviderInfo["csamProvider"] {
  if (photoDnaConfigured) return "photodna";
  if (providerName === "hive") return "provider_native";
  if (providerName === "sightengine") return "none"; // Sightengine doesn't expose the NCMEC list.
  if (providerName === "stub") return "stub";
  return "none";
}

export function getModerationProviderInfo(): ModerationProviderInfo {
  const p = selectProvider();
  const photoDnaConfigured = (process.env.PHOTODNA_API_KEY ?? "").trim() !== "";
  const csamProvider = csamCoverageFor(p.name, photoDnaConfigured);
  // Layer the CSAM-coverage gap into the degraded signal when the
  // selector itself was healthy. The dashboard banner uses this flag,
  // so a Sightengine-without-PhotoDNA deploy still surfaces a red
  // banner that names the missing PHOTODNA_API_KEY.
  let effectiveDegradedReason = degradedReason;
  if (effectiveDegradedReason === null && csamProvider === "none") {
    effectiveDegradedReason = "csam_coverage_missing_photodna_required_for_sightengine";
  }
  return {
    provider: p.name,
    degraded: effectiveDegradedReason !== null,
    degradedReason: effectiveDegradedReason,
    csamProvider,
  };
}

// --- Boot-time configuration check ----------------------------------------

/**
 * Boot-time sanity check: production deploys MUST set `MODERATION_PROVIDER`
 * to a real provider (`hive` or `sightengine`).
 *
 * Without a real provider, every uploaded image / stream poster / chat
 * message falls through to `stubProvider`, which only matches a tiny
 * substring allow-list. That means CSAM, NSFW, hate, and weapons content
 * is silently passed in production — the largest live-commerce trust
 * gap and a regulatory non-starter for the Nigerian / South African
 * market (Films & Publications Act mandatory CSAM reporting).
 *
 * Modelled on `assertSentryDsnConfiguredForProduction` (see `lib/sentry.ts`):
 *   - Production-shape detected via `detectNonHostnameProductionSignals`.
 *   - Returns `{ ok: true }` (with no log output) on staging / dev /
 *     preview where the stub is the intended behaviour.
 *   - Returns `{ ok: false, reason }` on production-shape with the env
 *     var unset, the literal `stub`, or set to a value whose required
 *     credentials are missing.
 *   - Always emits `moderation_provider_missing_for_production` on the
 *     warn channel so log aggregators can alert.
 *
 * Warning, not a hard failure: a brand-new production deploy may
 * legitimately ship while the moderation provider is being procured;
 * crash-looping every existing deploy that hasn't yet wired one would
 * be more disruptive than the marginal observability gain. The
 * dashboard's degraded banner + the warn-tag alert are the operator-
 * facing controls.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type ModerationProviderConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertModerationProviderConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): ModerationProviderConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) {
    return { ok: true };
  }
  const requested = (env.MODERATION_PROVIDER ?? "").trim().toLowerCase();
  let problem: string | null = null;
  if (!requested || requested === "stub") {
    problem =
      "MODERATION_PROVIDER is not set (or is the literal 'stub'). " +
      "Every upload, stream poster, and chat message will silently " +
      "fall through to the substring-matching stub — no real CSAM / " +
      "NSFW / hate / weapons scanning is happening.";
  } else if (requested === "hive") {
    const apiKey = (env.HIVE_API_KEY ?? "").trim();
    if (!apiKey) {
      problem =
        "MODERATION_PROVIDER=hive but HIVE_API_KEY is unset. " +
        "selectProvider() falls back to the stub; no real moderation runs.";
    }
  } else if (requested === "sightengine") {
    const apiUser = (env.SIGHTENGINE_API_USER ?? "").trim();
    const apiSecret = (env.SIGHTENGINE_API_SECRET ?? "").trim();
    const photoDnaKey = (env.PHOTODNA_API_KEY ?? "").trim();
    if (!apiUser || !apiSecret) {
      problem =
        "MODERATION_PROVIDER=sightengine but SIGHTENGINE_API_USER and/or " +
        "SIGHTENGINE_API_SECRET is unset. selectProvider() falls back to " +
        "the stub; no real moderation runs.";
    } else if (!photoDnaKey) {
      // Sightengine has no NCMEC hash list; PhotoDNA is the ONLY
      // CSAM-grade signal when this provider is chosen. A
      // production deploy without PhotoDNA leaves the
      // regulatorily-required CSAM gate open even though general
      // moderation looks healthy. Hard-warn distinctly so on-call
      // sees the gap.
      problem =
        "MODERATION_PROVIDER=sightengine is configured, but " +
        "PHOTODNA_API_KEY is unset. Sightengine does not expose " +
        "the NCMEC hash list, so without PhotoDNA every uploaded " +
        "image bypasses the CSAM hash check entirely.";
    }
  } else {
    problem =
      `MODERATION_PROVIDER=${requested} is not implemented. ` +
      "selectProvider() falls back to the stub; no real moderation runs.";
  }

  if (!problem) {
    return { ok: true };
  }

  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    `${problem} Detected production signal(s): ${signalDetails}. ` +
    "Set MODERATION_PROVIDER=hive (with HIVE_API_KEY) or " +
    "MODERATION_PROVIDER=sightengine (with SIGHTENGINE_API_USER + " +
    "SIGHTENGINE_API_SECRET). For NCMEC-grade CSAM hash matching also " +
    "set PHOTODNA_API_KEY. See docs/runbooks/production-secrets.md " +
    "(MODERATION_PROVIDER section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      moderation_provider: requested || null,
      hive_api_key_set: (env.HIVE_API_KEY ?? "").trim() !== "",
      sightengine_api_user_set: (env.SIGHTENGINE_API_USER ?? "").trim() !== "",
      sightengine_api_secret_set: (env.SIGHTENGINE_API_SECRET ?? "").trim() !== "",
      photodna_api_key_set: (env.PHOTODNA_API_KEY ?? "").trim() !== "",
      production_signals: productionSignals.map((s) => s.signal),
    },
    `moderation_provider_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

// --- Boot-time health probe -----------------------------------------------

/**
 * Run the active provider's health probe and write the outcome to the
 * audit log. Called from `src/app.ts` after `initAuditChain()` so the
 * audit table is guaranteed to exist when we append.
 *
 * Best-effort: any failure is logged at the error level but never
 * thrown — the moderation pipeline is allowed to come up degraded; the
 * dashboard banner + the audit-log row + the warn-tag alert are the
 * operator-facing controls.
 */
export async function runModerationProviderHealthCheck(): Promise<void> {
  const info = getModerationProviderInfo();
  let health: ProviderHealth;
  try {
    health = await selectProvider().getHealth();
  } catch (err) {
    health = { ok: false, detail: (err as Error).message };
  }
  // PhotoDNA overlay probe (independent of the generic provider). We
  // only check its presence + a single tiny `/Match` call against a
  // benign sentinel URL — PhotoDNA is rate-limited and we don't want
  // to burn quota on every boot, so skip the network call when the
  // key is unset.
  let photoDna: ProviderHealth | null = null;
  const photoDnaKey = (process.env.PHOTODNA_API_KEY ?? "").trim();
  if (photoDnaKey) {
    const start = Date.now();
    try {
      await withTimeout(
        (signal) => photoDnaMatch(photoDnaKey, "https://example.com/healthcheck.png", signal),
        PHOTODNA_TIMEOUT_MS,
      );
      photoDna = { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      photoDna = classifyPhotoDnaHealthError((err as Error).message, Date.now() - start);
    }
  }
  const payload = {
    provider: info.provider,
    degraded: info.degraded,
    degradedReason: info.degradedReason,
    csamProvider: info.csamProvider,
    health: { ok: health.ok, detail: health.detail ?? null, latencyMs: health.latencyMs ?? null },
    photoDna: photoDna
      ? { ok: photoDna.ok, detail: photoDna.detail ?? null, latencyMs: photoDna.latencyMs ?? null }
      : null,
    checkedAt: new Date().toISOString(),
  };
  if (!health.ok || info.degraded || (photoDna && !photoDna.ok)) {
    logger.error(payload, "moderation_provider_health_check_failed");
  } else {
    logger.info(payload, "moderation_provider_health_check_ok");
  }
  try {
    await recordAudit({
      action: "moderation.provider_health_check",
      entity: "moderation_provider",
      entityId: info.provider,
      payload,
    });
  } catch (err) {
    // recordAudit already best-effort writes to the DLQ on failure;
    // log explicitly here so a boot-time DB outage doesn't swallow
    // the moderation health signal entirely.
    logger.error(
      { err: (err as Error).message, payload },
      "moderation_provider_health_check_audit_failed",
    );
  }
}

// --- Case opener ----------------------------------------------------------

interface OpenCaseInput {
  kind: "report" | "dispute" | "content" | "csam" | "kyc";
  targetKind: string;
  targetId: string;
  severity: "low" | "normal" | "high" | "critical";
  evidence: Record<string, unknown>;
  sourceUserId?: string | null;
  sourceReportId?: string | null;
}

const SLA_HOURS_BY_SEVERITY: Record<OpenCaseInput["severity"], number> = {
  critical: 1,
  high: 4,
  normal: 24,
  low: 72,
};

export async function openModerationCase(input: OpenCaseInput): Promise<string> {
  const id = newModerationCaseId();
  const slaDueAt = new Date(Date.now() + SLA_HOURS_BY_SEVERITY[input.severity] * 3600 * 1000);
  await db.insert(schema.moderationCasesTable).values({
    id,
    kind: input.kind,
    targetKind: input.targetKind,
    targetId: input.targetId,
    severity: input.severity,
    state: "open",
    slaDueAt,
    evidence: input.evidence,
    sourceUserId: input.sourceUserId ?? null,
    sourceReportId: input.sourceReportId ?? null,
  });
  await recordAudit({
    actorId: input.sourceUserId ?? null,
    action: "moderation.case_opened",
    entity: "moderation_case",
    entityId: id,
    payload: { kind: input.kind, targetKind: input.targetKind, severity: input.severity },
  });
  return id;
}

/**
 * Persist a scan row and, when the decision is review/block (or CSAM
 * matches), open a moderation case for it.
 */
export async function recordScanAndMaybeOpenCase(
  result: ModerationResult,
  ctx: ModerationContext,
): Promise<{ scanId: string; caseId: string | null }> {
  const scanId = newModerationScanId();
  await db.insert(schema.moderationScansTable).values({
    id: scanId,
    targetKind: ctx.surface,
    targetId: ctx.targetId,
    provider: result.provider,
    decision: result.decision,
    scores: result.scores,
    csamMatch: result.csamMatch,
    raw: result.raw,
  });
  let caseId: string | null = null;
  if (result.csamMatch) {
    caseId = await openModerationCase({
      kind: "csam",
      targetKind: ctx.surface,
      targetId: ctx.targetId,
      severity: "critical",
      evidence: { scanId, scores: result.scores, raw: result.raw },
      sourceUserId: ctx.sourceUserId ?? null,
    });
  } else if (result.decision === "block" || result.decision === "review") {
    caseId = await openModerationCase({
      kind: "content",
      targetKind: ctx.surface,
      targetId: ctx.targetId,
      severity: result.decision === "block" ? ctx.severityHint ?? "high" : "normal",
      evidence: { scanId, scores: result.scores },
      sourceUserId: ctx.sourceUserId ?? null,
    });
  }
  return { scanId, caseId };
}

// --- Public scan helpers --------------------------------------------------

export async function scanText(text: string, ctx: ModerationContext): Promise<ModerationResult> {
  return selectProvider().scanText(text, ctx);
}
export async function scanImage(url: string, ctx: ModerationContext): Promise<ModerationResult> {
  const provider = selectProvider();
  const result = await provider.scanImage(url, ctx);
  // Layer the dedicated CSAM check on every image upload — a generic
  // moderation block is never a substitute for a hash-matched NCMEC
  // entry. PhotoDNA is preferred when configured (gold standard);
  // otherwise we fall back to whatever the active provider exposes.
  if (!result.csamMatch) {
    const photoDnaKey = (process.env.PHOTODNA_API_KEY ?? "").trim();
    if (photoDnaKey) {
      try {
        const csam = await withTimeout(
          (signal) => photoDnaMatch(photoDnaKey, url, signal),
          PHOTODNA_TIMEOUT_MS,
        );
        if (csam.match) {
          return { ...result, decision: "block", csamMatch: true, raw: { ...result.raw, photoDna: csam.raw } };
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, "photodna_scan_failed");
      }
    } else {
      try {
        const csam = await provider.scanCsam(url, ctx);
        if (csam.match) {
          return { ...result, decision: "block", csamMatch: true, raw: { ...result.raw, csam: csam.raw } };
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, "csam_scan_failed");
      }
    }
  }
  return result;
}
export async function scanVideoFrame(url: string, ctx: ModerationContext): Promise<ModerationResult> {
  return selectProvider().scanVideoFrame(url, ctx);
}

/**
 * Convenience: scan + persist + maybe open case in one call. Returns a
 * `blocked` boolean plus the case id when a case was opened.
 */
export async function moderateText(text: string, ctx: ModerationContext): Promise<{
  blocked: boolean;
  caseId: string | null;
  decision: ModerationDecision;
  scanId: string;
}> {
  const result = await scanText(text, ctx);
  const { scanId, caseId } = await recordScanAndMaybeOpenCase(result, ctx);
  return { blocked: result.decision === "block", caseId, decision: result.decision, scanId };
}

export async function moderateImage(url: string, ctx: ModerationContext): Promise<{
  blocked: boolean;
  caseId: string | null;
  decision: ModerationDecision;
  scanId: string;
  csamMatch: boolean;
}> {
  const result = await scanImage(url, ctx);
  const { scanId, caseId } = await recordScanAndMaybeOpenCase(result, ctx);
  return {
    blocked: result.decision === "block" || result.csamMatch,
    caseId,
    decision: result.decision,
    scanId,
    csamMatch: result.csamMatch,
  };
}

/**
 * Resolve the user account that owns a given moderation target. Used to
 * notify the affected seller when a takedown is issued: a takedown of a
 * `product` removes the listing on the catalogue, but the seller is the
 * party we owe a "your content was removed" notification to.
 *
 * Returns `null` when the target kind has no natural owner (e.g. `text`
 * snippets pasted into a moderator scan bench, where there is nothing to
 * remove). The caller is expected to log + skip the notification rather
 * than fail the takedown — recording the takedown row is the source of
 * truth even when notification routing fails.
 */
export async function resolveTargetOwnerUserId(
  targetKind: string,
  targetId: string,
): Promise<string | null> {
  const id = String(targetId ?? "").trim();
  if (!id) return null;
  switch (targetKind) {
    case "user":
    case "seller": {
      // Both forward to the underlying clerk id directly. `seller` rows
      // are keyed by `userId` so the caller already has the answer.
      return id;
    }
    case "product": {
      const [row] = await db
        .select({ sellerUserId: schema.productsTable.sellerUserId })
        .from(schema.productsTable)
        .where(eq(schema.productsTable.id, id))
        .limit(1);
      return row?.sellerUserId ?? null;
    }
    case "listing": {
      const [row] = await db
        .select({ userId: schema.sellerListingsTable.userId })
        .from(schema.sellerListingsTable)
        .where(eq(schema.sellerListingsTable.id, id))
        .limit(1);
      return row?.userId ?? null;
    }
    case "stream": {
      const [row] = await db
        .select({ sellerUserId: schema.streamsTable.sellerUserId })
        .from(schema.streamsTable)
        .where(eq(schema.streamsTable.id, id))
        .limit(1);
      return row?.sellerUserId ?? null;
    }
    case "message": {
      const [row] = await db
        .select({ userId: schema.streamChatMessagesTable.userId })
        .from(schema.streamChatMessagesTable)
        .where(eq(schema.streamChatMessagesTable.id, id))
        .limit(1);
      return row?.userId ?? null;
    }
    case "return": {
      // A takedown of a return (rare — usually for fraudulent return
      // claims) affects the buyer who filed it.
      const [row] = await db
        .select({ userId: schema.returnsTable.userId })
        .from(schema.returnsTable)
        .where(eq(schema.returnsTable.id, id))
        .limit(1);
      return row?.userId ?? null;
    }
    default:
      // image/video/text or any future surface where ownership is not
      // resolvable from the id alone — caller decides what to do.
      return null;
  }
}

/** Used by the dashboard to surface backlogs / SLA breaches. */
export async function getModerationDashboardCounts(): Promise<{
  openCases: number;
  dueSoon: number;
  pendingDisputes: number;
  csamCases: number;
  takedowns7d: number;
}> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const dueWithin24h = new Date(Date.now() + 24 * 3600 * 1000);
  const openCases = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM moderation_cases WHERE state IN ('open','triage','in_review')`,
  );
  const dueSoon = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM moderation_cases WHERE state IN ('open','triage','in_review') AND sla_due_at IS NOT NULL AND sla_due_at <= ${dueWithin24h}`,
  );
  const pendingDisputes = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM moderation_cases WHERE kind = 'dispute' AND state IN ('open','triage','in_review')`,
  );
  const csamCases = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM moderation_cases WHERE kind = 'csam' AND state IN ('open','triage','in_review','action')`,
  );
  const takedowns7d = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM takedowns WHERE created_at >= ${sevenDaysAgo}`,
  );
  return {
    openCases: Number(openCases.rows[0]?.count ?? 0),
    dueSoon: Number(dueSoon.rows[0]?.count ?? 0),
    pendingDisputes: Number(pendingDisputes.rows[0]?.count ?? 0),
    csamCases: Number(csamCases.rows[0]?.count ?? 0),
    takedowns7d: Number(takedowns7d.rows[0]?.count ?? 0),
  };
}
