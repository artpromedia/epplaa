import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ApiError,
  listManufacturerOrders,
  type WholesaleOrder,
} from "@workspace/api-client-react";
import { formatMinor } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";

export default function OrdersPage() {
  const [items, setItems] = useState<WholesaleOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let alive = true;
    listManufacturerOrders()
      .then((rows) => alive && setItems(rows))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true);
        else setError(e instanceof ApiError ? e.message : (e as Error).message);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (forbidden) {
    return (
      <div className="max-w-xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approval required</CardTitle>
            <CardDescription>
              Cross-border orders flow once your manufacturer application is approved.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Wholesale orders</h1>
        <p className="text-sm text-muted-foreground">
          Orders placed by Epplaa sellers. Mark as shipped once your forwarder picks up.
        </p>
      </header>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-sm rounded-md p-3">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="text-sm text-muted-foreground p-4">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No orders yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Order</th>
                  <th className="text-left px-4 py-2 font-medium">Qty</th>
                  <th className="text-left px-4 py-2 font-medium">FOB</th>
                  <th className="text-left px-4 py-2 font-medium">Landed (NGN equiv)</th>
                  <th className="text-left px-4 py-2 font-medium">Dest</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id} className="border-b last:border-b-0 hover-elevate">
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link href={`/orders/${o.id}`} className="hover:underline">
                        {o.id.slice(0, 18)}…
                      </Link>
                    </td>
                    <td className="px-4 py-2">{o.qty}</td>
                    <td className="px-4 py-2">{formatMinor(o.fobMinor, o.originCurrencyCode)}</td>
                    <td className="px-4 py-2">
                      {formatMinor(o.landedTotalMinor, o.destinationCurrencyCode)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{o.destinationCountryCode}</td>
                    <td className="px-4 py-2">
                      <StatusBadge value={o.status} />
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
