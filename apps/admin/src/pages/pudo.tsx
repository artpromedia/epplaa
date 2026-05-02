/**
 * PUDO partner configuration (admin) — task #175.
 *
 * Operator surface for the daily-push delivery configuration on the
 * `pudo_partners` table. Backed by `/admin/pudo-partners` endpoints
 * declared in services/api-monolith/src/routes/admin.ts. Renders the
 * table, supports add + edit dialogs, and surfaces the "secrets are
 * by env-var NAME, not value" rule directly in the form so an operator
 * doesn't accidentally paste a real password into the input.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Truck, Plus } from "lucide-react";
import { getCsrfToken } from "@workspace/api-client-react";
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
import { useToast } from "@/hooks/use-toast";

interface PudoPartner {
  code: string;
  name: string;
  countryCode: string;
  contactEmail: string;
  active: boolean;
  manifestTimezone: string;
  deliveryMethod: "none" | "email" | "sftp";
  manifestEmail: string;
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  sftpPasswordEnvVar: string;
  sftpKeyEnvVar: string;
  sftpRemoteDir: string;
  hasApiKey: boolean;
  createdAtIso: string;
}

const QUERY_KEY = ["admin", "pudo-partners"] as const;

async function listPartners(): Promise<{ items: PudoPartner[] }> {
  const res = await fetch("/api/admin/pudo-partners", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`pudo_list_failed:${res.status}`);
  return (await res.json()) as { items: PudoPartner[] };
}

async function mutatePartner(
  method: "POST" | "PATCH",
  code: string | null,
  body: Record<string, unknown>,
): Promise<PudoPartner> {
  const url = code
    ? `/api/admin/pudo-partners/${encodeURIComponent(code)}`
    : "/api/admin/pudo-partners";
  const csrf = getCsrfToken();
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const detail = (errBody as { detail?: string }).detail ?? `http_${res.status}`;
    throw new Error(detail);
  }
  return (await res.json()) as PudoPartner;
}

const EMPTY_FORM: Omit<PudoPartner, "createdAtIso" | "hasApiKey"> = {
  code: "",
  name: "",
  countryCode: "NG",
  contactEmail: "",
  active: true,
  manifestTimezone: "Africa/Lagos",
  deliveryMethod: "none",
  manifestEmail: "",
  sftpHost: "",
  sftpPort: 22,
  sftpUsername: "",
  sftpPasswordEnvVar: "",
  sftpKeyEnvVar: "",
  sftpRemoteDir: "/",
};

function PartnerForm({
  initial,
  isCreate,
  onClose,
}: {
  initial: typeof EMPTY_FORM;
  isCreate: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<typeof EMPTY_FORM>(initial);
  const mutation = useMutation({
    mutationFn: (values: typeof EMPTY_FORM) =>
      mutatePartner(isCreate ? "POST" : "PATCH", isCreate ? null : initial.code, values),
    onSuccess: () => {
      toast({ title: isCreate ? "Partner created" : "Partner updated" });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      onClose();
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Save failed",
        description: (err as Error).message,
      });
    },
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit() {
    mutation.mutate(form);
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Code</Label>
          <Input
            value={form.code}
            onChange={(e) => set("code", e.target.value)}
            disabled={!isCreate}
            data-testid="input-pudo-code"
            placeholder="e.g. paxi-za"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            data-testid="input-pudo-name"
            placeholder="PAXI South Africa"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Country (ISO 3166-1)</Label>
          <Input
            value={form.countryCode}
            onChange={(e) => set("countryCode", e.target.value.toUpperCase())}
            maxLength={2}
            data-testid="input-pudo-country"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Contact email</Label>
          <Input
            value={form.contactEmail}
            onChange={(e) => set("contactEmail", e.target.value)}
            data-testid="input-pudo-contact"
            placeholder="ops@partner.example"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Manifest timezone (IANA)</Label>
        <Input
          value={form.manifestTimezone}
          onChange={(e) => set("manifestTimezone", e.target.value)}
          data-testid="input-pudo-tz"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Delivery method</Label>
        <Select
          value={form.deliveryMethod}
          onValueChange={(v) =>
            set("deliveryMethod", v as typeof form.deliveryMethod)
          }
        >
          <SelectTrigger data-testid="select-pudo-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None (partner pulls)</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="sftp">SFTP</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {form.deliveryMethod === "email" && (
        <div className="space-y-1">
          <Label className="text-xs">Manifest recipient(s) — comma-separated</Label>
          <Input
            value={form.manifestEmail}
            onChange={(e) => set("manifestEmail", e.target.value)}
            data-testid="input-pudo-manifest-email"
            placeholder="ops@partner.example,manifests@partner.example"
          />
        </div>
      )}

      {form.deliveryMethod === "sftp" && (
        <div className="space-y-3 rounded-md border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            Secrets are referenced by environment-variable NAME, not value.
            Add the actual password / private key to the deploy's secret
            store under the name you enter below; this UI never stores secret
            material.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">SFTP host</Label>
              <Input
                value={form.sftpHost}
                onChange={(e) => set("sftpHost", e.target.value)}
                data-testid="input-pudo-sftp-host"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">SFTP port</Label>
              <Input
                type="number"
                value={form.sftpPort}
                onChange={(e) => set("sftpPort", Number(e.target.value) || 22)}
                data-testid="input-pudo-sftp-port"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">SFTP username</Label>
              <Input
                value={form.sftpUsername}
                onChange={(e) => set("sftpUsername", e.target.value)}
                data-testid="input-pudo-sftp-user"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Remote directory</Label>
              <Input
                value={form.sftpRemoteDir}
                onChange={(e) => set("sftpRemoteDir", e.target.value)}
                data-testid="input-pudo-sftp-dir"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Password env var NAME</Label>
              <Input
                value={form.sftpPasswordEnvVar}
                onChange={(e) => set("sftpPasswordEnvVar", e.target.value)}
                data-testid="input-pudo-sftp-pw-env"
                placeholder="PUDO_PAXI_SFTP_PASSWORD"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Private-key env var NAME (wins over password)</Label>
              <Input
                value={form.sftpKeyEnvVar}
                onChange={(e) => set("sftpKeyEnvVar", e.target.value)}
                data-testid="input-pudo-sftp-key-env"
                placeholder="PUDO_PAXI_SFTP_KEY"
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => set("active", e.target.checked)}
          id="pudo-active"
          data-testid="input-pudo-active"
        />
        <Label htmlFor="pudo-active" className="text-sm">Active</Label>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={mutation.isPending}
          data-testid="btn-pudo-save"
        >
          {mutation.isPending ? "Saving…" : isCreate ? "Create partner" : "Save changes"}
        </Button>
      </DialogFooter>
    </div>
  );
}

export default function PudoPage() {
  const [editing, setEditing] = useState<PudoPartner | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listPartners,
    staleTime: 10_000,
  });
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="PUDO partners"
        description="Pickup-and-drop-off carriers and their daily-manifest delivery configuration. Daily CSV manifests are pushed to email or SFTP per-partner; partners with delivery_method='none' continue to pull from /pudo/:code/manifest.csv themselves."
      />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Truck className="h-4 w-4" /> {items.length} partner(s)
        </p>
        <Button onClick={() => setCreating(true)} data-testid="btn-pudo-new">
          <Plus className="mr-2 h-4 w-4" /> Add partner
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          Couldn't load PUDO partners: {(error as Error).message}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    No partners configured yet.
                  </TableCell>
                </TableRow>
              )}
              {items.map((p) => (
                <TableRow key={p.code} data-testid={`row-pudo-${p.code}`}>
                  <TableCell className="font-mono text-xs">{p.code}</TableCell>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>{p.countryCode}</TableCell>
                  <TableCell>
                    <Badge variant={p.deliveryMethod === "none" ? "secondary" : "default"}>
                      {p.deliveryMethod}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.deliveryMethod === "email" && (p.manifestEmail || "—")}
                    {p.deliveryMethod === "sftp" && (p.sftpHost ? `${p.sftpUsername}@${p.sftpHost}:${p.sftpPort}${p.sftpRemoteDir}` : "—")}
                    {p.deliveryMethod === "none" && "—"}
                  </TableCell>
                  <TableCell>
                    {p.active ? (
                      <Badge variant="outline">active</Badge>
                    ) : (
                      <Badge variant="secondary">disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(p)}
                      data-testid={`btn-edit-pudo-${p.code}`}
                    >
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={(o) => !o && setCreating(false)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add PUDO partner</DialogTitle>
          </DialogHeader>
          {creating && (
            <PartnerForm
              initial={EMPTY_FORM}
              isCreate
              onClose={() => setCreating(false)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          {editing && (
            <PartnerForm
              initial={{
                code: editing.code,
                name: editing.name,
                countryCode: editing.countryCode,
                contactEmail: editing.contactEmail,
                active: editing.active,
                manifestTimezone: editing.manifestTimezone,
                deliveryMethod: editing.deliveryMethod,
                manifestEmail: editing.manifestEmail,
                sftpHost: editing.sftpHost,
                sftpPort: editing.sftpPort,
                sftpUsername: editing.sftpUsername,
                sftpPasswordEnvVar: editing.sftpPasswordEnvVar,
                sftpKeyEnvVar: editing.sftpKeyEnvVar,
                sftpRemoteDir: editing.sftpRemoteDir,
              }}
              isCreate={false}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
