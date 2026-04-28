import {
  useAdminDashboard,
  getHealthCheckQueryOptions,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/admin-shell";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Inbox,
  Scale,
  Wallet,
  Ban,
  Activity,
  Database,
} from "lucide-react";

const tiles = [
  { key: "openCases", label: "Open cases", icon: Inbox },
  { key: "dueSoon", label: "SLA due ≤ 1h", icon: AlertTriangle },
  { key: "pendingDisputes", label: "Pending disputes", icon: Scale },
  { key: "heldPayouts", label: "Held payouts", icon: Wallet },
  { key: "takedowns7d", label: "Takedowns (7d)", icon: Ban },
] as const;

export default function DashboardPage() {
  const { data, isLoading, error } = useAdminDashboard();

  return (
    <div>
      <PageHeader
        title="Trust &amp; Safety dashboard"
        description="Live counters across the moderation, dispute, and payout queues."
      />

      {error && (
        <div
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="dashboard-error"
        >
          You may not have permission to view this dashboard. Ask an admin to
          grant you a moderator, finance_ops, or support role.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {tiles.map((t) => {
          const Icon = t.icon;
          const value = data ? (data as unknown as Record<string, unknown>)[t.key] : null;
          return (
            <Card key={t.key} data-testid={`tile-${t.key}`}>
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t.label}
                </CardTitle>
                <Icon className="w-4 h-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tabular-nums">
                  {isLoading ? "…" : typeof value === "number" ? value : 0}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <RateLimitStorePanel />
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">Moderation provider</CardTitle>
            <Activity className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" data-testid="provider-name">
                {data?.moderationProvider ?? "—"}
              </Badge>
              {data?.degraded ? (
                <Badge variant="destructive" data-testid="provider-degraded">
                  degraded
                </Badge>
              ) : (
                <Badge variant="secondary">healthy</Badge>
              )}
            </div>
            {data?.degradedReason && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="provider-degraded-reason"
              >
                {data.degradedReason}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Set <code>MODERATION_PROVIDER</code> to <code>hive</code> or{" "}
              <code>sightengine</code> in production. Stub provider is for dev
              only.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Operator notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              All mutations are appended to the hash-chained audit log. Only
              admins can grant/revoke roles.
            </p>
            <p>
              Dispute decisions update the underlying return row. Use the
              payouts queue to clawback funds when needed.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function formatTimestamp(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatRelative(ms: number | null, now: number): string {
  if (ms === null) return "—";
  const deltaSec = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const minutes = Math.round(deltaSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
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
      className={cn(
        degraded && "border-destructive/60 bg-destructive/5",
      )}
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
                  : `${formatRelative(status.firstFailureAt, now)} (${formatTimestamp(status.firstFailureAt)})`}
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
                  : `${formatRelative(status.lastRecoveredAt, now)} (${formatTimestamp(status.lastRecoveredAt)})`}
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
