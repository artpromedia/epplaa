import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  Inbox,
  Package,
  Truck,
  CheckCircle2,
  ShieldCheck,
  AlertCircle,
  Clock,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useSeller } from "@/lib/seller-context";
import {
  useSellerOrders,
  SELLER_ORDER_STATUS_LABEL,
  SellerOrder,
  SellerOrderStatus,
} from "@/lib/seller-orders";
import { formatPrice } from "@/lib/format";
import { relativeTime } from "@/lib/replays";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

const TABS: { key: "active" | "delivered" | "all"; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "delivered", label: "Delivered" },
  { key: "all", label: "All" },
];

const ACTIVE_STATUSES: SellerOrderStatus[] = [
  "new",
  "packing",
  "ready",
  "in_transit",
];

export default function SellerOrders() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { status } = useSeller();
  const {
    orders,
    markPacking,
    markReady,
    markInTransit,
    verifyPickup,
    markDelivered,
  } = useSellerOrders();
  const { toast } = useToast();
  const [tab, setTab] = useState<"active" | "delivered" | "all">("active");
  const [otpFor, setOtpFor] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [trackNote, setTrackNote] = useState("Out with rider");

  const filtered = useMemo(() => {
    if (tab === "all") return orders;
    if (tab === "delivered")
      return orders.filter((o) => o.status === "delivered");
    return orders.filter((o) => ACTIVE_STATUSES.includes(o.status));
  }, [orders, tab]);

  if (status !== "approved") {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Orders" backHref="/seller/studio" />
        <div className="px-4 py-12 text-center">
          <p className={isDark ? "text-white/60" : "text-stone-600"}>
            Approved sellers only.
          </p>
        </div>
      </div>
    );
  }

  const subtle = isDark ? "text-white/50" : "text-stone-500";
  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  function handleVerifyOTP(order: SellerOrder) {
    const ok = verifyPickup(order.id, otp);
    if (!ok) {
      toast({
        title: "Wrong code",
        description: "Ask the buyer to read the 4-digit code from their phone.",
      });
      return;
    }
    toast({
      title: "Pickup confirmed",
      description: `${order.buyerName} collected order ${order.id}.`,
    });
    setOtpFor(null);
    setOtp("");
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Orders" backHref="/seller/studio" />

      <div className="px-4 pb-24">
        <div
          className={`flex p-1 rounded-full mb-4 ${
            isDark ? "bg-white/5" : "bg-stone-200/70"
          }`}
        >
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                data-testid={`tab-orders-${t.key}`}
                className={`flex-1 py-2 text-xs font-bold rounded-full ${
                  isActive
                    ? isDark
                      ? "bg-[#FF8855] text-white"
                      : "bg-[#1B2A4A] text-white"
                    : isDark
                      ? "text-white/60"
                      : "text-stone-600"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {filtered.length === 0 ? (
          <div
            className={`rounded-xl border p-8 text-center ${cardClass}`}
            data-testid="seller-orders-empty"
          >
            <Inbox
              className={`w-10 h-10 mx-auto mb-3 ${
                isDark ? "text-white/30" : "text-stone-400"
              }`}
            />
            <p className="font-bold mb-1">Nothing in this lane</p>
            <p className={`text-sm ${subtle}`}>
              Orders will land here as buyers check out.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((o) => (
              <div
                key={o.id}
                className={`rounded-xl border overflow-hidden ${cardClass}`}
                data-testid={`seller-order-${o.id}`}
              >
                <div className="p-3 flex gap-3">
                  <img
                    src={o.productImage}
                    alt=""
                    className="w-16 h-16 rounded-lg object-cover shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className="font-bold text-sm leading-tight line-clamp-2"
                        data-testid={`text-order-title-${o.id}`}
                      >
                        {o.productTitle}
                      </p>
                      <StatusPill status={o.status} isDark={isDark} />
                    </div>
                    <p className={`text-xs mt-1 ${subtle}`}>
                      {o.buyerName} (@{o.buyerHandle}) · qty {o.qty}
                    </p>
                    <p className="text-sm font-bold mt-1">
                      {formatPrice(o.unitPriceMinor * o.qty, o.currencyCode)}
                    </p>
                  </div>
                </div>

                <div
                  className={`px-3 py-2 text-[11px] flex items-center gap-2 border-t ${
                    isDark ? "border-white/10" : "border-stone-200"
                  }`}
                >
                  <Truck
                    className={`w-3.5 h-3.5 ${
                      isDark ? "text-white/40" : "text-stone-400"
                    }`}
                  />
                  <span className={subtle}>{o.fulfillmentLabel}</span>
                  <span className={subtle}>·</span>
                  <Clock
                    className={`w-3.5 h-3.5 ${
                      isDark ? "text-white/40" : "text-stone-400"
                    }`}
                  />
                  <span className={subtle}>{relativeTime(o.placedAtIso)}</span>
                </div>

                {o.trackingNote && (
                  <div
                    className={`px-3 py-2 text-xs border-t ${
                      isDark
                        ? "border-white/10 bg-white/[0.02]"
                        : "border-stone-200 bg-stone-50"
                    }`}
                  >
                    <span className="font-semibold">Note:</span> {o.trackingNote}
                  </div>
                )}

                {/* Actions per status */}
                <OrderActions
                  order={o}
                  isDark={isDark}
                  onPack={() => {
                    markPacking(o.id);
                    toast({
                      title: "Marked as packing",
                      description: o.id,
                    });
                  }}
                  onReady={() => {
                    markReady(o.id);
                    toast({
                      title: "Ready for pickup",
                      description: `Courier alerted for ${o.id}.`,
                    });
                  }}
                  onShip={() => {
                    markInTransit(o.id, trackNote);
                    toast({
                      title: "Order in transit",
                      description: trackNote,
                    });
                  }}
                  onOpenOTP={() => {
                    setOtpFor(o.id);
                    setOtp("");
                  }}
                  onMarkDelivered={() => {
                    markDelivered(o.id);
                    toast({ title: "Marked delivered", description: o.id });
                  }}
                />

                {otpFor === o.id && (
                  <div
                    className={`px-3 py-3 border-t ${
                      isDark
                        ? "border-white/10 bg-black/30"
                        : "border-stone-200 bg-amber-50/60"
                    }`}
                  >
                    <p className="text-xs font-bold mb-2 flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5" /> Ask the buyer for
                      their 4-digit pickup code
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={otp}
                        onChange={(e) =>
                          setOtp(e.target.value.replace(/\D/g, "").slice(0, 4))
                        }
                        inputMode="numeric"
                        placeholder="0000"
                        data-testid={`input-otp-${o.id}`}
                        className={`flex-1 px-3 py-2 rounded-lg border text-center font-mono text-lg tracking-widest ${
                          isDark
                            ? "bg-black/40 border-white/10 text-white"
                            : "bg-white border-stone-300 text-stone-900"
                        }`}
                      />
                      <button
                        onClick={() => handleVerifyOTP(o)}
                        disabled={otp.length !== 4}
                        data-testid={`button-verify-otp-${o.id}`}
                        className={`px-4 py-2 rounded-lg text-sm font-bold ${
                          otp.length === 4
                            ? isDark
                              ? "bg-[#FF8855] text-white"
                              : "bg-[#E6502E] text-white"
                            : isDark
                              ? "bg-white/10 text-white/30"
                              : "bg-stone-200 text-stone-400"
                        }`}
                      >
                        Confirm
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({
  status,
  isDark,
}: {
  status: SellerOrderStatus;
  isDark: boolean;
}) {
  const tone = (() => {
    switch (status) {
      case "new":
        return isDark ? "bg-[#FF8855]/20 text-[#FF8855]" : "bg-[#E6502E]/15 text-[#E6502E]";
      case "packing":
        return isDark ? "bg-[#5BA3F5]/20 text-[#5BA3F5]" : "bg-[#1B2A4A]/15 text-[#1B2A4A]";
      case "ready":
        return isDark ? "bg-amber-400/20 text-amber-300" : "bg-amber-500/20 text-amber-700";
      case "in_transit":
        return isDark ? "bg-emerald-400/20 text-emerald-300" : "bg-emerald-600/15 text-emerald-700";
      case "delivered":
        return isDark ? "bg-white/10 text-white/60" : "bg-stone-200 text-stone-600";
      case "cancelled":
        return isDark ? "bg-red-400/20 text-red-300" : "bg-red-100 text-red-700";
    }
  })();
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${tone}`}
    >
      {SELLER_ORDER_STATUS_LABEL[status]}
    </span>
  );
}

function OrderActions({
  order,
  isDark,
  onPack,
  onReady,
  onShip,
  onOpenOTP,
  onMarkDelivered,
}: {
  order: SellerOrder;
  isDark: boolean;
  onPack: () => void;
  onReady: () => void;
  onShip: () => void;
  onOpenOTP: () => void;
  onMarkDelivered: () => void;
}) {
  const isBoxPickup = order.fulfillmentLabel.toLowerCase().includes("box");

  if (order.status === "delivered" || order.status === "cancelled") return null;

  return (
    <div
      className={`px-3 py-2 flex flex-wrap gap-2 border-t ${
        isDark ? "border-white/10" : "border-stone-200"
      }`}
    >
      {order.status === "new" && (
        <ActionButton
          label="Start packing"
          icon={Package}
          onClick={onPack}
          isDark={isDark}
          testId={`button-pack-${order.id}`}
          primary
        />
      )}
      {order.status === "packing" && (
        <ActionButton
          label={isBoxPickup ? "Hand to Box" : "Ready for courier"}
          icon={Truck}
          onClick={onReady}
          isDark={isDark}
          testId={`button-ready-${order.id}`}
          primary
        />
      )}
      {order.status === "ready" && !isBoxPickup && (
        <ActionButton
          label="Mark in transit"
          icon={Truck}
          onClick={onShip}
          isDark={isDark}
          testId={`button-ship-${order.id}`}
          primary
        />
      )}
      {order.status === "ready" && isBoxPickup && (
        <ActionButton
          label="Verify pickup code"
          icon={ShieldCheck}
          onClick={onOpenOTP}
          isDark={isDark}
          testId={`button-open-otp-${order.id}`}
          primary
        />
      )}
      {order.status === "in_transit" && (
        <ActionButton
          label="Mark delivered"
          icon={CheckCircle2}
          onClick={onMarkDelivered}
          isDark={isDark}
          testId={`button-delivered-${order.id}`}
          primary
        />
      )}
      <Link
        href={`/inbox`}
        className={`text-xs font-bold px-3 py-2 rounded-lg ${
          isDark
            ? "border border-white/10 text-white/70"
            : "border border-stone-300 text-stone-700"
        }`}
        data-testid={`button-message-buyer-${order.id}`}
      >
        Message buyer
      </Link>
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  onClick,
  isDark,
  testId,
  primary,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  isDark: boolean;
  testId: string;
  primary?: boolean;
}) {
  const cls = primary
    ? isDark
      ? "bg-[#FF8855] text-white"
      : "bg-[#E6502E] text-white"
    : isDark
      ? "border border-white/10 text-white/70"
      : "border border-stone-300 text-stone-700";
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1 ${cls}`}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}
