import { useState } from "react";
import { useRoute } from "wouter";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  MessageSquare,
  Send,
  Truck,
  Wallet as WalletIcon,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useReturns, RETURN_STATUS_LABEL } from "@/lib/returns-context";
import { formatPrice } from "@/lib/format";
import { relativeTime } from "@/lib/replays";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

export default function ReturnDetail() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [, params] = useRoute<{ returnId: string }>("/returns/:returnId");
  const returnId = params?.returnId ?? "";
  const {
    getById,
    approveReturn,
    rejectReturn,
    markShippedBack,
    refund,
    openDispute,
    postMessage,
  } = useReturns();
  const rec = getById(returnId);
  const { toast } = useToast();
  const [disputeText, setDisputeText] = useState("");
  const [reply, setReply] = useState("");

  const subtle = isDark ? "text-white/50" : "text-stone-500";
  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  if (!rec) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Return" backHref="/returns" />
        <div className="px-4 py-12 text-center">
          <AlertCircle
            className={`w-10 h-10 mx-auto mb-3 ${
              isDark ? "text-white/40" : "text-stone-400"
            }`}
          />
          <p className="font-bold">Return not found</p>
        </div>
      </div>
    );
  }

  const canApprove = rec.status === "requested";
  const canShipBack = rec.status === "approved";
  const canRefund =
    rec.status === "shipped_back" || rec.status === "in_dispute";
  const canDispute =
    rec.status === "rejected" || rec.status === "requested";

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title={`Return ${rec.id}`} backHref="/returns" />
      <div className="px-4 pb-24 space-y-4">
        <div className={`rounded-xl border p-4 ${cardClass}`}>
          <div className="flex gap-3">
            {rec.productImage && (
              <img
                src={rec.productImage}
                alt=""
                className="w-16 h-16 rounded-lg object-cover shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm line-clamp-2">
                {rec.productTitle}
              </p>
              <p className={`text-xs mt-1 ${subtle}`}>
                Order {rec.orderId}
              </p>
              <p className="text-sm font-bold mt-1">
                {formatPrice(rec.refundAmountMinor, rec.currencyCode)}
              </p>
            </div>
            <span
              className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full self-start ${
                rec.status === "refunded"
                  ? isDark
                    ? "bg-emerald-400/20 text-emerald-300"
                    : "bg-emerald-600/15 text-emerald-700"
                  : rec.status === "rejected"
                    ? isDark
                      ? "bg-red-400/20 text-red-300"
                      : "bg-red-100 text-red-700"
                    : isDark
                      ? "bg-[#5BA3F5]/20 text-[#5BA3F5]"
                      : "bg-[#1B2A4A]/15 text-[#1B2A4A]"
              }`}
              data-testid={`status-pill-${rec.id}`}
            >
              {RETURN_STATUS_LABEL[rec.status]}
            </span>
          </div>
          <p className={`text-xs mt-3 ${subtle}`}>
            Reason: <span className="font-bold">{rec.reasonLabel}</span>
            {rec.photoCount > 0 ? ` · ${rec.photoCount} photo${rec.photoCount > 1 ? "s" : ""}` : ""}
          </p>
          {rec.notes && (
            <p className="text-sm mt-2 leading-relaxed">{rec.notes}</p>
          )}
        </div>

        {/* Demo: simulate seller / support actions */}
        <div className={`rounded-xl border p-3 ${cardClass}`}>
          <p className={`text-[10px] font-bold uppercase tracking-wider mb-2 ${subtle}`}>
            Simulate response
          </p>
          <div className="flex flex-wrap gap-2">
            {canApprove && (
              <button
                onClick={() => {
                  approveReturn(rec.id);
                  toast({ title: "Seller approved your return" });
                }}
                data-testid="sim-approve"
                className={`text-xs font-bold px-3 py-2 rounded-lg ${
                  isDark ? "bg-white/10 text-white" : "bg-stone-200 text-stone-800"
                }`}
              >
                Seller approves
              </button>
            )}
            {canApprove && (
              <button
                onClick={() => {
                  rejectReturn(rec.id, "Item shows signs of use beyond inspection.");
                  toast({ title: "Seller rejected the return" });
                }}
                data-testid="sim-reject"
                className={`text-xs font-bold px-3 py-2 rounded-lg ${
                  isDark ? "bg-white/10 text-white" : "bg-stone-200 text-stone-800"
                }`}
              >
                Seller rejects
              </button>
            )}
            {canShipBack && (
              <button
                onClick={() => {
                  markShippedBack(rec.id);
                  toast({ title: "Marked shipped back" });
                }}
                data-testid="sim-ship"
                className={`text-xs font-bold px-3 py-2 rounded-lg ${
                  isDark ? "bg-white/10 text-white" : "bg-stone-200 text-stone-800"
                }`}
              >
                I shipped it back
              </button>
            )}
            {canRefund && (
              <button
                onClick={() => {
                  refund(rec.id);
                  toast({
                    title: "Refunded to wallet",
                    description: formatPrice(
                      rec.refundAmountMinor,
                      rec.currencyCode,
                    ),
                  });
                }}
                data-testid="sim-refund"
                className={`text-xs font-bold px-3 py-2 rounded-lg ${
                  isDark ? "bg-[#FF8855] text-white" : "bg-[#E6502E] text-white"
                }`}
              >
                Issue refund
              </button>
            )}
          </div>
        </div>

        <div>
          <h3
            className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
          >
            Timeline
          </h3>
          <div className={`rounded-xl border ${cardClass}`}>
            {rec.timeline.map((ev, i) => (
              <div
                key={i}
                className={`p-3 flex gap-3 ${
                  i < rec.timeline.length - 1
                    ? isDark
                      ? "border-b border-white/10"
                      : "border-b border-stone-200"
                    : ""
                }`}
                data-testid={`timeline-${i}`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    isDark ? "bg-white/10" : "bg-stone-200"
                  }`}
                >
                  {ev.status === "refunded" ? (
                    <WalletIcon className="w-4 h-4" />
                  ) : ev.status === "shipped_back" ? (
                    <Truck className="w-4 h-4" />
                  ) : ev.status === "approved" ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : ev.status === "rejected" ? (
                    <AlertCircle className="w-4 h-4" />
                  ) : (
                    <Clock className="w-4 h-4" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold">{ev.label}</p>
                  {ev.detail && (
                    <p className={`text-xs mt-0.5 ${subtle}`}>{ev.detail}</p>
                  )}
                  <p className={`text-[11px] mt-0.5 ${subtle}`}>
                    {relativeTime(ev.atIso)} · {ev.byRole ?? "system"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {rec.dispute.length === 0 && canDispute && (
          <div className={`rounded-xl border p-4 ${cardClass}`}>
            <h3 className="text-sm font-bold mb-2 flex items-center gap-2">
              <MessageSquare className="w-4 h-4" /> Need help?
            </h3>
            <p className={`text-xs mb-3 ${subtle}`}>
              Open a dispute and our support team will mediate within 24 hours.
            </p>
            <textarea
              value={disputeText}
              onChange={(e) => setDisputeText(e.target.value)}
              rows={3}
              placeholder="Describe the problem in your own words"
              data-testid="input-dispute"
              className={`w-full px-3 py-2 rounded-lg border text-sm ${
                isDark
                  ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
                  : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
              }`}
            />
            <button
              onClick={() => {
                if (!disputeText.trim()) return;
                openDispute(rec.id, disputeText.trim());
                setDisputeText("");
                toast({ title: "Dispute opened" });
              }}
              disabled={!disputeText.trim()}
              data-testid="button-open-dispute"
              className={`mt-2 px-4 py-2 rounded-full text-sm font-bold ${
                disputeText.trim()
                  ? isDark
                    ? "bg-[#FF8855] text-white"
                    : "bg-[#E6502E] text-white"
                  : isDark
                    ? "bg-white/10 text-white/30"
                    : "bg-stone-200 text-stone-400"
              }`}
            >
              Open dispute
            </button>
          </div>
        )}

        {rec.dispute.length > 0 && (
          <div>
            <h3
              className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
            >
              Dispute thread
            </h3>
            <div className={`rounded-xl border p-3 space-y-2 ${cardClass}`}>
              {rec.dispute.map((m) => {
                const mine = m.byRole === "buyer";
                return (
                  <div
                    key={m.id}
                    className={`flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm ${
                        mine
                          ? isDark
                            ? "bg-[#FF8855] text-white rounded-br-sm"
                            : "bg-[#E6502E] text-white rounded-br-sm"
                          : isDark
                            ? "bg-white/10 text-white rounded-bl-sm"
                            : "bg-stone-200 text-stone-900 rounded-bl-sm"
                      }`}
                      data-testid={`dispute-msg-${m.id}`}
                    >
                      <p className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-0.5">
                        {m.byRole}
                      </p>
                      {m.body}
                    </div>
                  </div>
                );
              })}
              <div className="flex gap-2 pt-2">
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Reply to support"
                  data-testid="input-dispute-reply"
                  className={`flex-1 px-3 py-2 rounded-lg border text-sm ${
                    isDark
                      ? "bg-black/40 border-white/10 text-white"
                      : "bg-white border-stone-300 text-stone-900"
                  }`}
                />
                <button
                  onClick={() => {
                    if (!reply.trim()) return;
                    postMessage(rec.id, {
                      byRole: "buyer",
                      body: reply.trim(),
                    });
                    setReply("");
                  }}
                  disabled={!reply.trim()}
                  data-testid="button-send-reply"
                  className={`px-3 py-2 rounded-lg ${
                    reply.trim()
                      ? isDark
                        ? "bg-[#FF8855] text-white"
                        : "bg-[#E6502E] text-white"
                      : isDark
                        ? "bg-white/10 text-white/30"
                        : "bg-stone-200 text-stone-400"
                  }`}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
