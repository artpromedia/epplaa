import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminListPayouts,
  useAdminHoldPayout,
  useAdminReleasePayout,
  useAdminClawbackPayout,
  useAdminListPayoutActions,
  getAdminListPayoutsQueryKey,
} from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

type ActionKind = "hold" | "release" | "clawback";

const STATUSES = ["all", "pending", "scheduled", "processing", "blocked", "paid", "failed"];

function ActionDialog({
  payoutId,
  kind,
  onDone,
}: {
  payoutId: string;
  kind: ActionKind;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const hold = useAdminHoldPayout({ mutation: { onSuccess: () => done(), onError: e => fail(e) } });
  const release = useAdminReleasePayout({ mutation: { onSuccess: () => done(), onError: e => fail(e) } });
  const clawback = useAdminClawbackPayout({ mutation: { onSuccess: () => done(), onError: e => fail(e) } });

  function done() {
    toast({ title: `Payout ${kind} recorded` });
    setOpen(false);
    onDone();
  }
  function fail(e: unknown) {
    toast({ variant: "destructive", title: `${kind} failed`, description: String(e) });
  }
  function submit() {
    if (kind === "hold") hold.mutate({ id: payoutId, data: { reason } });
    if (kind === "release") release.mutate({ id: payoutId, data: { reason } });
    if (kind === "clawback") clawback.mutate({ id: payoutId, data: { reason } });
  }
  const pending = hold.isPending || release.isPending || clawback.isPending;
  const variant = kind === "clawback" ? "destructive" : kind === "hold" ? "outline" : "default";
  const label = kind[0].toUpperCase() + kind.slice(1);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant} data-testid={`btn-${kind}-${payoutId}`}>{label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{label} payout</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs">Reason {kind === "release" ? "(optional)" : "(required)"}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`input-${kind}-reason`} />
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || (kind !== "release" && !reason)} data-testid={`btn-submit-${kind}`}>
            {pending ? "Saving…" : `Confirm ${label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ payoutId }: { payoutId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useAdminListPayoutActions(payoutId, {
    query: { enabled: open } as never,
  });
  const actions = data ?? [];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" data-testid={`btn-history-${payoutId}`}>History</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Payout actions</DialogTitle></DialogHeader>
        <div className="text-xs space-y-2 max-h-72 overflow-auto">
          {isLoading && <p className="text-muted-foreground">Loading…</p>}
          {!isLoading && actions.length === 0 && <p className="text-muted-foreground">No actions recorded.</p>}
          {actions.map((a) => (
            <div key={a.id} className="border border-border rounded-md p-2">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="capitalize">{a.action}</Badge>
                <span className="text-muted-foreground">{new Date(a.createdAtIso).toLocaleString()}</span>
              </div>
              <p className="mt-1">By <span className="font-mono">{a.actorUserId.slice(0, 12)}</span></p>
              {a.reason && <p className="mt-1 text-muted-foreground">{a.reason}</p>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PayoutsPage() {
  const search = useSearch();
  const initialStatus = (() => {
    const urlStatus = new URLSearchParams(search).get("status");
    return urlStatus && STATUSES.includes(urlStatus) ? urlStatus : "all";
  })();
  const [status, setStatus] = useState<string>(initialStatus);
  useEffect(() => {
    const urlStatus = new URLSearchParams(search).get("status");
    if (urlStatus && STATUSES.includes(urlStatus) && urlStatus !== status) {
      setStatus(urlStatus);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const params = status === "all" ? undefined : { status };
  const qc = useQueryClient();
  const { data, isLoading, error } = useAdminListPayouts(params, {
    query: { staleTime: 5_000 } as never,
  });
  const items = data?.items ?? [];

  const refresh = () => qc.invalidateQueries({ queryKey: getAdminListPayoutsQueryKey(params) });

  return (
    <div>
      <PageHeader title="Payout operations" description="Hold, release, or clawback seller payouts." />
      <div className="flex gap-2 mb-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="filter-payout-status"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load payouts.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payout</TableHead>
                <TableHead>Seller</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No payouts.</TableCell></TableRow>
              )}
              {items.map((p) => (
                <TableRow key={p.id} data-testid={`payout-row-${p.id}`}>
                  <TableCell className="font-mono text-xs">{p.id.slice(0, 12)}…</TableCell>
                  <TableCell className="font-mono text-xs">{p.sellerId ? p.sellerId.slice(0, 12) : p.userId.slice(0, 12)}</TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {(p.amountMinor / 100).toLocaleString(undefined, { style: "currency", currency: p.currencyCode })}
                  </TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{p.status.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.requestedAtIso ? new Date(p.requestedAtIso).toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="flex flex-wrap gap-1">
                    <ActionDialog payoutId={p.id} kind="hold" onDone={refresh} />
                    <ActionDialog payoutId={p.id} kind="release" onDone={refresh} />
                    <ActionDialog payoutId={p.id} kind="clawback" onDone={refresh} />
                    <HistoryDialog payoutId={p.id} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
