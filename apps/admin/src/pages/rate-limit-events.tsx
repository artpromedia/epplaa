import { useState } from "react";
import { Link } from "wouter";
import { useListAdminRateLimitEvents } from "@workspace/api-client-react";
import type { AdminRateLimitEvent } from "@workspace/api-client-react";
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

interface FilterState {
  identity: string;
  route: string;
  tier: string;
  sinceIso: string;
  untilIso: string;
}

const EMPTY: FilterState = {
  identity: "",
  route: "",
  tier: "",
  sinceIso: "",
  untilIso: "",
};

const PAGE_SIZE = 100;

const TIER_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  anon: "outline",
  buyer: "secondary",
  seller: "default",
  admin: "destructive",
};

function tierBadge(tier: string) {
  const variant = TIER_VARIANTS[tier] ?? "outline";
  return (
    <Badge variant={variant} className="font-mono text-[10px]">
      {tier}
    </Badge>
  );
}

function trustSafetyLink(identity: string): string | null {
  // Identity bucket keys are written as `${tier}:${userIdOrIp}`. We only
  // deep-link the user-keyed buckets into the existing users page so an
  // operator can pivot from a 429 spike straight into the user's
  // Trust & Safety profile. IP-keyed buckets stay as plain text.
  const m = identity.match(/^(?:user|buyer|seller|admin):(.+)$/);
  if (!m) return null;
  return `/users?q=${encodeURIComponent(m[1] ?? "")}`;
}

type SortDir = "desc" | "asc";

export default function RateLimitEventsPage() {
  const [draft, setDraft] = useState<FilterState>(EMPTY);
  const [active, setActive] = useState<FilterState>(EMPTY);
  const [page, setPage] = useState(0);
  // Sort direction is sent to the server so pagination stays globally
  // consistent (oldest-first walks the burst from its start across
  // pages instead of just reversing the visible slice).
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const params = {
    identity: active.identity || undefined,
    route: active.route || undefined,
    tier: active.tier || undefined,
    sinceIso: active.sinceIso || undefined,
    untilIso: active.untilIso || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    sortDir,
  };
  const { data, isLoading, error, isFetching } = useListAdminRateLimitEvents(
    params,
    { query: { staleTime: 5_000 } as never },
  );
  const items: AdminRateLimitEvent[] = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;
  const showingFrom = totalCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = page * PAGE_SIZE + items.length;
  const hasNext = showingTo < totalCount;

  function apply() {
    setActive(draft);
    setPage(0);
  }
  function clear() {
    setDraft(EMPTY);
    setActive(EMPTY);
    setPage(0);
  }

  return (
    <div data-testid="page-rate-limit-events">
      <PageHeader
        title="Rate-limit events"
        description="Forensic trail of 429s from the per-route + per-identity rate limiter. Bounded to the last 90 days. Searches are themselves audited."
      />

      <Card className="mb-4">
        <CardContent className="pt-6 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Identity</Label>
              <Input
                value={draft.identity}
                onChange={(e) =>
                  setDraft({ ...draft, identity: e.target.value })
                }
                className="font-mono text-xs"
                placeholder="user:abc or ip:1.2.3.4"
                data-testid="filter-rl-identity"
              />
            </div>
            <div>
              <Label className="text-xs">Route (substring)</Label>
              <Input
                value={draft.route}
                onChange={(e) =>
                  setDraft({ ...draft, route: e.target.value })
                }
                className="font-mono text-xs"
                placeholder="/auth or /api/wallet"
                data-testid="filter-rl-route"
              />
            </div>
            <div>
              <Label className="text-xs">Tier</Label>
              <Select
                value={draft.tier === "" ? "all" : draft.tier}
                onValueChange={(v) =>
                  setDraft({ ...draft, tier: v === "all" ? "" : v })
                }
              >
                <SelectTrigger
                  className="text-xs"
                  data-testid="filter-rl-tier"
                >
                  <SelectValue placeholder="All tiers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tiers</SelectItem>
                  <SelectItem value="anon">anon</SelectItem>
                  <SelectItem value="buyer">buyer</SelectItem>
                  <SelectItem value="seller">seller</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Since</Label>
              <Input
                type="datetime-local"
                value={draft.sinceIso}
                onChange={(e) =>
                  setDraft({ ...draft, sinceIso: e.target.value })
                }
                data-testid="filter-rl-since"
              />
            </div>
            <div>
              <Label className="text-xs">Until</Label>
              <Input
                type="datetime-local"
                value={draft.untilIso}
                onChange={(e) =>
                  setDraft({ ...draft, untilIso: e.target.value })
                }
                data-testid="filter-rl-until"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={apply} data-testid="btn-rl-search">
              Search
            </Button>
            <Button
              variant="outline"
              onClick={clear}
              data-testid="btn-rl-clear"
            >
              Clear
            </Button>
            <p
              className="text-xs text-muted-foreground self-center ml-auto"
              data-testid="rl-pagination-summary"
            >
              {totalCount === 0
                ? "No matches."
                : `Showing ${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} of ${totalCount.toLocaleString()} events`}
              {isFetching && " (refreshing…)"}
            </p>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load rate-limit events.
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">
                  <button
                    type="button"
                    onClick={() => {
                      // Flipping sort resets pagination to the first
                      // page so the operator always sees the head of
                      // the new ordering rather than landing in the
                      // middle of the previous page's offset.
                      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
                      setPage(0);
                    }}
                    className="text-xs font-medium hover-elevate inline-flex items-center gap-1 px-1 py-0.5 rounded"
                    data-testid="btn-rl-sort-ts"
                    title={
                      sortDir === "desc"
                        ? "Sorted newest first — click for oldest first"
                        : "Sorted oldest first — click for newest first"
                    }
                  >
                    When {sortDir === "desc" ? "↓" : "↑"}
                  </button>
                </TableHead>
                <TableHead className="w-20">Tier</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="w-32">Trust &amp; Safety</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="py-8 text-center text-sm text-muted-foreground"
                    data-testid="rl-empty"
                  >
                    No 429 events match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {items.map((ev) => {
                const tsLink = trustSafetyLink(ev.identity);
                return (
                  <TableRow
                    key={ev.id}
                    data-testid={`rl-row-${ev.id}`}
                  >
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(ev.tsIso).toLocaleString()}
                    </TableCell>
                    <TableCell>{tierBadge(ev.tier)}</TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {ev.identity}
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {ev.route}
                    </TableCell>
                    <TableCell>
                      {tsLink ? (
                        <Button
                          asChild
                          size="sm"
                          variant="ghost"
                          data-testid={`btn-rl-ts-${ev.id}`}
                        >
                          <Link href={tsLink}>Open</Link>
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2 mt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0 || isFetching}
          data-testid="btn-rl-prev"
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="rl-page">
          Page {page + 1}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => p + 1)}
          disabled={!hasNext || isFetching}
          data-testid="btn-rl-next"
        >
          Next
        </Button>
      </div>
    </div>
  );
}
