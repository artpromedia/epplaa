import { Link, useParams } from "wouter";
import {
  CheckCircle2,
  Package,
  MapPin,
  Truck,
  Clock,
  Copy,
  ShieldCheck,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useOrders } from "@/lib/orders-context";
import { formatOrderPrice } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

export default function CheckoutSuccess() {
  const { orderId } = useParams<{ orderId: string }>();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { getById } = useOrders();
  const { toast } = useToast();
  const order = getById(orderId);

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <p className="font-bold mb-2">Order not found.</p>
        <Link
          href="/orders"
          className={`mt-3 px-4 py-2 rounded-full font-bold text-sm ${
            isDark
              ? "bg-[#5BA3F5] text-black"
              : "bg-[#1B2A4A] text-white"
          }`}
        >
          See your orders
        </Link>
      </div>
    );
  }

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  function pickupIcon() {
    if (order!.fulfillment.optionId.includes("box") || order!.fulfillment.optionId.includes("locker")) return Package;
    if (order!.fulfillment.deliveryAddress) return Truck;
    return MapPin;
  }
  const Icon = pickupIcon();

  return (
    <div className="flex flex-col h-full w-full">
      <div className="px-4 pt-12 pb-32 overflow-y-auto">
        <div className="flex flex-col items-center text-center mb-6">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center mb-3 ${
              isDark
                ? "bg-[#5BA3F5]/20 text-[#5BA3F5]"
                : "bg-[#1B2A4A]/15 text-[#1B2A4A]"
            }`}
          >
            <CheckCircle2 className="w-12 h-12" />
          </div>
          <h1 className="text-2xl font-black">Order placed!</h1>
          <p className={`text-sm mt-1 ${subtle}`}>
            We'll keep you posted via push, WhatsApp, and SMS where you opted in.
          </p>
          <p className={`text-[11px] font-bold uppercase tracking-wider mt-2 ${subtle}`}>
            Order
          </p>
          <p className="text-base font-mono font-bold" data-testid="text-order-id">
            {order.id}
          </p>
        </div>

        {order.pickupOTP && (
          <div
            className={`rounded-2xl p-4 mb-4 border-2 ${
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
              Show this code at the pickup point. Don't share it with anyone
              else.
            </p>
          </div>
        )}

        <div className={`rounded-xl border p-4 mb-4 ${cardBorder}`}>
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
              {order.fulfillment.deliveryAddress && (
                <p className={`text-xs ${subtle}`}>
                  {order.fulfillment.deliveryAddress.street},{" "}
                  {order.fulfillment.deliveryAddress.area},{" "}
                  {order.fulfillment.deliveryAddress.city}
                </p>
              )}
              <div
                className={`flex items-center gap-1 mt-1 text-xs ${subtle}`}
              >
                <Clock className="w-3 h-3" /> ETA {order.etaLabel}
              </div>
            </div>
          </div>
        </div>

        <div className={`rounded-xl border p-4 mb-4 ${cardBorder}`}>
          <p className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            Order summary
          </p>
          <div className="space-y-1.5 text-sm">
            <Row label="Items" value={`${order.items.length}`} subtle={subtle} />
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
              <span className="font-bold">Total paid</span>
              <span className="text-lg font-black">
                {formatOrderPrice(order.totalsMinor.total, order.countryCode, country)}
              </span>
            </div>
            <p className={`text-[11px] mt-1 ${subtle}`}>
              Paid via {order.payment.methodLabel}
            </p>
          </div>
        </div>
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 backdrop-blur-xl border-t p-4 z-30 flex gap-2 ${
          isDark
            ? "bg-[#0F1525]/95 border-white/10"
            : "bg-[#fbeed3]/95 border-stone-400/55"
        }`}
      >
        <Link
          href="/orders"
          data-testid="link-orders-from-success"
          className={`flex-1 h-12 rounded-xl border font-bold flex items-center justify-center ${
            isDark
              ? "border-white/20 text-white"
              : "border-stone-400 text-stone-900"
          }`}
        >
          See orders
        </Link>
        <Link
          href="/discover"
          data-testid="link-discover-from-success"
          className={`flex-1 h-12 rounded-xl text-white font-bold flex items-center justify-center ${
            isDark
              ? "bg-[#FF8855] hover:bg-[#FF6B35]"
              : "bg-[#E6502E] hover:bg-[#C4441E]"
          }`}
        >
          Keep shopping
        </Link>
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
    <div className="flex items-center justify-between">
      <span className={subtle}>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
