import { Link } from "wouter";
import { Inbox, ChevronRight, RotateCcw } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useReturns, RETURN_STATUS_LABEL } from "@/lib/returns-context";
import { formatPrice } from "@/lib/format";
import { relativeTime } from "@/lib/replays";
import { PageHeader } from "@/components/page-header";

export default function ReturnsList() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { returns } = useReturns();

  const subtle = isDark ? "text-white/50" : "text-stone-500";
  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Returns & refunds" backHref="/profile" />
      <div className="px-4 pb-24">
        {returns.length === 0 ? (
          <div
            className={`rounded-xl border p-8 text-center ${cardClass}`}
            data-testid="returns-empty"
          >
            <Inbox
              className={`w-10 h-10 mx-auto mb-3 ${
                isDark ? "text-white/30" : "text-stone-400"
              }`}
            />
            <p className="font-bold mb-1">No returns yet</p>
            <p className={`text-sm ${subtle}`}>
              Open a delivered order and tap Request return to start one.
            </p>
            <Link
              href="/orders"
              data-testid="link-go-to-orders"
              className={`inline-block mt-4 px-4 py-2 rounded-full font-bold text-sm ${
                isDark ? "bg-[#FF8855] text-white" : "bg-[#E6502E] text-white"
              }`}
            >
              View orders
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {returns.map((r) => (
              <Link
                key={r.id}
                href={`/returns/${r.id}`}
                data-testid={`return-row-${r.id}`}
                className={`rounded-xl border overflow-hidden block ${cardClass} ${
                  isDark ? "hover:bg-white/[0.07]" : "hover:bg-stone-50"
                }`}
              >
                <div className="flex gap-3 p-3">
                  {r.productImage ? (
                    <img
                      src={r.productImage}
                      alt=""
                      className="w-16 h-16 rounded-lg object-cover shrink-0"
                    />
                  ) : (
                    <div
                      className={`w-16 h-16 rounded-lg flex items-center justify-center shrink-0 ${
                        isDark ? "bg-white/10" : "bg-stone-200"
                      }`}
                    >
                      <RotateCcw className="w-6 h-6 opacity-60" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm leading-tight line-clamp-2">
                      {r.productTitle}
                    </p>
                    <p className={`text-xs mt-1 ${subtle}`}>
                      Order {r.orderId} · {relativeTime(r.createdAtIso)}
                    </p>
                    <p className="text-sm font-bold mt-1">
                      Refund: {formatPrice(r.refundAmountMinor, r.currencyCode)}
                    </p>
                  </div>
                  <ChevronRight
                    className={`w-4 h-4 self-center ${
                      isDark ? "text-white/30" : "text-stone-400"
                    }`}
                  />
                </div>
                <div
                  className={`px-3 py-2 text-[11px] flex items-center justify-between border-t ${
                    isDark ? "border-white/10" : "border-stone-200"
                  }`}
                >
                  <span className={subtle}>{r.reasonLabel}</span>
                  <StatusPill status={r.status} isDark={isDark} />
                </div>
              </Link>
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
  status: keyof typeof RETURN_STATUS_LABEL;
  isDark: boolean;
}) {
  const tone = (() => {
    switch (status) {
      case "requested":
        return isDark ? "bg-amber-400/20 text-amber-300" : "bg-amber-500/20 text-amber-700";
      case "approved":
      case "shipped_back":
        return isDark ? "bg-[#5BA3F5]/20 text-[#5BA3F5]" : "bg-[#1B2A4A]/15 text-[#1B2A4A]";
      case "refunded":
        return isDark ? "bg-emerald-400/20 text-emerald-300" : "bg-emerald-600/15 text-emerald-700";
      case "rejected":
        return isDark ? "bg-red-400/20 text-red-300" : "bg-red-100 text-red-700";
      case "in_dispute":
        return isDark ? "bg-[#FF8855]/20 text-[#FF8855]" : "bg-[#E6502E]/15 text-[#E6502E]";
    }
  })();
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${tone}`}
    >
      {RETURN_STATUS_LABEL[status]}
    </span>
  );
}
