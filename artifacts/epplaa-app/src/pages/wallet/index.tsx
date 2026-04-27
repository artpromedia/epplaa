import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Plus,
  RotateCcw,
  ShoppingBag,
  Wallet as WalletIcon,
  Sparkles,
  Banknote,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useWallet, TXN_LABEL, WalletTxnKind } from "@/lib/wallet-context";
import { formatPrice } from "@/lib/format";
import { relativeTime } from "@/lib/replays";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

const TOPUP_AMOUNTS = [1000, 5000, 10000, 25000];

export default function WalletPage() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { balanceMinor, currencyCode, txns, topUp, withdraw } = useWallet();
  const { toast } = useToast();
  const [showTopUp, setShowTopUp] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const subtle = isDark ? "text-white/50" : "text-stone-500";
  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Wallet" backHref="/profile" />
      <div className="px-4 pb-24 space-y-4">
        <div
          className={`rounded-2xl p-5 ${
            isDark
              ? "bg-gradient-to-br from-[#1B2A4A] via-[#2A3D6B] to-[#FF8855]"
              : "bg-gradient-to-br from-[#1B2A4A] via-[#2A3D6B] to-[#E6502E]"
          } text-white`}
          data-testid="wallet-balance-card"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-wider opacity-80">
              Available balance
            </span>
            <WalletIcon className="w-5 h-5 opacity-80" />
          </div>
          <p className="text-3xl font-black" data-testid="text-wallet-balance">
            {formatPrice(balanceMinor, currencyCode)}
          </p>
          <p className="text-xs mt-1 opacity-80">
            Use at checkout, or withdraw to your bank.
          </p>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => setShowTopUp(true)}
              data-testid="button-topup"
              className="flex-1 bg-white/20 backdrop-blur px-3 py-2 rounded-full text-xs font-bold flex items-center justify-center gap-1"
            >
              <ArrowDownToLine className="w-3.5 h-3.5" /> Top up
            </button>
            <button
              onClick={() => setShowWithdraw(true)}
              data-testid="button-withdraw"
              className="flex-1 bg-white/20 backdrop-blur px-3 py-2 rounded-full text-xs font-bold flex items-center justify-center gap-1"
            >
              <ArrowUpFromLine className="w-3.5 h-3.5" /> Withdraw
            </button>
          </div>
        </div>

        <div className={`rounded-xl border p-3 ${cardClass}`}>
          <div className="flex items-start gap-3">
            <Banknote
              className={`w-5 h-5 mt-0.5 ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
            />
            <div className="flex-1">
              <p className="font-bold text-sm">Pay on collection is on</p>
              <p className={`text-xs mt-0.5 ${subtle}`}>
                Pick a Box pickup at checkout and pay with cash or transfer when
                you collect. Wallet balance still applies if you top up.
              </p>
            </div>
          </div>
        </div>

        <div>
          <h3
            className={`text-xs font-bold uppercase tracking-wider mb-2 ${subtle}`}
          >
            Activity
          </h3>
          {txns.length === 0 ? (
            <div className={`rounded-xl border p-6 text-center ${cardClass}`}>
              <p className={subtle}>No wallet activity yet.</p>
            </div>
          ) : (
            <div className={`rounded-xl border ${cardClass}`}>
              {txns.map((t, i) => (
                <div
                  key={t.id}
                  className={`p-3 flex items-center gap-3 ${
                    i < txns.length - 1
                      ? isDark
                        ? "border-b border-white/10"
                        : "border-b border-stone-200"
                      : ""
                  }`}
                  data-testid={`txn-${t.id}`}
                >
                  <TxnIcon kind={t.kind} isDark={isDark} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold leading-tight">
                      {t.label}
                    </p>
                    <p className={`text-[11px] mt-0.5 ${subtle}`}>
                      {TXN_LABEL[t.kind]} · {relativeTime(t.atIso)}
                    </p>
                  </div>
                  <p
                    className={`text-sm font-bold ${
                      t.amountMinor >= 0
                        ? isDark
                          ? "text-emerald-300"
                          : "text-emerald-700"
                        : ""
                    }`}
                  >
                    {t.amountMinor >= 0 ? "+" : ""}
                    {formatPrice(t.amountMinor, currencyCode)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showTopUp && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
          <div
            className={`w-full max-w-[390px] rounded-t-2xl p-5 ${
              isDark ? "bg-[#171C30] text-white" : "bg-white text-stone-900"
            }`}
            data-testid="topup-sheet"
          >
            <div className="flex items-center gap-2 mb-3">
              <Plus
                className={`w-5 h-5 ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              />
              <h3 className="text-lg font-bold">Top up wallet</h3>
            </div>
            <p className={`text-xs mb-3 ${subtle}`}>
              Funds load instantly in this preview. Real top-ups debit your
              chosen payment method.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {TOPUP_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => {
                    topUp(amt * country.currency.minorPerMajor, `Top up ${amt}`);
                    toast({
                      title: "Wallet topped up",
                      description: formatPrice(
                        amt * country.currency.minorPerMajor,
                        currencyCode,
                      ),
                    });
                    setShowTopUp(false);
                  }}
                  data-testid={`topup-${amt}`}
                  className={`px-3 py-3 rounded-xl border text-sm font-bold ${
                    isDark
                      ? "border-white/10 bg-white/5"
                      : "border-stone-300 bg-stone-50"
                  }`}
                >
                  {formatPrice(amt * country.currency.minorPerMajor, currencyCode)}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowTopUp(false)}
              data-testid="button-close-topup"
              className={`w-full mt-4 py-2 rounded-full text-sm font-bold ${
                isDark ? "bg-white/10" : "bg-stone-200"
              }`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showWithdraw && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
          <div
            className={`w-full max-w-[390px] rounded-t-2xl p-5 ${
              isDark ? "bg-[#171C30] text-white" : "bg-white text-stone-900"
            }`}
            data-testid="withdraw-sheet"
          >
            <div className="flex items-center gap-2 mb-3">
              <ArrowUpFromLine
                className={`w-5 h-5 ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              />
              <h3 className="text-lg font-bold">Withdraw to bank</h3>
            </div>
            <p className={`text-xs mb-3 ${subtle}`}>
              Goes to the saved payout bank in your account. Arrives in under 60
              minutes for verified accounts.
            </p>
            <input
              value={withdrawAmount}
              onChange={(e) =>
                setWithdrawAmount(e.target.value.replace(/\D/g, ""))
              }
              inputMode="numeric"
              placeholder={`Amount in ${currencyCode}`}
              data-testid="input-withdraw-amount"
              className={`w-full px-3 py-2 rounded-lg border text-sm ${
                isDark
                  ? "bg-black/40 border-white/10 text-white"
                  : "bg-white border-stone-300 text-stone-900"
              }`}
            />
            <button
              onClick={() => {
                const major = Number(withdrawAmount || "0");
                if (!major) return;
                const minor = major * country.currency.minorPerMajor;
                if (!withdraw(minor, "GTBank ••3210")) {
                  toast({
                    title: "Not enough balance",
                    description: "Top up first or pick a smaller amount.",
                  });
                  return;
                }
                toast({
                  title: "Withdrawal sent",
                  description: `${formatPrice(minor, currencyCode)} to GTBank ••3210`,
                });
                setWithdrawAmount("");
                setShowWithdraw(false);
              }}
              data-testid="button-confirm-withdraw"
              className={`w-full mt-3 py-3 rounded-full font-bold text-sm ${
                isDark ? "bg-[#FF8855] text-white" : "bg-[#E6502E] text-white"
              }`}
            >
              Confirm withdrawal
            </button>
            <button
              onClick={() => setShowWithdraw(false)}
              data-testid="button-close-withdraw"
              className={`w-full mt-2 py-2 rounded-full text-sm font-bold ${
                isDark ? "bg-white/10" : "bg-stone-200"
              }`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TxnIcon({ kind, isDark }: { kind: WalletTxnKind; isDark: boolean }) {
  const Icon =
    kind === "topup"
      ? ArrowDownToLine
      : kind === "withdrawal"
        ? ArrowUpFromLine
        : kind === "refund"
          ? RotateCcw
          : kind === "promo"
            ? Sparkles
            : ShoppingBag;
  const tone = (() => {
    switch (kind) {
      case "topup":
      case "refund":
      case "promo":
        return isDark
          ? "bg-emerald-400/20 text-emerald-300"
          : "bg-emerald-600/15 text-emerald-700";
      case "withdrawal":
      case "spend":
        return isDark ? "bg-white/10 text-white/70" : "bg-stone-200 text-stone-600";
    }
  })();
  return (
    <div
      className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${tone}`}
    >
      <Icon className="w-4 h-4" />
    </div>
  );
}
