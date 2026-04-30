import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Camera, AlertCircle, RotateCcw } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useOrders } from "@/lib/orders-context";
import { useReturns, RETURN_REASONS, ReturnReason } from "@/lib/returns-context";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

export default function RequestReturn() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [, params] = useRoute<{ orderId: string }>("/returns/new/:orderId");
  const orderId = params?.orderId ?? "";
  const { getById } = useOrders();
  const order = getById(orderId);
  const { request, byOrder } = useReturns();
  const existing = byOrder(orderId);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [reason, setReason] = useState<ReturnReason>("defective");
  const [notes, setNotes] = useState("");
  const [photoCount, setPhotoCount] = useState(0);

  const subtle = isDark ? "text-white/50" : "text-stone-500";
  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#5BA3F5]/30 ${
    isDark
      ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
      : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
  }`;

  if (!order) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Request return" backHref="/orders" />
        <div className="px-4 py-12 text-center">
          <AlertCircle
            className={`w-10 h-10 mx-auto mb-3 ${
              isDark ? "text-white/40" : "text-stone-400"
            }`}
          />
          <p className="font-bold">Order not found</p>
          <p className={`text-sm mt-1 ${subtle}`}>
            We could not find this order in your account.
          </p>
        </div>
      </div>
    );
  }

  if (existing) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Request return" backHref={`/orders/${orderId}`} />
        <div className="px-4 py-8">
          <div className={`rounded-xl border p-4 ${cardClass}`}>
            <p className="font-bold mb-1">A return is already open</p>
            <p className={`text-sm mb-3 ${subtle}`}>
              You opened a return for this order. Track its status from the
              returns hub.
            </p>
            <button
              onClick={() => navigate(`/returns/${existing.id}`)}
              data-testid="button-view-existing-return"
              className={`px-4 py-2 rounded-full font-bold text-sm ${
                isDark ? "bg-[#FF8855] text-white" : "bg-[#E6502E] text-white"
              }`}
            >
              View return
            </button>
          </div>
        </div>
      </div>
    );
  }

  const reasonDef = RETURN_REASONS.find((r) => r.id === reason)!;
  const refundMinor = order.totalsMinor.subtotal;

  function submit() {
    if (reasonDef.needsPhoto && photoCount === 0) {
      toast({
        title: "Add at least one photo",
        description: "Photos help the seller approve faster.",
      });
      return;
    }
    if (!notes.trim()) {
      toast({ title: "Add a short note", description: "Tell us what happened." });
      return;
    }
    void (async () => {
      const created = await request({
        orderId: order!.id,
        productTitle: order!.items[0]?.title ?? "Order item",
        productImage: order!.items[0]?.image,
        refundAmountMinor: refundMinor,
        currencyCode: order!.currencyCode,
        reason,
        notes: notes.trim(),
        photoCount,
      });
      toast({
        title: "Return requested",
        description: `We notified the seller. Reference ${created.id}.`,
      });
      navigate(`/returns/${created.id}`);
    })();
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Request return" backHref={`/orders/${orderId}`} />
      <div className="px-4 pb-32 space-y-4">
        <div className={`rounded-xl border p-4 ${cardClass}`}>
          <div className="flex gap-3">
            {order.items[0]?.image && (
              <img
                src={order.items[0].image}
                alt=""
                className="w-16 h-16 rounded-lg object-cover shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm line-clamp-2">
                {order.items[0]?.title}
              </p>
              <p className={`text-xs mt-1 ${subtle}`}>
                Order {order.id}
              </p>
              <p className="text-sm font-bold mt-1">
                Refund up to {formatPrice(refundMinor, order.currencyCode)}
              </p>
            </div>
          </div>
          <p className={`text-[11px] mt-3 ${subtle}`}>
            7 day return window per Epplaa policy. Refunds are credited to your
            Epplaa wallet within seconds of approval.
          </p>
        </div>

        <div>
          <label className="text-sm font-bold block mb-2">Reason</label>
          <div className="space-y-2">
            {RETURN_REASONS.map((r) => {
              const selected = reason === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => setReason(r.id)}
                  data-testid={`reason-${r.id}`}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-left text-sm ${
                    selected
                      ? isDark
                        ? "border-[#FF8855] bg-[#FF8855]/10 text-white"
                        : "border-[#E6502E] bg-[#E6502E]/10 text-stone-900"
                      : isDark
                        ? "border-white/10 bg-white/5 text-white/80"
                        : "border-stone-300 bg-white text-stone-700"
                  }`}
                >
                  <span>{r.label}</span>
                  {r.needsPhoto && (
                    <span className={`text-[10px] font-bold ${subtle}`}>
                      Photo helps
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-bold block mb-2">
            Add photos {reasonDef.needsPhoto ? "(required)" : "(optional)"}
          </label>
          <button
            onClick={() => setPhotoCount((n) => n + 1)}
            data-testid="button-add-photo"
            className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed text-sm font-bold ${
              isDark
                ? "border-white/15 text-white/70"
                : "border-stone-400 text-stone-700"
            }`}
          >
            <Camera className="w-4 h-4" /> Tap to add photo
            {photoCount > 0 ? ` (${photoCount} added)` : ""}
          </button>
          {photoCount > 0 && (
            <button
              onClick={() => setPhotoCount(0)}
              className={`mt-2 text-xs ${subtle} underline`}
              data-testid="button-clear-photos"
            >
              Clear photos
            </button>
          )}
        </div>

        <div>
          <label className="text-sm font-bold block mb-2">Tell us more</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            data-testid="input-return-notes"
            placeholder="What happened? When did you notice the issue?"
            className={inputClass}
          />
        </div>
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 px-4 py-3 border-t ${
          isDark
            ? "bg-[#0F1525]/95 border-white/10"
            : "bg-[#fbeed3]/95 border-stone-300"
        }`}
      >
        <button
          onClick={submit}
          data-testid="button-submit-return"
          className={`w-full py-3 rounded-full font-bold flex items-center justify-center gap-2 ${
            isDark ? "bg-[#FF8855] text-white" : "bg-[#E6502E] text-white"
          }`}
        >
          <RotateCcw className="w-4 h-4" /> Submit return request
        </button>
      </div>
    </div>
  );
}
