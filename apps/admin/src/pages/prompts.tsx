import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AgentAdminError,
  activatePrompt,
  createPrompt,
  getAgentAdminToken,
  listPrompts,
  setAgentAdminToken,
  type CreatePromptInput,
  type PromptAdminRow,
} from "@/lib/agentAdminClient";
import { useToast } from "@/hooks/use-toast";

const PROMPTS_QUERY_KEY = ["agent-admin", "prompts"] as const;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function TokenBanner({ onSet }: { onSet: () => void }) {
  const [draft, setDraft] = useState("");
  const [hasToken, setHasToken] = useState<boolean>(() => Boolean(getAgentAdminToken()));

  useEffect(() => {
    setHasToken(Boolean(getAgentAdminToken()));
  }, []);

  function save() {
    setAgentAdminToken(draft.trim() || null);
    setHasToken(Boolean(draft.trim()));
    setDraft("");
    onSet();
  }

  function clear() {
    setAgentAdminToken(null);
    setHasToken(false);
    onSet();
  }

  return (
    <Card className="mb-4 border-dashed">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          Agent admin token
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          The agent-service prompt registry is gated by a static admin
          token (env <code>AGENT_ADMIN_TOKEN</code>). Token is held in
          this tab's <code>sessionStorage</code> only and is cleared
          when you close the tab.
        </p>
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder={hasToken ? "token set — paste a new one to replace" : "paste agent admin token"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="input-agent-admin-token"
          />
          <Button onClick={save} disabled={!draft.trim()} data-testid="btn-set-token">
            Save
          </Button>
          {hasToken && (
            <Button variant="outline" onClick={clear} data-testid="btn-clear-token">
              Clear
            </Button>
          )}
        </div>
        {hasToken && (
          <Badge variant="secondary" className="font-mono text-[10px]">
            token loaded
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}

function CreatePromptDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreatePromptInput>({
    ref: "",
    family: "",
    version: "",
    systemPrompt: "",
  });
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: createPrompt,
    onSuccess: (row) => {
      toast({ title: "Prompt created", description: row.ref });
      setOpen(false);
      setForm({ ref: "", family: "", version: "", systemPrompt: "" });
      onCreated();
    },
    onError: (err) => {
      const e = err as AgentAdminError;
      toast({
        title: "Could not create prompt",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const canSubmit =
    form.ref.trim() && form.family.trim() && form.version.trim() && form.systemPrompt.trim();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="btn-new-prompt">New prompt draft</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create prompt draft</DialogTitle>
          <DialogDescription>
            Drafts are inactive on creation. Activate from the list once
            the prompt-eval harness is green for the candidate.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="prompt-family">Family</Label>
              <Input
                id="prompt-family"
                placeholder="buyer-concierge"
                value={form.family}
                onChange={(e) => setForm((f) => ({ ...f, family: e.target.value }))}
                data-testid="input-prompt-family"
              />
            </div>
            <div>
              <Label htmlFor="prompt-version">Version</Label>
              <Input
                id="prompt-version"
                placeholder="v2"
                value={form.version}
                onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))}
                data-testid="input-prompt-version"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="prompt-ref">Ref</Label>
            <Input
              id="prompt-ref"
              placeholder="prompts/buyer-concierge/v2"
              value={form.ref}
              onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))}
              data-testid="input-prompt-ref"
            />
          </div>
          <div>
            <Label htmlFor="prompt-body">System prompt</Label>
            <Textarea
              id="prompt-body"
              rows={10}
              placeholder="You are a buyer concierge…"
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              data-testid="input-prompt-body"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate(form)}
            disabled={!canSubmit || mutation.isPending}
            data-testid="btn-submit-prompt"
          >
            {mutation.isPending ? "Saving…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PromptsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tokenVersion, setTokenVersion] = useState(0);

  const enabled = Boolean(getAgentAdminToken());

  const promptsQuery = useQuery<PromptAdminRow[], AgentAdminError>({
    queryKey: [...PROMPTS_QUERY_KEY, tokenVersion],
    queryFn: listPrompts,
    enabled,
  });

  const activateMutation = useMutation({
    mutationFn: activatePrompt,
    onSuccess: (row) => {
      toast({ title: "Prompt activated", description: row.ref });
      void queryClient.invalidateQueries({ queryKey: PROMPTS_QUERY_KEY });
    },
    onError: (err) => {
      const e = err as AgentAdminError;
      toast({
        title: "Could not activate prompt",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  // Group prompts by family so the operator immediately sees which
  // family currently has an active version and which drafts are
  // candidates for activation.
  const grouped = useMemo(() => {
    const map = new Map<string, PromptAdminRow[]>();
    for (const row of promptsQuery.data ?? []) {
      const list = map.get(row.family) ?? [];
      list.push(row);
      map.set(row.family, list);
    }
    return [...map.entries()]
      .map(([family, rows]) => ({
        family,
        rows: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }))
      .sort((a, b) => a.family.localeCompare(b.family));
  }, [promptsQuery.data]);

  return (
    <div data-testid="page-prompts">
      <PageHeader
        title="Prompt registry"
        description="Versioned system prompts for every agent. Drafts are inactive on creation; activation is the production cutover and atomically swaps the active version within a family."
      />

      <TokenBanner onSet={() => setTokenVersion((v) => v + 1)} />

      {!enabled && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="pt-6 flex items-start gap-3 text-sm">
            <ShieldAlert className="h-5 w-5 text-amber-600 mt-0.5" />
            <div>
              Set the agent admin token above to load the prompt list.
              Without it the registry is unreachable from this tab.
            </div>
          </CardContent>
        </Card>
      )}

      {enabled && (
        <>
          <div className="flex items-center justify-between mb-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => promptsQuery.refetch()}
              disabled={promptsQuery.isFetching}
              data-testid="btn-refresh-prompts"
            >
              <RefreshCw
                className={`h-4 w-4 mr-1 ${promptsQuery.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            <CreatePromptDialog onCreated={() => promptsQuery.refetch()} />
          </div>

          {promptsQuery.error && (
            <Card className="border-destructive/40 bg-destructive/5 mb-3">
              <CardContent className="pt-6 text-sm text-destructive">
                Failed to load prompts: {promptsQuery.error.message}
              </CardContent>
            </Card>
          )}

          {promptsQuery.isLoading && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}

          {!promptsQuery.isLoading && grouped.length === 0 && !promptsQuery.error && (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                No prompts yet. Create a draft to seed the registry.
              </CardContent>
            </Card>
          )}

          {grouped.map(({ family, rows }) => (
            <Card key={family} className="mb-4">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <span>{family}</span>
                  {rows.some((r) => r.isActive) && (
                    <Badge variant="default" className="text-[10px]">
                      active version present
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Ref</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Activated</TableHead>
                      <TableHead>Created by</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.ref} data-testid={`row-prompt-${row.ref}`}>
                        <TableCell className="font-mono text-xs">{row.version}</TableCell>
                        <TableCell className="font-mono text-xs">{row.ref}</TableCell>
                        <TableCell>
                          {row.isActive ? (
                            <Badge variant="default" className="gap-1">
                              <CheckCircle2 className="h-3 w-3" /> active
                            </Badge>
                          ) : (
                            <Badge variant="outline">draft</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{formatDate(row.createdAt)}</TableCell>
                        <TableCell className="text-xs">{formatDate(row.activatedAt)}</TableCell>
                        <TableCell className="text-xs">{row.createdBy ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant={row.isActive ? "ghost" : "default"}
                            disabled={row.isActive || activateMutation.isPending}
                            onClick={() => activateMutation.mutate(row.ref)}
                            data-testid={`btn-activate-${row.ref}`}
                          >
                            {row.isActive ? "active" : "Activate"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
