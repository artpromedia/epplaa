import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetCase,
  useAdminTransitionCase,
  useAdminAssignCase,
  useAdminDecideCase,
  getAdminGetCaseQueryKey,
} from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const STATES = ["open", "triage", "in_review", "action", "closed"] as const;
const DECISIONS = [
  { value: "approve", label: "Approve / no action" },
  { value: "hide", label: "Hide content" },
  { value: "ban", label: "Ban + auto-takedown" },
  { value: "refund", label: "Refund (dispute)" },
  { value: "deny", label: "Deny (dispute)" },
  { value: "partial", label: "Partial refund (dispute)" },
  { value: "escalate", label: "Escalate" },
  { value: "dismiss", label: "Dismiss" },
] as const;

export default function CaseDetailPage() {
  const [, params] = useRoute<{ id: string }>("/cases/:id");
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, error } = useAdminGetCase(id);
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getAdminGetCaseQueryKey(id) });

  const transition = useAdminTransitionCase({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Case state updated" });
      },
      onError: (e) => toast({ variant: "destructive", title: "Update failed", description: String(e) }),
    },
  });
  const assign = useAdminAssignCase({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Assignee updated" });
      },
      onError: (e) => toast({ variant: "destructive", title: "Assign failed", description: String(e) }),
    },
  });
  const decide = useAdminDecideCase({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Decision recorded" });
      },
      onError: (e) => toast({ variant: "destructive", title: "Decide failed", description: String(e) }),
    },
  });

  const [assignee, setAssignee] = useState("");
  const [decision, setDecision] = useState<string>("approve");
  const [reason, setReason] = useState("");
  const [nextState, setNextState] = useState<string>("triage");

  if (!id) return null;

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground" data-testid="case-loading">Loading case…</div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
        Couldn't load this case. It may have been deleted, or you may not have permission.
        <div className="mt-2">
          <Link href="/cases" className="underline">
            Back to cases
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/cases"
        className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-2"
        data-testid="back-cases"
      >
        <ChevronLeft className="w-3 h-3 mr-1" /> Back to cases
      </Link>

      <PageHeader
        title={`Case ${data.id.slice(0, 12)}…`}
        description={`Kind: ${data.kind} · Target: ${data.targetKind}/${data.targetId}`}
        actions={<Badge variant="outline" className="capitalize">{data.state.replace(/_/g, " ")}</Badge>}
      />

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Evidence</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs whitespace-pre-wrap break-all bg-muted p-3 rounded-md max-h-72 overflow-auto" data-testid="case-evidence">
                {JSON.stringify(data.evidence ?? null, null, 2)}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Provider scans</CardTitle>
            </CardHeader>
            <CardContent>
              {data.scans && data.scans.length > 0 ? (
                <ul className="text-xs space-y-2" data-testid="case-scans">
                  {data.scans.map((s) => (
                    <li key={s.id} className="border border-border rounded-md p-2">
                      <div className="flex items-center justify-between">
                        <Badge variant={s.decision === "block" ? "destructive" : s.decision === "review" ? "outline" : "secondary"}>
                          {s.decision}
                        </Badge>
                        <span className="text-muted-foreground">{new Date(s.scannedAtIso).toLocaleString()}</span>
                      </div>
                      <p className="mt-1">
                        Provider: <span className="font-mono">{s.provider}</span>
                        {s.csamMatch && <Badge className="ml-2 bg-red-700 text-white">CSAM match</Badge>}
                      </p>
                      {s.scores && (
                        <pre className="mt-1 bg-muted p-2 rounded text-[11px] overflow-auto">{JSON.stringify(s.scores, null, 2)}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No automated scans recorded.</p>
              )}
            </CardContent>
          </Card>

          {data.decision && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Decision history</CardTitle>
              </CardHeader>
              <CardContent className="text-xs space-y-1">
                <p>
                  <span className="text-muted-foreground">Decision:</span>{" "}
                  <Badge variant="outline">{data.decision}</Badge>
                </p>
                {data.decisionReason && (
                  <p>
                    <span className="text-muted-foreground">Reason:</span> {data.decisionReason}
                  </p>
                )}
                {data.decidedBy && (
                  <p>
                    <span className="text-muted-foreground">Decided by:</span>{" "}
                    <span className="font-mono">{data.decidedBy}</span>
                  </p>
                )}
                {data.decidedAtIso && (
                  <p>
                    <span className="text-muted-foreground">At:</span>{" "}
                    {new Date(data.decidedAtIso).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Assign</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="assignee" className="text-xs">Operator user id (or empty to unassign)</Label>
              <Input
                id="assignee"
                value={assignee}
                placeholder={data.assignedTo ?? ""}
                onChange={(e) => setAssignee(e.target.value)}
                data-testid="input-assignee"
              />
              <Button
                size="sm"
                onClick={() => assign.mutate({ id, data: { assignee: assignee || null } })}
                disabled={assign.isPending}
                data-testid="btn-assign"
              >
                {assign.isPending ? "Saving…" : "Assign"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Transition state</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Select value={nextState} onValueChange={setNextState}>
                <SelectTrigger data-testid="select-state"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATES.map((s) => (
                    <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => transition.mutate({ id, data: { state: nextState } })}
                disabled={transition.isPending}
                data-testid="btn-transition"
              >
                {transition.isPending ? "Saving…" : "Transition"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Decide</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Select value={decision} onValueChange={setDecision}>
                <SelectTrigger data-testid="select-decision"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DECISIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label htmlFor="reason" className="text-xs">Reason</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                data-testid="input-reason"
                placeholder="Short rationale recorded in the audit log"
              />
              <Button
                size="sm"
                variant="default"
                onClick={() => decide.mutate({ id, data: { decision, reason } })}
                disabled={decide.isPending}
                data-testid="btn-decide"
              >
                {decide.isPending ? "Saving…" : "Record decision"}
              </Button>
              {decision === "ban" && (
                <p className="text-[11px] text-muted-foreground">
                  This will also create a takedown row referencing this case.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
