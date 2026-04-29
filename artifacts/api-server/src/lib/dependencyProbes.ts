/**
 * Opt-in readiness probes for backing dependencies that are NOT
 * required to serve traffic at the request level but, when wedged,
 * will turn most user-facing requests into 5xx (Clerk auth, payment
 * gateways). The first cut of `/readyz` deliberately checked only DB
 * and Redis to avoid cascading drains when a flaky third party went
 * down — this module extends the same drain-on-unhealthy benefit to
 * those other dependencies behind explicit env-gated opt-ins so a
 * misbehaving probe can be turned off in seconds during an incident.
 *
 * Design notes:
 *
 *   - Each probe is gated on its own `READYZ_PROBE_<NAME>=1` env flag.
 *     Strict match on the literal "1" mirrors the strictness of
 *     `REPLIT_DEPLOYMENT=1` and `RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1`
 *     elsewhere in the boot sequence so casing drift like `"true"` or
 *     `" 1 "` cannot accidentally enable a probe an operator didn't
 *     intend to. When a probe is disabled it returns `null` from its
 *     ping function, which the route layer treats as `"skipped"` —
 *     the same shape `pingRateLimitRedis` uses for memory-store
 *     replicas.
 *
 *   - Each probe has its own short timeout (default 2s) overrideable
 *     via `READYZ_<NAME>_TIMEOUT_MS`. Sanitisation matches `health.ts`:
 *     a missing, non-numeric, zero, or negative value falls back to
 *     the default rather than producing a `NaN` timer that would fire
 *     immediately on every probe and turn every readyz call into a
 *     503.
 *
 *   - Each probe URL is overrideable via `READYZ_<NAME>_URL` so an
 *     operator can swap in a region-specific endpoint or a known-
 *     cheap healthz path without a code change. We deliberately do
 *     NOT auto-derive the URL from the gateway adapters: the adapter
 *     constants (`https://api.paystack.co`, `https://api.flutterwave.com/v3`)
 *     are sometimes versioned API paths and a `GET /v3` may not
 *     return what we expect for a connectivity probe. Defaulting to
 *     the base hostnames keeps the probe semantically "can this
 *     replica reach the gateway provider at all", independent of any
 *     specific endpoint contract.
 *
 *   - Probe success = the HTTP request completed (any status code).
 *     A 401 / 403 / 404 still proves the network round-trip works
 *     and the dependency is reachable; the route doesn't care
 *     whether the unauthenticated `GET /` returned 200, 401, or 404
 *     — the gateway is up if any of those came back. Probe failure
 *     = the fetch threw (DNS, TCP refused, TLS error) or the
 *     timeout fired.
 *
 *   - The probe runs `GET <url>` with `redirect: "manual"` and
 *     `cache: "no-store"`. Manual redirects matter because some
 *     providers permanently redirect their root to docs sites in
 *     other regions, and we don't want to follow those during a
 *     latency-sensitive readiness probe. `no-store` matters because
 *     we never want a CDN-cached response to mask a real outage.
 *
 *   - "Circuit-breaker semantics" (per task #91): if the probe fails
 *     repeatedly, an operator can flip its env flag to anything other
 *     than `"1"` (typically `"0"`) and the next readyz call will
 *     report `<name>: "skipped"` instead — the runbook documents this
 *     as the in-incident escape hatch. We do NOT add an in-process
 *     auto-trip breaker because that would either hide real outages
 *     (if the threshold is wrong) or never recover (if state isn't
 *     shared across replicas). The env flag IS the breaker.
 *
 * Pure helpers — `getDependencyProbeConfig` reads `process.env` at
 * call time so a hot env-var rotation is picked up by the next probe,
 * and the `pingHttpEndpoint` helper accepts a `fetch` impl so tests
 * can exercise success / timeout / network-error paths without real
 * network IO.
 */

export type DependencyProbeName = "clerk" | "paystack" | "flutterwave";

export interface DependencyProbeConfig {
  enabled: boolean;
  url: string;
  timeoutMs: number;
}

export interface DependencyProbeConfigBlock {
  clerk: DependencyProbeConfig;
  paystack: DependencyProbeConfig;
  flutterwave: DependencyProbeConfig;
}

const DEFAULT_TIMEOUT_MS = 2000;

const DEFAULTS: Record<
  DependencyProbeName,
  { url: string; flagEnv: string; urlEnv: string; timeoutEnv: string }
> = {
  clerk: {
    url: "https://api.clerk.com",
    flagEnv: "READYZ_PROBE_CLERK",
    urlEnv: "READYZ_CLERK_URL",
    timeoutEnv: "READYZ_CLERK_TIMEOUT_MS",
  },
  paystack: {
    url: "https://api.paystack.co",
    flagEnv: "READYZ_PROBE_PAYSTACK",
    urlEnv: "READYZ_PAYSTACK_URL",
    timeoutEnv: "READYZ_PAYSTACK_TIMEOUT_MS",
  },
  flutterwave: {
    url: "https://api.flutterwave.com",
    flagEnv: "READYZ_PROBE_FLUTTERWAVE",
    urlEnv: "READYZ_FLUTTERWAVE_URL",
    timeoutEnv: "READYZ_FLUTTERWAVE_TIMEOUT_MS",
  },
};

function parseTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackMs;
}

function resolveUrl(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === "" ? fallback : trimmed;
}

export function getDependencyProbeConfig(
  name: DependencyProbeName,
  env: NodeJS.ProcessEnv = process.env,
): DependencyProbeConfig {
  const d = DEFAULTS[name];
  return {
    // Strict match on "1" — same strictness as REPLIT_DEPLOYMENT=1 and
    // RATE_LIMIT_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 elsewhere in this
    // codebase. This is intentional so casing drift like "true" or
    // " 1 " can't accidentally enable a probe.
    enabled: env[d.flagEnv] === "1",
    url: resolveUrl(env[d.urlEnv], d.url),
    timeoutMs: parseTimeoutMs(env[d.timeoutEnv], DEFAULT_TIMEOUT_MS),
  };
}

export function getDependencyProbeConfigBlock(
  env: NodeJS.ProcessEnv = process.env,
): DependencyProbeConfigBlock {
  return {
    clerk: getDependencyProbeConfig("clerk", env),
    paystack: getDependencyProbeConfig("paystack", env),
    flutterwave: getDependencyProbeConfig("flutterwave", env),
  };
}

export type PingResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Fetch `url` with a hard timeout via `AbortSignal`. Returns ok when
 * the request completed with ANY HTTP status (the gateway is
 * reachable); returns failed when fetch threw or the timeout fired.
 *
 * `fetchImpl` is injected so tests can simulate success, network
 * error, and timeout without touching the real network. In production
 * the global `fetch` (Node 20+) is used.
 */
export async function pingHttpEndpoint(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // unref so a leaked timer never holds the process alive in tests.
  (timer as { unref?: () => void }).unref?.();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      // Don't follow cross-region redirects in a latency-sensitive
      // probe — see module doc for why.
      redirect: "manual",
      // Defeat any intermediate cache; a cached response would mask a
      // real outage.
      cache: "no-store",
      signal: controller.signal,
    });
    // Drain the body so the connection can be reused / closed
    // promptly. Failing to drain leaves keep-alive sockets dangling
    // on some Node versions and can leak FDs on a busy probe.
    try {
      // `res.body?.cancel?.()` would also work but `arrayBuffer()` is
      // more portable across the Node fetch API surface.
      await res.arrayBuffer();
    } catch {
      // Drain failures don't affect reachability — the response
      // headers already came back, which is all we need.
    }
    return { ok: true };
  } catch (err) {
    const e = err as Error & { name?: string };
    // AbortError → translate to the same `*_timeout_after_*ms` shape
    // `pingRateLimitRedis` uses so log aggregator queries stay
    // uniform across probes.
    if (e.name === "AbortError") {
      return { ok: false, error: `http_probe_timeout_after_${timeoutMs}ms` };
    }
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a single dependency. Returns:
 *
 *   - `null` when the probe is disabled (the route reports `"skipped"`).
 *   - `{ ok: true }` on a successful HTTP round-trip (any status code).
 *   - `{ ok: false, error }` on network error or timeout.
 *
 * Pure with respect to the env / fetch — both are injectable so the
 * route can call the convenience function and tests can drive the
 * helper directly.
 */
export async function pingDependency(
  name: DependencyProbeName,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PingResult | null> {
  const cfg = getDependencyProbeConfig(name, env);
  if (!cfg.enabled) return null;
  return pingHttpEndpoint(cfg.url, cfg.timeoutMs, fetchImpl);
}
