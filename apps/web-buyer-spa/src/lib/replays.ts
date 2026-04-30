// Live Replays (VOD) — ended streams that buyers can rewatch with the products
// that were showcased pinned to the side. Frontend-only seed; production would
// hydrate from the streaming backend.

export interface Replay {
  id: string;
  hostName: string;
  hostAvatar: string;
  posterImage: string;
  title: string;
  durationLabel: string; // "48:12"
  durationSeconds: number;
  viewCount: string; // "12.4K"
  recordedAtIso: string;
  productIds: string[]; // products showcased during the stream, in order
  // Whether the same host is currently live again — surfaces a "Watch live now"
  // CTA on the replay detail page.
  liveStreamId?: string;
  // HLS manifest URL for the recorded VOD (real streams only). Undefined on
  // the seed entries which are static placeholders.
  playbackUrl?: string | null;
}

const now = Date.now();
const HOUR = 1000 * 60 * 60;

export const SEED_REPLAYS: Replay[] = [
  {
    id: "replay-1",
    hostName: "Ada Beauty",
    hostAvatar: "/images/lagos-avatar-2.png",
    posterImage: "/images/lagos-host-stream.png",
    title: "Naija Beauty Haul · Glow up szn ✨",
    durationLabel: "48:12",
    durationSeconds: 48 * 60 + 12,
    viewCount: "12.4K",
    recordedAtIso: new Date(now - 6 * HOUR).toISOString(),
    productIds: ["prod-1", "prod-2"],
    liveStreamId: "feature",
  },
  {
    id: "replay-2",
    hostName: "TechBoy",
    hostAvatar: "/images/lagos-avatar-1.png",
    posterImage: "/images/lagos-feed-2.png",
    title: "Shenzhen tech drops 🔥",
    durationLabel: "1:02:45",
    durationSeconds: 62 * 60 + 45,
    viewCount: "8.6K",
    recordedAtIso: new Date(now - 22 * HOUR).toISOString(),
    productIds: ["prod-3", "prod-4"],
    liveStreamId: "stream-2",
  },
  {
    id: "replay-3",
    hostName: "Chika Styles",
    hostAvatar: "/images/lagos-avatar-2.png",
    posterImage: "/images/lagos-feed-1.png",
    title: "Premium Ankara fits, grab yours",
    durationLabel: "55:30",
    durationSeconds: 55 * 60 + 30,
    viewCount: "5.2K",
    recordedAtIso: new Date(now - 2 * 24 * HOUR).toISOString(),
    productIds: ["prod-1", "prod-3"],
    liveStreamId: "stream-3",
  },
  {
    id: "replay-4",
    hostName: "Kelechi Gadgets",
    hostAvatar: "/images/lagos-avatar-1.png",
    posterImage: "/images/lagos-feed-2.png",
    title: "Power bank face-off · honest review",
    durationLabel: "32:18",
    durationSeconds: 32 * 60 + 18,
    viewCount: "3.1K",
    recordedAtIso: new Date(now - 3 * 24 * HOUR).toISOString(),
    productIds: ["prod-4"],
    liveStreamId: "stream-4",
  },
  {
    id: "replay-5",
    hostName: "Bisi Essentials",
    hostAvatar: "/images/lagos-avatar-2.png",
    posterImage: "/images/lagos-host-stream.png",
    title: "Home decor imported direct",
    durationLabel: "1:14:02",
    durationSeconds: 74 * 60 + 2,
    viewCount: "4.8K",
    recordedAtIso: new Date(now - 5 * 24 * HOUR).toISOString(),
    productIds: ["prod-2", "prod-4"],
    liveStreamId: "stream-5",
  },
  {
    id: "replay-6",
    hostName: "Emeka Fresh",
    hostAvatar: "/images/lagos-avatar-1.png",
    posterImage: "/images/lagos-feed-1.png",
    title: "Sneaker drop replay",
    durationLabel: "41:55",
    durationSeconds: 41 * 60 + 55,
    viewCount: "9.7K",
    recordedAtIso: new Date(now - 7 * 24 * HOUR).toISOString(),
    productIds: ["prod-3", "prod-1"],
    liveStreamId: "stream-6",
  },
];

export function getReplayById(id: string): Replay | undefined {
  return SEED_REPLAYS.find((r) => r.id === id);
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  return `${wk}w ago`;
}
