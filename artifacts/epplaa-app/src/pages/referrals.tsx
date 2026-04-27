import { useMemo, useState } from "react";
import {
  Gift,
  Copy,
  Share2,
  Check,
  Users,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useWallet } from "@/lib/wallet-context";
import {
  REFERRAL_REWARDS,
  SEED_REFERRAL_ACTIVITY,
  buildShareLink,
  generateReferralCode,
} from "@/lib/referrals";
import { formatPrice } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/hooks/use-toast";
import { useGetMyReferrals } from "@workspace/api-client-react";

export default function ReferralsHub() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { topUp } = useWallet();
  const { toast } = useToast();

  const referralsQuery = useGetMyReferrals();
  const code = referralsQuery.data?.code ?? generateReferralCode();
  const shareLink = useMemo(() => buildShareLink(code), [code]);
  const activity = SEED_REFERRAL_ACTIVITY;
  const totalEarnedMinor = activity.reduce(
    (s, a) => s + (a.status === "rewarded" ? a.rewardMinor : 0),
    0,
  );

  const [copied, setCopied] = useState(false);
  const subtle = isDark ? "text-white/55" : "text-stone-500";
  const card = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";

  function copyCode() {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
        toast({ title: "Code copied", description: code });
      })
      .catch(() => {
        toast({ title: "Could not copy", description: "Try long-press" });
      });
  }

  function share() {
    if (navigator.share) {
      navigator
        .share({
          title: "Join me on Epplaa",
          text: `Use my code ${code} for 500 NGN off your first order.`,
          url: shareLink,
        })
        .catch(() => {
          /* user cancelled */
        });
    } else {
      navigator.clipboard.writeText(shareLink);
      toast({
        title: "Link copied",
        description: "Paste it in WhatsApp, X, or anywhere.",
      });
    }
  }

  function claimDemoCredit() {
    topUp(REFERRAL_REWARDS.firstPurchaseMinor, "Friend joined with your code");
    toast({
      title: "Wallet credited",
      description: `+${formatPrice(REFERRAL_REWARDS.firstPurchaseMinor, country.currency.code)}`,
    });
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Refer & earn" backHref="/profile" />

      <div className="px-4 pb-24 space-y-6">
        <div
          className={`relative overflow-hidden rounded-3xl p-5 text-white ${
            isDark
              ? "bg-gradient-to-br from-[#FF8855] via-[#FF6B35] to-[#E6502E] shadow-[0_0_40px_rgba(255,136,85,0.4)]"
              : "bg-gradient-to-br from-[#E6502E] via-[#C4441E] to-[#1B2A4A] shadow-lg"
          }`}
          data-testid="referral-hero"
        >
          <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white/10 blur-2xl" />
          <div className="relative">
            <Gift className="w-7 h-7" />
            <p className="text-xs font-bold uppercase tracking-wider mt-2 opacity-80">
              You earn
            </p>
            <p className="text-3xl font-black mt-1">
              {formatPrice(REFERRAL_REWARDS.rewardMinor, country.currency.code)}
            </p>
            <p className="text-sm opacity-90 mt-1">
              for every friend who orders. Friend gets{" "}
              {formatPrice(
                REFERRAL_REWARDS.firstPurchaseMinor,
                country.currency.code,
              )}{" "}
              off their first buy.
            </p>
          </div>
        </div>

        <div className={`rounded-2xl border p-4 ${card}`}>
          <p className={`text-xs font-bold uppercase tracking-wider ${subtle}`}>
            Your invite code
          </p>
          <div className="mt-2 flex items-center gap-3">
            <p
              className={`text-2xl font-black font-mono tracking-widest flex-1 ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
              data-testid="referral-code"
            >
              {code}
            </p>
            <button
              onClick={copyCode}
              data-testid="button-copy-code"
              className={`h-10 w-10 rounded-full flex items-center justify-center border ${
                isDark
                  ? "border-white/15 hover:bg-white/10"
                  : "border-stone-300 hover:bg-stone-100"
              }`}
              aria-label="Copy code"
            >
              {copied ? (
                <Check className="w-4 h-4 text-emerald-500" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
          <button
            onClick={share}
            data-testid="button-share-referral"
            className={`mt-4 w-full h-12 rounded-xl font-bold text-sm flex items-center justify-center gap-2 text-white ${
              isDark
                ? "bg-gradient-to-r from-[#FF8855] to-[#FF6B35] shadow-[0_0_18px_rgba(255,136,85,0.4)]"
                : "bg-gradient-to-r from-[#E6502E] to-[#C4441E] shadow-md"
            }`}
          >
            <Share2 className="w-4 h-4" />
            Share to WhatsApp, X, anywhere
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Stat
            isDark={isDark}
            icon={<Users className="w-4 h-4" />}
            label="Friends joined"
            value={activity.length.toString()}
          />
          <Stat
            isDark={isDark}
            icon={<TrendingUp className="w-4 h-4" />}
            label="Total earned"
            value={formatPrice(totalEarnedMinor, country.currency.code)}
          />
        </div>

        <div>
          <h3
            className={`text-sm font-bold mb-3 uppercase tracking-wider ${subtle}`}
          >
            Recent activity
          </h3>
          <div className={`rounded-xl border overflow-hidden ${card}`}>
            {activity.map((a, idx) => (
              <div
                key={a.id}
                data-testid={`referral-activity-${a.id}`}
                className={`p-3 flex items-center justify-between ${
                  idx > 0
                    ? isDark
                      ? "border-t border-white/10"
                      : "border-t border-stone-200"
                    : ""
                }`}
              >
                <div>
                  <p className="text-sm font-bold">{a.inviteeHandle}</p>
                  <p className={`text-xs ${subtle}`}>
                    {a.status === "joined"
                      ? "Joined"
                      : a.status === "first_purchase"
                        ? "Made first purchase"
                        : "Reward credited"}{" "}
                    · {new Date(a.atIso).toLocaleDateString()}
                  </p>
                </div>
                {a.rewardMinor > 0 && (
                  <span
                    className={`text-xs font-black ${
                      isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                    }`}
                  >
                    +{formatPrice(a.rewardMinor, country.currency.code)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={claimDemoCredit}
          data-testid="button-demo-credit"
          className={`w-full rounded-xl border-dashed border-2 p-3 flex items-center justify-center gap-2 text-xs font-bold ${
            isDark
              ? "border-white/15 text-white/60"
              : "border-stone-300 text-stone-500"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          Simulate a friend ordering (credits your wallet)
        </button>

        <p className={`text-xs leading-relaxed ${subtle}`}>
          Capped at{" "}
          {formatPrice(
            REFERRAL_REWARDS.monthlyCapMinor,
            country.currency.code,
          )}{" "}
          per calendar month. Self-referrals don't count. We reverse rewards on
          chargebacks.
        </p>
      </div>
    </div>
  );
}

function Stat({
  isDark,
  icon,
  label,
  value,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        isDark
          ? "bg-white/5 border-white/10"
          : "bg-white border-stone-400/35"
      }`}
    >
      <div
        className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${
          isDark ? "text-white/50" : "text-stone-500"
        }`}
      >
        {icon}
        {label}
      </div>
      <p className="text-lg font-black mt-1">{value}</p>
    </div>
  );
}
