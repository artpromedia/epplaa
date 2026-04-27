import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  MessageSquare,
  Package,
  ShoppingBag,
  ChevronRight,
  Sparkles,
  Bell,
  Radio,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useOrders } from "@/lib/orders-context";
import { useFollows } from "@/lib/follows-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { formatOrderPrice } from "@/lib/format";
import { statusColorClass, relativeDate } from "./orders";
import { generateDropAlerts } from "@/lib/drop-alerts";

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
  const { followedSellers } = useFollows();
  const drops = useMemo(
    () => generateDropAlerts(followedSellers),
    [followedSellers],
  );
  const [tab, setTab] = useState<"drops" | "orders" | "messages">(
    drops.length > 0
      ? "drops"
      : orders.length > 0
        ? "orders"
        : "messages",
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
          <TabButton
            label="Drops"
            count={drops.length}
            active={tab === "drops"}
            onClick={() => setTab("drops")}
            isDark={isDark}
            testId="tab-drops"
          />
          <TabButton
            label="Orders"
            count={orders.length}
            active={tab === "orders"}
            onClick={() => setTab("orders")}
            isDark={isDark}
            testId="tab-orders"
          />
          <TabButton
            label="Messages"
            count={0}
            active={tab === "messages"}
            onClick={() => setTab("messages")}
            isDark={isDark}
            testId="tab-messages"
          />
        </div>
      </div>

      {tab === "drops" ? (
        drops.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div
              className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
                isDark
                  ? "bg-white/5 text-white/30"
                  : "bg-stone-300/35 text-stone-400"
              }`}
            >
              <Bell className="w-10 h-10" />
            </div>
            <h2 className="text-lg font-bold mb-2">No drop alerts yet</h2>
            <p className={`text-sm ${subtle}`}>
              Follow your favorite sellers from any product page to get notified
              when they drop something new.
            </p>
            <Link
              href="/discover"
              data-testid="link-discover-from-drops"
              className={`mt-6 px-6 py-2 rounded-full font-bold text-sm ${
                isDark
                  ? "bg-[#5BA3F5] text-black hover:bg-[#3D7BC4]"
                  : "bg-[#1B2A4A] text-white hover:bg-[#0F1E3A]"
              }`}
            >
              Discover sellers
            </Link>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {drops.map((d) => {
              const isLive = d.kind === "live";
              return (
                <Link
                  key={d.id}
                  href={d.href}
                  data-testid={`drop-${d.id}`}
                  className={`flex gap-3 p-3 rounded-xl border transition-colors ${
                    isDark
                      ? "bg-white/5 border-white/10 hover:bg-white/10"
                      : "bg-white border-stone-400/35 hover:bg-stone-50"
                  }`}
                >
                  <div className="w-12 h-12 rounded-full overflow-hidden bg-stone-200 shrink-0 relative">
                    {d.hostAvatar ? (
                      <img
                        src={d.hostAvatar}
                        alt={d.sellerName}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div
                        className={`w-full h-full flex items-center justify-center text-sm font-bold ${
                          isDark
                            ? "bg-[#5BA3F5]/20 text-[#5BA3F5]"
                            : "bg-[#1B2A4A]/15 text-[#1B2A4A]"
                        }`}
                      >
                        {d.sellerName.slice(0, 1)}
                      </div>
                    )}
                    {isLive && (
                      <div
                        className={`absolute -bottom-0.5 left-1/2 -translate-x-1/2 px-1 rounded text-[7px] font-black uppercase tracking-wider text-white ${
                          isDark ? "bg-[#FF8855]" : "bg-[#E6502E]"
                        } animate-pulse`}
                      >
                        LIVE
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 mb-0.5">
                      {isLive ? (
                        <Radio
                          className={`w-3 h-3 ${
                            isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                          }`}
                        />
                      ) : (
                        <Sparkles
                          className={`w-3 h-3 ${
                            isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                          }`}
                        />
                      )}
                      <p
                        className={`text-[11px] font-bold uppercase tracking-wider ${
                          isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                        }`}
                      >
                        {d.title}
                      </p>
                    </div>
                    <p className="text-sm font-bold leading-snug line-clamp-2">
                      {d.detail}
                    </p>
                    <p className={`text-xs mt-1 ${subtle}`}>
                      {relativeDate(d.createdAtIso)}
                    </p>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 self-center shrink-0 ${
                      isDark ? "text-white/30" : "text-stone-400"
                    }`}
                  />
                </Link>
              );
            })}
          </div>
        )
      ) : tab === "messages" ? (
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

function TabButton({
  label,
  count,
  active,
  onClick,
  isDark,
  testId,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  isDark: boolean;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`pb-2 border-b-2 font-bold flex items-center gap-1.5 ${
        active
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
      {label}
      {count > 0 && (
        <span
          className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black flex items-center justify-center ${
            isDark ? "bg-[#FF8855] text-black" : "bg-[#E6502E] text-white"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
