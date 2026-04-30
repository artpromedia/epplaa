import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminListTakedowns,
  useAdminCreateTakedown,
  getAdminListTakedownsQueryKey,
  type Takedown,
} from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TARGET_KINDS = ["product", "stream", "user", "message"];
const REASON_CODES = [
  "policy_violation",
  "counterfeit",
  "harassment",
  "csam",
  "fraud",
  "ip_violation",
  "other",
];

function CreateTakedownDialog({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [targetKind, setTargetKind] = useState<string>("product");
  const [targetId, setTargetId] = useState("");
  const [reasonCode, setReasonCode] = useState<string>("policy_violation");
  const [notes, setNotes] = useState("");

  const create = useAdminCreateTakedown({
    mutation: {
      onSuccess: () => {
        toast({ title: "Takedown created" });
        setOpen(false);
        setTargetId("");
        setNotes("");
        onCreated();
      },
      onError: (e) => toast({ variant: "destructive", title: "Failed", description: String(e) }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="btn-new-takedown">
          <Plus className="w-3 h-3 mr-1" /> New takedown
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Issue takedown</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Target kind</Label>
            <Select value={targetKind} onValueChange={setTargetKind}>
              <SelectTrigger data-testid="select-takedown-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TARGET_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Target id</Label>
            <Input value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="input-takedown-target" />
          </div>
          <div>
            <Label className="text-xs">Reason code</Label>
            <Select value={reasonCode} onValueChange={setReasonCode}>
              <SelectTrigger data-testid="select-takedown-reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASON_CODES.map((r) => <SelectItem key={r} value={r}>{r.replace(/_/g, " ")}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} data-testid="input-takedown-notes" />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!targetId || create.isPending}
            onClick={() => create.mutate({ data: { targetKind, targetId, reasonCode, notes } })}
            data-testid="btn-submit-takedown"
          >
            {create.isPending ? "Saving…" : "Issue takedown"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TakedownsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useAdminListTakedowns(undefined, {
    query: { staleTime: 5_000 } as never,
  });
  const items: Takedown[] = data ?? [];

  return (
    <div>
      <PageHeader
        title="Takedowns"
        description="Hard removals of products, streams, accounts, or chat messages."
        actions={
          <CreateTakedownDialog onCreated={() => qc.invalidateQueries({ queryKey: getAdminListTakedownsQueryKey(undefined) })} />
        }
      />
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load takedowns.
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Id</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>By</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No takedowns yet.</TableCell></TableRow>
              )}
              {items.map((t) => (
                <TableRow key={t.id} data-testid={`takedown-row-${t.id}`}>
                  <TableCell className="font-mono text-xs">{t.id.slice(0, 12)}…</TableCell>
                  <TableCell className="text-xs">
                    <span className="capitalize">{t.targetKind}</span>{" "}
                    <span className="font-mono">{t.targetId.slice(0, 16)}</span>
                  </TableCell>
                  <TableCell className="text-xs capitalize">{t.reasonCode.replace(/_/g, " ")}</TableCell>
                  <TableCell className="font-mono text-xs">{t.actorUserId ? t.actorUserId.slice(0, 12) : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{t.createdAtIso ? new Date(t.createdAtIso).toLocaleString() : "—"}</TableCell>
                  <TableCell className="text-xs max-w-xs truncate">{t.notes ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
