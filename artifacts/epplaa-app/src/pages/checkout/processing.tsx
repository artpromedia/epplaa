import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useVerifyPaymentIntent } from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme-context";
import { Loader2, AlertCircle } from "lucide-react";

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 40;

export default function CheckoutProcessing() {
  const [, params] = useRoute("/checkout/processing/:orderId/:intentId");
  const [, setLocation] = useLocation();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const verify = useVerifyPaymentIntent();
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const orderId = params?.orderId;
  const intentId = params?.intentId;

  useEffect(() => {
    if (!orderId || !intentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      try {
        const result = await verify.mutateAsync({ intentId: intentId! });
        if (cancelled) return;
        if (result.status === "succeeded") {
          setLocation(`/checkout/success/${orderId}`);
          return;
        }
        if (result.status === "failed" || result.status === "cancelled") {
          setLocation(`/checkout/payment?failed=${encodeURIComponent(result.status)}`);
          return;
        }
        setPolls((p) => {
          const next = p + 1;
          if (next >= MAX_POLLS) {
            setError("We're still confirming your payment. We'll email you once it settles.");
            return next;
          }
          timer = setTimeout(tick, POLL_INTERVAL_MS);
          return next;
        });
      } catch (err) {
        setError((err as Error).message ?? "Verification failed");
      }
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, intentId]);

  return (
    <div
      className={`flex flex-col items-center justify-center min-h-screen px-6 text-center ${
        isDark ? "bg-stone-950 text-white" : "bg-amber-50 text-stone-900"
      }`}
    >
      {error ? (
        <>
          <AlertCircle className="w-12 h-12 text-amber-500 mb-4" />
          <h1 className="text-xl font-bold mb-2">Still processing</h1>
          <p className="text-sm opacity-80 max-w-sm mb-6">{error}</p>
          <button
            onClick={() => orderId && setLocation(`/orders/${orderId}`)}
            className="h-11 px-5 rounded-xl bg-[#E6502E] text-white font-bold"
          >
            View order
          </button>
        </>
      ) : (
        <>
          <Loader2 className="w-10 h-10 animate-spin mb-4 text-[#E6502E]" />
          <h1 className="text-xl font-bold mb-2">Confirming payment…</h1>
          <p className="text-sm opacity-80 max-w-sm">
            We're checking with your bank. This usually takes a few seconds.
          </p>
          <p className="text-xs opacity-60 mt-3" data-testid="text-polls">
            Attempt {polls + 1} / {MAX_POLLS}
          </p>
        </>
      )}
    </div>
  );
}
