import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Heart,
  MessageCircle,
  Share2,
  Gift,
  X,
  Send,
  Gauge,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { TippingSheet } from "@/components/tipping-sheet";
import { Link, useParams, useLocation } from "wouter";
import { useTheme } from "@/lib/theme-context";
import { SEED_STREAMS, SEED_PRODUCTS, SEED_COMMENTS } from "@/lib/seed";
import { useCountry } from "@/lib/country-context";
import { useFollows } from "@/lib/follows-context";
import { useCart } from "@/lib/cart-context";
import { formatPrice } from "@/lib/format";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { connectStreamSocket } from "@/lib/stream-socket";
import { useGetProduct } from "@workspace/api-client-react";
import {
  getStreamPlayback,
  listStreamMessages,
  getStreamModerationRole,
  updateStreamModConfig,
  type StreamPlayback,
  type StreamChatMessage,
} from "@workspace/api-client-react";
import {
  BotViewer,
  formatViewerCount,
  nextViewerDelta,
  parseViewerCount,
  randomBotMessage,
  randomBotViewer,
} from "@/lib/live-engagement";

interface ChatMessage {
  id: string;
  username: string;
  text: string;
  kind: "bot" | "seed" | "you";
  // Server-supplied role for "you" messages from the live socket. Used
  // by the viewer UI to render host/mod badges. Demo (seed/bot) chats
  // never carry a role.
  role?: "host" | "mod" | "viewer";
  bot?: BotViewer;
  seed?: (typeof SEED_COMMENTS)[number];
}

interface FloatingHeart {
  id: number;
  x: number;
  drift: number;
}

const MAX_CHAT = 30;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function LiveShopping() {
  const { streamId } = useParams<{ streamId: string }>();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const { isFollowing, toggle: toggleFollow } = useFollows();
  const { add: addToCart } = useCart();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // Demo fallback for /live/stream1, /live/stream-2… URLs without a DB row.
  const seedStream =
    SEED_STREAMS.find((s) => s.id === streamId) || SEED_STREAMS[0];

  const seedViewers = useMemo(() => parseViewerCount(seedStream.viewerCount), [
    seedStream.viewerCount,
  ]);
  const [viewers, setViewers] = useState<number>(seedViewers);
  const [likeCount, setLikeCount] = useState<number>(12800);
  const [commentCount, setCommentCount] = useState<number>(452);
  const [hearts, setHearts] = useState<FloatingHeart[]>([]);
  const [draft, setDraft] = useState("");
  const [tipOpen, setTipOpen] = useState(false);
  const heartIdRef = useRef(0);

  const [realPlayback, setRealPlayback] = useState<StreamPlayback | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [liteMode, setLiteMode] = useState(false);
  // Per-stream moderation role for the signed-in viewer (Task #22).
  // "viewer" hides moderation tools; host/mod unlocks delete buttons
  // and the slow-mode tuner. Defaults to "viewer" so anonymous browsing
  // never accidentally renders mod controls.
  const [myRole, setMyRole] = useState<"host" | "mod" | "viewer">("viewer");
  // Tracks the *applied* slow-mode value the moderation dropdown should
  // reflect. Seeded from the playback response so the dropdown shows
  // the host's existing setting (not a misleading "Off") on first paint.
  const [slowModeDraft, setSlowModeDraft] = useState<number | null>(null);

  // Real playback row overrides seed metadata when present.
  const liveTitle = realPlayback?.title ?? seedStream.title;
  const liveHostName = realPlayback?.hostName ?? seedStream.hostName;
  const liveHostAvatar =
    (realPlayback?.hostAvatar?.length ? realPlayback.hostAvatar : null) ??
    seedStream.hostAvatar;
  const livePosterImage =
    (realPlayback?.posterImage?.length ? realPlayback.posterImage : null) ??
    seedStream.posterImage;
  const livePinnedProductId =
    realPlayback?.currentProductId ?? seedStream.currentProductId ?? null;
  const seedPinned = SEED_PRODUCTS.find((p) => p.id === livePinnedProductId);
  const { data: fetchedPinned } = useGetProduct(
    !seedPinned && livePinnedProductId ? livePinnedProductId : "",
  );
  const pinnedProduct = seedPinned ?? fetchedPinned ?? undefined;
  const stream = {
    ...seedStream,
    title: liveTitle,
    hostName: liveHostName,
    hostAvatar: liveHostAvatar,
    posterImage: livePosterImage,
    currentProductId: livePinnedProductId,
  };

  const initialMessages = (): ChatMessage[] =>
    SEED_COMMENTS.slice(0, 4).map((c) => ({
      id: uid(),
      username: c.username,
      text: c.text,
      kind: "seed",
      seed: c,
    }));
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);

  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Reset stream-scoped state on /live/:streamId navigation.
  const isFirstStreamMount = useRef(true);
  useEffect(() => {
    if (isFirstStreamMount.current) {
      isFirstStreamMount.current = false;
      return;
    }
    setViewers(seedViewers);
    setLikeCount(12800);
    setCommentCount(452);
    setHearts([]);
    setDraft("");
    setMessages(initialMessages());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamId]);

  function pushMessage(msg: ChatMessage) {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_CHAT ? next.slice(next.length - MAX_CHAT) : next;
    });
  }

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Bot chatter only in the demo fallback; real streams use the socket.
  useEffect(() => {
    if (realPlayback) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function tick() {
      if (cancelled) return;
      const bot = randomBotViewer();
      pushMessage({
        id: uid(),
        username: bot.username,
        text: randomBotMessage(),
        kind: "bot",
        bot,
      });
      setCommentCount((c) => c + 1);
      const delay = 2200 + Math.floor(Math.random() * 2000);
      timeoutId = setTimeout(tick, delay);
    }
    timeoutId = setTimeout(tick, 1800);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [streamId, realPlayback]);

  useEffect(() => {
    let cancelled = false;
    if (!streamId) return;
    getStreamPlayback(streamId)
      .then((p) => {
        if (cancelled) return;
        setRealPlayback(p);
        // Seed the moderation slow-mode dropdown with the stream's
        // currently-applied value so a deputised mod doesn't see a
        // misleading "Off" before changing it.
        setSlowModeDraft((prev) => prev ?? p.slowModeSeconds);
      })
      .catch(() => {
        if (!cancelled) setRealPlayback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [streamId]);

  // Safari = native HLS; otherwise attach hls.js. Stub URLs are skipped.
  useEffect(() => {
    const video = videoRef.current;
    const url = realPlayback?.hlsUrl ?? null;
    if (!video || !url || url.includes("stub-playback.epplaa.local")) return undefined;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return undefined;
    }
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hls.autoLevelCapping = liteMode ? 0 : -1;
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
    return undefined;
  }, [realPlayback?.hlsUrl, liteMode]);

  // Lite mode: 0 pins lowest rendition; -1 lets ABR choose.
  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.autoLevelCapping = liteMode ? 0 : -1;
  }, [liteMode]);

  useEffect(() => {
    if (!realPlayback || !streamId) return;
    const sock = connectStreamSocket();
    sock.emit("join", { streamId });
    const onPresence = (p: { streamId: string; count: number }) => {
      if (p.streamId === streamId) setViewers(Math.max(1, p.count));
    };
    const onMessage = (m: StreamChatMessage) => {
      if (m.streamId !== streamId) return;
      pushMessage({
        id: m.id,
        username: m.username,
        text: m.text,
        kind: "you",
        role: m.role,
      });
      setCommentCount((c) => c + 1);
    };
    const onDeleted = (p: { streamId: string; messageId: string }) => {
      if (p.streamId !== streamId) return;
      setMessages((prev) => prev.filter((x) => x.id !== p.messageId));
    };
    const onReaction = (p: { streamId: string; count: number }) => {
      if (p.streamId !== streamId) return;
      setLikeCount((c) => c + p.count);
    };
    sock.on("presence:count", onPresence);
    sock.on("chat:message", onMessage);
    sock.on("chat:deleted", onDeleted);
    sock.on("reaction:burst", onReaction);
    listStreamMessages(streamId, { limit: 50 })
      .then((res) => {
        if (res.messages.length === 0) return;
        setMessages(
          res.messages.map((m) => ({
            id: m.id,
            username: m.username,
            text: m.text,
            kind: "you" as const,
            role: m.role,
          })),
        );
      })
      .catch(() => {});
    // Find out whether the signed-in viewer is the host, a deputised
    // mod, or just a regular viewer for *this* stream. Failures fall
    // through to "viewer" so the moderation panel stays hidden.
    getStreamModerationRole(streamId)
      .then((res) => setMyRole(res.role))
      .catch(() => setMyRole("viewer"));
    return () => {
      sock.emit("leave", { streamId });
      sock.off("presence:count", onPresence);
      sock.off("chat:message", onMessage);
      sock.off("chat:deleted", onDeleted);
      sock.off("reaction:burst", onReaction);
    };
  }, [realPlayback, streamId]);

  // Demo fallbacks (off when realPlayback drives the counters).
  useEffect(() => {
    if (realPlayback) return;
    const interval = setInterval(() => {
      setViewers((v) => Math.max(50, v + nextViewerDelta()));
    }, 3500);
    return () => clearInterval(interval);
  }, [realPlayback]);

  useEffect(() => {
    if (realPlayback) return;
    const interval = setInterval(() => {
      setLikeCount((c) => c + 1 + Math.floor(Math.random() * 3));
    }, 2400);
    return () => clearInterval(interval);
  }, [realPlayback]);

  useEffect(() => {
    if (hearts.length === 0) return;
    const t = setTimeout(() => {
      setHearts((prev) => prev.slice(1));
    }, 1500);
    return () => clearTimeout(t);
  }, [hearts.length]);

  function spawnHeart() {
    heartIdRef.current += 1;
    const id = heartIdRef.current;
    const x = Math.floor(Math.random() * 18) - 9; // -9..+9 px jitter
    const drift = Math.floor(Math.random() * 24) - 12; // sideways drift
    setHearts((prev) => [...prev.slice(-12), { id, x, drift }]);
    setLikeCount((c) => c + 1);
    if (realPlayback && streamId) {
      const sock = connectStreamSocket();
      sock.emit("reaction:add", { streamId, kind: "heart", count: 1 });
    }
  }

  function submitMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (realPlayback && streamId) {
      const sock = connectStreamSocket();
      sock.emit("chat:send", { streamId, text }, (ack: { ok: boolean; reason?: string }) => {
        if (!ack?.ok) {
          if (ack?.reason?.startsWith("slow_mode_")) {
            const wait = ack.reason.slice("slow_mode_".length);
            toast({ title: `Slow mode — wait ${wait}s` });
          } else if (ack?.reason === "unauthorized") {
            toast({ title: "Sign in to chat" });
          } else {
            toast({ title: "Couldn't send" });
          }
        }
      });
      setDraft("");
      return;
    }
    pushMessage({
      id: uid(),
      username: "You",
      text,
      kind: "you",
    });
    setCommentCount((c) => c + 1);
    setDraft("");
  }

  // Mod tools are only meaningful when the page is backed by a real
  // stream row (realPlayback). Demo seed streams have no server-side
  // chat to moderate.
  const canModerate = !!realPlayback && (myRole === "host" || myRole === "mod");

  function onModDelete(messageId: string) {
    if (!realPlayback || !streamId) return;
    const sock = connectStreamSocket();
    sock.emit(
      "chat:delete",
      { streamId, messageId },
      (ack: { ok: boolean; reason?: string }) => {
        if (!ack?.ok) {
          toast({ title: "Couldn't delete message" });
        }
      },
    );
  }

  async function onApplySlowMode(seconds: number) {
    if (!streamId) return;
    try {
      const cfg = await updateStreamModConfig(streamId, {
        slowModeSeconds: seconds,
      });
      setSlowModeDraft(cfg.slowModeSeconds);
      toast({
        title: cfg.slowModeSeconds > 0
          ? `Slow mode set to ${cfg.slowModeSeconds}s`
          : "Slow mode off",
      });
    } catch {
      toast({ title: "Couldn't update slow mode" });
    }
  }

  const following = isFollowing(stream.hostName);
  function onFollow() {
    const nowFollowing = toggleFollow(stream.hostName);
    toast({
      title: nowFollowing
        ? `Following ${stream.hostName}`
        : `Unfollowed ${stream.hostName}`,
      description: nowFollowing
        ? "You'll be notified when they go live."
        : "You won't get drop alerts from this seller.",
    });
  }

  function onBuyNow() {
    if (!pinnedProduct) return;
    addToCart(pinnedProduct.id, 1);
    toast({
      title: "Added to cart",
      description: pinnedProduct.title,
    });
    navigate("/cart");
  }

  async function onShare() {
    const url = `${window.location.origin}${window.location.pathname.replace(/\/$/, "")}`;
    const shareData = {
      title: `${stream.hostName} on Epplaa Live`,
      text: stream.title,
      url,
    };
    try {
      if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return;
      }
    } catch {
      // share dismissed — fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({
        title: "Link copied",
        description: "Stream URL is on your clipboard.",
      });
    } catch {
      toast({
        title: "Couldn't copy link",
        description: "Long-press the address bar to share manually.",
      });
    }
  }

  return (
    <div
      className={`w-full h-full relative overflow-hidden font-sans select-none ${
        isDark ? "bg-[#0F1525] text-white" : "bg-[#fbeed3] text-stone-900"
      }`}
    >
      {/* Video Background — real HLS player when a backend stream exists,
          otherwise the seed poster image. */}
      <div className="absolute inset-0">
        {realPlayback?.hlsUrl && !realPlayback.hlsUrl.includes("stub-playback.epplaa.local") ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            controls={false}
            className="w-full h-full object-cover opacity-90"
            poster={stream.posterImage}
            data-testid="video-live-hls"
          />
        ) : (
          <img
            src={stream.posterImage}
            alt="Live stream"
            className="w-full h-full object-cover opacity-90"
          />
        )}
        <div
          className={`absolute inset-0 bg-gradient-to-b ${
            isDark
              ? "from-black/60 via-transparent to-black/90"
              : "from-[#fff5d8]/55 via-transparent to-[#fff5d8]/95"
          }`}
        ></div>
      </div>

      {/* Top Header */}
      <div className="absolute top-12 left-4 right-4 flex items-center justify-between z-10">
        <div
          className={`flex items-center backdrop-blur-md rounded-full p-1 pr-3 border ${
            isDark
              ? "bg-black/40 border-white/10"
              : "bg-[#fff5d8]/75 border-stone-400/55"
          }`}
        >
          <img
            src={stream.hostAvatar}
            className="h-8 w-8 rounded-full border border-[#FF8855]"
            alt={stream.hostName}
          />
          <div className="ml-2 flex flex-col">
            <span className="text-xs font-bold leading-tight">
              {stream.hostName}
            </span>
            <span
              className={`text-[10px] leading-tight ${
                isDark ? "text-white/70" : "text-stone-700"
              }`}
              data-testid="text-viewer-count"
            >
              {formatViewerCount(viewers)} watching
            </span>
          </div>
          <button
            onClick={onFollow}
            data-testid="button-follow-host"
            className={`ml-3 h-6 rounded-full text-xs px-3 font-bold transition-colors ${
              following
                ? isDark
                  ? "bg-white/10 text-white border border-white/20"
                  : "bg-stone-300/55 text-stone-900 border border-stone-400/55"
                : "bg-[#5BA3F5] text-black hover:bg-[#3D7BC4]"
            }`}
          >
            {following ? "Following" : "Follow"}
          </button>
        </div>

        <div className="flex gap-2">
          <ThemeToggle variant="overlay" />
          <div
            className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border ${
              isDark
                ? "bg-black/40 border-white/10"
                : "bg-[#fff5d8]/75 border-stone-400/55"
            }`}
          >
            <span
              className={`text-xs font-bold ${
                isDark ? "text-[#FF8855]" : "text-[#E6502E]"
              }`}
            >
              LIVE
            </span>
          </div>
          <Link
            href="/"
            className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border ${
              isDark
                ? "bg-black/40 border-white/10 text-white"
                : "bg-[#fff5d8]/75 border-stone-400/55 text-stone-900"
            }`}
            data-testid="link-close-live"
          >
            <X className="h-5 w-5" />
          </Link>
        </div>
      </div>

      {/* Floating hearts column — anchored above the action rail. */}
      <div
        className="pointer-events-none absolute right-7 bottom-44 z-20"
        aria-hidden
      >
        {hearts.map((h) => (
          <span
            key={h.id}
            className="absolute"
            style={{
              left: h.x,
              animation: "epplaa-heart 1.4s ease-out forwards",
              ["--epplaa-heart-drift" as string]: `${h.drift}px`,
            }}
          >
            <Heart
              className={`h-6 w-6 ${
                isDark
                  ? "text-[#FF8855] fill-[#FF8855]"
                  : "text-[#E6502E] fill-[#E6502E]"
              }`}
            />
          </span>
        ))}
      </div>

      {/* Main Content Area (Bottom aligned) */}
      <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 flex flex-col justify-end z-10">
        {/* Mod Tools (host & deputised mods only) */}
        {canModerate && (
          <div
            className="w-[70%] mb-2 flex items-center gap-2 text-[10px] bg-black/55 backdrop-blur-sm border border-[#A78BFA]/40 rounded-lg px-2 py-1.5"
            data-testid="mod-tools-bar"
          >
            <ShieldCheck className="w-3 h-3 text-[#A78BFA] shrink-0" />
            <span className="font-bold uppercase tracking-wider text-[#C4B5FD] shrink-0">
              {myRole === "host" ? "Host tools" : "Mod tools"}
            </span>
            <span className="text-white/50 shrink-0">Slow mode</span>
            <select
              value={slowModeDraft ?? 0}
              onChange={(e) => onApplySlowMode(Number(e.target.value))}
              className="bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-white text-[10px]"
              data-testid="select-mod-slow-mode"
            >
              <option value={0}>Off</option>
              <option value={3}>3s</option>
              <option value={10}>10s</option>
              <option value={30}>30s</option>
              <option value={60}>60s</option>
            </select>
            <span className="ml-auto text-white/40 shrink-0 hidden sm:inline">
              Hover any chat to delete
            </span>
          </div>
        )}

        {/* Chat Area */}
        <div
          ref={chatScrollRef}
          className="w-[70%] h-48 overflow-y-auto no-scrollbar flex flex-col space-y-3 mb-4 mask-image-to-top"
          data-testid="list-live-chat"
        >
          {messages.map((m) => {
            if (m.kind === "you") {
              const isHostMsg = m.role === "host";
              const isModMsg = m.role === "mod";
              return (
                <div
                  key={m.id}
                  className="flex items-start gap-2 justify-end pr-1 group"
                  data-testid="chat-message-you"
                >
                  {canModerate && !isHostMsg && (
                    <button
                      onClick={() => onModDelete(m.id)}
                      className="opacity-0 group-hover:opacity-100 self-center text-white/60 hover:text-[#FF8855]"
                      aria-label="Delete message"
                      data-testid={`mod-delete-message-${m.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                  <div
                    className={`backdrop-blur-sm rounded-xl rounded-tr-none p-2 border ${
                      isDark
                        ? "bg-[#FF8855]/25 border-[#FF8855]/40"
                        : "bg-[#E6502E]/15 border-[#E6502E]/40"
                    }`}
                  >
                    <p
                      className={`text-[10px] font-bold mb-0.5 flex items-center gap-1 ${
                        isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                      }`}
                    >
                      {m.username}
                      {isHostMsg && (
                        <span
                          className="inline-flex items-center text-[8px] uppercase font-bold bg-[#FF8855]/30 text-white rounded px-1 py-0.5"
                          data-testid={`badge-host-${m.id}`}
                        >
                          host
                        </span>
                      )}
                      {isModMsg && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[8px] uppercase font-bold bg-[#A78BFA]/25 text-[#C4B5FD] rounded px-1 py-0.5"
                          data-testid={`badge-mod-${m.id}`}
                        >
                          <ShieldCheck className="w-2 h-2" /> mod
                        </span>
                      )}
                    </p>
                    <p className="text-xs">{m.text}</p>
                  </div>
                </div>
              );
            }

            const seed = m.seed;
            const bot = m.bot;
            const meta = seed ?? bot!;
            return (
              <div key={m.id} className="flex items-start gap-2">
                {seed && "avatar" in seed && seed.avatar ? (
                  <img
                    src={seed.avatar}
                    className={`h-6 w-6 rounded-full border ${
                      isDark ? "border-white/20" : "border-stone-400/55"
                    }`}
                    alt={m.username}
                  />
                ) : (
                  <div
                    className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold border shrink-0 ${
                      isDark
                        ? `border-white/20 ${meta.darkFallbackBg} ${meta.darkFallbackColor}`
                        : `border-stone-400/55 ${meta.fallbackBg} ${meta.fallbackColor}`
                    }`}
                  >
                    {seed?.avatarFallback ?? bot?.avatarFallback ?? "?"}
                  </div>
                )}
                <div
                  className={`backdrop-blur-sm rounded-xl rounded-tl-none p-2 border ${
                    isDark
                      ? "bg-black/30 border-white/5"
                      : "bg-[#fff5d8]/75 border-stone-400/35"
                  }`}
                >
                  <p
                    className={`text-[10px] font-bold mb-0.5 ${
                      isDark ? meta.darkColor : meta.color
                    }`}
                  >
                    {m.username}
                  </p>
                  <p className="text-xs">{m.text}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-3 items-end">
          {/* Pinned Product Card */}
          {pinnedProduct && (
            <div
              className={`flex-1 backdrop-blur-xl border rounded-2xl p-3 flex gap-3 relative overflow-hidden ${
                isDark
                  ? "bg-black/60 border-[#FF8855]/30 shadow-[0_0_20px_rgba(255,136,85,0.15)]"
                  : "bg-[#fff5d8]/85 border-[#E6502E]/30 shadow-md"
              }`}
            >
              <div
                className={`absolute top-0 right-0 w-16 h-16 blur-xl rounded-full ${
                  isDark ? "bg-[#FF8855]/20" : "bg-[#E6502E]/10"
                }`}
              ></div>
              <Link
                href={`/product/${pinnedProduct.id}`}
                className="shrink-0"
                aria-label={`View ${pinnedProduct.title}`}
              >
                <img
                  src={pinnedProduct.images[0]}
                  alt={pinnedProduct.title}
                  className={`w-16 h-16 rounded-xl object-cover border ${
                    isDark ? "border-white/10" : "border-stone-400/35"
                  }`}
                />
              </Link>
              <div className="flex-1 flex flex-col justify-between z-10 min-w-0">
                <Link
                  href={`/product/${pinnedProduct.id}`}
                  className="block min-w-0"
                >
                  <p className="text-xs font-bold leading-tight line-clamp-2">
                    {pinnedProduct.title}
                  </p>
                  <p
                    className={`text-sm font-black mt-1 ${
                      isDark ? "text-[#5BA3F5]" : "text-[#1B2A4A]"
                    }`}
                  >
                    {formatPrice(pinnedProduct.priceMinor, country)}
                  </p>
                </Link>
                <button
                  onClick={onBuyNow}
                  data-testid="button-live-buy-now"
                  className={`h-7 w-full mt-2 text-white text-xs font-bold rounded-lg ${
                    isDark
                      ? "bg-[#FF8855] hover:bg-[#FF6B35] shadow-[0_0_10px_rgba(255,136,85,0.4)]"
                      : "bg-[#E6502E] hover:bg-[#C4441E] shadow-[0_4px_10px_rgba(230,80,46,0.3)]"
                  }`}
                >
                  Buy now
                </button>
              </div>
            </div>
          )}
          {!pinnedProduct && <div className="flex-1" />}

          {/* Action Rail */}
          <div className="flex flex-col gap-4">
            {/* Lite mode (data saver). Caps the HLS bitrate ladder to the
                lowest rendition; only meaningful when a real stream is
                playing through hls.js. Hidden when no real playback is
                attached so it doesn't lie to the user. */}
            {realPlayback?.hlsUrl && (
              <div className="flex flex-col items-center gap-1">
                <button
                  onClick={() => setLiteMode((v) => !v)}
                  data-testid="button-quality-toggle"
                  aria-pressed={liteMode}
                  aria-label={liteMode ? "Disable Lite mode" : "Enable Lite mode"}
                  className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 active:scale-95 transition-transform ${
                    liteMode
                      ? isDark
                        ? "bg-[#FF8855]/30 border-[#FF8855]/60 text-[#FF8855] shadow-[0_0_15px_rgba(255,136,85,0.3)]"
                        : "bg-[#E6502E]/15 border-[#E6502E]/40 text-[#E6502E] shadow-sm"
                      : isDark
                        ? "bg-black/40 border-white/10 text-white hover:bg-white/20"
                        : "bg-[#fff5d8]/75 border-stone-400/55 text-stone-900 hover:bg-stone-300/40"
                  }`}
                >
                  <Gauge className="h-6 w-6" />
                </button>
                <span
                  className={`text-[10px] font-bold ${
                    isDark ? "text-white" : "text-stone-800"
                  }`}
                  data-testid="text-quality-label"
                >
                  {liteMode ? "Lite" : "Auto"}
                </span>
              </div>
            )}
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={spawnHeart}
                data-testid="button-live-heart"
                aria-label="Like"
                className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 active:scale-95 transition-transform ${
                  isDark
                    ? "bg-black/40 border-white/10 text-white hover:bg-white/20"
                    : "bg-[#fff5d8]/75 border-stone-400/55 text-stone-900 hover:bg-stone-300/40"
                }`}
              >
                <Heart
                  className={`h-6 w-6 ${
                    isDark
                      ? "text-[#FF8855] fill-[#FF8855]"
                      : "text-[#E6502E] fill-[#E6502E]"
                  }`}
                />
              </button>
              <span
                className={`text-[10px] font-bold ${
                  isDark ? "text-white" : "text-stone-800"
                }`}
                data-testid="text-like-count"
              >
                {formatViewerCount(likeCount)}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div
                className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center ${
                  isDark
                    ? "bg-black/40 border-white/10 text-white"
                    : "bg-[#fff5d8]/75 border-stone-400/55 text-stone-900"
                }`}
              >
                <MessageCircle className="h-6 w-6" />
              </div>
              <span
                className={`text-[10px] font-bold ${
                  isDark ? "text-white" : "text-stone-800"
                }`}
                data-testid="text-comment-count"
              >
                {formatViewerCount(commentCount)}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={onShare}
                data-testid="button-live-share"
                aria-label="Share stream"
                className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 active:scale-95 transition-transform ${
                  isDark
                    ? "bg-black/40 border-white/10 text-white hover:bg-white/20"
                    : "bg-[#fff5d8]/75 border-stone-400/55 text-stone-900 hover:bg-stone-300/40"
                }`}
              >
                <Share2 className="h-6 w-6" />
              </button>
              <span
                className={`text-[10px] font-bold ${
                  isDark ? "text-white" : "text-stone-800"
                }`}
              >
                Share
              </span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={() => setTipOpen(true)}
                data-testid="button-live-gift"
                aria-label="Send gift"
                className={`h-12 w-12 rounded-full backdrop-blur-md border flex items-center justify-center hover:scale-110 active:scale-95 transition-transform ${
                  isDark
                    ? "bg-[#FF8855]/20 border-[#FF8855]/50 text-[#FF8855] hover:bg-[#FF8855]/40 shadow-[0_0_15px_rgba(255,136,85,0.3)]"
                    : "bg-[#E6502E]/10 border-[#E6502E]/30 text-[#E6502E] hover:bg-[#E6502E]/20 shadow-sm"
                }`}
              >
                <Gift className="h-6 w-6" />
              </button>
              <span
                className={`text-[10px] font-bold ${
                  isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                }`}
              >
                Gift
              </span>
            </div>
          </div>
        </div>

        {/* Comment Input */}
        <form
          onSubmit={submitMessage}
          className="mt-4 flex gap-2 items-center"
        >
          <div
            className={`flex-1 backdrop-blur-md border rounded-full h-10 pl-4 pr-1 flex items-center gap-2 ${
              isDark
                ? "bg-black/40 border-white/10"
                : "bg-[#fff5d8]/75 border-stone-400/55"
            }`}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 140))}
              placeholder="Add a comment..."
              data-testid="input-live-chat"
              maxLength={140}
              className={`flex-1 bg-transparent outline-none text-sm ${
                isDark
                  ? "text-white placeholder:text-white/50"
                  : "text-stone-900 placeholder:text-stone-500"
              }`}
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              data-testid="button-send-chat"
              aria-label="Send message"
              className={`h-8 w-8 rounded-full flex items-center justify-center disabled:opacity-40 ${
                isDark
                  ? "bg-[#FF8855] text-black hover:bg-[#FF6B35]"
                  : "bg-[#E6502E] text-white hover:bg-[#C4441E]"
              }`}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>

      <TippingSheet
        open={tipOpen}
        onClose={() => setTipOpen(false)}
        hostName={stream.hostName}
        streamId={stream.id}
      />

      {/* Inline keyframes — kept here so the live page stays self-contained. */}
      <style>{`
        @keyframes epplaa-heart {
          0% { transform: translate(0, 0) scale(0.6); opacity: 0; }
          15% { transform: translate(0, -8px) scale(1.05); opacity: 1; }
          100% {
            transform: translate(var(--epplaa-heart-drift, 0), -160px) scale(1.2);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}
