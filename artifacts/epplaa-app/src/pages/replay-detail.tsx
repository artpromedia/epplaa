import { useEffect, useRef, useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { Play, X, Eye, Clock, Radio } from "lucide-react";
import Hls from "hls.js";
import { useTheme } from "@/lib/theme-context";
import { useCountry } from "@/lib/country-context";
import { getReplayById, relativeTime, type Replay } from "@/lib/replays";
import { SEED_PRODUCTS } from "@/lib/seed";
import { formatPrice } from "@/lib/format";
import { useGetReplay } from "@workspace/api-client-react";

export default function ReplayDetail() {
  const { replayId } = useParams<{ replayId: string }>();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { country } = useCountry();
  const [, navigate] = useLocation();

  // Try the API first; if the id matches a seed entry instead (e.g. a
  // demo replay shipped with the app), fall back to the static row so
  // the existing UX keeps working without a backend record.
  const { data: apiReplay, isLoading } = useGetReplay(replayId ?? "");
  const seedReplay = getReplayById(replayId ?? "");
  const replay: Replay | undefined =
    (apiReplay as Replay | undefined) ?? seedReplay;

  // Mount hls.js for the recorded VOD when the API returned a real
  // playback URL. Stub URLs (used in dev when CF isn't configured) are
  // skipped so we don't spam MEDIA_ERR cycles, and Safari uses native
  // HLS via the <video src> attribute path.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackUrl = replay?.playbackUrl ?? null;
  const hasRealPlayback =
    !!playbackUrl && !playbackUrl.includes("stub-playback.epplaa.local");

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasRealPlayback || !playbackUrl) return undefined;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
      return undefined;
    }
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    return undefined;
  }, [playbackUrl, hasRealPlayback]);

  if (isLoading && !seedReplay) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <p className="text-sm font-bold mb-2">Loading replay…</p>
      </div>
    );
  }

  if (!replay) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <p className="text-sm font-bold mb-2">Replay not found</p>
        <Link
          href="/replays"
          className={`text-xs underline ${
            isDark ? "text-[#FF8855]" : "text-[#E6502E]"
          }`}
        >
          Back to replays
        </Link>
      </div>
    );
  }

  const products = replay.productIds
    .map((id) => SEED_PRODUCTS.find((p) => p.id === id))
    .filter((p): p is (typeof SEED_PRODUCTS)[number] => !!p);

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${
        isDark ? "bg-[#0F1525] text-white" : "bg-[#fbeed3] text-stone-900"
      }`}
    >
      {/* Real VOD player when available; poster fallback otherwise. */}
      <div className="absolute inset-0">
        {hasRealPlayback ? (
          <video
            ref={videoRef}
            data-testid="video-replay"
            className="w-full h-full object-cover"
            poster={replay.posterImage}
            controls
            playsInline
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
        ) : (
          <img
            src={replay.posterImage}
            alt={replay.title}
            className="w-full h-full object-cover opacity-90"
          />
        )}
        <div
          className={`absolute inset-0 pointer-events-none bg-gradient-to-b ${
            isDark
              ? "from-black/60 via-black/40 to-black/95"
              : "from-black/40 via-black/30 to-black/85"
          }`}
        />
      </div>

      {/* Top bar */}
      <div className="absolute top-12 left-4 right-4 z-10 flex items-center justify-between">
        <div
          className={`flex items-center backdrop-blur-md rounded-full p-1 pr-3 border bg-black/40 border-white/10 text-white`}
        >
          <img
            src={replay.hostAvatar}
            className="h-8 w-8 rounded-full border border-[#FF8855]"
            alt={replay.hostName}
          />
          <div className="ml-2 flex flex-col">
            <span className="text-xs font-bold leading-tight">
              {replay.hostName}
            </span>
            <span className="text-[10px] leading-tight text-white/70">
              {relativeTime(replay.recordedAtIso)} · {replay.viewCount} views
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <div
            className={`backdrop-blur-md h-10 px-3 rounded-full flex items-center justify-center border bg-black/40 border-white/10 text-white text-[11px] font-bold gap-1`}
            data-testid="badge-replay"
          >
            REPLAY
          </div>
          <button
            onClick={() => navigate("/replays")}
            data-testid="link-close-replay"
            className={`backdrop-blur-md h-10 w-10 rounded-full flex items-center justify-center border bg-black/40 border-white/10 text-white`}
            aria-label="Close replay"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Centered play overlay (only when we don't have a real player or
          it's currently paused — controls are still on the video). */}
      {(!hasRealPlayback || !isPlaying) && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div
            className={`h-20 w-20 rounded-full backdrop-blur-md flex items-center justify-center border bg-black/50 border-white/30 text-white`}
          >
            <Play className="h-9 w-9 fill-current ml-1" />
          </div>
        </div>
      )}

      {/* Bottom sheet: title + showcased products */}
      <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 z-10 flex flex-col gap-3 max-h-[55%] overflow-y-auto no-scrollbar pointer-events-none">
        <div className="text-white pointer-events-auto">
          <h1 className="text-base font-black leading-tight">
            {replay.title}
          </h1>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-white/80">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {replay.durationLabel}
            </span>
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {replay.viewCount} views
            </span>
          </div>
        </div>

        {replay.liveStreamId && (
          <Link
            href={`/live/${replay.liveStreamId}`}
            data-testid="link-watch-live-now"
            className={`pointer-events-auto flex items-center justify-center gap-2 h-10 rounded-full font-bold text-sm ${
              isDark
                ? "bg-[#FF8855] text-black hover:bg-[#FF6B35] shadow-[0_0_15px_rgba(255,136,85,0.5)]"
                : "bg-[#E6502E] text-white hover:bg-[#C4441E] shadow-md"
            }`}
          >
            <Radio className="h-4 w-4" />
            Watch {replay.hostName} live now
          </Link>
        )}

        <div className="pointer-events-auto">
          <p className="text-[10px] font-bold uppercase tracking-wider text-white/70 mb-2">
            Featured in this stream
          </p>
          <div className="space-y-2" data-testid="list-replay-products">
            {products.map((p) => (
              <Link
                key={p.id}
                href={`/product/${p.id}`}
                data-testid={`link-replay-product-${p.id}`}
                className="flex items-center gap-3 backdrop-blur-md bg-black/45 border border-white/10 rounded-xl p-2 text-white hover:bg-black/60 transition-colors"
              >
                <img
                  src={p.images[0]}
                  alt={p.title}
                  className="h-14 w-14 rounded-lg object-cover border border-white/10 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold line-clamp-2 leading-tight">
                    {p.title}
                  </p>
                  <p
                    className={`text-sm font-black mt-1 ${
                      isDark ? "text-[#5BA3F5]" : "text-white"
                    }`}
                  >
                    {formatPrice(p.priceMinor, country)}
                  </p>
                </div>
                <span className="text-[10px] font-bold text-white/70">
                  Shop ›
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
