import { Link } from "wouter";
import { Package, Clock, ShoppingBag, ChevronRight } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useOrders, OrderStatus } from "@/lib/orders-context";
import { formatOrderPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "Placed",
  ready_for_pickup: "Ready for pickup",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function Orders() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { orders } = useOrders();

  const subtle = isDark ? "text-white/55" : "text-stone-500";

  if (orders.length === 0) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="My orders" />
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
              isDark
                ? "bg-white/5 text-white/30"
                : "bg-stone-300/35 text-stone-400"
            }`}
          >
            <ShoppingBag className="w-10 h-10" />
          </div>
          <h2 className="text-lg font-bold mb-2">No orders yet</h2>
          <p className={`text-sm ${subtle}`}>
            When you check out, your orders show up here.
          </p>
          <Link
            href="/discover"
            data-testid="link-discover-from-empty-orders"
            className={`mt-6 px-6 py-2 rounded-full font-bold text-sm ${
              isDark
                ? "bg-[#5BA3F5] text-black"
                : "bg-[#1B2A4A] text-white"
            }`}
          >
            Start shopping
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="My orders" />
      <div className="px-4 pb-24 space-y-3">
        {orders.map((o) => {
          const isPickup =
            o.fulfillment.optionId.includes("box") ||
            o.fulfillment.optionId.includes("locker") ||
            o.fulfillment.optionId.includes("pudo") ||
            o.fulfillment.optionId.includes("pickup") ||
            o.fulfillment.optionId.includes("paxi") ||
            o.fulfillment.optionId.includes("speedaf") ||
            o.fulfillment.optionId.includes("g4s");
          const statusColor = statusColorClass(o.status, isDark);
          return (
            <Link
              key={o.id}
              href={`/orders/${o.id}`}
              data-testid={`order-${o.id}`}
              className={`block rounded-xl border p-4 transition-colors ${
                isDark
                  ? "bg-white/5 border-white/10 hover:bg-white/10"
                  : "bg-white border-stone-400/35 hover:bg-stone-50"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${statusColor}`}
                >
                  {STATUS_LABEL[o.status]}
                </span>
                <p className={`text-xs ${subtle}`}>{relativeDate(o.createdAtIso)}</p>
              </div>
              <p className="font-bold text-sm">
                {o.items.length} item{o.items.length === 1 ? "" : "s"} · {formatOrderPrice(o.totalsMinor.total, o.countryCode, country)}
              </p>
              <div className="flex items-center justify-between mt-2">
                <div className={`flex items-center gap-2 text-xs ${subtle}`}>
                  {isPickup ? (
                    <Package className="w-3.5 h-3.5" />
                  ) : (
                    <Clock className="w-3.5 h-3.5" />
                  )}
                  <span className="truncate max-w-[200px]">
                    {o.fulfillment.locationName ??
                      o.fulfillment.optionLabel}
                  </span>
                </div>
                {o.pickupOTP && (
                  <span
                    className={`text-[10px] font-mono font-bold ${
                      isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                    }`}
                  >
                    OTP {o.pickupOTP}
                  </span>
                )}
                <ChevronRight
                  className={`w-4 h-4 ${
                    isDark ? "text-white/30" : "text-stone-400"
                  }`}
                />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function statusColorClass(status: OrderStatus, isDark: boolean): string {
  switch (status) {
    case "delivered":
      return isDark
        ? "bg-emerald-500/15 text-emerald-300"
        : "bg-emerald-500/10 text-emerald-700";
    case "cancelled":
      return isDark
        ? "bg-stone-500/20 text-stone-300"
        : "bg-stone-500/10 text-stone-600";
    case "out_for_delivery":
      return isDark
        ? "bg-[#FF8855]/15 text-[#FF8855]"
        : "bg-[#E6502E]/10 text-[#E6502E]";
    case "ready_for_pickup":
      return isDark
        ? "bg-[#5BA3F5]/15 text-[#5BA3F5]"
        : "bg-[#1B2A4A]/10 text-[#1B2A4A]";
    default:
      return isDark
        ? "bg-white/10 text-white/70"
        : "bg-stone-200 text-stone-700";
  }
}

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}
