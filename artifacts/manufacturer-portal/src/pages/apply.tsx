import { useEffect, useState } from "react";
import { manufacturerApi, type Manufacturer } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/status-badge";

const ORIGIN_COUNTRIES = [
  { code: "VN", label: "Vietnam" },
  { code: "CN", label: "China" },
  { code: "JP", label: "Japan" },
  { code: "TW", label: "Taiwan" },
];

export default function ApplyPage() {
  const [existing, setExisting] = useState<Manufacturer | null>(null);
  const [status, setStatus] = useState<string>("none");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [originCountry, setOriginCountry] = useState("VN");
  const [legalName, setLegalName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [exportLicenceNumber, setExportLicenceNumber] = useState("");
  const [factoryAddress, setFactoryAddress] = useState("");
  const [productCategories, setProductCategories] = useState("");
  const [annualCapacity, setAnnualCapacity] = useState("");

  useEffect(() => {
    let alive = true;
    manufacturerApi
      .me()
      .then((res) => {
        if (!alive) return;
        setStatus(res.status);
        setExisting(res.manufacturer);
        if (res.manufacturer) {
          setOriginCountry(res.manufacturer.originCountry || "VN");
          setLegalName(res.manufacturer.legalName);
          setContactEmail(res.manufacturer.contactEmail);
          setContactPhone(res.manufacturer.contactPhone ?? "");
          setExportLicenceNumber(res.manufacturer.exportLicenceNumber ?? "");
          const app = res.manufacturer.application as Record<string, unknown> | null;
          setFactoryAddress(String((app?.factoryAddress as string) ?? ""));
          setProductCategories(String((app?.productCategories as string) ?? ""));
          setAnnualCapacity(String((app?.annualCapacity as string) ?? ""));
        }
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const finalised = status === "approved" || status === "suspended";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await manufacturerApi.apply({
        originCountry,
        legalName,
        contactEmail,
        contactPhone,
        exportLicenceNumber,
        application: {
          factoryAddress,
          productCategories,
          annualCapacity,
        },
      });
      setStatus(res.status);
      setExisting(res.manufacturer);
      setSuccess(
        existing
          ? "Application updated. We'll review the changes."
          : "Application submitted. We'll review it shortly.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Manufacturer application</h1>
          <p className="text-sm text-muted-foreground">
            Tell us about your factory. We onboard exporters from VN, CN, JP, and TW.
          </p>
        </div>
        <StatusBadge value={status} />
      </header>

      {finalised && (
        <div className="border border-border bg-muted text-muted-foreground text-sm rounded-md p-3">
          Your application is finalised and can no longer be edited from here. Reach out to support
          if you need to update legal details.
        </div>
      )}

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-sm rounded-md p-3">
          {error}
        </div>
      )}
      {success && (
        <div className="border border-emerald-300 bg-emerald-50 text-emerald-900 text-sm rounded-md p-3 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800">
          {success}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Company details</CardTitle>
          <CardDescription>Used for export documents and customs broker filings.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="originCountry">Origin country</Label>
                <Select value={originCountry} onValueChange={setOriginCountry} disabled={finalised}>
                  <SelectTrigger id="originCountry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORIGIN_COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="legalName">Legal company name</Label>
                <Input
                  id="legalName"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  required
                  disabled={finalised}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactEmail">Contact email</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  disabled={finalised}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactPhone">Contact phone</Label>
                <Input
                  id="contactPhone"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  disabled={finalised}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="exportLicenceNumber">Export licence number</Label>
                <Input
                  id="exportLicenceNumber"
                  value={exportLicenceNumber}
                  onChange={(e) => setExportLicenceNumber(e.target.value)}
                  disabled={finalised}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="factoryAddress">Factory address</Label>
                <Textarea
                  id="factoryAddress"
                  value={factoryAddress}
                  onChange={(e) => setFactoryAddress(e.target.value)}
                  disabled={finalised}
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="productCategories">Product categories</Label>
                <Input
                  id="productCategories"
                  placeholder="e.g. Apparel, Footwear"
                  value={productCategories}
                  onChange={(e) => setProductCategories(e.target.value)}
                  disabled={finalised}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="annualCapacity">Annual capacity (units)</Label>
                <Input
                  id="annualCapacity"
                  value={annualCapacity}
                  onChange={(e) => setAnnualCapacity(e.target.value)}
                  disabled={finalised}
                />
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={submitting || finalised}>
                {submitting ? "Saving…" : existing ? "Update application" : "Submit application"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
