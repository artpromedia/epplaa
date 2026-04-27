import { useEffect, useMemo, useRef, useState } from "react";
import { Heart, MessageCircle, Share2, Gift, X, Send } from "lucide-react";
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
  // Bot messages render with the styled fallback avatar; the local "you"
  // message uses a coral pill so the user can spot their own contribution.
  kind: "bot" | "seed" | "you";
  bot?: BotViewer;
  seed?: (typeof SEED_COMMENTS)[number];
}

interface FloatingHeart {
  id: number;
  // Horizontal jitter so the hearts don't stack in a single column.
  x: number;
  // Drift slightly to the side as they rise.
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

  const stream = SEED_STREAMS.find((s) => s.id === streamId) || SEED_STREAMS[0];
  const pinnedProduct = SEED_PRODUCTS.find(
    (p) => p.id === stream.currentProductId,
  );

  const seedViewers = useMemo(() => parseViewerCount(stream.viewerCount), [
    stream.viewerCount,
  ]);
  const [viewers, setViewers] = useState<number>(seedViewers);
  const [likeCount, setLikeCount] = useState<number>(12800);
  const [commentCount, setCommentCount] = useState<number>(452);
  const [hearts, setHearts] = useState<FloatingHeart[]>([]);
  const [draft, setDraft] = useState("");
  const [tipOpen, setTipOpen] = useState(false);
  const heartIdRef = useRef(0);

  // Seed the chat with the existing static comments so the screen never looks
  // empty before bots start talking.
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

  // Reset every stream-scoped piece of state when the user navigates between
  // /live/:streamId routes (e.g. via a "Watch live now" CTA from a replay).
  // Without this, viewer/like/comment counts and chat history would bleed
  // across streams. The intervals below are also keyed on `streamId` so they
  // tear down and restart with fresh closures.
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
    // initialMessages and seedViewers are intentionally regenerated per stream;
    // we don't list them as deps to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamId]);

  function pushMessage(msg: ChatMessage) {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_CHAT ? next.slice(next.length - MAX_CHAT) : next;
    });
  }

  // Auto-scroll chat to bottom whenever a new message arrives.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Bot chatter: random cadence between 2.2s and 4.2s. The currently scheduled
  // timeout id is tracked in a ref so cleanup cancels the *pending* tick (not
  // just the initial one) when streamId changes or the page unmounts.
  useEffect(() => {
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
      // Bots also bump the comment counter (gives the side-rail life).
      setCommentCount((c) => c + 1);
      const delay = 2200 + Math.floor(Math.random() * 2000);
      timeoutId = setTimeout(tick, delay);
    }
    timeoutId = setTimeout(tick, 1800);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [streamId]);

  // Viewer count random walk every 3.5s; a tiny floor of 50 prevents zero.
  useEffect(() => {
    const interval = setInterval(() => {
      setViewers((v) => Math.max(50, v + nextViewerDelta()));
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  // Bot likes — occasional ambient growth so the heart count moves even when
  // the user isn't tapping.
  useEffect(() => {
    const interval = setInterval(() => {
      setLikeCount((c) => c + 1 + Math.floor(Math.random() * 3));
    }, 2400);
    return () => clearInterval(interval);
  }, []);

  // Garbage-collect floating hearts after their 1.4s animation finishes so the
  // DOM doesn't grow forever.
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
  }

  function submitMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    pushMessage({
      id: uid(),
      username: "You",
      text,
      kind: "you",
    });
    setCommentCount((c) => c + 1);
    setDraft("");
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
      // user dismissed the native share sheet; fall through to clipboard
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
      {/* Video Background */}
      <div className="absolute inset-0">
        <img
          src={stream.posterImage}
          alt="Live stream"
          className="w-full h-full object-cover opacity-90"
        />
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
        {/* Chat Area */}
        <div
          ref={chatScrollRef}
          className="w-[70%] h-48 overflow-y-auto no-scrollbar flex flex-col space-y-3 mb-4 mask-image-to-top"
          data-testid="list-live-chat"
        >
          {messages.map((m) => {
            if (m.kind === "you") {
              return (
                <div
                  key={m.id}
                  className="flex items-start gap-2 justify-end pr-1"
                  data-testid="chat-message-you"
                >
                  <div
                    className={`backdrop-blur-sm rounded-xl rounded-tr-none p-2 border ${
                      isDark
                        ? "bg-[#FF8855]/25 border-[#FF8855]/40"
                        : "bg-[#E6502E]/15 border-[#E6502E]/40"
                    }`}
                  >
                    <p
                      className={`text-[10px] font-bold mb-0.5 ${
                        isDark ? "text-[#FF8855]" : "text-[#E6502E]"
                      }`}
                    >
                      You
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
