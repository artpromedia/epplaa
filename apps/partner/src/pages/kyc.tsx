import { useEffect, useState } from "react";
import {
  ApiError,
  listManufacturerKyc,
  uploadManufacturerKyc,
  type ManufacturerKyc,
  type ManufacturerKycUploadBodyKind,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";

const REQUIRED_DOCS: {
  kind: ManufacturerKycUploadBodyKind;
  label: string;
  description: string;
}[] = [
  { kind: "export_licence", label: "Export licence", description: "Customs-issued export permit" },
  { kind: "business_registration", label: "Business registration", description: "Articles of incorporation" },
  { kind: "tax_id", label: "Tax ID", description: "Origin-country tax registration" },
  { kind: "ubo", label: "UBO declaration", description: "Ultimate beneficial owner statement" },
  { kind: "factory_audit", label: "Factory audit", description: "BSCI, Sedex, or equivalent" },
];

export default function KycPage() {
  const [docs, setDocs] = useState<ManufacturerKyc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [kind, setKind] = useState<ManufacturerKycUploadBodyKind>(REQUIRED_DOCS[0].kind);
  const [documentUrl, setDocumentUrl] = useState("");

  async function refresh() {
    try {
      const rows = await listManufacturerKyc();
      setDocs(rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  useEffect(() => {
    let alive = true;
    refresh().finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!documentUrl) return;
    setSubmitting(true);
    setError(null);
    try {
      await uploadManufacturerKyc({ kind, documentUrl });
      setDocumentUrl("");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const byKind = (k: string) => docs.filter((d) => d.kind === k);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">KYC documents</h1>
        <p className="text-sm text-muted-foreground">
          Upload export licences, factory audits, and beneficial-ownership records. We approve once
          all required documents are validated.
        </p>
      </header>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-sm rounded-md p-3">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload a document</CardTitle>
          <CardDescription>
            Paste a link from your secure storage (Drive, Dropbox, signed URL).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5 sm:col-span-1">
                <Label htmlFor="kind">Document type</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => setKind(v as ManufacturerKycUploadBodyKind)}
                >
                  <SelectTrigger id="kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUIRED_DOCS.map((d) => (
                      <SelectItem key={d.kind} value={d.kind}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="documentUrl">Document URL</Label>
                <Input
                  id="documentUrl"
                  type="url"
                  required
                  placeholder="https://…"
                  value={documentUrl}
                  onChange={(e) => setDocumentUrl(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Uploading…" : "Add document"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Required documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            REQUIRED_DOCS.map((req) => {
              const items = byKind(req.kind);
              const latest = items[0];
              return (
                <div
                  key={req.kind}
                  className="border border-border rounded-md p-3 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{req.label}</p>
                      <StatusBadge value={latest?.status ?? "missing"} />
                    </div>
                    <p className="text-xs text-muted-foreground">{req.description}</p>
                    {latest && (
                      <a
                        href={latest.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline break-all"
                      >
                        {latest.documentUrl}
                      </a>
                    )}
                    {latest?.status === "rejected" && latest.rejectReason && (
                      <p className="text-xs text-destructive mt-1">Rejected: {latest.rejectReason}</p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground whitespace-nowrap">
                    {items.length} upload{items.length === 1 ? "" : "s"}
                  </p>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
