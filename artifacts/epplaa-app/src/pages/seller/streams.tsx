import { Link } from "wouter";
import { Eye, Users, Clock, ShoppingBag, Radio } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useSeller } from "@/lib/seller-context";
import { useSellerStreams, summarizeStreams } from "@/lib/seller-streams";
import { formatPrice } from "@/lib/format";
import { relativeTime } from "@/lib/replays";
import { PageHeader } from "@/components/page-header";

export default function SellerStreams() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { status } = useSeller();
  const { streams } = useSellerStreams();

  if (status !== "approved") {
    return (
      <div className="flex flex-col h-full w-full">
        <PageHeader title="Streams" backHref="/seller/studio" />
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
  const summary = summarizeStreams(streams);

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Stream history" backHref="/seller/studio" />

      <div className="px-4 pb-24">
        <div
          className={`grid grid-cols-2 gap-2 mb-4`}
          data-testid="streams-summary"
        >
          <Stat
            label="Streams"
            value={summary.totalStreams.toString()}
            isDark={isDark}
            cardClass={cardClass}
          />
          <Stat
            label="Total minutes"
            value={summary.totalMinutes.toString()}
            isDark={isDark}
            cardClass={cardClass}
          />
          <Stat
            label="Peak viewers"
            value={summary.peakViewers.toLocaleString()}
            isDark={isDark}
            cardClass={cardClass}
          />
          <Stat
            label="Orders driven"
            value={summary.totalOrders.toString()}
            isDark={isDark}
            cardClass={cardClass}
          />
        </div>

        <div
          className={`rounded-xl border p-3 mb-4 flex items-center justify-between ${cardClass}`}
        >
          <div>
            <p className={`text-[10px] font-bold uppercase tracking-wider ${subtle}`}>
              Lifetime gross from live
            </p>
            <p className="text-2xl font-black">
              {formatPrice(summary.grossMinor, "NGN")}
            </p>
          </div>
          <Link
            href="/seller/go-live"
            data-testid="link-go-live-from-streams"
            className={`px-4 py-2 rounded-full text-sm font-bold flex items-center gap-1 ${
              isDark ? "bg-[#FF8855] text-white" : "bg-[#E6502E] text-white"
            }`}
          >
            <Radio className="w-4 h-4" /> Go live
          </Link>
        </div>

        {streams.length === 0 ? (
          <div className={`rounded-xl border p-8 text-center ${cardClass}`}>
            <Radio
              className={`w-10 h-10 mx-auto mb-3 ${
                isDark ? "text-white/30" : "text-stone-400"
              }`}
            />
            <p className="font-bold mb-1">No streams yet</p>
            <p className={`text-sm ${subtle}`}>
              Tap Go live to broadcast your first session.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {streams.map((s) => (
              <div
                key={s.id}
                className={`rounded-xl border overflow-hidden ${cardClass}`}
                data-testid={`stream-row-${s.id}`}
              >
                <div className="flex gap-3 p-3">
                  <div className="relative w-24 h-24 shrink-0">
                    <img
                      src={s.posterImage}
                      alt=""
                      className="w-full h-full object-cover rounded-lg"
                    />
                    <div className="absolute bottom-1 left-1 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                      {s.durationMinutes}m
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm leading-tight line-clamp-2">
                      {s.title}
                    </p>
                    <p className={`text-[11px] mt-0.5 ${subtle}`}>
                      {s.category} · {relativeTime(s.startedAtIso)}
                    </p>
                    <div className="flex items-center gap-3 mt-2 text-[11px]">
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" /> {s.peakViewers}
                      </span>
                      <span className="flex items-center gap-1">
                        <Eye className="w-3 h-3" /> {s.totalViewers}
                      </span>
                      <span className="flex items-center gap-1">
                        <ShoppingBag className="w-3 h-3" /> {s.ordersCount}
                      </span>
                    </div>
                    <p
                      className={`text-sm font-bold mt-1 ${
                        isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                      }`}
                    >
                      {formatPrice(s.grossMinor, "NGN")}
                    </p>
                  </div>
                </div>
                <div
                  className={`px-3 py-2 text-[11px] flex items-center gap-1 border-t ${
                    isDark
                      ? "border-white/10 text-white/40"
                      : "border-stone-200 text-stone-500"
                  }`}
                >
                  <Clock className="w-3 h-3" />
                  Started {new Date(s.startedAtIso).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  isDark,
  cardClass,
}: {
  label: string;
  value: string;
  isDark: boolean;
  cardClass: string;
}) {
  return (
    <div className={`rounded-xl border p-3 ${cardClass}`}>
      <p
        className={`text-[10px] font-bold uppercase tracking-wider ${
          isDark ? "text-white/40" : "text-stone-400"
        }`}
      >
        {label}
      </p>
      <p className="text-xl font-black mt-0.5">{value}</p>
    </div>
  );
}
