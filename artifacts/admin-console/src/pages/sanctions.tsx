import { useState } from "react";
import { useListAdminSanctionsHits } from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/dialog";
import type { AdminSanctionsHit } from "@workspace/api-client-react";

const STATUSES = ["all", "pending", "flagged", "blocked", "clear"] as const;

function severityFor(score: number) {
  if (score >= 90) return "destructive";
  if (score >= 80) return "outline";
  return "secondary";
}

export default function SanctionsPage() {
  const [status, setStatus] = useState<string>("flagged");
  const [selected, setSelected] = useState<AdminSanctionsHit | null>(null);

  const { data, isLoading, error } = useListAdminSanctionsHits(
    { status: status as never },
    { query: { staleTime: 5_000 } as never },
  );
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Sanctions &amp; PEP review"
        description="Sanctions / politically-exposed-person screening hits. Flagged or blocked subjects have payouts held until cleared."
      />

      <div className="flex gap-2 mb-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="filter-sanctions-status">
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
          Couldn't load sanctions hits.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-32">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="py-8 text-center text-sm text-muted-foreground"
                    data-testid="sanctions-empty"
                  >
                    No screening hits.
                  </TableCell>
                </TableRow>
              )}
              {items.map((hit) => (
                <TableRow key={hit.id} data-testid={`sanctions-row-${hit.id}`}>
                  <TableCell className="text-sm font-medium">
                    {hit.subjectName || (
                      <span className="text-muted-foreground italic">
                        unnamed
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {hit.userId.slice(0, 12)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {hit.subjectCountry || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={severityFor(hit.matchScore)}>
                      {hit.matchScore}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {hit.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{hit.provider}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(hit.createdAtIso).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected(hit)}
                      data-testid={`btn-sanctions-detail-${hit.id}`}
                    >
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sanctions hit detail</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Subject</p>
                  <p className="font-medium">{selected.subjectName || "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">User id</p>
                  <p className="font-mono text-xs">{selected.userId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Country</p>
                  <p>{selected.subjectCountry || "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Match score</p>
                  <Badge variant={severityFor(selected.matchScore)}>
                    {selected.matchScore}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Provider</p>
                  <p>{selected.provider}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Badge variant="outline" className="capitalize">
                    {selected.status}
                  </Badge>
                </div>
              </div>
              {selected.note && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    Reviewer note
                  </p>
                  <p className="rounded-md border border-border bg-muted/40 p-2 text-xs">
                    {selected.note}
                  </p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  List hits ({selected.listHits.length})
                </p>
                {selected.listHits.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None.</p>
                ) : (
                  <pre
                    className="rounded-md border border-border bg-muted/40 p-2 text-xs overflow-auto max-h-72"
                    data-testid="sanctions-list-hits"
                  >
                    {JSON.stringify(selected.listHits, null, 2)}
                  </pre>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Use the Payouts page (status: blocked) to release any holds
                created by this hit once the case is cleared.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
