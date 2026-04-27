import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Heart, Sparkles, X, Gift } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useWallet } from "@/lib/wallet-context";
import { formatPrice } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

const PRESETS_MINOR = [5000, 20000, 50000, 100000]; // 50, 200, 500, 1000

export function TippingSheet({
  open,
  onClose,
  hostName,
  streamId,
}: {
  open: boolean;
  onClose: () => void;
  hostName: string;
  streamId: string;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { balanceMinor, spend, currencyCode } = useWallet();
  const { toast } = useToast();
  const [picked, setPicked] = useState<number>(PRESETS_MINOR[1]);
  const [sending, setSending] = useState(false);

  function send() {
    if (sending) return;
    setSending(true);
    const ok = spend(picked, `Tip to ${hostName}`, `tip-${streamId}-${Date.now()}`);
    setSending(false);
    if (!ok) {
      toast({
        title: "Wallet too low",
        description: "Top up your wallet to send tips.",
      });
      return;
    }
    toast({
      title: `${formatPrice(picked, currencyCode)} sent to ${hostName}`,
      description: "Thanks for hyping the host!",
    });
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm"
            data-testid="tipping-overlay"
          />
          <motion.div
            initial={{ y: 400 }}
            animate={{ y: 0 }}
            exit={{ y: 400 }}
            transition={{ type: "spring", damping: 30, stiffness: 320 }}
            className={`absolute bottom-0 left-0 right-0 z-50 rounded-t-3xl border-t p-5 pb-7 ${
              isDark
                ? "bg-[#0F1525] border-white/10 text-white"
                : "bg-[#fbeed3] border-stone-400/55 text-stone-900"
            }`}
            data-testid="tipping-sheet"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <span
                  className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    isDark
                      ? "bg-[#FF8855]/20 text-[#FF8855]"
                      : "bg-[#E6502E]/15 text-[#E6502E]"
                  }`}
                >
                  <Gift className="w-4 h-4" />
                </span>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider opacity-60">
                    Tip the host
                  </p>
                  <p className="text-base font-bold">{hostName}</p>
                </div>
              </div>
              <button
                onClick={onClose}
                data-testid="button-close-tip"
                aria-label="Close"
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  isDark ? "bg-white/10" : "bg-stone-200"
                }`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {PRESETS_MINOR.map((amt) => {
                const active = picked === amt;
                return (
                  <button
                    key={amt}
                    onClick={() => setPicked(amt)}
                    data-testid={`tip-preset-${amt}`}
                    className={`rounded-2xl border p-3 text-left transition-all ${
                      active
                        ? isDark
                          ? "border-[#FF8855] bg-[#FF8855]/10"
                          : "border-[#E6502E] bg-[#E6502E]/10"
                        : isDark
                          ? "border-white/10 bg-white/5"
                          : "border-stone-300 bg-white/70"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <Sparkles
                        className={`w-3.5 h-3.5 ${
                          active
                            ? isDark
                              ? "text-[#FF8855]"
                              : "text-[#E6502E]"
                            : "opacity-40"
                        }`}
                      />
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-60">
                        {amt < 20000 ? "Cheer" : amt < 50000 ? "Hype" : amt < 100000 ? "Star" : "Legend"}
                      </span>
                    </div>
                    <p className="text-lg font-black mt-1">
                      {formatPrice(amt, country.currency.code)}
                    </p>
                  </button>
                );
              })}
            </div>

            <div
              className={`mt-4 flex items-center justify-between text-xs ${
                isDark ? "text-white/60" : "text-stone-500"
              }`}
            >
              <span>Wallet balance</span>
              <span className="font-bold">
                {formatPrice(balanceMinor, currencyCode)}
              </span>
            </div>

            <button
              onClick={send}
              disabled={picked > balanceMinor}
              data-testid="button-send-tip"
              className={`mt-4 w-full h-13 rounded-xl flex items-center justify-center gap-2 font-black text-base text-white ${
                picked > balanceMinor
                  ? "bg-stone-400 cursor-not-allowed"
                  : isDark
                    ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_18px_rgba(255,136,85,0.4)]"
                    : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md"
              }`}
            >
              <Heart className="w-4 h-4" />
              {picked > balanceMinor ? "Top up wallet" : "Send tip"}
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
