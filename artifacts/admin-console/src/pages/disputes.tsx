import { useState } from "react";
import {
  useAdminListDisputes,
  useAdminDecideDispute,
  getAdminListDisputesQueryKey,
  type AdminDecideDisputeBodyDecision,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

const STATES = ["all", "open", "triage", "in_review", "action", "closed"];

function DecideDialog({
  caseId,
  returnId,
  onDone,
}: {
  caseId: string;
  returnId?: string | null;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<AdminDecideDisputeBodyDecision>("refund");
  const [reason, setReason] = useState("");

  const decide = useAdminDecideDispute({
    mutation: {
      onSuccess: () => {
        toast({ title: "Dispute decided" });
        setOpen(false);
        onDone();
      },
      onError: (e) => toast({ variant: "destructive", title: "Decide failed", description: String(e) }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`btn-open-decide-${caseId}`}>
          Decide
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decide dispute</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Decision</Label>
            <Select value={decision} onValueChange={(v) => setDecision(v as AdminDecideDisputeBodyDecision)}>
              <SelectTrigger data-testid="select-dispute-decision"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="refund">Refund (full)</SelectItem>
                <SelectItem value="partial">Partial refund</SelectItem>
                <SelectItem value="deny">Deny</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              data-testid="input-dispute-reason"
            />
          </div>
          {returnId && (
            <p className="text-[11px] text-muted-foreground">
              Affects return <span className="font-mono">{returnId}</span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => decide.mutate({ id: caseId, data: { decision, reason } })}
            disabled={decide.isPending}
            data-testid="btn-submit-decide"
          >
            {decide.isPending ? "Saving…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DisputesPage() {
  const [state, setState] = useState<string>("all");
  const qc = useQueryClient();
  const params = state === "all" ? undefined : { state };
  const { data, isLoading, error } = useAdminListDisputes(params, {
    query: { staleTime: 5_000 } as never,
  });
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader title="Dispute queue" description="Disputed returns awaiting an operator decision." />
      <div className="flex gap-2 mb-4">
        <Select value={state} onValueChange={setState}>
          <SelectTrigger className="w-44" data-testid="filter-dispute-state"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATES.map((s) => (
              <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load disputes.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Return</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No open disputes.</TableCell></TableRow>
              )}
              {items.map((d) => (
                <TableRow key={d.id} data-testid={`dispute-row-${d.id}`}>
                  <TableCell className="font-mono text-xs">{d.id.slice(0, 12)}…</TableCell>
                  <TableCell className="font-mono text-xs">{d.returnRow?.id ? d.returnRow.id.slice(0, 12) : "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{d.returnRow?.orderId ? d.returnRow.orderId.slice(0, 12) : "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{d.state.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell className="text-xs max-w-xs truncate">{d.returnRow?.reasonLabel ?? d.decisionReason ?? "—"}</TableCell>
                  <TableCell>
                    <DecideDialog
                      caseId={d.id}
                      returnId={d.returnRow?.id ?? null}
                      onDone={() => qc.invalidateQueries({ queryKey: getAdminListDisputesQueryKey(params) })}
                    />
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
