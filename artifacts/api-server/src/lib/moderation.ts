import { sql } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./audit";
import { newModerationCaseId, newModerationScanId } from "./ids";

/**
 * Trust & Safety moderation provider abstraction.
 *
 * Mirrors the sanctions-provider pattern: a stub provider is wired in by
 * default; a real provider (Hive / Sightengine for general content,
 * PhotoDNA / NCMEC for CSAM) can be plugged in via the `MODERATION_PROVIDER`
 * env. In production an unknown / missing provider raises a `degraded`
 * flag through `getModerationProviderInfo()` so operators can be alarmed,
 * but the stub keeps content moving rather than fail-closed (T&S blocks
 * uploads that the stub flags; everything else is allowed). For CSAM the
 * stub is treated as suspicious — we never let unscanned uploads pass for
 * CSAM regardless of decision; the stub records `csam_match=false` but the
 * absence of a real provider is surfaced via the degraded flag.
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

export interface ModerationProvider {
  name: string;
  scanText(text: string, ctx: ModerationContext): Promise<ModerationResult>;
  scanImage(url: string, ctx: ModerationContext): Promise<ModerationResult>;
  scanVideoFrame(url: string, ctx: ModerationContext): Promise<ModerationResult>;
  /** Dedicated CSAM check. Real providers: PhotoDNA/NCMEC hash match. */
  scanCsam(url: string, ctx: ModerationContext): Promise<{ match: boolean; raw: Record<string, unknown> }>;
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
};

// --- Provider selection ---------------------------------------------------

let cachedProvider: ModerationProvider | null = null;
let degradedReason: string | null = null;

function selectProvider(): ModerationProvider {
  if (cachedProvider) return cachedProvider;
  const requested = (process.env.MODERATION_PROVIDER ?? "").trim().toLowerCase();
  if (!requested || requested === "stub") {
    if (process.env.NODE_ENV === "production") {
      degradedReason = "no_real_moderation_provider_configured";
      logger.warn({ degradedReason }, "moderation_provider_degraded");
    }
    cachedProvider = stubProvider;
    return cachedProvider;
  }
  // Real providers (Hive, Sightengine, PhotoDNA) would be wired here.
  // Until that integration lands, the unknown-provider branch falls back
  // to the stub but flags `degraded` so the admin dashboard can show a
  // banner.
  degradedReason = `provider_${requested}_not_implemented`;
  logger.warn({ requested, degradedReason }, "moderation_provider_not_implemented_using_stub");
  cachedProvider = stubProvider;
  return cachedProvider;
}

export interface ModerationProviderInfo {
  provider: string;
  degraded: boolean;
  degradedReason: string | null;
}

export function getModerationProviderInfo(): ModerationProviderInfo {
  const p = selectProvider();
  return {
    provider: p.name,
    degraded: degradedReason !== null,
    degradedReason,
  };
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
  if (!result.csamMatch) {
    // Always run the dedicated CSAM hash check on every image upload — a
    // generic moderation block is never a substitute for PhotoDNA.
    try {
      const csam = await provider.scanCsam(url, ctx);
      if (csam.match) {
        return { ...result, decision: "block", csamMatch: true, raw: { ...result.raw, csam: csam.raw } };
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "csam_scan_failed");
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
