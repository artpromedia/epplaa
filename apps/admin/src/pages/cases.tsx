import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useAdminListCases } from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const STATE_OPTIONS = ["", "open", "triage", "in_review", "action", "closed"] as const;
const KIND_OPTIONS = ["", "report", "scan", "dispute"] as const;

function severityBadge(sev: string) {
  switch (sev) {
    case "critical":
      return <Badge variant="destructive">{sev}</Badge>;
    case "high":
      return <Badge className="bg-orange-500 text-white hover:bg-orange-500">{sev}</Badge>;
    case "low":
      return <Badge variant="secondary">{sev}</Badge>;
    default:
      return <Badge variant="outline">{sev}</Badge>;
  }
}

function stateBadge(state: string) {
  return (
    <Badge
      variant={state === "closed" ? "secondary" : "outline"}
      className="capitalize"
    >
      {state.replace(/_/g, " ")}
    </Badge>
  );
}

function relativeFrom(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${sign}${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${sign}${hr}h`;
  const d = Math.round(hr / 24);
  return `${sign}${d}d`;
}

export default function CasesPage() {
  const [state, setState] = useState<string>("");
  const [kind, setKind] = useState<string>("");

  const params = useMemo(
    () => ({
      state: state || undefined,
      kind: kind || undefined,
      limit: 50,
    }),
    [state, kind],
  );

  const { data, isLoading, error } = useAdminListCases(params);
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Moderation cases"
        description="Reports, scans, and disputes routed through the case queue."
      />

      <div className="flex flex-wrap gap-2 mb-4">
        <Select value={state || "all"} onValueChange={(v) => setState(v === "all" ? "" : v)}>
          <SelectTrigger className="w-40" data-testid="filter-state">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            {STATE_OPTIONS.filter(Boolean).map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind || "all"} onValueChange={(v) => setKind(v === "all" ? "" : v)}>
          <SelectTrigger className="w-40" data-testid="filter-kind">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {KIND_OPTIONS.filter(Boolean).map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load cases. You may not have a moderator/support role.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>State</TableHead>
                <TableHead>SLA</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-sm text-muted-foreground py-8 text-center">
                    Loading cases…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-sm text-muted-foreground py-8 text-center">
                    No cases match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {items.map((c) => {
                const overdue =
                  c.slaDueAtIso && new Date(c.slaDueAtIso).getTime() < Date.now() && c.state !== "closed";
                return (
                  <TableRow key={c.id} data-testid={`case-row-${c.id}`}>
                    <TableCell className="font-mono text-xs">
                      {c.id.slice(0, 12)}…
                    </TableCell>
                    <TableCell className="capitalize text-sm">{c.kind}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="capitalize">{c.targetKind}</div>
                      <div className="font-mono">{c.targetId.slice(0, 16)}</div>
                    </TableCell>
                    <TableCell>{severityBadge(c.severity)}</TableCell>
                    <TableCell>{stateBadge(c.state)}</TableCell>
                    <TableCell className={cn("text-xs", overdue && "text-destructive font-medium")}>
                      {overdue && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                      {relativeFrom(c.slaDueAtIso)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {c.assignedTo ? c.assignedTo.slice(0, 12) : "—"}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/cases/${c.id}`}
                        data-testid={`open-case-${c.id}`}
                        className="inline-flex items-center text-primary text-sm hover:underline"
                      >
                        Open <ArrowRight className="w-3 h-3 ml-1" />
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
