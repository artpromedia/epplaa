import { Link } from "wouter";
import { Play, Clock, Eye } from "lucide-react";
import { useTheme } from "@/lib/theme-context";
import { SEED_REPLAYS, relativeTime, type Replay } from "@/lib/replays";
import { PageHeader } from "@/components/page-header";
import { useListReplays } from "@workspace/api-client-react";

/**
 * Replays index. Pulls real replay rows from the backend (which are
 * persisted automatically when a live stream ends). While the request
 * is in flight — or if it fails — we render the seed catalogue so the
 * page is never empty in dev or first-load scenarios.
 */
export default function Replays() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const { data, isLoading } = useListReplays();
  const apiReplays = (data ?? []) as Replay[];
  const replays: Replay[] = isLoading
    ? SEED_REPLAYS
    : apiReplays.length > 0
      ? apiReplays
      : SEED_REPLAYS;

  return (
    <div className="flex flex-col h-full w-full">
      <PageHeader title="Live replays" backHref="/discover" />
      <div className="px-4 pb-8 space-y-4">
        <p
          className={`text-xs ${
            isDark ? "text-white/55" : "text-stone-500"
          }`}
          data-testid="text-replays-intro"
        >
          Catch up on streams you missed. Tap any replay to rewatch and shop
          the products that were showcased.
        </p>

        <div className="grid grid-cols-2 gap-3" data-testid="list-replays">
          {replays.map((r) => (
            <Link
              key={r.id}
              href={`/replay/${r.id}`}
              data-testid={`link-replay-${r.id}`}
              className="relative rounded-xl overflow-hidden aspect-[3/4] block"
            >
              <img
                src={r.posterImage}
                alt={r.title}
                className="w-full h-full object-cover"
              />
              <div
                className={`absolute inset-0 bg-gradient-to-t ${
                  isDark
                    ? "from-black/85 via-black/20 to-black/40"
                    : "from-black/80 via-black/10 to-black/30"
                }`}
              />
              {/* Centered play badge */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  className={`h-12 w-12 rounded-full backdrop-blur-md flex items-center justify-center border ${
                    isDark
                      ? "bg-black/50 border-white/20 text-white"
                      : "bg-white/55 border-white/40 text-white"
                  }`}
                >
                  <Play className="h-5 w-5 fill-current ml-0.5" />
                </div>
              </div>
              {/* Duration badge */}
              <div className="absolute top-2 left-2 bg-black/60 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {r.durationLabel}
              </div>
              {/* View count */}
              <div className="absolute top-2 right-2 bg-black/60 backdrop-blur text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {r.viewCount}
              </div>
              {/* Footer */}
              <div className="absolute bottom-2 left-2 right-2">
                <p className="text-xs font-bold leading-tight mb-1 text-white line-clamp-2">
                  {r.title}
                </p>
                <div className="flex items-center gap-1">
                  <img
                    src={r.hostAvatar}
                    className="w-4 h-4 rounded-full border border-white/40"
                    alt={r.hostName}
                  />
                  <span className="text-[10px] text-white/90">
                    {r.hostName}
                  </span>
                  <span className="text-[10px] text-white/60 ml-auto">
                    {relativeTime(r.recordedAtIso)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
