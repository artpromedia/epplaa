import { useMemo, useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { Star, ChevronLeft, CheckCircle2 } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useOrders } from "@/lib/orders-context";
import { useReviews } from "@/lib/reviews-context";
import { SEED_PRODUCTS } from "@/lib/seed";
import { useToast } from "@/hooks/use-toast";

export default function RateOrder() {
  const { orderId } = useParams<{ orderId: string }>();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { getById } = useOrders();
  const { add: addReview, getForOrderItem } = useReviews();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const order = getById(orderId);

  const itemRefs = useMemo(() => {
    if (!order) return [];
    return order.items.map((it) => {
      const product = SEED_PRODUCTS.find((p) => p.id === it.productId);
      const existing = getForOrderItem(order.id, it.productId);
      return { item: it, product, existing };
    });
  }, [order, getForOrderItem]);

  const [drafts, setDrafts] = useState<Record<string, { rating: number; text: string }>>(
    () =>
      Object.fromEntries(
        (order?.items ?? []).map((it) => {
          const existing = getForOrderItem(order!.id, it.productId);
          return [it.productId, { rating: existing?.rating ?? 0, text: existing?.text ?? "" }];
        }),
      ),
  );

  if (!order) {
    return (
      <div className="flex flex-col h-full w-full items-center justify-center p-6 text-center">
        <p className={isDark ? "text-white/55" : "text-stone-500"}>
          Order not found.
        </p>
        <Link
          href="/orders"
          className={`mt-4 px-5 py-2 rounded-full font-bold text-sm ${
            isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
          }`}
          data-testid="link-back-to-orders-missing"
        >
          Back to orders
        </Link>
      </div>
    );
  }

  if (order.status !== "delivered") {
    return (
      <div className="flex flex-col h-full w-full items-center justify-center p-6 text-center">
        <p className="font-bold mb-1">Not delivered yet</p>
        <p
          className={`text-sm ${isDark ? "text-white/55" : "text-stone-500"}`}
        >
          You can leave a review once your order is delivered.
        </p>
        <Link
          href={`/orders/${order.id}`}
          className={`mt-4 px-5 py-2 rounded-full font-bold text-sm ${
            isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
          }`}
          data-testid="link-back-order"
        >
          Back to order
        </Link>
      </div>
    );
  }

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  function handleSubmit() {
    let saved = 0;
    itemRefs.forEach(({ item, product }) => {
      const draft = drafts[item.productId];
      if (!draft || draft.rating === 0) return;
      addReview({
        orderId: order!.id,
        productId: item.productId,
        sellerName: product?.sellerName ?? "Unknown seller",
        rating: draft.rating,
        text: draft.text.trim(),
      });
      saved += 1;
    });
    if (saved === 0) {
      toast({ title: "Tap a star to rate at least one item" });
      return;
    }
    toast({
      title: `Thanks for ${saved === 1 ? "the review" : "the reviews"}!`,
      description: "Your feedback helps the community.",
    });
    setLocation(`/orders/${order!.id}`);
  }

  const allDone = itemRefs.every(({ existing }) => Boolean(existing));

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-3 px-4 z-10 sticky top-0 flex items-center gap-3 ${
          isDark
            ? "bg-[#0F1525] border-b border-white/10"
            : "bg-[#fbeed3] border-b border-stone-400/35"
        }`}
      >
        <Link
          href={`/orders/${order.id}`}
          className={`w-9 h-9 rounded-full flex items-center justify-center ${
            isDark ? "hover:bg-white/10" : "hover:bg-stone-200"
          }`}
          data-testid="link-back-rate"
        >
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div>
          <p className={`text-[11px] font-bold uppercase tracking-wider ${subtle}`}>
            Rate order
          </p>
          <h1 className="text-base font-bold font-mono">{order.id}</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-32 pt-3 space-y-3">
        {allDone && (
          <div
            className={`rounded-xl p-3 flex items-center gap-2 text-sm ${
              isDark
                ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                : "bg-emerald-50 text-emerald-800 border border-emerald-300"
            }`}
            data-testid="banner-already-rated"
          >
            <CheckCircle2 className="w-4 h-4" />
            All items are rated. You can update them below.
          </div>
        )}

        {itemRefs.map(({ item, product, existing }) => {
          const draft = drafts[item.productId] ?? { rating: 0, text: "" };
          return (
            <div
              key={item.productId}
              className={`rounded-xl border p-4 ${cardBorder}`}
              data-testid={`rate-item-${item.productId}`}
            >
              <div className="flex gap-3 mb-3">
                {item.image && (
                  <div className="w-14 h-14 rounded-md overflow-hidden bg-stone-200 shrink-0">
                    <img
                      src={item.image}
                      alt={item.title}
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold leading-snug line-clamp-2">
                    {item.title}
                  </p>
                  <p className={`text-xs mt-0.5 ${subtle}`}>
                    Sold by {product?.sellerName ?? "—"}
                  </p>
                  {existing && (
                    <p
                      className={`text-[11px] font-bold mt-1 ${
                        isDark ? "text-emerald-300" : "text-emerald-700"
                      }`}
                    >
                      Already reviewed — submit to update
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-center gap-1 mb-3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() =>
                      setDrafts((prev) => ({
                        ...prev,
                        [item.productId]: { ...draft, rating: n },
                      }))
                    }
                    data-testid={`star-${item.productId}-${n}`}
                    className="p-1"
                    aria-label={`${n} star${n === 1 ? "" : "s"}`}
                  >
                    <Star
                      className={`w-9 h-9 ${
                        n <= draft.rating
                          ? isDark
                            ? "text-[#FF8855] fill-current"
                            : "text-[#E6502E] fill-current"
                          : isDark
                            ? "text-white/20"
                            : "text-stone-300"
                      }`}
                    />
                  </button>
                ))}
              </div>

              <textarea
                value={draft.text}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [item.productId]: { ...draft, text: e.target.value },
                  }))
                }
                placeholder="Share what you loved or what could be better..."
                rows={3}
                data-testid={`textarea-${item.productId}`}
                className={`w-full px-3 py-2 rounded-lg border text-sm outline-none ${
                  isDark
                    ? "bg-black/40 border-white/10 text-white placeholder:text-white/40"
                    : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
                }`}
              />
            </div>
          );
        })}
      </div>

      <div
        className={`absolute bottom-0 left-0 right-0 p-4 backdrop-blur-xl border-t z-20 ${
          isDark
            ? "bg-[#0F1525]/90 border-white/10"
            : "bg-[#fbeed3]/90 border-stone-400/55"
        }`}
      >
        <button
          onClick={handleSubmit}
          data-testid="button-submit-reviews"
          className={`w-full h-12 rounded-xl font-black text-base ${
            isDark
              ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] text-white"
              : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] text-white"
          }`}
        >
          Submit review{itemRefs.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
