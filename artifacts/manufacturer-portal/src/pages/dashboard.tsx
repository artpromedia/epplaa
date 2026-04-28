import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  manufacturerApi,
  type ManufacturerMeResponse,
  type ManufacturerKyc,
  type ManufacturerListing,
  type WholesaleOrder,
  formatMinor,
} from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight, FileCheck2, Boxes, PackageSearch } from "lucide-react";

export default function DashboardPage() {
  const [me, setMe] = useState<ManufacturerMeResponse | null>(null);
  const [kyc, setKyc] = useState<ManufacturerKyc[]>([]);
  const [listings, setListings] = useState<ManufacturerListing[]>([]);
  const [orders, setOrders] = useState<WholesaleOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const meRes = await manufacturerApi.me();
        if (!alive) return;
        setMe(meRes);
        if (meRes.manufacturer) {
          const [kycRes, listingsRes, ordersRes] = await Promise.allSettled([
            manufacturerApi.listKyc(),
            meRes.status === "approved" ? manufacturerApi.listListings() : Promise.resolve([]),
            meRes.status === "approved" ? manufacturerApi.listOrders() : Promise.resolve([]),
          ]);
          if (!alive) return;
          if (kycRes.status === "fulfilled") setKyc(kycRes.value);
          if (listingsRes.status === "fulfilled") setListings(listingsRes.value as ManufacturerListing[]);
          if (ordersRes.status === "fulfilled") setOrders(ordersRes.value as WholesaleOrder[]);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const status = me?.status ?? "loading";
  const mfr = me?.manufacturer;
  const approvedKyc = kyc.filter((k) => k.status === "approved").length;
  const activeListings = listings.filter((l) => l.status === "active").length;
  const openOrders = orders.filter(
    (o) => o.status !== "delivered" && o.status !== "cancelled",
  ).length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Welcome to Epplaa Manufacturers</h1>
        <p className="text-sm text-muted-foreground">
          Onboard your factory, list wholesale SKUs, and supply African sellers across 16 markets.
        </p>
      </header>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-sm rounded-md p-3">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Account status</CardTitle>
            <CardDescription>
              {status === "none"
                ? "You haven't started a manufacturer application yet."
                : mfr
                  ? `${mfr.legalName} · ${mfr.originCountry}`
                  : "Loading…"}
            </CardDescription>
          </div>
          <StatusBadge value={status} />
        </CardHeader>
        <CardContent>
          {status === "none" && (
            <Link href="/apply">
              <Button>
                Start application <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          )}
          {status === "pending" && (
            <p className="text-sm text-muted-foreground">
              Your application is in review. Upload your KYC documents to speed things up.
            </p>
          )}
          {status === "approved" && (
            <p className="text-sm text-muted-foreground">
              You're approved. Add wholesale listings and start receiving cross-border orders.
            </p>
          )}
          {status === "rejected" && (
            <p className="text-sm text-destructive">
              Your application was declined. Update it under Application and re-submit.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <FileCheck2 className="w-3.5 h-3.5" /> KYC documents
            </CardDescription>
            <CardTitle className="text-2xl">
              {approvedKyc}
              <span className="text-sm font-normal text-muted-foreground"> / {kyc.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Link href="/kyc" className="text-xs text-primary hover:underline">
              Manage documents →
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <Boxes className="w-3.5 h-3.5" /> Active listings
            </CardDescription>
            <CardTitle className="text-2xl">
              {activeListings}
              <span className="text-sm font-normal text-muted-foreground"> / {listings.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Link href="/listings" className="text-xs text-primary hover:underline">
              Manage catalog →
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <PackageSearch className="w-3.5 h-3.5" /> Open orders
            </CardDescription>
            <CardTitle className="text-2xl">{openOrders}</CardTitle>
          </CardHeader>
          <CardContent>
            <Link href="/orders" className="text-xs text-primary hover:underline">
              View orders →
            </Link>
          </CardContent>
        </Card>
      </div>

      {orders.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent orders</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Order</th>
                  <th className="text-left px-4 py-2 font-medium">Qty</th>
                  <th className="text-left px-4 py-2 font-medium">FOB</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 5).map((o) => (
                  <tr key={o.id} className="border-b last:border-b-0">
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link href={`/orders/${o.id}`} className="hover:underline">
                        {o.id.slice(0, 14)}…
                      </Link>
                    </td>
                    <td className="px-4 py-2">{o.qty}</td>
                    <td className="px-4 py-2">{formatMinor(o.fobMinor, o.originCurrencyCode)}</td>
                    <td className="px-4 py-2">
                      <StatusBadge value={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
