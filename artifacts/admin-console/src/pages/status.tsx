import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 10_000;
const SAMPLES_PER_CYCLE = 5;
const REPLICA_STALE_AFTER_MS = 60_000;

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

function isReplicaUnhealthy(s: ReplicaSample): boolean {
  if (s.httpStatus !== 200) return true;
  if (!s.body) return true;
  if (s.body.status !== "ready") return true;
  const checks = s.body.checks ?? {};
  return Object.values(checks).some((v) => v === "failed");
}

function formatRelative(now: number, then: number): string {
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

export default function StatusPage() {
  const [replicas, setReplicas] = useState<Record<string, ReplicaSample>>({});
  const [lastError, setLastError] = useState<SamplerError | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  // Re-render the "Xs ago" labels on a tick independent of the poll loop
  // so timestamps don't appear frozen between polls.
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);

  const pollNow = useCallback(async () => {
    setIsPolling(true);
    try {
      const samples = await Promise.allSettled(
        Array.from({ length: SAMPLES_PER_CYCLE }, () => probeOnce()),
      );
      if (!mountedRef.current) return;
      const fulfilled: ReplicaSample[] = [];
      const errors: string[] = [];
      for (const s of samples) {
        if (s.status === "fulfilled") fulfilled.push(s.value);
        else errors.push((s.reason as Error)?.message ?? String(s.reason));
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
      }
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

  return (
    <div data-testid="page-status">
      <PageHeader
        title="Replica health"
        description={`Polls /api/readyz every ${POLL_INTERVAL_MS / 1000}s and groups responses by replica. Multiple parallel probes per cycle increase the odds of sampling every replica behind the load balancer.`}
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
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
      </div>

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
          <ReplicaCard key={replica.replicaId} replica={replica} now={now} />
        ))}
      </div>

      <p className="mt-6 text-xs text-muted-foreground" data-testid="status-poll-meta">
        Last polled {lastPolledAt ? formatRelative(now, lastPolledAt) : "never"} ·{" "}
        {SAMPLES_PER_CYCLE} parallel probes per cycle · stale replicas drop after{" "}
        {REPLICA_STALE_AFTER_MS / 1000}s of silence
      </p>
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

function ReplicaCard({ replica, now }: { replica: ReplicaSample; now: number }) {
  const unhealthy = isReplicaUnhealthy(replica);
  const checks = replica.body?.checks ?? {};
  const failures = replica.body?.failures ?? {};
  const rateLimitStore = replica.body?.rateLimitStore;
  const productionHostnamePattern = replica.body?.config?.productionHostnamePattern;
  return (
    <Card
      data-testid={`replica-${replica.replicaId}`}
      className={cn(unhealthy && "border-destructive/60")}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <CardTitle className="text-sm font-mono break-all" data-testid={`replica-id-${replica.replicaId}`}>
              {replica.replicaId}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              HTTP {replica.httpStatus} · last seen {formatRelative(now, replica.observedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {unhealthy ? (
              <Badge variant="destructive" data-testid={`replica-status-${replica.replicaId}`}>
                <XCircle className="w-3 h-3 mr-1" /> Degraded
              </Badge>
            ) : (
              <Badge variant="secondary" data-testid={`replica-status-${replica.replicaId}`}>
                <CheckCircle2 className="w-3 h-3 mr-1" /> Ready
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
