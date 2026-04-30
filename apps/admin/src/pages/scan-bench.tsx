import { useState } from "react";
import { useAdminScanText } from "@workspace/api-client-react";
import { PageHeader } from "@/components/admin-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

export default function ScanBenchPage() {
  const [text, setText] = useState("");
  const { toast } = useToast();
  const scan = useAdminScanText({
    mutation: {
      onError: (e) => toast({ variant: "destructive", title: "Scan failed", description: String(e) }),
    },
  });
  const result = scan.data;

  return (
    <div>
      <PageHeader
        title="Scan bench"
        description="Test the active moderation provider against arbitrary text. Useful for tuning thresholds and debugging false positives."
      />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Input</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="Paste a chat message, product description, or stream title…"
              data-testid="input-scan-text"
            />
            <div className="flex items-center gap-2">
              <Button
                disabled={!text || scan.isPending}
                onClick={() => scan.mutate({ data: { text } })}
                data-testid="btn-run-scan"
              >
                {scan.isPending ? "Scanning…" : "Run scan"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Stub provider blocks the substring <code>FLAG_BLOCK</code>.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Result</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {!result && <p className="text-xs text-muted-foreground">No scan run yet.</p>}
            {result && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant={result.decision === "block" ? "destructive" : result.decision === "review" ? "outline" : "secondary"}
                    data-testid="scan-decision"
                  >
                    {result.decision}
                  </Badge>
                  {result.blocked && (
                    <Badge variant="destructive">blocked</Badge>
                  )}
                  {result.csamMatch && (
                    <Badge className="bg-red-700 text-white">CSAM match</Badge>
                  )}
                  <Badge variant="outline" className="font-mono text-[10px]">scan {result.scanId.slice(0, 10)}</Badge>
                  {result.caseId && (
                    <Badge variant="outline" className="font-mono text-[10px]">case {result.caseId.slice(0, 10)}</Badge>
                  )}
                </div>
                <pre
                  className="text-[11px] bg-muted p-3 rounded-md overflow-auto max-h-96"
                  data-testid="scan-raw"
                >
                  {JSON.stringify(result, null, 2)}
                </pre>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
