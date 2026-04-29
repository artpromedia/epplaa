import { useState } from "react";
import { useSearchAdminAuditLog } from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import type { AdminAuditEvent } from "@workspace/api-client-react";

interface FilterState {
  actorId: string;
  entity: string;
  entityId: string;
  action: string;
  piiOnly: boolean;
  sinceIso: string;
}

const EMPTY: FilterState = {
  actorId: "",
  entity: "",
  entityId: "",
  action: "",
  piiOnly: false,
  sinceIso: "",
};

export default function AuditPage() {
  const [draft, setDraft] = useState<FilterState>(EMPTY);
  const [active, setActive] = useState<FilterState>(EMPTY);
  const [selected, setSelected] = useState<AdminAuditEvent | null>(null);

  const params = {
    actorId: active.actorId || undefined,
    entity: active.entity || undefined,
    entityId: active.entityId || undefined,
    action: active.action || undefined,
    piiOnly: active.piiOnly || undefined,
    sinceIso: active.sinceIso || undefined,
    limit: 200,
  };
  const { data, isLoading, error, isFetching } = useSearchAdminAuditLog(
    params,
    { query: { staleTime: 5_000 } as never },
  );
  const items = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  function apply() {
    setActive(draft);
  }
  function clear() {
    setDraft(EMPTY);
    setActive(EMPTY);
  }

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Append-only, hash-chained event log. Searches are themselves recorded as audit events."
      />

      <Card className="mb-4">
        <CardContent className="pt-6 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Actor user id</Label>
              <Input
                value={draft.actorId}
                onChange={(e) =>
                  setDraft({ ...draft, actorId: e.target.value })
                }
                className="font-mono text-xs"
                placeholder="user_..."
                data-testid="filter-audit-actor"
              />
            </div>
            <div>
              <Label className="text-xs">Entity</Label>
              <Input
                value={draft.entity}
                onChange={(e) =>
                  setDraft({ ...draft, entity: e.target.value })
                }
                placeholder="kyc_verification, payout, …"
                data-testid="filter-audit-entity"
              />
            </div>
            <div>
              <Label className="text-xs">Entity id</Label>
              <Input
                value={draft.entityId}
                onChange={(e) =>
                  setDraft({ ...draft, entityId: e.target.value })
                }
                className="font-mono text-xs"
                data-testid="filter-audit-entity-id"
              />
            </div>
            <div>
              <Label className="text-xs">Action verb</Label>
              <Input
                value={draft.action}
                onChange={(e) =>
                  setDraft({ ...draft, action: e.target.value })
                }
                placeholder="ndpr.* or kyc.verification.approved"
                data-testid="filter-audit-action"
              />
            </div>
            <div>
              <Label className="text-xs">Since (ISO datetime)</Label>
              <Input
                type="datetime-local"
                value={draft.sinceIso}
                onChange={(e) =>
                  setDraft({ ...draft, sinceIso: e.target.value })
                }
                data-testid="filter-audit-since"
              />
            </div>
            <div className="flex items-end gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="pii-only"
                  checked={draft.piiOnly}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, piiOnly: Boolean(checked) })
                  }
                  data-testid="filter-audit-pii-only"
                />
                <Label htmlFor="pii-only" className="text-xs">
                  PII reads only
                </Label>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={apply} data-testid="btn-audit-search">
              Search
            </Button>
            <Button variant="outline" onClick={clear} data-testid="btn-audit-clear">
              Clear
            </Button>
            {totalCount > 0 && (
              <p className="text-xs text-muted-foreground self-center ml-auto">
                Showing {items.length} of {totalCount.toLocaleString()} matches
                {isFetching && " (refreshing…)"}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load audit events.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Seq</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Entity id</TableHead>
                <TableHead className="w-20">PII</TableHead>
                <TableHead className="w-24">Payload</TableHead>
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
                    data-testid="audit-empty"
                  >
                    No events match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {items.map((ev) => (
                <TableRow key={ev.seq} data-testid={`audit-row-${ev.seq}`}>
                  <TableCell className="font-mono text-xs">{ev.seq}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(ev.createdAtIso).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {ev.actorId
                      ? ev.actorId.slice(0, 12)
                      : <span className="italic text-muted-foreground">system</span>}
                  </TableCell>
                  <TableCell className="text-xs">{ev.action}</TableCell>
                  <TableCell className="text-xs">{ev.entity}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {ev.entityId ? ev.entityId.slice(0, 16) : "—"}
                  </TableCell>
                  <TableCell>
                    {ev.piiRead ? (
                      <Badge variant="destructive">PII</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(ev)}
                      data-testid={`btn-audit-payload-${ev.seq}`}
                    >
                      View
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
            <DialogTitle>
              Audit event #{selected?.seq}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Action</p>
                  <p className="font-medium">{selected.action}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Entity</p>
                  <p>
                    {selected.entity}{" "}
                    <span className="font-mono">{selected.entityId}</span>
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Actor</p>
                  <p className="font-mono">{selected.actorId ?? "system"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">When</p>
                  <p>{new Date(selected.createdAtIso).toLocaleString()}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Payload</p>
                <pre
                  className="rounded-md border border-border bg-muted/40 p-2 text-xs overflow-auto max-h-72"
                  data-testid="audit-payload-json"
                >
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
