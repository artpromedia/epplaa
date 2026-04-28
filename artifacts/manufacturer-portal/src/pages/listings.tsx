import { useEffect, useState } from "react";
import { manufacturerApi, type ManufacturerListing, formatMinor } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";
import { Trash2, Pencil, Plus } from "lucide-react";

const ORIGIN_CURRENCIES = ["USD", "CNY", "VND", "JPY", "TWD"];
const CATEGORIES = [
  "Apparel",
  "Footwear",
  "Electronics",
  "Beauty",
  "Home goods",
  "Accessories",
  "Other",
];

type FormState = {
  id?: string;
  sku: string;
  title: string;
  description: string;
  hsCode: string;
  originCurrencyCode: string;
  wholesalePriceMinor: number;
  moq: number;
  leadDays: number;
  weightGrams: number;
  category: string;
  status: ManufacturerListing["status"];
  imagesText: string;
};

const EMPTY: FormState = {
  sku: "",
  title: "",
  description: "",
  hsCode: "",
  originCurrencyCode: "USD",
  wholesalePriceMinor: 0,
  moq: 1,
  leadDays: 14,
  weightGrams: 0,
  category: "Other",
  status: "active",
  imagesText: "",
};

export default function ListingsPage() {
  const [items, setItems] = useState<ManufacturerListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function refresh() {
    try {
      const rows = await manufacturerApi.listListings();
      setItems(rows);
      setForbidden(false);
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 403) setForbidden(true);
      else setError(err.message);
    }
  }

  useEffect(() => {
    let alive = true;
    refresh().finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  function startCreate() {
    setEditing({ ...EMPTY });
    setError(null);
  }

  function startEdit(item: ManufacturerListing) {
    setEditing({
      id: item.id,
      sku: item.sku,
      title: item.title,
      description: item.description,
      hsCode: item.hsCode,
      originCurrencyCode: item.originCurrencyCode,
      wholesalePriceMinor: item.wholesalePriceMinor,
      moq: item.moq,
      leadDays: item.leadDays,
      weightGrams: item.weightGrams,
      category: item.category,
      status: item.status,
      imagesText: (item.images ?? []).join("\n"),
    });
    setError(null);
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this listing? This cannot be undone.")) return;
    try {
      await manufacturerApi.deleteListing(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSubmitting(true);
    setError(null);
    const payload = {
      sku: editing.sku,
      title: editing.title,
      description: editing.description,
      hsCode: editing.hsCode,
      originCurrencyCode: editing.originCurrencyCode,
      wholesalePriceMinor: Math.round(editing.wholesalePriceMinor),
      moq: Math.max(1, editing.moq),
      leadDays: Math.max(0, editing.leadDays),
      weightGrams: Math.max(0, editing.weightGrams),
      category: editing.category,
      status: editing.status,
      images: editing.imagesText
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      if (editing.id) {
        await manufacturerApi.updateListing(editing.id, payload);
      } else {
        await manufacturerApi.createListing(payload);
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (forbidden) {
    return (
      <div className="max-w-xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approval required</CardTitle>
            <CardDescription>
              Wholesale listings open up once your manufacturer application is approved. Finish KYC
              to speed up review.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Wholesale catalog</h1>
          <p className="text-sm text-muted-foreground">
            Listings priced in your origin currency. Buyers see Naira after FX, freight, duty, and VAT.
          </p>
        </div>
        <Button onClick={startCreate}>
          <Plus className="w-4 h-4 mr-1" /> New listing
        </Button>
      </header>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-sm rounded-md p-3">
          {error}
        </div>
      )}

      {editing && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editing.id ? "Edit listing" : "New listing"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    required
                    value={editing.title}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sku">SKU</Label>
                  <Input
                    id="sku"
                    value={editing.sku}
                    onChange={(e) => setEditing({ ...editing, sku: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="hsCode">HS code</Label>
                  <Input
                    id="hsCode"
                    required
                    placeholder="e.g. 6204.62"
                    value={editing.hsCode}
                    onChange={(e) => setEditing({ ...editing, hsCode: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="originCurrencyCode">Origin currency</Label>
                  <Select
                    value={editing.originCurrencyCode}
                    onValueChange={(v) => setEditing({ ...editing, originCurrencyCode: v })}
                  >
                    <SelectTrigger id="originCurrencyCode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORIGIN_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wholesalePriceMinor">Wholesale price (minor units)</Label>
                  <Input
                    id="wholesalePriceMinor"
                    type="number"
                    min={1}
                    required
                    value={editing.wholesalePriceMinor}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        wholesalePriceMinor: Number(e.target.value || 0),
                      })
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Cents/fen/sen — 100 USD = 10000.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="moq">MOQ</Label>
                  <Input
                    id="moq"
                    type="number"
                    min={1}
                    value={editing.moq}
                    onChange={(e) => setEditing({ ...editing, moq: Number(e.target.value || 1) })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="leadDays">Lead time (days)</Label>
                  <Input
                    id="leadDays"
                    type="number"
                    min={0}
                    value={editing.leadDays}
                    onChange={(e) =>
                      setEditing({ ...editing, leadDays: Number(e.target.value || 0) })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="weightGrams">Weight (g)</Label>
                  <Input
                    id="weightGrams"
                    type="number"
                    min={0}
                    value={editing.weightGrams}
                    onChange={(e) =>
                      setEditing({ ...editing, weightGrams: Number(e.target.value || 0) })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="category">Category</Label>
                  <Select
                    value={editing.category}
                    onValueChange={(v) => setEditing({ ...editing, category: v })}
                  >
                    <SelectTrigger id="category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="status">Status</Label>
                  <Select
                    value={editing.status}
                    onValueChange={(v) =>
                      setEditing({ ...editing, status: v as FormState["status"] })
                    }
                  >
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                      <SelectItem value="draft">Draft</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    rows={3}
                    value={editing.description}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="imagesText">Image URLs (one per line)</Label>
                  <Textarea
                    id="imagesText"
                    rows={2}
                    placeholder="https://…"
                    value={editing.imagesText}
                    onChange={(e) => setEditing({ ...editing, imagesText: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving…" : editing.id ? "Update listing" : "Create listing"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your catalog</CardTitle>
          <CardDescription>{items.length} listing{items.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="text-sm text-muted-foreground p-4">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">
              No listings yet. Create your first wholesale SKU.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Title</th>
                  <th className="text-left px-4 py-2 font-medium">HS</th>
                  <th className="text-left px-4 py-2 font-medium">Price</th>
                  <th className="text-left px-4 py-2 font-medium">MOQ</th>
                  <th className="text-left px-4 py-2 font-medium">Lead</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-b last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="font-medium truncate max-w-xs">{it.title}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {it.sku || "no sku"} · {it.category}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{it.hsCode}</td>
                    <td className="px-4 py-2">{formatMinor(it.wholesalePriceMinor, it.originCurrencyCode)}</td>
                    <td className="px-4 py-2">{it.moq}</td>
                    <td className="px-4 py-2">{it.leadDays}d</td>
                    <td className="px-4 py-2">
                      <StatusBadge value={it.status} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1 justify-end">
                        <Button size="sm" variant="ghost" onClick={() => startEdit(it)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onDelete(it.id)}>
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
