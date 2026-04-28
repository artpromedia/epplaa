import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  createStream,
  startStream,
  stopStream,
  rotateStreamKey,
  getStreamPlayback,
  listStreamMessages,
  deleteStreamMessage,
  updateStreamModConfig,
  type StreamWithSecrets,
  type StreamChatMessage,
} from "@workspace/api-client-react";
import {
  Radio,
  Square,
  Eye,
  Sparkles,
  Copy,
  Eye as EyeIcon,
  EyeOff,
  RefreshCw,
  Trash2,
  ShieldAlert,
} from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { useSeller } from "@/lib/seller-context";
import { TIERS, tierIndex } from "@/lib/seller-tiers";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
import { TierBadge } from "@/components/tier-badge";
import { useToast } from "@/hooks/use-toast";
import { connectStreamSocket } from "@/lib/stream-socket";

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
  const [stream, setStream] = useState<StreamWithSecrets | null>(null);
  const [creating, setCreating] = useState(false);

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
    setCreating(true);
    try {
      const created = await createStream({
        title: trimmed,
        currentProductId: selectedListings[0],
      });
      const started = await startStream(created.id);
      recordBroadcast({
        title: trimmed,
        category,
        listingIds: selectedListings,
      });
      setIsBroadcasting(true);
      setStream(started);
      toast({
        title: "You're live!",
        description: started.provider === "stub"
          ? "Streaming via dev stub. Configure CF_STREAM_API_TOKEN for real ingest."
          : `Point OBS at the RTMP URL with your stream key.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The API returns 403 with `kyc_tier_required` when seller hasn't
      // hit Tier 2 yet — give the host a clean nudge instead of a raw error.
      if (msg.includes("kyc_tier_required")) {
        toast({
          title: "KYC Tier 2 required to go live",
          description: "Verify your identity in Settings to unlock live streaming.",
        });
      } else {
        toast({ title: "Couldn't start stream", description: msg });
      }
    } finally {
      setCreating(false);
    }
  }

  async function endBroadcast() {
    if (!stream) return;
    try {
      await stopStream(stream.id);
    } catch {
      /* swallow — we still want the UI to drop back to setup */
    }
    setIsBroadcasting(false);
    toast({
      title: "Stream ended",
      description: `Replay saved to your storefront.`,
    });
    setStreamTitle("");
    setSelectedListings([]);
    setStream(null);
  }

  if (stream) {
    return (
      <LiveBroadcastView
        isDark={isDark}
        stream={stream}
        featured={listings.filter((l) => selectedListings.includes(l.id))}
        country={country}
        storeHandle={application?.storeHandle ?? "you"}
        onEnd={endBroadcast}
        onStreamUpdated={setStream}
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
        {tierIndex(tier) < 1 && (
          <div
            className={`rounded-xl border p-4 flex items-start gap-3 ${
              isDark
                ? "bg-[#FF8855]/10 border-[#FF8855]/30 text-white"
                : "bg-[#E6502E]/10 border-[#E6502E]/30 text-stone-900"
            }`}
          >
            <ShieldAlert
              className={`h-5 w-5 shrink-0 mt-0.5 ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
            />
            <div className="space-y-1">
              <p className="font-bold text-sm">KYC Tier 2 needed to broadcast</p>
              <p className={`text-xs ${subtleText}`}>
                Verify your government ID and selfie in Settings → Identity to unlock live streaming.
              </p>
              <Link
                href="/settings"
                className={`inline-block mt-1 text-xs font-bold ${
                  isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                }`}
              >
                Open settings →
              </Link>
            </div>
          </div>
        )}
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
          disabled={activeListings.length === 0 || creating}
          className={`w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-base ${
            isDark
              ? "bg-gradient-to-r from-[#FF8855] to-[#5BA3F5] text-black disabled:from-white/10 disabled:to-white/10 disabled:text-white/30"
              : "bg-gradient-to-r from-[#E6502E] to-[#1B2A4A] text-white disabled:from-stone-200 disabled:to-stone-200 disabled:text-stone-400"
          }`}
          data-testid="button-start-broadcast"
        >
          <Radio className="w-5 h-5" />
          {creating ? "Provisioning…" : "Start broadcast"}
        </button>
      </div>
    </div>
  );
}

function LiveBroadcastView({
  isDark,
  stream,
  featured,
  country,
  storeHandle,
  onEnd,
  onStreamUpdated,
}: {
  isDark: boolean;
  stream: StreamWithSecrets;
  featured: ReturnType<typeof useSeller>["listings"];
  country: ReturnType<typeof useCountry>["country"];
  storeHandle: string;
  onEnd: () => void;
  onStreamUpdated: (s: StreamWithSecrets) => void;
}) {
  const { toast } = useToast();
  const [showKey, setShowKey] = useState(false);
  const [livePresence, setLivePresence] = useState<number>(stream.currentViewers);
  const [recentChat, setRecentChat] = useState<StreamChatMessage[]>([]);
  const [slowMode, setSlowMode] = useState<number>(stream.slowModeSeconds);
  const [bannedDraft, setBannedDraft] = useState("");
  const [bannedWords, setBannedWords] = useState<string[]>(stream.bannedWords);
  const headline = featured[0];

  // Connect to socket presence + chat firehose so the host can moderate.
  useEffect(() => {
    const sock = connectStreamSocket();
    sock.emit("join", { streamId: stream.id });
    const onPresence = (p: { streamId: string; count: number }) => {
      if (p.streamId === stream.id) setLivePresence(p.count);
    };
    const onMessage = (m: StreamChatMessage) => {
      if (m.streamId !== stream.id) return;
      setRecentChat((prev) => [...prev.slice(-49), m]);
    };
    const onDeleted = (p: { streamId: string; messageId: string }) => {
      if (p.streamId !== stream.id) return;
      setRecentChat((prev) => prev.filter((m) => m.id !== p.messageId));
    };
    sock.on("presence:count", onPresence);
    sock.on("chat:message", onMessage);
    sock.on("chat:deleted", onDeleted);
    // Hydrate with the most recent persisted history.
    listStreamMessages(stream.id, { limit: 50 })
      .then((res) => setRecentChat(res.messages))
      .catch(() => {});
    return () => {
      sock.emit("leave", { streamId: stream.id });
      sock.off("presence:count", onPresence);
      sock.off("chat:message", onMessage);
      sock.off("chat:deleted", onDeleted);
    };
  }, [stream.id]);

  async function copyToClipboard(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} copied` });
    } catch {
      toast({ title: `Couldn't copy ${label}` });
    }
  }

  async function onRotateKey() {
    try {
      const updated = await rotateStreamKey(stream.id);
      onStreamUpdated(updated);
      toast({ title: "Stream key rotated" });
    } catch (err) {
      toast({
        title: "Rotation failed",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onDeleteMessage(id: string) {
    try {
      await deleteStreamMessage(stream.id, id);
    } catch {
      toast({ title: "Couldn't delete message" });
    }
  }

  async function onSlowModeChange(value: number) {
    setSlowMode(value);
    try {
      await updateStreamModConfig(stream.id, { slowModeSeconds: value });
    } catch {
      toast({ title: "Couldn't update slow mode" });
    }
  }

  async function onAddBanned() {
    const word = bannedDraft.trim();
    if (!word) return;
    try {
      const cfg = await updateStreamModConfig(stream.id, { addBannedWord: word });
      setBannedWords(cfg.bannedWords);
      setBannedDraft("");
    } catch {
      toast({ title: "Couldn't add banned word" });
    }
  }

  return (
    <div className="absolute inset-0 bg-gradient-to-br from-[#1a0033] via-black to-[#001a1a] text-white overflow-y-auto">
      <div className="min-h-full">
        <div className="pt-12 pb-3 px-4 flex items-start justify-between sticky top-0 z-20 bg-black/60 backdrop-blur">
          <div className="flex items-center gap-2 min-w-0">
            <span className="bg-[#FF8855] text-white text-[10px] font-bold px-2 py-1 rounded">
              ● LIVE
            </span>
            <span className="text-sm font-bold truncate">@{storeHandle}</span>
          </div>
          <div className="flex items-center gap-1 bg-black/40 rounded-full px-3 py-1 backdrop-blur">
            <Eye className="w-3.5 h-3.5" />
            <span className="text-xs font-bold" data-testid="text-host-viewer-count">
              {livePresence.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="px-4 mt-2">
          <p className="text-base font-bold leading-tight">{stream.title}</p>
          <p className="text-[11px] text-white/50 mt-1">
            Provider: {stream.provider} · Status: {stream.status}
          </p>
        </div>

        <div className="px-4 mt-4 space-y-4">
          <section className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Radio className="w-4 h-4 text-[#FF8855]" /> Ingest
              </h3>
              <button
                onClick={onRotateKey}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20"
                data-testid="button-rotate-stream-key"
              >
                <RefreshCw className="w-3 h-3" /> Rotate key
              </button>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase text-white/50 mb-1">RTMP URL</label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={stream.rtmpUrl ?? ""}
                  className="flex-1 px-2 py-1.5 rounded bg-black/40 border border-white/10 text-xs"
                  data-testid="input-rtmp-url"
                />
                <button
                  onClick={() => copyToClipboard(stream.rtmpUrl ?? "", "RTMP URL")}
                  className="p-1.5 rounded bg-white/10 hover:bg-white/20"
                  aria-label="Copy RTMP URL"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase text-white/50 mb-1">Stream key</label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  type={showKey ? "text" : "password"}
                  value={stream.rtmpStreamKey ?? ""}
                  className="flex-1 px-2 py-1.5 rounded bg-black/40 border border-white/10 text-xs"
                  data-testid="input-stream-key"
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  className="p-1.5 rounded bg-white/10 hover:bg-white/20"
                  aria-label={showKey ? "Hide stream key" : "Show stream key"}
                >
                  {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => copyToClipboard(stream.rtmpStreamKey ?? "", "Stream key")}
                  className="p-1.5 rounded bg-white/10 hover:bg-white/20"
                  aria-label="Copy stream key"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[10px] text-white/40 mt-1">
                Treat this like a password. Rotated each session — never share or commit.
              </p>
            </div>
          </section>

          <section className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-3">
            <h3 className="text-sm font-bold">Moderation</h3>
            <div>
              <label className="block text-[10px] font-bold uppercase text-white/50 mb-1">
                Slow mode (seconds between messages)
              </label>
              <select
                value={slowMode}
                onChange={(e) => onSlowModeChange(Number(e.target.value))}
                className="w-full px-2 py-1.5 rounded bg-black/40 border border-white/10 text-xs"
                data-testid="select-slow-mode"
              >
                {[0, 3, 5, 10, 15, 30, 60].map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? "Off" : `${s}s`}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase text-white/50 mb-1">
                Banned words ({bannedWords.length})
              </label>
              <div className="flex gap-2">
                <input
                  value={bannedDraft}
                  onChange={(e) => setBannedDraft(e.target.value.slice(0, 32))}
                  placeholder="add a word"
                  className="flex-1 px-2 py-1.5 rounded bg-black/40 border border-white/10 text-xs"
                  data-testid="input-banned-word"
                />
                <button
                  onClick={onAddBanned}
                  className="px-3 py-1.5 rounded bg-[#FF8855] text-black text-xs font-bold"
                  data-testid="button-add-banned-word"
                >
                  Add
                </button>
              </div>
              {bannedWords.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {bannedWords.map((w) => (
                    <span
                      key={w}
                      className="text-[10px] bg-white/5 border border-white/10 rounded px-2 py-0.5"
                    >
                      {w}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="bg-white/5 border border-white/10 rounded-xl p-3">
            <h3 className="text-sm font-bold mb-2">Live chat</h3>
            <div
              className="space-y-1 max-h-72 overflow-y-auto"
              data-testid="host-chat-list"
            >
              {recentChat.length === 0 && (
                <p className="text-xs text-white/40">No messages yet.</p>
              )}
              {recentChat.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-2 text-xs bg-black/30 rounded px-2 py-1.5 group"
                >
                  <span
                    className={`font-bold ${
                      m.role === "host" ? "text-[#FF8855]" : "text-[#5BA3F5]"
                    }`}
                  >
                    {m.username}
                  </span>
                  <span className="flex-1">{m.text}</span>
                  {m.role !== "host" && (
                    <button
                      onClick={() => onDeleteMessage(m.id)}
                      className="opacity-0 group-hover:opacity-100 text-white/50 hover:text-[#FF8855]"
                      aria-label="Delete message"
                      data-testid={`delete-message-${m.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          {headline && (
            <section className="bg-white/5 border border-white/10 rounded-xl p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#5BA3F5] mb-1">
                Pinned now
              </p>
              <p className="text-sm font-bold leading-tight mb-1 line-clamp-2">
                {headline.title}
              </p>
              <p className="text-base font-bold text-[#5BA3F5]">
                {formatPrice(headline.priceMinor, country)}
              </p>
            </section>
          )}

          <div className="flex items-center justify-center gap-3 pb-12">
            <Sparkles className="w-5 h-5 text-white/40" />
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
