import { useState } from "react";
import { Link } from "wouter";
import { sellerGoLiveBroadcast } from "@workspace/api-client-react";
import {
  Radio,
  Square,
  Heart,
  MessageCircle,
  Share,
  Eye,
  Sparkles,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { TIERS } from "@/lib/seller-tiers";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
import { TierBadge } from "@/components/tier-badge";
import { useToast } from "@/hooks/use-toast";

const CATEGORIES = [
  "Beauty",
  "Fashion",
  "Phones & Tech",
  "Home & Living",
  "Food & Drinks",
  "Kids",
  "Other",
];

export default function SellerGoLive() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { status, tier, listings, application, recordBroadcast, setIsBroadcasting } = useSeller();
  const { toast } = useToast();

  const [streamTitle, setStreamTitle] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [selectedListings, setSelectedListings] = useState<string[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [viewers] = useState(() => Math.floor(Math.random() * 80) + 12);

  if (status !== "approved") {
    return <NotApprovedState isDark={isDark} />;
  }

  const def = TIERS[tier];
  const cardClass = isDark
    ? "bg-white/5 border-white/10"
    : "bg-white border-stone-400/35";
  const subtleText = isDark ? "text-white/50" : "text-stone-500";
  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-[#5BA3F5]/30 ${
    isDark
      ? "bg-black/40 border-white/10 text-white placeholder:text-white/30"
      : "bg-white border-stone-300 text-stone-900 placeholder:text-stone-400"
  }`;

  const activeListings = listings.filter((l) => l.status === "active");

  function toggleListing(id: string) {
    setSelectedListings((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function startBroadcast() {
    const trimmed = streamTitle.trim();
    if (!trimmed) {
      toast({ title: "Give your stream a title" });
      return;
    }
    if (selectedListings.length === 0) {
      toast({ title: "Pin at least one product to feature" });
      return;
    }
    recordBroadcast({
      title: trimmed,
      category,
      listingIds: selectedListings,
    });
    setIsLive(true);
    setIsBroadcasting(true);
    toast({
      title: "You're live!",
      description: `Streaming "${trimmed}" to ${viewers} viewers.`,
    });
    // Fire follower fan-out via backend. Best-effort — UI is already live.
    const handle = application?.storeHandle;
    if (handle) {
      try {
        await sellerGoLiveBroadcast({ storeHandle: handle, title: trimmed });
      } catch {
        // Swallow: notifications are non-critical for the live experience.
      }
    }
  }

  function endBroadcast() {
    setIsLive(false);
    setIsBroadcasting(false);
    toast({
      title: "Stream ended",
      description: `Recorded ${viewers} peak viewers. Replay saved to your storefront.`,
    });
    setStreamTitle("");
    setSelectedListings([]);
  }

  if (isLive) {
    return (
      <LiveBroadcastView
        isDark={isDark}
        title={streamTitle}
        viewers={viewers}
        featured={listings.filter((l) => selectedListings.includes(l.id))}
        country={country}
        storeHandle={application?.storeHandle ?? "you"}
        onEnd={endBroadcast}
      />
    );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-xl font-bold">Go Live</h1>
            <TierBadge tier={tier} />
          </div>
          <ThemeToggle />
        </div>
      </div>

      <div className="px-4 pb-24 space-y-4">
        <div className={`rounded-xl border p-4 space-y-3 ${cardClass}`}>
          <p className={`text-xs ${subtleText}`}>
            {def.label} tier · up to {def.maxLiveHoursPerDay ?? "∞"} hour(s)
            per day
          </p>
          <div>
            <label className="block text-sm font-bold mb-1">Stream title</label>
            <input
              value={streamTitle}
              onChange={(e) => setStreamTitle(e.target.value.slice(0, 80))}
              placeholder="Friday night drop, Glow up szn ✨"
              className={inputClass}
              data-testid="input-stream-title"
            />
            <p className={`text-xs mt-1 ${subtleText}`}>
              {streamTitle.length}/80
            </p>
          </div>
          <div>
            <label className="block text-sm font-bold mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={inputClass}
              data-testid="select-stream-category"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={`rounded-xl border p-4 ${cardClass}`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold">Pin products to feature</h3>
            <span className={`text-xs ${subtleText}`}>
              {selectedListings.length} selected
            </span>
          </div>
          {activeListings.length === 0 ? (
            <div className="text-center py-6">
              <p className={`text-sm mb-3 ${subtleText}`}>
                You don't have active listings to feature yet.
              </p>
              <Link
                href="/seller/listings"
                className={`inline-block px-4 py-2 rounded-full font-bold text-sm ${
                  isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
                }`}
              >
                Add a listing
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {activeListings.map((l) => {
                const selected = selectedListings.includes(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => toggleListing(l.id)}
                    className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-colors ${
                      selected
                        ? isDark
                          ? "bg-[#FF8855]/10 border-[#FF8855]/30"
                          : "bg-[#E6502E]/10 border-[#E6502E]/30"
                        : isDark
                          ? "bg-black/40 border-white/10 hover:bg-white/5"
                          : "bg-white border-stone-300 hover:bg-stone-50"
                    }`}
                    data-testid={`pin-listing-${l.id}`}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{l.title}</p>
                      <p
                        className={`text-sm font-bold ${
                          isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                        }`}
                      >
                        {formatPrice(l.priceMinor, country)}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-1 rounded ${
                        selected
                          ? isDark
                            ? "bg-[#FF8855] text-white"
                            : "bg-[#E6502E] text-white"
                          : isDark
                            ? "bg-white/10 text-white/50"
                            : "bg-stone-200 text-stone-500"
                      }`}
                    >
                      {selected ? "PINNED" : "PIN"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={startBroadcast}
          disabled={activeListings.length === 0}
          className={`w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-base ${
            isDark
              ? "bg-gradient-to-r from-[#FF8855] to-[#5BA3F5] text-black disabled:from-white/10 disabled:to-white/10 disabled:text-white/30"
              : "bg-gradient-to-r from-[#E6502E] to-[#1B2A4A] text-white disabled:from-stone-200 disabled:to-stone-200 disabled:text-stone-400"
          }`}
          data-testid="button-start-broadcast"
        >
          <Radio className="w-5 h-5" />
          Start broadcast
        </button>
      </div>
    </div>
  );
}

function LiveBroadcastView({
  isDark: _isDark,
  title,
  viewers,
  featured,
  country,
  storeHandle,
  onEnd,
}: {
  isDark: boolean;
  title: string;
  viewers: number;
  featured: ReturnType<typeof useSeller>["listings"];
  country: ReturnType<typeof useCountry>["country"];
  storeHandle: string;
  onEnd: () => void;
}) {
  const headline = featured[0];

  return (
    <div className="absolute inset-0 bg-gradient-to-br from-[#1a0033] via-black to-[#001a1a] text-white overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,136,85,0.25),transparent_60%),radial-gradient(ellipse_at_bottom,rgba(91,163,245,0.2),transparent_55%)]" />

      <div className="relative h-full flex flex-col">
        <div className="pt-12 pb-3 px-4 flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="bg-[#FF8855] text-white text-[10px] font-bold px-2 py-1 rounded">
              ● LIVE
            </span>
            <span className="text-sm font-bold truncate">@{storeHandle}</span>
          </div>
          <div className="flex items-center gap-1 bg-black/40 rounded-full px-3 py-1 backdrop-blur">
            <Eye className="w-3.5 h-3.5" />
            <span className="text-xs font-bold">
              {viewers.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="px-4">
          <p className="text-base font-bold leading-tight">{title}</p>
        </div>

        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <Radio className="w-16 h-16 mx-auto mb-4 text-[#5BA3F5] animate-pulse" />
            <p className="font-bold text-lg mb-1">You're broadcasting</p>
            <p className="text-sm text-white/60 max-w-xs">
              In production, your camera feed shows here. Buyers chat, react,
              and tap pinned products to buy live.
            </p>
          </div>
        </div>

        {headline && (
          <div className="absolute right-3 bottom-32 max-w-[200px] bg-black/60 backdrop-blur rounded-lg p-3 border border-white/15">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#5BA3F5] mb-1">
              Pinned now
            </p>
            <p className="text-sm font-bold leading-tight mb-1 line-clamp-2">
              {headline.title}
            </p>
            <p className="text-base font-bold text-[#5BA3F5]">
              {formatPrice(headline.priceMinor, country)}
            </p>
            <button className="mt-2 w-full py-1.5 bg-[#FF8855] text-white text-xs font-bold rounded-full">
              Buy now
            </button>
          </div>
        )}

        <div className="absolute right-3 bottom-3 flex flex-col items-center gap-3">
          <Sparkles className="w-7 h-7 text-white/70" />
          <Heart className="w-7 h-7 text-white/70" />
          <MessageCircle className="w-7 h-7 text-white/70" />
          <Share className="w-7 h-7 text-white/70" />
        </div>

        <div className="absolute bottom-3 left-3 right-20 space-y-2 pointer-events-none">
          <div className="bg-black/40 backdrop-blur rounded-full px-3 py-1.5 max-w-fit">
            <span className="text-xs">
              <strong>chika_styles</strong> is this still in stock? 👀
            </span>
          </div>
          <div className="bg-black/40 backdrop-blur rounded-full px-3 py-1.5 max-w-fit">
            <span className="text-xs">
              <strong>tobi.lagos</strong> dropping a follow!
            </span>
          </div>
        </div>

        <div className="px-4 pb-12 pt-3 flex justify-center pointer-events-auto">
          <button
            onClick={onEnd}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-white/10 backdrop-blur border border-white/20 text-white font-bold hover:bg-white/15"
            data-testid="button-end-broadcast"
          >
            <Square className="w-4 h-4" />
            End broadcast
          </button>
        </div>
      </div>
    </div>
  );
}

function NotApprovedState({ isDark }: { isDark: boolean }) {
  return (
    <div className="flex flex-col h-full w-full">
      <div
        className={`pt-12 pb-4 px-4 z-10 sticky top-0 ${
          isDark ? "bg-[#0F1525]" : "bg-[#fbeed3]"
        }`}
      >
        <h1 className="text-xl font-bold">Go Live</h1>
      </div>
      <div className="px-6 py-12 text-center space-y-4">
        <Radio
          className={`w-10 h-10 mx-auto ${
            isDark ? "text-[#FF8855]" : "text-[#E6502E]"
          }`}
        />
        <p className="font-bold text-lg">Live broadcasting is for sellers</p>
        <p
          className={`text-sm ${
            isDark ? "text-white/50" : "text-stone-500"
          }`}
        >
          Become a vetted seller to broadcast products to buyers in real time.
          Vetting takes about 24-48 hours.
        </p>
        <Link
          href="/seller/apply"
          className={`inline-block px-6 py-3 rounded-full font-bold ${
            isDark ? "bg-[#5BA3F5] text-black" : "bg-[#1B2A4A] text-white"
          }`}
          data-testid="button-apply-from-go-live"
        >
          Become a Seller
        </Link>
        <div>
          <Link
            href="/seller/tiers"
            className={`text-sm font-bold ${
              isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
            }`}
          >
            See seller tiers →
          </Link>
        </div>
      </div>
    </div>
  );
}
