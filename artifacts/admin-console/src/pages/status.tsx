import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  HardDrive,
  Layers,
  RefreshCw,
  Siren,
  Timer,
  XCircle,
} from "lucide-react";
import {
  adminReportReplicaDegraded,
  adminReportReplicaRecovered,
  getHealthCheckQueryOptions,
  useAdminGetDbHealth,
  useAdminGetGatewayHealth,
  useAdminGetQueueHealth,
  type DbHealthSnapshot,
  type GatewayHealthSnapshot,
  type QueueHealthSnapshot,
} from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 10_000;
const SAMPLES_PER_CYCLE = 5;
const REPLICA_STALE_AFTER_MS = 60_000;
// Mirrors the default in
// `artifacts/api-server/src/scripts/checkHealthzDegraded.ts` so the panel
// highlights any per-replica streak that the GitHub Actions stuck-degraded
// probe would already be paging on. Kept in lockstep — if the probe's
// default ever changes, update this constant too so on-call sees the same
// "probe would page now" boundary in the UI as in their pages.
const STUCK_DEGRADED_THRESHOLD_MS = 5 * 60 * 1000;
/**
 * The panel only pages on-call once a replica has been observed
 * unhealthy for more than one consecutive poll cycle. A single bad
 * sample is too easy to confuse with a transient blip (the LB happened
 * to land a probe on a replica that was draining, a TCP RST on an idle
 * connection, etc.) and would generate noise that erodes the signal.
 * Two consecutive cycles is the minimum that "the panel saw a problem"
 * actually means "the replica is degraded right now". See task #118
 * "Done looks like" for the canonical wording.
 */
const PAGE_AFTER_CONSECUTIVE_DEGRADED_POLLS = 2;

type CheckState = "ok" | "failed" | "skipped";

interface ReadyzBody {
  status: "ready" | "not_ready";
  replicaId?: string;
  checks?: Record<string, CheckState>;
  failures?: Record<string, string>;
  rateLimitStore?: "memory" | "redis";
  config?: { productionHostnamePattern?: "configured" | "missing" | "not_required" };
}

interface ReplicaSample {
  replicaId: string;
  httpStatus: number;
  body: ReadyzBody | null;
  parseError: string | null;
  observedAt: number;
}

interface SamplerError {
  message: string;
  observedAt: number;
}

// Subset of the /healthz `subsystems` map entry shape we render. Kept narrow
// because the api-server adds new subsystem-specific fields over time
// (auditDlq, auditChainVerify, ...) and we don't want a new field to break
// parsing here. The four required fields are the canonical
// SubsystemSnapshot contract from `lib/subsystemHealth.ts`.
interface HealthzSubsystem {
  state: "healthy" | "degraded" | string;
  failureCount?: number;
  firstFailureAt: number | null;
  lastRecoveredAt?: number | null;
}

interface HealthzBody {
  status?: string;
  replicaId?: string;
  subsystems?: Record<string, HealthzSubsystem>;
}

interface HealthzSample {
  replicaId: string;
  observedAt: number;
  subsystems: Record<string, HealthzSubsystem>;
}

interface DegradedStreak {
  name: string;
  firstFailureAt: number;
  failureCount: number;
  durationMs: number;
  // True once the streak has been open for longer than
  // STUCK_DEGRADED_THRESHOLD_MS — i.e. the
  // checkHealthzDegraded probe would already be paging on this. Used to
  // pull the streak forward visually so on-call sees the page-worthy
  // streak before the merely-recent ones.
  pageable: boolean;
}

async function probeOnce(): Promise<ReplicaSample> {
  const observedAt = Date.now();
  const res = await fetch("/api/readyz", {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
  });
  let body: ReadyzBody | null = null;
  let parseError: string | null = null;
  try {
    body = (await res.json()) as ReadyzBody;
  } catch (err) {
    parseError = (err as Error).message;
  }
  const replicaId =
    body?.replicaId && body.replicaId.trim() !== ""
      ? body.replicaId
      : `unknown-${observedAt}`;
  return { replicaId, httpStatus: res.status, body, parseError, observedAt };
}

/**
 * Sister probe to `probeOnce` that hits /healthz instead of /readyz so we
 * can merge the per-replica `subsystems` failure-streak data onto each
 * replica card. /readyz only carries point-in-time check results
 * (db: ok / failed); /healthz additionally reports `firstFailureAt`,
 * `failureCount`, and `lastRecoveredAt` per subsystem (db, rateLimitStore,
 * auditChain, ...). Surfacing the streak fields makes "stuck-degraded for
 * 7 minutes" visible without leaving the panel and lets on-call see when
 * the duration-based GitHub Actions probe would already be paging.
 *
 * Returns `null` (rather than throwing) on any malformed response so the
 * caller can silently skip the sample. The /readyz probe drives the
 * primary error banner; /healthz reachability problems would be redundant
 * noise here because the existing rate-limit-store panel already surfaces
 * them.
 */
async function probeHealthzOnce(): Promise<HealthzSample | null> {
  const observedAt = Date.now();
  let res: Response;
  try {
    res = await fetch("/api/healthz", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: HealthzBody;
  try {
    body = (await res.json()) as HealthzBody;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  if (typeof body.replicaId !== "string" || body.replicaId.trim() === "") {
    return null;
  }
  const subsystems: Record<string, HealthzSubsystem> = {};
  const map = body.subsystems;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [name, entry] of Object.entries(map)) {
      if (entry && typeof entry === "object") {
        subsystems[name] = entry as HealthzSubsystem;
      }
    }
  }
  return { replicaId: body.replicaId, observedAt, subsystems };
}

/**
 * Pull the in-progress degraded streaks out of a /healthz sample, sorted
 * worst-first so the operator's eye lands on the longest streak and any
 * pageable streaks appear before merely-recent ones. Skips entries that
 * are healthy or that are degraded but missing firstFailureAt — the
 * latter would trip the duration probe's "page on shape regression"
 * branch, but here we just decline to render a streak we can't time.
 */
function collectDegradedStreaks(
  sample: HealthzSample,
  now: number,
): DegradedStreak[] {
  const out: DegradedStreak[] = [];
  for (const [name, entry] of Object.entries(sample.subsystems)) {
    if (entry.state !== "degraded") continue;
    const first =
      typeof entry.firstFailureAt === "number" &&
      Number.isFinite(entry.firstFailureAt)
        ? entry.firstFailureAt
        : null;
    if (first === null) continue;
    const durationMs = Math.max(0, now - first);
    out.push({
      name,
      firstFailureAt: first,
      failureCount:
        typeof entry.failureCount === "number" && Number.isFinite(entry.failureCount)
          ? entry.failureCount
          : 0,
      durationMs,
      pageable: durationMs > STUCK_DEGRADED_THRESHOLD_MS,
    });
  }
  out.sort((a, b) => {
    if (a.pageable !== b.pageable) return a.pageable ? -1 : 1;
    return b.durationMs - a.durationMs;
  });
  return out;
}

/**
 * "7m 23s"-style compact duration for streak display. Matches the
 * granularity on-call cares about — a streak of seconds is harmless,
 * minutes is when the duration probe starts mattering, hours is an
 * incident.
 */
function formatDurationMs(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  if (safe < 60) return `${safe}s`;
  const m = Math.floor(safe / 60);
  const rs = safe % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function isReplicaUnhealthy(s: ReplicaSample): boolean {
  if (s.httpStatus !== 200) return true;
  if (!s.body) return true;
  if (s.body.status !== "ready") return true;
  const checks = s.body.checks ?? {};
  return Object.values(checks).some((v) => v === "failed");
}

function failingChecksOf(sample: ReplicaSample): string[] {
  const checks = sample.body?.checks ?? {};
  const failing: string[] = [];
  for (const [name, state] of Object.entries(checks)) {
    if (state === "failed") failing.push(name);
  }
  // When the panel saw a non-200 with no parseable body, the readyz
  // body's `checks` map is empty even though the replica is clearly
  // degraded. Surface a synthetic marker so the alert payload still
  // tells on-call WHY the panel decided this was a problem.
  if (failing.length === 0 && (sample.httpStatus !== 200 || !sample.body)) {
    failing.push(`http_status_${sample.httpStatus}`);
  }
  return failing;
}

interface ReplicaAlertState {
  consecutiveDegraded: number;
  /**
   * True only after this tab has SUCCESSFULLY POSTed a degraded
   * report for the current outage. A failed POST must NOT set this
   * to true, otherwise a single transient failure (network blip,
   * 5xx, CSRF refresh) would silently suppress paging for the
   * remainder of the outage on this tab.
   */
  alertOpen: boolean;
  /**
   * Guard against issuing a second POST while the first is still
   * in flight. The poll loop runs every 10s and the alert POST is
   * usually fast, but a slow API server during an actual outage
   * could easily stretch a request past one cycle. Without this
   * flag we'd duplicate-POST and rely on server dedup to absorb it.
   */
  postInFlight: boolean;
}

/**
 * Decide whether to fire / clear a degraded-replica page based on
 * THIS cycle's sample for one replica. Pure-ish: takes the bookkeeping
 * map by ref so callers can drive the same function from a unit test
 * with a fresh map per case.
 *
 * Decision matrix:
 *   - Sample healthy + no open alert  → clear streak counter, no-op.
 *   - Sample healthy + open alert     → POST recovery; only clear the
 *                                       flag on POST SUCCESS so a
 *                                       failed recovery POST is retried
 *                                       on the next healthy cycle.
 *   - Sample unhealthy + streak < N   → bump streak, no-op.
 *   - Sample unhealthy + streak >= N AND no open alert → POST degraded;
 *                                                       only set the
 *                                                       flag on POST
 *                                                       SUCCESS so a
 *                                                       failed POST is
 *                                                       retried next
 *                                                       cycle.
 *   - Sample unhealthy + streak >= N AND open alert → no-op (server
 *                                                     dedup is already
 *                                                     holding the
 *                                                     alert open).
 *
 * Network errors from the POST are logged to console but otherwise
 * leave the bookkeeping in a state where the next poll will retry.
 * The panel's UI keeps showing the live status regardless.
 */
function evaluateReplicaForPaging(
  replicaId: string,
  sample: ReplicaSample,
  stateRef: React.MutableRefObject<Map<string, ReplicaAlertState>>,
): void {
  const state =
    stateRef.current.get(replicaId) ?? {
      consecutiveDegraded: 0,
      alertOpen: false,
      postInFlight: false,
    };
  const unhealthy = isReplicaUnhealthy(sample);

  if (!unhealthy) {
    // Reset the streak immediately - the replica is healthy this
    // cycle. Do NOT clear `alertOpen` until a recovery POST succeeds,
    // otherwise a failed recovery POST permanently strands the
    // recovery signal and on-call never sees the all-clear.
    const nextState: ReplicaAlertState = {
      consecutiveDegraded: 0,
      alertOpen: state.alertOpen,
      postInFlight: state.postInFlight,
    };
    if (state.alertOpen && !state.postInFlight) {
      nextState.postInFlight = true;
      stateRef.current.set(replicaId, nextState);
      void adminReportReplicaRecovered({ replicaId })
        .then(() => {
          const cur = stateRef.current.get(replicaId);
          if (!cur) return;
          stateRef.current.set(replicaId, {
            ...cur,
            alertOpen: false,
            postInFlight: false,
          });
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            "[status] failed to POST replica recovery",
            (err as Error)?.message ?? err,
          );
          const cur = stateRef.current.get(replicaId);
          if (!cur) return;
          // Leave alertOpen=true so the next healthy cycle retries.
          stateRef.current.set(replicaId, { ...cur, postInFlight: false });
        });
      return;
    }
    stateRef.current.set(replicaId, nextState);
    return;
  }

  const nextStreak = state.consecutiveDegraded + 1;
  const baseNext: ReplicaAlertState = {
    consecutiveDegraded: nextStreak,
    alertOpen: state.alertOpen,
    postInFlight: state.postInFlight,
  };
  if (
    nextStreak >= PAGE_AFTER_CONSECUTIVE_DEGRADED_POLLS &&
    !state.alertOpen &&
    !state.postInFlight
  ) {
    const failingChecks = failingChecksOf(sample);
    const failures = sample.body?.failures ?? {};
    baseNext.postInFlight = true;
    stateRef.current.set(replicaId, baseNext);
    void adminReportReplicaDegraded({
      replicaId,
      httpStatus: sample.httpStatus,
      failingChecks,
      failures,
      consecutivePolls: nextStreak,
    })
      .then(() => {
        const cur = stateRef.current.get(replicaId);
        if (!cur) return;
        stateRef.current.set(replicaId, {
          ...cur,
          alertOpen: true,
          postInFlight: false,
        });
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(
          "[status] failed to POST replica degraded",
          (err as Error)?.message ?? err,
        );
        const cur = stateRef.current.get(replicaId);
        if (!cur) return;
        // Leave alertOpen=false so the next degraded cycle retries.
        stateRef.current.set(replicaId, { ...cur, postInFlight: false });
      });
    return;
  }
  stateRef.current.set(replicaId, baseNext);
}

function formatRelativeMs(now: number, then: number): string {
  const ms = Math.max(0, now - then);
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

function checkBadgeVariant(state: CheckState): "default" | "destructive" | "outline" | "secondary" {
  if (state === "ok") return "secondary";
  if (state === "failed") return "destructive";
  return "outline";
}

function formatTimestamp(value: number | string | null): string {
  if (value === null) return "—";
  const ms = typeof value === "string" ? Date.parse(value) : value;
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatRelativeFlexible(value: number | string | null, now: number): string {
  if (value === null) return "—";
  const ms = typeof value === "string" ? Date.parse(value) : value;
  if (Number.isNaN(ms)) return "—";
  const deltaSec = Math.round((now - ms) / 1000);
  const absSec = Math.abs(deltaSec);
  const future = deltaSec < 0;
  const fmt = (n: number, unit: string) =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;
  if (absSec < 60) return fmt(absSec, "s");
  const minutes = Math.round(absSec / 60);
  if (minutes < 60) return fmt(minutes, "m");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return fmt(hours, "h");
  const days = Math.round(hours / 24);
  return fmt(days, "d");
}

export default function StatusPage() {
  const [replicas, setReplicas] = useState<Record<string, ReplicaSample>>({});
  const [healthzReplicas, setHealthzReplicas] = useState<
    Record<string, HealthzSample>
  >({});
  const [lastError, setLastError] = useState<SamplerError | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  // Re-render the "Xs ago" labels on a tick independent of the poll loop
  // so timestamps don't appear frozen between polls.
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);
  /**
   * Per-replica consecutive-poll counters used to gate when this tab
   * pages on-call. Stored in a ref (not state) because:
   *   - It's strictly an internal bookkeeping signal — no UI reads it,
   *     so flipping it must not trigger a re-render of every replica
   *     card on every poll.
   *   - The decision to fire / clear an alert is made at the end of
   *     each poll cycle synchronously against the latest cycle's
   *     samples, not against React state (which lags one render).
   *
   * `consecutiveDegraded` is the count of consecutive cycles this
   * replica was unhealthy. `alertOpen` tracks whether THIS browser tab
   * has already POSTed a degraded report for the current outage —
   * server-side dedup (lib/replicaDegradedAlerts) collapses across all
   * tabs/operators, but we still avoid spamming the endpoint on every
   * poll once we know an alert is open.
   */
  const replicaAlertStateRef = useRef<Map<string, ReplicaAlertState>>(
    new Map(),
  );

  const pollNow = useCallback(async () => {
    setIsPolling(true);
    try {
      // Run readyz + healthz probe batches in parallel. They hit different
      // endpoints with the same fan-out strategy so the LB spreads samples
      // across replicas; merging by replicaId on each side gives us a
      // per-replica view of both the readyz check matrix and the healthz
      // failure-streak fields.
      const [readyzSettled, healthzSettled] = await Promise.all([
        Promise.allSettled(
          Array.from({ length: SAMPLES_PER_CYCLE }, () => probeOnce()),
        ),
        Promise.allSettled(
          Array.from({ length: SAMPLES_PER_CYCLE }, () => probeHealthzOnce()),
        ),
      ]);
      if (!mountedRef.current) return;
      const fulfilled: ReplicaSample[] = [];
      const errors: string[] = [];
      for (const s of readyzSettled) {
        if (s.status === "fulfilled") fulfilled.push(s.value);
        else errors.push((s.reason as Error)?.message ?? String(s.reason));
      }
      const healthzFulfilled: HealthzSample[] = [];
      for (const s of healthzSettled) {
        if (s.status === "fulfilled" && s.value !== null) {
          healthzFulfilled.push(s.value);
        }
      }
      if (fulfilled.length > 0) {
        setReplicas((prev) => {
          const next = { ...prev };
          for (const sample of fulfilled) {
            const existing = next[sample.replicaId];
            if (!existing || existing.observedAt <= sample.observedAt) {
              next[sample.replicaId] = sample;
            }
          }
          // Drop replicas we haven't heard from in a while so a
          // crashed/scaled-down container doesn't haunt the list
          // forever and produce a stale "degraded" row.
          const cutoff = Date.now() - REPLICA_STALE_AFTER_MS;
          for (const [id, value] of Object.entries(next)) {
            if (value.observedAt < cutoff) delete next[id];
          }
          return next;
        });
        // Pick the latest sample per replicaId from THIS cycle so the
        // alert decision uses what we just observed (not stale state)
        // and a flap that we did and then didn't see in the same cycle
        // counts as "currently bad" if the latest sample is bad.
        const latestThisCycle = new Map<string, ReplicaSample>();
        for (const sample of fulfilled) {
          const existing = latestThisCycle.get(sample.replicaId);
          if (!existing || existing.observedAt <= sample.observedAt) {
            latestThisCycle.set(sample.replicaId, sample);
          }
        }
        for (const [replicaId, sample] of latestThisCycle) {
          evaluateReplicaForPaging(replicaId, sample, replicaAlertStateRef);
        }
        // Replicas we did NOT see this cycle are NOT cleared — a
        // single missed poll shouldn't close an open alert (the LB
        // round-robin can starve a replica for a cycle or two even
        // when it's healthy). The panel-side `REPLICA_STALE_AFTER_MS`
        // cleanup AND the server-side staleness sweep
        // (REPLICA_DEGRADED_ALERT_STALE_AFTER_MS) bound the table.
      }
      // Always run the staleness sweep, even when every healthz probe in
      // this cycle failed. Otherwise a healthz outage that lasts longer
      // than REPLICA_STALE_AFTER_MS would leave the previous degraded
      // streak rendered indefinitely and overstate current degradation.
      setHealthzReplicas((prev) => {
        const next = { ...prev };
        for (const sample of healthzFulfilled) {
          const existing = next[sample.replicaId];
          if (!existing || existing.observedAt <= sample.observedAt) {
            next[sample.replicaId] = sample;
          }
        }
        // Same staleness rule as readyz: a replica we haven't heard
        // from in a minute is likely gone, and showing its last-known
        // streak forever would be misleading.
        const cutoff = Date.now() - REPLICA_STALE_AFTER_MS;
        let mutated = healthzFulfilled.length > 0;
        for (const [id, value] of Object.entries(next)) {
          if (value.observedAt < cutoff) {
            delete next[id];
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
      if (errors.length > 0 && fulfilled.length === 0) {
        setLastError({ message: errors[0] ?? "Probe failed", observedAt: Date.now() });
      } else if (fulfilled.length > 0) {
        setLastError(null);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setLastError({ message: (err as Error).message, observedAt: Date.now() });
    } finally {
      if (mountedRef.current) {
        setIsPolling(false);
        setLastPolledAt(Date.now());
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void pollNow();
    const interval = window.setInterval(() => {
      void pollNow();
    }, POLL_INTERVAL_MS);
    const tick = window.setInterval(
      () => mountedRef.current && setTick((t) => t + 1),
      1000,
    );
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.clearInterval(tick);
    };
  }, [pollNow]);

  const sortedReplicas = useMemo(() => {
    return Object.values(replicas).sort((a, b) => {
      const aBad = isReplicaUnhealthy(a) ? 0 : 1;
      const bBad = isReplicaUnhealthy(b) ? 0 : 1;
      if (aBad !== bBad) return aBad - bBad;
      return a.replicaId.localeCompare(b.replicaId);
    });
  }, [replicas]);

  const degradedCount = sortedReplicas.filter(isReplicaUnhealthy).length;
  const healthyCount = sortedReplicas.length - degradedCount;
  const now = Date.now();

  // How many replicas have at least one subsystem stuck-degraded longer
  // than the duration probe's threshold. Surfaced as a top-level tile +
  // banner so on-call sees "the GitHub Actions probe would page right
  // now" without scanning every card.
  const stuckDegradedReplicaCount = useMemo(() => {
    let count = 0;
    for (const sample of Object.values(healthzReplicas)) {
      const streaks = collectDegradedStreaks(sample, now);
      if (streaks.some((s) => s.pageable)) count += 1;
    }
    return count;
  }, [healthzReplicas, now]);

  return (
    <div data-testid="page-status">
      <PageHeader
        title="System status"
        description="Backing dependencies the api-server relies on, plus a live view of the replicas behind the load balancer. Each panel shows the dependency, current state, and the latest timestamps."
        actions={
          <button
            type="button"
            onClick={() => void pollNow()}
            disabled={isPolling}
            data-testid="button-refresh-status"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover-elevate disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isPolling && "animate-spin")} />
            Refresh now
          </button>
        }
      />

      <section
        aria-labelledby="status-dependencies-heading"
        className="mb-8"
        data-testid="section-dependencies"
      >
        <h2
          id="status-dependencies-heading"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3"
        >
          Backing dependencies
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <RateLimitStorePanel />
          <PaymentGatewayHealthPanel />
          <DatabaseHealthPanel />
          <BackgroundQueuePanel />
        </div>
      </section>

      <section
        aria-labelledby="status-replicas-heading"
        data-testid="section-replicas"
      >
        <h2
          id="status-replicas-heading"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3"
        >
          Replica health
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Polls <code>/api/readyz</code> and <code>/api/healthz</code> every{" "}
          {POLL_INTERVAL_MS / 1000}s and groups responses by replica. Multiple
          parallel probes per cycle increase the odds of sampling every replica
          behind the load balancer. Each card shows the readyz check matrix
          plus, when degraded, the healthz failure-streak duration so on-call
          can see at a glance which subsystem owns a "stuck-degraded for N
          minutes" page.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <SummaryTile
            label="Replicas observed"
            value={sortedReplicas.length}
            icon={Activity}
            testId="tile-replicas"
          />
          <SummaryTile
            label="Healthy"
            value={healthyCount}
            icon={CheckCircle2}
            tone={sortedReplicas.length > 0 && healthyCount === sortedReplicas.length ? "good" : "neutral"}
            testId="tile-healthy"
          />
          <SummaryTile
            label="Degraded"
            value={degradedCount}
            icon={AlertTriangle}
            tone={degradedCount > 0 ? "bad" : "neutral"}
            testId="tile-degraded"
          />
          <SummaryTile
            label="Stuck-degraded"
            value={stuckDegradedReplicaCount}
            icon={Siren}
            tone={stuckDegradedReplicaCount > 0 ? "bad" : "neutral"}
            testId="tile-stuck-degraded"
          />
        </div>

        {stuckDegradedReplicaCount > 0 && (
          <div
            className="mb-4 rounded-md border border-destructive/60 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2"
            data-testid="stuck-degraded-banner"
          >
            <Siren className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                {stuckDegradedReplicaCount === 1
                  ? "1 replica has a subsystem stuck-degraded past the probe threshold."
                  : `${stuckDegradedReplicaCount} replicas have a subsystem stuck-degraded past the probe threshold.`}
              </p>
              <p className="text-xs mt-0.5">
                The GitHub Actions <code>checkHealthzDegraded</code> probe pages
                on-call once a streak exceeds{" "}
                {STUCK_DEGRADED_THRESHOLD_MS / 60_000}m. See each card below
                for the offending subsystem.
              </p>
            </div>
          </div>
        )}

        {lastError && sortedReplicas.length === 0 && (
          <div
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            data-testid="status-network-error"
          >
            Could not reach <code>/api/readyz</code>: {lastError.message}
          </div>
        )}

        <div className="space-y-3">
          {sortedReplicas.length === 0 && !lastError && (
            <Card data-testid="status-empty">
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Waiting for the first probe response…
              </CardContent>
            </Card>
          )}
          {sortedReplicas.map((replica) => (
            <ReplicaCard
              key={replica.replicaId}
              replica={replica}
              healthz={healthzReplicas[replica.replicaId]}
              now={now}
            />
          ))}
        </div>

        <p className="mt-6 text-xs text-muted-foreground" data-testid="status-poll-meta">
          Last polled {lastPolledAt ? formatRelativeMs(now, lastPolledAt) : "never"} ·{" "}
          {SAMPLES_PER_CYCLE} parallel probes per cycle · stale replicas drop after{" "}
          {REPLICA_STALE_AFTER_MS / 1000}s of silence
        </p>
      </section>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  icon: Icon,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: number;
  icon: typeof Activity;
  tone?: "good" | "bad" | "neutral";
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </CardTitle>
        <Icon
          className={cn(
            "w-4 h-4",
            tone === "good" && "text-emerald-600 dark:text-emerald-400",
            tone === "bad" && "text-destructive",
            tone === "neutral" && "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent>
        <p
          className={cn(
            "text-2xl font-semibold tabular-nums",
            tone === "bad" && value > 0 && "text-destructive",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function RateLimitStorePanel() {
  const { data, isLoading, error } = useQuery({
    ...getHealthCheckQueryOptions(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const status = data?.rateLimitStore;
  const degraded = status?.state === "degraded";
  const now = Date.now();

  return (
    <Card
      className={cn(degraded && "border-destructive/60 bg-destructive/5")}
      data-testid="rate-limit-store-panel"
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Rate limit store</CardTitle>
        <Database
          className={cn(
            "w-4 h-4",
            degraded ? "text-destructive" : "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <p
            className="text-xs text-destructive"
            data-testid="rate-limit-store-error"
          >
            Could not reach /api/healthz. The api-server may be down or
            the preview proxy is misrouting requests.
          </p>
        ) : isLoading || !status ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" data-testid="rate-limit-store-kind">
                {status.kind}
              </Badge>
              {degraded ? (
                <Badge
                  variant="destructive"
                  data-testid="rate-limit-store-state"
                >
                  degraded
                </Badge>
              ) : (
                <Badge
                  variant="secondary"
                  data-testid="rate-limit-store-state"
                >
                  healthy
                </Badge>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Failure count</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  degraded && "font-medium text-destructive",
                )}
                data-testid="rate-limit-store-failure-count"
              >
                {status.failureCount}
              </dd>
              <dt className="text-muted-foreground">Streak started</dt>
              <dd
                className="tabular-nums"
                data-testid="rate-limit-store-first-failure"
                title={
                  status.firstFailureAt === null
                    ? undefined
                    : formatTimestamp(status.firstFailureAt)
                }
              >
                {status.firstFailureAt === null
                  ? "—"
                  : `${formatRelativeFlexible(status.firstFailureAt, now)} (${formatTimestamp(status.firstFailureAt)})`}
              </dd>
              <dt className="text-muted-foreground">Last recovered</dt>
              <dd
                className="tabular-nums"
                data-testid="rate-limit-store-last-recovered"
                title={
                  status.lastRecoveredAt === null
                    ? undefined
                    : formatTimestamp(status.lastRecoveredAt)
                }
              >
                {status.lastRecoveredAt === null
                  ? "—"
                  : `${formatRelativeFlexible(status.lastRecoveredAt, now)} (${formatTimestamp(status.lastRecoveredAt)})`}
              </dd>
            </dl>
            {status.kind === "memory" && (
              <p className="text-[11px] text-muted-foreground">
                Memory store: streak metrics are always zero. Set{" "}
                <code>RATE_LIMIT_STORE=redis</code> before scaling the
                api-server beyond one replica.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function isGatewayDegraded(gateway: GatewayHealthSnapshot, now: number): boolean {
  if (gateway.circuitOpenUntilIso) {
    const ts = Date.parse(gateway.circuitOpenUntilIso);
    if (!Number.isNaN(ts) && ts > now) return true;
  }
  return false;
}

function PaymentGatewayHealthPanel() {
  const { data, isLoading, error } = useAdminGetGatewayHealth({
    query: {
      refetchInterval: 15_000,
      refetchIntervalInBackground: true,
      staleTime: 0,
    } as never,
  });

  const now = Date.now();
  const gateways = data ?? [];
  const anyDegraded = gateways.some((g) => isGatewayDegraded(g, now));

  return (
    <Card
      className={cn(anyDegraded && "border-destructive/60 bg-destructive/5")}
      data-testid="payment-gateway-health-panel"
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Payment gateways</CardTitle>
        <CreditCard
          className={cn(
            "w-4 h-4",
            anyDegraded ? "text-destructive" : "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p
            className="text-xs text-destructive"
            data-testid="payment-gateway-health-error"
          >
            Could not load /api/admin/payment-gateway-health. You may not have
            permission, or the api-server may be down.
          </p>
        ) : isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : gateways.length === 0 ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="payment-gateway-health-empty"
          >
            No gateway activity recorded yet.
          </p>
        ) : (
          gateways.map((g) => {
            const degraded = isGatewayDegraded(g, now);
            return (
              <div
                key={g.gateway}
                className="space-y-1.5 border-t border-border first:border-t-0 first:pt-0 pt-3"
                data-testid={`payment-gateway-row-${g.gateway}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    data-testid={`payment-gateway-${g.gateway}-name`}
                  >
                    {g.gateway}
                  </Badge>
                  {degraded ? (
                    <Badge
                      variant="destructive"
                      data-testid={`payment-gateway-${g.gateway}-state`}
                    >
                      degraded
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      data-testid={`payment-gateway-${g.gateway}-state`}
                    >
                      healthy
                    </Badge>
                  )}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Successes</dt>
                  <dd className="tabular-nums">{g.successCount}</dd>
                  <dt className="text-muted-foreground">Failures</dt>
                  <dd
                    className={cn(
                      "tabular-nums",
                      g.failureCount > 0 && "font-medium",
                      degraded && "text-destructive",
                    )}
                  >
                    {g.failureCount}
                  </dd>
                  <dt className="text-muted-foreground">Window started</dt>
                  <dd
                    className="tabular-nums"
                    data-testid={`payment-gateway-${g.gateway}-window-started`}
                    title={
                      g.windowStartedAtIso
                        ? formatTimestamp(g.windowStartedAtIso)
                        : undefined
                    }
                  >
                    {g.windowStartedAtIso
                      ? `${formatRelativeFlexible(g.windowStartedAtIso, now)} (${formatTimestamp(g.windowStartedAtIso)})`
                      : "—"}
                  </dd>
                  <dt className="text-muted-foreground">Last event</dt>
                  <dd
                    className="tabular-nums"
                    data-testid={`payment-gateway-${g.gateway}-last-event`}
                    title={
                      g.lastEventAtIso
                        ? formatTimestamp(g.lastEventAtIso)
                        : undefined
                    }
                  >
                    {g.lastEventAtIso
                      ? `${formatRelativeFlexible(g.lastEventAtIso, now)} (${formatTimestamp(g.lastEventAtIso)})`
                      : "—"}
                  </dd>
                  {g.circuitOpenUntilIso && (
                    <>
                      <dt className="text-muted-foreground">Circuit reopens</dt>
                      <dd
                        className={cn(
                          "tabular-nums",
                          degraded && "font-medium text-destructive",
                        )}
                        data-testid={`payment-gateway-${g.gateway}-circuit-until`}
                        title={formatTimestamp(g.circuitOpenUntilIso)}
                      >
                        {`${formatRelativeFlexible(g.circuitOpenUntilIso, now)} (${formatTimestamp(g.circuitOpenUntilIso)})`}
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function ReplicaCard({
  replica,
  healthz,
  now,
}: {
  replica: ReplicaSample;
  healthz: HealthzSample | undefined;
  now: number;
}) {
  const unhealthy = isReplicaUnhealthy(replica);
  const checks = replica.body?.checks ?? {};
  const failures = replica.body?.failures ?? {};
  const rateLimitStore = replica.body?.rateLimitStore;
  const productionHostnamePattern = replica.body?.config?.productionHostnamePattern;
  const streaks = healthz ? collectDegradedStreaks(healthz, now) : [];
  const hasPageableStreak = streaks.some((s) => s.pageable);
  return (
    <Card
      data-testid={`replica-${replica.replicaId}`}
      className={cn(
        unhealthy && "border-destructive/60",
        // Even when readyz still passes, a streak past the duration
        // probe's threshold is on-call-paging-worthy and the card
        // should look that way.
        hasPageableStreak && "border-destructive/60",
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="text-sm font-mono break-all" data-testid={`replica-id-${replica.replicaId}`}>
              {replica.replicaId}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              HTTP {replica.httpStatus} · last seen {formatRelativeMs(now, replica.observedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {unhealthy ? (
              <Badge variant="destructive" data-testid={`replica-status-${replica.replicaId}`}>
                <XCircle className="w-3 h-3 mr-1" /> Degraded
              </Badge>
            ) : (
              <Badge variant="secondary" data-testid={`replica-status-${replica.replicaId}`}>
                <CheckCircle2 className="w-3 h-3 mr-1" /> Ready
              </Badge>
            )}
            {hasPageableStreak && (
              <Badge
                variant="destructive"
                data-testid={`replica-stuck-degraded-${replica.replicaId}`}
                title={`At least one subsystem has been degraded for more than ${STUCK_DEGRADED_THRESHOLD_MS / 60_000}m — the duration probe would page on-call.`}
              >
                <Siren className="w-3 h-3 mr-1" /> Stuck-degraded
              </Badge>
            )}
            {rateLimitStore && (
              <Badge
                variant="outline"
                data-testid={`replica-rls-${replica.replicaId}`}
              >
                rateLimitStore: {rateLimitStore}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {Object.keys(checks).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {Object.entries(checks).map(([name, state]) => (
              <Badge
                key={name}
                variant={checkBadgeVariant(state)}
                data-testid={`check-${replica.replicaId}-${name}`}
              >
                {name}: {state}
              </Badge>
            ))}
          </div>
        )}
        {Object.keys(failures).length > 0 && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"
            data-testid={`failures-${replica.replicaId}`}
          >
            <p className="font-medium text-destructive mb-1">Failures</p>
            <ul className="space-y-0.5 font-mono text-destructive/90 break-words">
              {Object.entries(failures).map(([name, msg]) => (
                <li key={name}>
                  <span className="font-semibold">{name}:</span> {msg}
                </li>
              ))}
            </ul>
          </div>
        )}
        {streaks.length > 0 && (
          <div
            className={cn(
              "rounded-md border p-2 text-xs",
              hasPageableStreak
                ? "border-destructive/60 bg-destructive/5"
                : "border-amber-500/40 bg-amber-500/5",
            )}
            data-testid={`streaks-${replica.replicaId}`}
          >
            <p
              className={cn(
                "font-medium mb-1 flex items-center gap-1.5",
                hasPageableStreak ? "text-destructive" : "text-amber-700 dark:text-amber-400",
              )}
            >
              {hasPageableStreak ? (
                <Siren className="w-3.5 h-3.5" />
              ) : (
                <Timer className="w-3.5 h-3.5" />
              )}
              Failure-streak history (from <code>/api/healthz</code>)
            </p>
            <ul className="space-y-1">
              {streaks.map((s) => (
                <li
                  key={s.name}
                  className="flex items-baseline gap-2 flex-wrap"
                  data-testid={`streak-${replica.replicaId}-${s.name}`}
                >
                  <span className="font-mono font-semibold">{s.name}</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      s.pageable
                        ? "text-destructive font-medium"
                        : "text-foreground",
                    )}
                    data-testid={`streak-duration-${replica.replicaId}-${s.name}`}
                    title={`Streak began ${formatTimestamp(s.firstFailureAt)} (${formatRelativeFlexible(s.firstFailureAt, now)})`}
                  >
                    stuck-degraded for {formatDurationMs(s.durationMs)}
                  </span>
                  {s.pageable && (
                    <Badge
                      variant="destructive"
                      data-testid={`streak-pageable-${replica.replicaId}-${s.name}`}
                      title={`> ${STUCK_DEGRADED_THRESHOLD_MS / 60_000}m — checkHealthzDegraded would page now`}
                    >
                      probe pages now
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    · {s.failureCount} failure{s.failureCount === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
            {!hasPageableStreak && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Page threshold: {STUCK_DEGRADED_THRESHOLD_MS / 60_000}m. Below
                that the streak is informational; above it the GitHub Actions{" "}
                <code>checkHealthzDegraded</code> probe pages on-call.
              </p>
            )}
          </div>
        )}
        {productionHostnamePattern && productionHostnamePattern !== "not_required" && (
          <p
            className={cn(
              "text-xs",
              productionHostnamePattern === "missing"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
            data-testid={`config-hostname-${replica.replicaId}`}
          >
            productionHostnamePattern: {productionHostnamePattern}
          </p>
        )}
        {replica.parseError && (
          <p className="text-xs text-destructive" data-testid={`parse-error-${replica.replicaId}`}>
            Could not parse response body: {replica.parseError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function isDbHealthDegraded(snapshot: DbHealthSnapshot | undefined): boolean {
  return snapshot?.state === "degraded";
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

function DatabaseHealthPanel() {
  const { data, isLoading, error } = useAdminGetDbHealth({
    query: {
      refetchInterval: 15_000,
      refetchIntervalInBackground: true,
      staleTime: 0,
    } as never,
  });

  const snapshot = data;
  const degraded = isDbHealthDegraded(snapshot);
  const now = Date.now();

  return (
    <Card
      className={cn(degraded && "border-destructive/60 bg-destructive/5")}
      data-testid="db-health-panel"
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Database</CardTitle>
        <HardDrive
          className={cn(
            "w-4 h-4",
            degraded ? "text-destructive" : "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <p
            className="text-xs text-destructive"
            data-testid="db-health-error"
          >
            Could not load /api/admin/db-health. You may not have permission,
            or the api-server may be down.
          </p>
        ) : isLoading || !snapshot ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" data-testid="db-health-replica">
                {snapshot.replicaId}
              </Badge>
              {degraded ? (
                <Badge variant="destructive" data-testid="db-health-state">
                  degraded
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="db-health-state">
                  healthy
                </Badge>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">p50 latency</dt>
              <dd
                className="tabular-nums"
                data-testid="db-health-p50"
              >
                {formatLatency(snapshot.p50LatencyMs)}
              </dd>
              <dt className="text-muted-foreground">p95 latency</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  degraded && "font-medium text-destructive",
                )}
                data-testid="db-health-p95"
              >
                {formatLatency(snapshot.p95LatencyMs)}
              </dd>
              <dt className="text-muted-foreground">Samples</dt>
              <dd
                className="tabular-nums"
                data-testid="db-health-sample-count"
              >
                {snapshot.sampleCount}
              </dd>
              <dt className="text-muted-foreground">Last success</dt>
              <dd
                className="tabular-nums"
                data-testid="db-health-last-success"
                title={
                  snapshot.lastSuccessAtIso
                    ? formatTimestamp(snapshot.lastSuccessAtIso)
                    : undefined
                }
              >
                {snapshot.lastSuccessAtIso
                  ? `${formatRelativeFlexible(snapshot.lastSuccessAtIso, now)} (${formatTimestamp(snapshot.lastSuccessAtIso)})`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Last probed</dt>
              <dd
                className="tabular-nums"
                data-testid="db-health-last-probed"
                title={formatTimestamp(snapshot.lastProbedAtIso)}
              >
                {`${formatRelativeFlexible(snapshot.lastProbedAtIso, now)} (${formatTimestamp(snapshot.lastProbedAtIso)})`}
              </dd>
            </dl>
            {snapshot.lastError && (
              <p
                className="text-[11px] text-destructive"
                data-testid="db-health-last-error"
              >
                {snapshot.lastError}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function isQueueHealthDegraded(snapshot: QueueHealthSnapshot | undefined): boolean {
  return snapshot?.state === "degraded";
}

function BackgroundQueuePanel() {
  const { data, isLoading, error } = useAdminGetQueueHealth({
    query: {
      refetchInterval: 15_000,
      refetchIntervalInBackground: true,
      staleTime: 0,
    } as never,
  });

  const snapshot = data;
  const degraded = isQueueHealthDegraded(snapshot);
  const now = Date.now();

  return (
    <Card
      className={cn(degraded && "border-destructive/60 bg-destructive/5")}
      data-testid="queue-health-panel"
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Background queue</CardTitle>
        <Layers
          className={cn(
            "w-4 h-4",
            degraded ? "text-destructive" : "text-muted-foreground",
          )}
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <p
            className="text-xs text-destructive"
            data-testid="queue-health-error"
          >
            Could not load /api/admin/queue-health. You may not have
            permission, or the api-server may be down.
          </p>
        ) : isLoading || !snapshot ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" data-testid="queue-health-kind">
                notifications_outbox
              </Badge>
              {degraded ? (
                <Badge variant="destructive" data-testid="queue-health-state">
                  degraded
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="queue-health-state">
                  healthy
                </Badge>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Pending</dt>
              <dd
                className="tabular-nums"
                data-testid="queue-health-pending"
              >
                {snapshot.pendingCount}
              </dd>
              <dt className="text-muted-foreground">In flight</dt>
              <dd
                className="tabular-nums"
                data-testid="queue-health-processing"
              >
                {snapshot.processingCount}
              </dd>
              <dt className="text-muted-foreground">Failed</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  snapshot.failedCount > 0 && "font-medium text-destructive",
                )}
                data-testid="queue-health-failed"
              >
                {snapshot.failedCount}
              </dd>
              <dt className="text-muted-foreground">Oldest pending</dt>
              <dd
                className={cn(
                  "tabular-nums",
                  degraded && snapshot.oldestPendingAtIso && "font-medium text-destructive",
                )}
                data-testid="queue-health-oldest-pending"
                title={
                  snapshot.oldestPendingAtIso
                    ? formatTimestamp(snapshot.oldestPendingAtIso)
                    : undefined
                }
              >
                {snapshot.oldestPendingAtIso
                  ? `${formatRelativeFlexible(snapshot.oldestPendingAtIso, now)} (${formatTimestamp(snapshot.oldestPendingAtIso)})`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Oldest in flight</dt>
              <dd
                className="tabular-nums"
                data-testid="queue-health-oldest-processing"
                title={
                  snapshot.oldestProcessingAtIso
                    ? formatTimestamp(snapshot.oldestProcessingAtIso)
                    : undefined
                }
              >
                {snapshot.oldestProcessingAtIso
                  ? `${formatRelativeFlexible(snapshot.oldestProcessingAtIso, now)} (${formatTimestamp(snapshot.oldestProcessingAtIso)})`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Sampled</dt>
              <dd
                className="tabular-nums"
                data-testid="queue-health-sampled"
                title={formatTimestamp(snapshot.sampledAtIso)}
              >
                {`${formatRelativeFlexible(snapshot.sampledAtIso, now)} (${formatTimestamp(snapshot.sampledAtIso)})`}
              </dd>
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}
