import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  ApiError,
  getManufacturerOrder,
  shipManufacturerOrder,
  type ManufacturerOrderDetail,
} from "@workspace/api-client-react";
import { formatMinor } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { ArrowLeft, Truck } from "lucide-react";

export default function OrderDetailPage() {
  const [, params] = useRoute("/orders/:orderId");
  const orderId = params?.orderId;
  const [detail, setDetail] = useState<ManufacturerOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shipping, setShipping] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  async function refresh() {
    if (!orderId) return;
    try {
      const res = await getManufacturerOrder(orderId);
      setDetail(res);
      setForbidden(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  useEffect(() => {
    let alive = true;
    refresh().finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [orderId]);

  async function onShip() {
    if (!orderId) return;
    setShipping(true);
    try {
      await shipManufacturerOrder(orderId);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setShipping(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (forbidden) {
    return (
      <div className="max-w-xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approval required</CardTitle>
            <CardDescription>
              You need an approved manufacturer profile to view cross-border orders.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  if (error)
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-sm rounded-md p-3">
        {error}
      </div>
    );
  if (!detail) return <p className="text-sm text-muted-foreground">Not found.</p>;

  const { order, events, booking } = detail;
  const canShip = order.status === "booked";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link href="/orders" className="inline-flex items-center text-xs text-muted-foreground hover:underline">
        <ArrowLeft className="w-3 h-3 mr-1" /> Back to orders
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold font-mono">{order.id}</h1>
          <p className="text-sm text-muted-foreground">
            {order.qty} units · destined for {order.destinationCountryCode}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge value={order.status} />
          {canShip && (
            <Button onClick={onShip} disabled={shipping}>
              <Truck className="w-4 h-4 mr-1" /> {shipping ? "Marking…" : "Mark shipped"}
            </Button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Landed cost</CardTitle>
            <CardDescription>
              FX rate {order.fxRate.toFixed(4)} · {order.originCurrencyCode} → {order.destinationCurrencyCode}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="text-sm space-y-1.5">
              <Row label="FOB" value={formatMinor(order.fobMinor, order.originCurrencyCode)} muted />
              <Row label="Freight" value={formatMinor(order.freightMinor, order.destinationCurrencyCode)} />
              <Row label="Insurance" value={formatMinor(order.insuranceMinor, order.destinationCurrencyCode)} />
              <Row label="Duty" value={formatMinor(order.dutyMinor, order.destinationCurrencyCode)} />
              <Row label="VAT" value={formatMinor(order.vatMinor, order.destinationCurrencyCode)} />
              <Row label="Clearance" value={formatMinor(order.clearanceMinor, order.destinationCurrencyCode)} />
              <div className="border-t pt-1.5 mt-1.5">
                <Row
                  label="Landed total"
                  value={formatMinor(order.landedTotalMinor, order.destinationCurrencyCode)}
                  bold
                />
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Freight booking</CardTitle>
            <CardDescription>
              {booking ? `${booking.forwarder} · ${booking.mode}` : "No booking yet"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {booking ? (
              <dl className="text-sm space-y-1.5">
                <Row label="Reference" value={booking.ref ?? "—"} mono />
                <Row label="From port" value={booking.originPort ?? "—"} />
                <Row label="To port" value={booking.destinationPort ?? "—"} />
                <Row label="ETA" value={booking.etaIso?.slice(0, 10) ?? "—"} />
                <Row label="Actual" value={booking.actualEtaIso?.slice(0, 10) ?? "—"} />
                <Row label="Status" value={booking.status} />
                {booking.costMinor !== null && booking.currencyCode && (
                  <Row label="Cost" value={formatMinor(booking.costMinor, booking.currencyCode)} />
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Freight booking is created automatically when the order is placed.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customs &amp; logistics timeline</CardTitle>
          <CardDescription>
            Combined feed of forwarder, broker, and bonded-warehouse events.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="space-y-3">
              {events.map((ev) => (
                <li key={ev.id} className="flex gap-3">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-primary shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{ev.kind.replace(/_/g, " ")}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(ev.createdAtIso).toLocaleString()}
                      </span>
                    </div>
                    {ev.note && <p className="text-xs text-muted-foreground">{ev.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
  mono,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={[
          bold ? "font-semibold" : "",
          muted ? "text-muted-foreground" : "",
          mono ? "font-mono text-xs" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
