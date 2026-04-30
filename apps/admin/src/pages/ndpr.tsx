import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAdminNdprRequests,
  useCancelAdminNdprRequest,
  getListAdminNdprRequestsQueryKey,
} from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const KINDS = ["all", "export", "erase", "rectify", "restrict", "portability"] as const;
const STATUSES = ["all", "pending", "ready", "completed", "cancelled", "failed"] as const;

function CancelDialog({
  ndprId,
  onDone,
}: {
  ndprId: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const cancel = useCancelAdminNdprRequest({
    mutation: {
      onSuccess: () => {
        toast({ title: "NDPR request cancelled" });
        qc.invalidateQueries({
          queryKey: getListAdminNdprRequestsQueryKey(),
        });
        setOpen(false);
        setNote("");
        onDone();
      },
      onError: (e) =>
        toast({
          variant: "destructive",
          title: "Cancel failed",
          description: String(e),
        }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid={`btn-cancel-ndpr-${ndprId}`}
      >
        Cancel
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel NDPR request</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            This is recorded in the audit log against your operator id. Add a
            short note explaining why the request is being cancelled by support.
          </p>
          <Label className="text-xs">Note (optional)</Label>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="input-ndpr-cancel-note"
            placeholder="e.g. user phoned to revoke erase request"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            variant="destructive"
            onClick={() => cancel.mutate({ id: ndprId, data: { note } })}
            disabled={cancel.isPending}
            data-testid="btn-confirm-cancel-ndpr"
          >
            {cancel.isPending ? "Cancelling…" : "Confirm cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function NdprPage() {
  const [kind, setKind] = useState<string>("all");
  const [status, setStatus] = useState<string>("pending");

  const { data, isLoading, error } = useListAdminNdprRequests(
    {
      kind: kind as never,
      status: status as never,
    },
    { query: { staleTime: 5_000 } as never },
  );
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="NDPR data-subject requests"
        description="Pending exports, erasures, rectifications, restrictions, and portability bundles. Cancel a pending erase if a user revokes during the 30-day grace window."
      />

      <div className="flex gap-2 mb-4 flex-wrap">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-44" data-testid="filter-ndpr-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="filter-ndpr-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load NDPR requests.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead className="w-32">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-sm text-muted-foreground"
                    data-testid="ndpr-queue-empty"
                  >
                    No requests match.
                  </TableCell>
                </TableRow>
              )}
              {items.map((r) => (
                <TableRow key={r.id} data-testid={`ndpr-row-${r.id}`}>
                  <TableCell className="font-mono text-xs">
                    {r.id.slice(0, 12)}…
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.userId.slice(0, 12)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {r.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        r.status === "failed"
                          ? "destructive"
                          : r.status === "pending"
                            ? "secondary"
                            : "outline"
                      }
                      className="capitalize"
                    >
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.createdAtIso).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.effectiveAtIso
                      ? new Date(r.effectiveAtIso).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {r.status === "pending" ? (
                      <CancelDialog ndprId={r.id} onDone={() => {}} />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
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
