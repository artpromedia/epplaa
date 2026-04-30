import { useAdminDashboard } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/admin-shell";
import { Link } from "wouter";
import {
  AlertTriangle,
  Inbox,
  Scale,
  Wallet,
  Ban,
  Activity,
  ShieldAlert,
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

      {data?.degraded && (
        <div
          className="mb-4 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="moderation-degraded-banner"
          role="alert"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">
              Moderation provider is degraded — uploads are NOT being scanned by
              a real provider.
            </p>
            <p>
              Active provider:{" "}
              <code className="rounded bg-destructive/10 px-1">
                {data.moderationProvider ?? "stub"}
              </code>
              {data.degradedReason && (
                <>
                  . Reason:{" "}
                  <code
                    className="rounded bg-destructive/10 px-1"
                    data-testid="moderation-degraded-banner-reason"
                  >
                    {data.degradedReason}
                  </code>
                </>
              )}
              . Set <code>MODERATION_PROVIDER</code> to <code>hive</code> or{" "}
              <code>sightengine</code> (with the matching credentials) and
              redeploy. CSAM coverage requires <code>PHOTODNA_API_KEY</code> in
              addition.
            </p>
          </div>
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
        <Card data-testid="card-system-status-link">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">System status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Backing dependencies (rate-limit store, payment gateways, …) now
              live on a dedicated page so on-call can scan them at a glance.
            </p>
            <Link
              href="/status"
              data-testid="link-system-status"
              className="inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Open system status →
            </Link>
          </CardContent>
        </Card>
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

