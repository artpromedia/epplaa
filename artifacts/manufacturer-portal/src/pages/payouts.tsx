import { useEffect, useState } from "react";
import {
  ApiError,
  listManufacturerPayouts,
  type ManufacturerPayout,
} from "@workspace/api-client-react";
import { formatMinor } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";

export default function PayoutsPage() {
  const [items, setItems] = useState<ManufacturerPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let alive = true;
    listManufacturerPayouts()
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
              Payouts open up once your manufacturer application is approved.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const total = items.reduce(
    (acc, p) => acc + (p.status === "paid" ? p.amountMinor : 0),
    0,
  );
  const ccy = items[0]?.currencyCode ?? "USD";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Payouts</h1>
          <p className="text-sm text-muted-foreground">
            Wholesale payouts in your origin currency, settled via Flutterwave international rail.
          </p>
        </div>
        {items.length > 0 && (
          <Card>
            <CardContent className="px-4 py-2">
              <p className="text-[11px] text-muted-foreground">Paid to date</p>
              <p className="text-lg font-semibold">{formatMinor(total, ccy)}</p>
            </CardContent>
          </Card>
        )}
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
            <p className="text-sm text-muted-foreground p-4">
              No payouts yet. They will appear here once your first wholesale order is delivered and
              fully released from bonded warehouse.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Reference</th>
                  <th className="text-left px-4 py-2 font-medium">Amount</th>
                  <th className="text-left px-4 py-2 font-medium">Requested</th>
                  <th className="text-left px-4 py-2 font-medium">Paid</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="border-b last:border-b-0">
                    <td className="px-4 py-2 font-mono text-xs">{p.reference ?? p.id}</td>
                    <td className="px-4 py-2">{formatMinor(p.amountMinor, p.currencyCode)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {new Date(p.requestedAtIso).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {p.paidAtIso ? new Date(p.paidAtIso).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge value={p.status} />
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
