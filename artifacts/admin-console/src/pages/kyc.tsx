import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPendingKyc,
  useGetAdminKycDetail,
  useGetAdminKycDocumentBlob,
  useApproveKycVerification,
  useRejectKycVerification,
  getListPendingKycQueryKey,
  getGetAdminKycDetailQueryKey,
} from "@workspace/api-client-react";
import type { AdminKycDocument } from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { FileText } from "lucide-react";

function DocumentThumbnail({ doc }: { doc: AdminKycDocument }) {
  const isImage = doc.contentType.startsWith("image/");
  const blobQuery = useGetAdminKycDocumentBlob(doc.id, {
    query: { staleTime: 60_000 } as never,
  });
  const blob = blobQuery.data;
  return (
    <div
      className="border border-border rounded-md p-2 flex flex-col gap-2"
      data-testid={`kyc-doc-${doc.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-[10px] uppercase">
          {doc.kind.replace(/_/g, " ")}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {(doc.sizeBytes / 1024).toFixed(1)} KB
        </span>
      </div>
      <div className="aspect-square w-full bg-muted rounded overflow-hidden flex items-center justify-center">
        {blobQuery.isLoading && (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )}
        {blobQuery.error && (
          <span className="text-xs text-destructive">Failed to load</span>
        )}
        {blob && isImage && (
          <img
            src={`data:${blob.contentType};base64,${blob.blobBase64}`}
            alt={blob.filename}
            className="object-contain w-full h-full"
            data-testid={`kyc-doc-img-${doc.id}`}
          />
        )}
        {blob && !isImage && (
          <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground p-2 text-center">
            <FileText className="w-8 h-8" />
            <span className="truncate max-w-[10rem]">{blob.filename}</span>
            <span className="text-[10px]">{blob.contentType}</span>
          </div>
        )}
      </div>
      <p className="text-[10px] font-mono text-muted-foreground truncate" title={doc.sha256}>
        {doc.sha256.slice(0, 16)}…
      </p>
    </div>
  );
}

function ReviewDialog({
  verificationId,
  open,
  onOpenChange,
  onDone,
}: {
  verificationId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const detailQuery = useGetAdminKycDetail(verificationId ?? "", {
    query: {
      enabled: open && !!verificationId,
      staleTime: 5_000,
    } as never,
  });
  const detail = detailQuery.data;

  const approve = useApproveKycVerification({
    mutation: {
      onSuccess: () => {
        toast({ title: "KYC approved" });
        qc.invalidateQueries({ queryKey: getListPendingKycQueryKey() });
        if (verificationId) {
          qc.invalidateQueries({
            queryKey: getGetAdminKycDetailQueryKey(verificationId),
          });
        }
        onDone();
      },
      onError: (e) =>
        toast({
          variant: "destructive",
          title: "Approve failed",
          description: String(e),
        }),
    },
  });
  const reject = useRejectKycVerification({
    mutation: {
      onSuccess: () => {
        toast({ title: "KYC rejected" });
        qc.invalidateQueries({ queryKey: getListPendingKycQueryKey() });
        if (verificationId) {
          qc.invalidateQueries({
            queryKey: getGetAdminKycDetailQueryKey(verificationId),
          });
        }
        onDone();
      },
      onError: (e) =>
        toast({
          variant: "destructive",
          title: "Reject failed",
          description: String(e),
        }),
    },
  });

  const pending = approve.isPending || reject.isPending;
  const canDecide = detail?.status === "pending_review";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>KYC verification</DialogTitle>
        </DialogHeader>

        {detailQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading verification…</p>
        )}
        {detailQuery.error && (
          <p className="text-sm text-destructive">
            Couldn't load verification.
          </p>
        )}

        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground">
                  Verification id
                </Label>
                <p className="font-mono text-xs" data-testid="kyc-detail-id">
                  {detail.id}
                </p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">User</Label>
                <p className="font-mono text-xs">{detail.userId}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Kind</Label>
                <p className="capitalize">{detail.kind.replace(/_/g, " ")}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  Target tier
                </Label>
                <p>Tier {detail.targetTier}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Status</Label>
                <Badge
                  variant="outline"
                  className="capitalize"
                  data-testid="kyc-detail-status"
                >
                  {detail.status.replace(/_/g, " ")}
                </Badge>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  Submitted
                </Label>
                <p className="text-xs">
                  {detail.submittedAtIso
                    ? new Date(detail.submittedAtIso).toLocaleString()
                    : "—"}
                </p>
              </div>
            </div>

            {detail.reviewerNote && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
                <Label className="text-xs text-muted-foreground mb-1">
                  Existing reviewer note
                </Label>
                <p>{detail.reviewerNote}</p>
              </div>
            )}

            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">
                Documents ({detail.documents.length})
              </Label>
              {detail.documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No documents attached.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {detail.documents.map((d) => (
                    <DocumentThumbnail key={d.id} doc={d} />
                  ))}
                </div>
              )}
            </div>

            {canDecide && (
              <div className="space-y-3 border-t border-border pt-3">
                <div>
                  <Label className="text-xs">Approval note (optional)</Label>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    data-testid="input-kyc-approve-note"
                    placeholder="Reviewed and verified"
                  />
                </div>
                <div>
                  <Label className="text-xs">
                    Rejection reason (required to reject)
                  </Label>
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="input-kyc-reject-reason"
                    placeholder="e.g. Document blurry"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="btn-kyc-close"
          >
            Close
          </Button>
          {canDecide && verificationId && (
            <>
              <Button
                variant="destructive"
                onClick={() =>
                  reject.mutate({
                    id: verificationId,
                    data: { reason },
                  })
                }
                disabled={pending || !reason.trim()}
                data-testid="btn-kyc-reject"
              >
                {reject.isPending ? "Rejecting…" : "Reject"}
              </Button>
              <Button
                onClick={() =>
                  approve.mutate({
                    id: verificationId,
                    data: { note: note.trim() || "approved" },
                  })
                }
                disabled={pending}
                data-testid="btn-kyc-approve"
              >
                {approve.isPending ? "Approving…" : "Approve"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function KycPage() {
  const [reviewId, setReviewId] = useState<string | null>(null);
  const { data, isLoading, error } = useListPendingKyc({
    query: { staleTime: 5_000 } as never,
  });
  const items = data ?? [];

  return (
    <div>
      <PageHeader
        title="KYC review queue"
        description="Pending tier-promotion verifications. Open a row to inspect uploaded documents and approve or reject."
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load the KYC queue.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Verification</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="w-32">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-sm text-muted-foreground"
                    data-testid="kyc-queue-empty"
                  >
                    No pending verifications.
                  </TableCell>
                </TableRow>
              )}
              {items.map((v) => (
                <TableRow key={v.id} data-testid={`kyc-row-${v.id}`}>
                  <TableCell className="font-mono text-xs">
                    {v.id.slice(0, 12)}…
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {v.userId.slice(0, 12)}
                  </TableCell>
                  <TableCell className="capitalize text-sm">
                    {v.kind.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {v.status.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {v.submittedAtIso
                      ? new Date(v.submittedAtIso).toLocaleString()
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReviewId(v.id)}
                      data-testid={`btn-review-kyc-${v.id}`}
                    >
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ReviewDialog
        verificationId={reviewId}
        open={reviewId !== null}
        onOpenChange={(open) => !open && setReviewId(null)}
        onDone={() => setReviewId(null)}
      />
    </div>
  );
}
