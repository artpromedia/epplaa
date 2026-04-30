import { useState } from "react";
import { Link } from "wouter";
import {
  Wallet,
  TrendingUp,
  Receipt,
  Clock,
  CheckCircle2,
  AlertCircle,
  X,
  ArrowDownToLine,
  Sparkles,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { useSellerEarnings } from "@/lib/earnings";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";

export default function SellerEarnings() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { status, application } = useSeller();
  const { summary, requestPayout, markPayoutPaid } = useSellerEarnings(country);
  const { toast } = useToast();

  const [showPayout, setShowPayout] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState<string>("");

  if (status !== "approved" || !application) {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Earnings" backHref="/seller/studio" />
        <div className="px-6 py-12 text-center space-y-3">
          <Wallet
            className={`w-10 h-10 mx-auto ${
              isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
            }`}
          />
          <p className="font-bold">You need a seller account first</p>
          <Link
            href="/seller/apply"
            className={`inline-block px-6 py-3 rounded-full font-bold ${
              isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
            }`}
            data-testid="link-apply-from-earnings"
          >
            Become a Seller
          </Link>
        </div>
      </div>
    );
  }

  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const cardBorder = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  const aboveThreshold = summary.availableMinor >= summary.payoutThresholdMinor;

  function openPayout() {
    setPayoutAmount(String(summary.availableMinor / country.currency.minorPerMajor));
    setShowPayout(true);
  }

  function submitPayout() {
    const major = Number(payoutAmount);
    if (!Number.isFinite(major) || major <= 0) {
      toast({ title: "Enter a valid amount" });
      return;
    }
    const minor = Math.round(major * country.currency.minorPerMajor);
    if (minor > summary.availableMinor) {
      toast({ title: "Amount exceeds available balance" });
      return;
    }
    if (minor < summary.payoutThresholdMinor) {
      toast({
        title: `Minimum payout is ${formatPrice(summary.payoutThresholdMinor, country)}`,
      });
      return;
    }
    const req = requestPayout(minor);
    if (req) {
      toast({
        title: "Payout requested",
        description: `${formatPrice(minor, country)} → ${req.bankLabel} ••${req.bankLast4}`,
      });
      setShowPayout(false);
    }
  }

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Earnings" backHref="/seller/studio" />
      <div className="px-4 pb-24 space-y-5">
        {/* Available balance hero */}
        <div
          className={`rounded-2xl p-5 border-2 ${
            isDark
              ? "border-[#5BA3F5]/40 bg-gradient-to-br from-[#5BA3F5]/15 to-transparent"
              : "border-[#1B2A4A]/30 bg-gradient-to-br from-[#1B2A4A]/10 to-transparent"
          }`}
          data-testid="balance-card"
        >
          <p
            className={`text-[11px] font-bold uppercase tracking-wider ${subtle}`}
          >
            Available to withdraw
          </p>
          <p
            className={`text-4xl font-black mt-1 ${
              isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
            }`}
            data-testid="text-available-balance"
          >
            {formatPrice(summary.availableMinor, country)}
          </p>
          <p className={`text-xs mt-1 ${subtle}`}>
            Min payout {formatPrice(summary.payoutThresholdMinor, country)} ·{" "}
            {summary.holdDays}-day clearing hold
          </p>
          <button
            onClick={openPayout}
            disabled={!aboveThreshold}
            className={`mt-4 w-full h-12 rounded-full font-bold flex items-center justify-center gap-2 ${
              aboveThreshold
                ? isDark
                  ? "bg-[#5BA3F5] text-black hover:bg-[#3D7BC4]"
                  : "bg-[#1B2A4A] text-white hover:bg-[#0F1E3A]"
                : isDark
                  ? "bg-white/10 text-white/40"
                  : "bg-stone-200 text-stone-400"
            }`}
            data-testid="button-request-payout"
          >
            <ArrowDownToLine className="w-4 h-4" />
            {aboveThreshold ? "Request payout" : `Min ${formatPrice(summary.payoutThresholdMinor, country)} required`}
          </button>
          <p className={`text-[11px] mt-2 ${subtle}`}>
            Payouts go to {application.payoutBank} ••{application.payoutAccountLast4}{" "}
            via {country.payoutAuthority}.
          </p>
        </div>

        {/* GMV stats */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            isDark={isDark}
            icon={<TrendingUp className="w-4 h-4" />}
            label="This month GMV"
            value={formatPrice(summary.thisMonthGmvMinor, country)}
            testId="stat-month-gmv"
          />
          <StatCard
            isDark={isDark}
            icon={<Receipt className="w-4 h-4" />}
            label="Lifetime GMV"
            value={formatPrice(summary.lifetimeGmvMinor, country)}
            testId="stat-lifetime-gmv"
          />
          <StatCard
            isDark={isDark}
            icon={<Sparkles className="w-4 h-4" />}
            label="Net earnings"
            value={formatPrice(summary.netLifetimeMinor, country)}
            sub={`After 10% platform fee`}
            testId="stat-net"
          />
          <StatCard
            isDark={isDark}
            icon={<CheckCircle2 className="w-4 h-4" />}
            label="Paid out"
            value={formatPrice(summary.paidOutMinor, country)}
            testId="stat-paid"
          />
        </div>

        {summary.pendingPayoutMinor > 0 && (
          <div
            className={`rounded-xl border p-4 flex items-center gap-3 ${
              isDark
                ? "border-amber-500/30 bg-amber-500/10"
                : "border-amber-500/30 bg-amber-50"
            }`}
            data-testid="banner-pending-payouts"
          >
            <Clock
              className={`w-5 h-5 shrink-0 ${
                isDark ? "text-amber-300" : "text-amber-600"
              }`}
            />
            <div className="flex-1">
              <p className="text-sm font-bold">
                {formatPrice(summary.pendingPayoutMinor, country)} clearing
              </p>
              <p className={`text-xs ${subtle}`}>
                Pending payouts arrive in 1-3 business days.
              </p>
            </div>
          </div>
        )}

        {/* Payout history */}
        <div>
          <h3
            className={`text-sm font-bold mb-3 uppercase tracking-wider ${
              isDark ? "text-white/40" : "text-stone-400"
            }`}
          >
            Payout history
          </h3>
          {summary.payouts.length === 0 ? (
            <div
              className={`rounded-xl border p-6 text-center ${cardBorder}`}
              data-testid="empty-payouts"
            >
              <Wallet
                className={`w-8 h-8 mx-auto mb-2 ${
                  isDark ? "text-white/30" : "text-stone-400"
                }`}
              />
              <p className={`text-sm ${subtle}`}>No payouts yet</p>
            </div>
          ) : (
            <div
              className={`rounded-xl border overflow-hidden ${cardBorder}`}
            >
              {summary.payouts.map((p, i) => (
                <div
                  key={p.id}
                  data-testid={`payout-row-${p.id}`}
                  className={`p-4 ${
                    i < summary.payouts.length - 1
                      ? isDark
                        ? "border-b border-white/10"
                        : "border-b border-stone-200"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-sm">
                        {formatPrice(p.amountMinor, country)}
                      </p>
                      <p className={`text-xs ${subtle}`}>
                        {p.bankLabel} ••{p.bankLast4} · {p.reference}
                      </p>
                      <p className={`text-[11px] mt-0.5 ${subtle}`}>
                        Requested {new Date(p.requestedAtIso).toLocaleString()}
                      </p>
                    </div>
                    <PayoutStatusBadge status={p.status} isDark={isDark} />
                  </div>
                  {p.status === "blocked" && p.errorMessage && (
                    <div
                      className={`mt-2 text-[11px] rounded-md px-2 py-1.5 ${
                        isDark
                          ? "bg-red-500/10 text-red-300 border border-red-500/30"
                          : "bg-red-50 text-red-800 border border-red-200"
                      }`}
                      data-testid={`payout-block-reason-${p.id}`}
                    >
                      {p.errorMessage.startsWith("kyc_tier_required")
                        ? `Verify Tier ${p.requiredKycTier ?? 2} KYC to release this payout.`
                        : p.errorMessage === "sanctions_review_required"
                          ? "Compliance review required — contact support."
                          : p.errorMessage}
                    </div>
                  )}
                  {p.status === "pending" && (
                    <button
                      onClick={() => {
                        markPayoutPaid(p.id);
                        toast({ title: "Marked as paid (demo)" });
                      }}
                      className={`mt-3 w-full text-xs py-1.5 rounded-full font-bold ${
                        isDark
                          ? "bg-white/10 hover:bg-white/15"
                          : "bg-stone-200 hover:bg-stone-300"
                      }`}
                      data-testid={`button-mark-paid-${p.id}`}
                    >
                      Demo: mark as paid
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className={`rounded-xl border p-4 ${cardBorder}`}
        >
          <p className="text-xs font-bold uppercase tracking-wider mb-2">
            How earnings work
          </p>
          <ul className={`text-xs space-y-1 ${subtle} list-disc pl-4`}>
            <li>You earn 90% of every order (10% platform fee).</li>
            <li>
              Funds clear after {summary.holdDays} days from order confirmation.
            </li>
            <li>
              Payouts settle to your registered bank via {country.payoutAuthority}.
            </li>
            <li>
              Minimum payout is {formatPrice(summary.payoutThresholdMinor, country)}.
            </li>
          </ul>
        </div>
      </div>

      {showPayout && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60">
          <div
            className={`w-full max-w-md rounded-t-2xl p-5 ${
              isDark ? "bg-[#171C30] text-white" : "bg-white text-stone-900"
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-lg font-bold">Request payout</h4>
              <button
                onClick={() => setShowPayout(false)}
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  isDark ? "hover:bg-white/10" : "hover:bg-stone-100"
                }`}
                data-testid="button-close-payout"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div
              className={`rounded-lg p-3 mb-4 ${
                isDark ? "bg-white/5" : "bg-stone-100"
              }`}
            >
              <p className={`text-[11px] uppercase tracking-wider ${subtle}`}>
                Available
              </p>
              <p className="text-xl font-black">
                {formatPrice(summary.availableMinor, country)}
              </p>
            </div>
            <label className="block text-sm font-bold mb-1">
              Amount ({country.currency.code})
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={payoutAmount}
              onChange={(e) => setPayoutAmount(e.target.value)}
              data-testid="input-payout-amount"
              className={`w-full px-3 py-3 rounded-lg border text-lg font-bold outline-none ${
                isDark
                  ? "bg-black/40 border-white/10 text-white"
                  : "bg-white border-stone-300 text-stone-900"
              }`}
            />
            <p className={`text-xs mt-2 ${subtle}`}>
              To {application.payoutBank} ••{application.payoutAccountLast4}
            </p>
            {summary.availableMinor < summary.payoutThresholdMinor && (
              <div
                className={`mt-3 p-2 rounded-lg flex items-start gap-2 text-xs ${
                  isDark ? "bg-amber-500/10 text-amber-200" : "bg-amber-50 text-amber-800"
                }`}
              >
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Minimum payout is {formatPrice(summary.payoutThresholdMinor, country)}.
                </span>
              </div>
            )}
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowPayout(false)}
                className={`flex-1 h-11 rounded-full font-bold ${
                  isDark
                    ? "bg-white/10 hover:bg-white/15"
                    : "bg-stone-200 hover:bg-stone-300"
                }`}
                data-testid="button-cancel-payout"
              >
                Cancel
              </button>
              <button
                onClick={submitPayout}
                className={`flex-1 h-11 rounded-full font-black ${
                  isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
                }`}
                data-testid="button-submit-payout"
              >
                Request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  isDark,
  icon,
  label,
  value,
  sub,
  testId,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-xl border p-3 ${
        isDark
          ? "bg-white/5 border-white/10"
          : "bg-white border-stone-400/35"
      }`}
    >
      <div
        className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${
          isDark ? "text-white/40" : "text-stone-400"
        }`}
      >
        {icon}
        {label}
      </div>
      <p className="text-base font-bold mt-1 truncate">{value}</p>
      {sub && (
        <p
          className={`text-[10px] mt-0.5 ${
            isDark ? "text-white/40" : "text-stone-400"
          }`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function PayoutStatusBadge({
  status,
  isDark,
}: {
  status: "pending" | "paid" | "rejected" | "blocked" | "processing" | "scheduled" | "cancelled";
  isDark: boolean;
}) {
  const map: Record<string, string> = {
    pending: isDark
      ? "bg-amber-500/15 text-amber-300"
      : "bg-amber-100 text-amber-800",
    paid: isDark
      ? "bg-emerald-500/15 text-emerald-300"
      : "bg-emerald-100 text-emerald-800",
    rejected: isDark
      ? "bg-red-500/15 text-red-300"
      : "bg-red-100 text-red-800",
    blocked: isDark
      ? "bg-red-500/15 text-red-300"
      : "bg-red-100 text-red-800",
    processing: isDark
      ? "bg-sky-500/15 text-sky-300"
      : "bg-sky-100 text-sky-800",
    scheduled: isDark
      ? "bg-stone-500/15 text-stone-300"
      : "bg-stone-200 text-stone-800",
    cancelled: isDark
      ? "bg-stone-500/15 text-stone-300"
      : "bg-stone-200 text-stone-800",
  };
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${map[status] ?? map.pending}`}
    >
      {status}
    </span>
  );
}
