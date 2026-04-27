import { Link, useParams } from "wouter";
import {
  Package,
  MapPin,
  Truck,
  Clock,
  Copy,
  ShieldCheck,
  CheckCircle2,
  X,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useOrders } from "@/lib/orders-context";
import { formatOrderPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";
import { statusColorClass, relativeDate } from "./orders";

export default function OrderDetail() {
  const { orderId } = useParams<{ orderId: string }>();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { getById, cancel } = useOrders();
  const { toast } = useToast();
  const order = getById(orderId);

  if (!order) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Order" backHref="/orders" />
        <div className="px-4 py-8 text-center">
          <p className={isDark ? "text-white/55" : "text-stone-500"}>
            Order not found.
          </p>
        </div>
      </div>
    );
  }

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  const isPickup =
    !!order.fulfillment.locationId ||
    order.fulfillment.optionId.includes("box") ||
    order.fulfillment.optionId.includes("locker") ||
    order.fulfillment.optionId.includes("pudo") ||
    order.fulfillment.optionId.includes("pickup");
  const isHome = !!order.fulfillment.deliveryAddress;
  const Icon = isPickup ? (order.fulfillment.optionId.includes("box") ? Package : MapPin) : Truck;

  const canCancel = order.status === "placed" || order.status === "ready_for_pickup" || order.status === "out_for_delivery";

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Order" backHref="/orders" />
      <div className="px-4 pb-24 space-y-4">
        <div>
          <p
            className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${statusColorClass(
              order.status,
              isDark,
            )}`}
            data-testid="text-status"
          >
            {order.status.replace(/_/g, " ")}
          </p>
          <h1 className="text-xl font-black mt-2 font-mono">{order.id}</h1>
          <p className={`text-xs ${subtle}`}>
            Placed {relativeDate(order.createdAtIso)}
          </p>
        </div>

        {order.pickupOTP && order.status !== "delivered" && order.status !== "cancelled" && (
          <div
            className={`rounded-2xl p-4 border-2 ${
              isDark
                ? "border-[#FF8855]/40 bg-[#FF8855]/10"
                : "border-[#E6502E]/40 bg-[#E6502E]/10"
            }`}
            data-testid="otp-card"
          >
            <div className="flex items-center justify-between mb-2">
              <p
                className={`text-[11px] font-bold uppercase tracking-wider ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              >
                Pickup OTP
              </p>
              <ShieldCheck
                className={`w-4 h-4 ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              />
            </div>
            <div className="flex items-center justify-between">
              <p
                className={`text-4xl font-black tracking-[0.4em] ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              >
                {order.pickupOTP}
              </p>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(order.pickupOTP!);
                  toast({ title: "OTP copied" });
                }}
                className={`p-2 rounded-full ${
                  isDark
                    ? "bg-white/10 hover:bg-white/20"
                    : "bg-white hover:bg-stone-100"
                }`}
                data-testid="button-copy-otp"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            <p className={`text-xs mt-2 ${subtle}`}>
              Show this 4-digit code at the pickup point.
            </p>
          </div>
        )}

        <div className={`rounded-xl border p-4 ${cardBorder}`}>
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                isDark
                  ? "bg-[#5BA3F5]/20 text-[#5BA3F5]"
                  : "bg-[#1B2A4A]/10 text-[#1B2A4A]"
              }`}
            >
              <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <p className="font-bold">{order.fulfillment.optionLabel}</p>
              {order.fulfillment.locationName && (
                <>
                  <p className="text-sm">{order.fulfillment.locationName}</p>
                  <p className={`text-xs ${subtle}`}>
                    {order.fulfillment.locationAddress}
                  </p>
                </>
              )}
              {isHome && order.fulfillment.deliveryAddress && (
                <>
                  <p className="text-sm">{order.fulfillment.deliveryAddress.label}</p>
                  <p className={`text-xs ${subtle}`}>
                    {order.fulfillment.deliveryAddress.street},{" "}
                    {order.fulfillment.deliveryAddress.area},{" "}
                    {order.fulfillment.deliveryAddress.city}
                  </p>
                  {order.fulfillment.deliveryAddress.notes && (
                    <p className={`text-xs italic mt-1 ${subtle}`}>
                      Note: {order.fulfillment.deliveryAddress.notes}
                    </p>
                  )}
                </>
              )}
              <div
                className={`flex items-center gap-1 mt-1 text-xs ${subtle}`}
              >
                <Clock className="w-3 h-3" /> ETA {order.etaLabel}
              </div>
            </div>
          </div>
        </div>

        <div className={`rounded-xl border overflow-hidden ${cardBorder}`}>
          <p
            className={`text-xs font-bold uppercase tracking-wider px-4 pt-3 pb-1 ${subtle}`}
          >
            Items
          </p>
          {order.items.map((it, i) => (
            <Link
              key={it.productId + i}
              href={`/product/${it.productId}`}
              className={`flex gap-3 p-3 ${
                i < order.items.length - 1
                  ? isDark
                    ? "border-b border-white/10"
                    : "border-b border-stone-200"
                  : ""
              }`}
            >
              {it.image && (
                <div className="w-12 h-12 rounded-md overflow-hidden bg-stone-200 shrink-0">
                  <img
                    src={it.image}
                    alt={it.title}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold leading-snug line-clamp-2">
                  {it.title}
                </p>
                <p className={`text-xs mt-0.5 ${subtle}`}>
                  Qty {it.qty} · {formatOrderPrice(it.priceMinor, order.countryCode, country)}
                </p>
              </div>
              <p className="text-sm font-bold shrink-0">
                {formatOrderPrice(it.priceMinor * it.qty, order.countryCode, country)}
              </p>
            </Link>
          ))}
        </div>

        <div className={`rounded-xl border p-4 space-y-2 ${cardBorder}`}>
          <p
            className={`text-xs font-bold uppercase tracking-wider ${subtle}`}
          >
            Totals
          </p>
          <Row
            label="Subtotal"
            value={formatOrderPrice(order.totalsMinor.subtotal, order.countryCode, country)}
            subtle={subtle}
          />
          <Row
            label="Shipping"
            value={
              order.totalsMinor.shipping === 0
                ? "FREE"
                : formatOrderPrice(order.totalsMinor.shipping, order.countryCode, country)
            }
            subtle={subtle}
          />
          <div
            className={`pt-2 border-t flex items-center justify-between ${
              isDark ? "border-white/10" : "border-stone-200"
            }`}
          >
            <span className="font-bold">Total</span>
            <span className="text-lg font-black">
              {formatOrderPrice(order.totalsMinor.total, order.countryCode, country)}
            </span>
          </div>
          <p className={`text-[11px] ${subtle}`}>
            Paid via {order.payment.methodLabel}
          </p>
        </div>

        <div className={`rounded-xl border p-4 ${cardBorder}`}>
          <p
            className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
          >
            Notifications
          </p>
          <ul className={`text-xs space-y-1 ${subtle}`}>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              Push (always on)
            </li>
            {order.notificationPrefs.whatsapp && (
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                WhatsApp{" "}
                {order.notificationPrefs.whatsappNumber
                  ? `· ${order.notificationPrefs.whatsappNumber}`
                  : ""}
              </li>
            )}
            {order.notificationPrefs.sms && (
              <li className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                SMS{" "}
                {order.notificationPrefs.smsNumber
                  ? `· ${order.notificationPrefs.smsNumber}`
                  : ""}
              </li>
            )}
          </ul>
        </div>

        {canCancel && (
          <button
            onClick={() => {
              cancel(order.id);
              toast({ title: "Order cancelled" });
            }}
            className={`w-full h-12 rounded-xl border font-bold flex items-center justify-center gap-2 ${
              isDark
                ? "border-[#FF8855]/40 text-[#FF8855] hover:bg-[#FF8855]/10"
                : "border-[#E6502E]/40 text-[#E6502E] hover:bg-[#E6502E]/10"
            }`}
            data-testid="button-cancel-order"
          >
            <X className="w-4 h-4" /> Cancel order
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  subtle,
}: {
  label: string;
  value: string;
  subtle: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={subtle}>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
