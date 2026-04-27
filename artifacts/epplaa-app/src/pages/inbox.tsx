import { useState } from "react";
import { Link } from "wouter";
import { MessageSquare, Package, ShoppingBag, ChevronRight } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useOrders } from "@/lib/orders-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { formatOrderPrice } from "@/lib/format";
import { statusColorClass, relativeDate } from "./orders";

const STATUS_LABEL = {
  placed: "Placed",
  ready_for_pickup: "Ready for pickup",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
} as const;

export default function Inbox() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { orders } = useOrders();
  const [tab, setTab] = useState<"messages" | "orders">(
    orders.length > 0 ? "orders" : "messages",
  );

  const subtle = isDark ? "text-white/55" : "text-stone-500";

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark
            ? "bg-[#0F1525] border-b border-white/10"
            : "bg-[#fbeed3] border-b border-stone-400/35"
        }`}
      >
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold">Inbox</h1>
          <ThemeToggle />
        </div>
        <div className="flex gap-4">
          <button
            onClick={() => setTab("messages")}
            data-testid="tab-messages"
            className={`pb-2 border-b-2 font-bold ${
              tab === "messages"
                ? isDark
                  ? "border-[#5BA3F5] text-white"
                  : "border-[#1B2A4A] text-stone-900"
                : `border-transparent ${
                    isDark
                      ? "text-white/50 hover:text-white"
                      : "text-stone-500 hover:text-stone-900"
                  }`
            }`}
          >
            Messages
          </button>
          <button
            onClick={() => setTab("orders")}
            data-testid="tab-orders"
            className={`pb-2 border-b-2 font-bold flex items-center gap-1.5 ${
              tab === "orders"
                ? isDark
                  ? "border-[#5BA3F5] text-white"
                  : "border-[#1B2A4A] text-stone-900"
                : `border-transparent ${
                    isDark
                      ? "text-white/50 hover:text-white"
                      : "text-stone-500 hover:text-stone-900"
                  }`
            }`}
          >
            Orders
            {orders.length > 0 && (
              <span
                className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black flex items-center justify-center ${
                  isDark
                    ? "bg-[#FF8855] text-black"
                    : "bg-[#E6502E] text-white"
                }`}
              >
                {orders.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {tab === "messages" ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div
            className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
              isDark
                ? "bg-white/5 text-white/30"
                : "bg-stone-300/35 text-stone-400"
            }`}
          >
            <MessageSquare className="w-10 h-10" />
          </div>
          <h2 className="text-lg font-bold mb-2">No messages yet</h2>
          <p className={`text-sm ${subtle}`}>
            When you contact sellers or receive updates, they'll appear here.
          </p>
          <Link
            href="/discover"
            data-testid="link-discover-from-inbox"
            className={`mt-6 px-6 py-2 rounded-full font-bold text-sm ${
              isDark
                ? "bg-[#5BA3F5] text-black hover:bg-[#3D7BC4]"
                : "bg-[#1B2A4A] text-white hover:bg-[#0F1E3A]"
            }`}
          >
            Start Shopping
          </Link>
        </div>
      ) : orders.length === 0 ? (
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
            Once you check out, your orders show up here.
          </p>
          <Link
            href="/discover"
            data-testid="link-discover-from-orders-tab"
            className={`mt-6 px-6 py-2 rounded-full font-bold text-sm ${
              isDark
                ? "bg-[#5BA3F5] text-black hover:bg-[#3D7BC4]"
                : "bg-[#1B2A4A] text-white hover:bg-[#0F1E3A]"
            }`}
          >
            Start Shopping
          </Link>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {orders.map((o) => (
            <Link
              key={o.id}
              href={`/orders/${o.id}`}
              data-testid={`inbox-order-${o.id}`}
              className={`block rounded-xl border p-4 transition-colors ${
                isDark
                  ? "bg-white/5 border-white/10 hover:bg-white/10"
                  : "bg-white border-stone-400/35 hover:bg-stone-50"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${statusColorClass(
                    o.status,
                    isDark,
                  )}`}
                >
                  {STATUS_LABEL[o.status]}
                </span>
                <p className={`text-xs ${subtle}`}>
                  {relativeDate(o.createdAtIso)}
                </p>
              </div>
              <p className="font-bold text-sm">
                {o.items.length} item{o.items.length === 1 ? "" : "s"} ·{" "}
                {formatOrderPrice(o.totalsMinor.total, o.countryCode, country)}
              </p>
              <div className="flex items-center justify-between mt-2">
                <div
                  className={`flex items-center gap-2 text-xs min-w-0 ${subtle}`}
                >
                  <Package className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {o.fulfillment.locationName ?? o.fulfillment.optionLabel}
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
          ))}
        </div>
      )}
    </div>
  );
}
