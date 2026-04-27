// Seller broadcast history. A list of past go-live sessions with peak viewers,
// orders driven, and gross sales. Frontend seed for the prototype; production
// would aggregate from streaming + orders services per sellerId.

import { useLocalStorage } from "./use-local-storage";

export interface SellerStreamRecord {
  id: string;
  title: string;
  category: string;
  startedAtIso: string;
  durationMinutes: number;
  peakViewers: number;
  totalViewers: number;
  ordersCount: number;
  grossMinor: number;
  posterImage: string;
  productIds: string[];
}

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;
const now = Date.now();

export const SEED_SELLER_STREAMS: SellerStreamRecord[] = [
  {
    id: "ss-1",
    title: "Ankara Friday flash drop",
    category: "Fashion",
    startedAtIso: new Date(now - 2 * DAY).toISOString(),
    durationMinutes: 62,
    peakViewers: 384,
    totalViewers: 1240,
    ordersCount: 17,
    grossMinor: 41650000,
    posterImage: "/images/lagos-host-stream.png",
    productIds: ["lst_seed_1", "lst_seed_2"],
  },
  {
    id: "ss-2",
    title: "Skincare Q&A · serums explained",
    category: "Beauty",
    startedAtIso: new Date(now - 5 * DAY).toISOString(),
    durationMinutes: 41,
    peakViewers: 220,
    totalViewers: 760,
    ordersCount: 9,
    grossMinor: 16650000,
    posterImage: "/images/lagos-product-serum.png",
    productIds: ["lst_seed_3"],
  },
  {
    id: "ss-3",
    title: "Weekend bundle stream",
    category: "Fashion",
    startedAtIso: new Date(now - 9 * DAY).toISOString(),
    durationMinutes: 88,
    peakViewers: 512,
    totalViewers: 1820,
    ordersCount: 28,
    grossMinor: 68600000,
    posterImage: "/images/lagos-feed-1.png",
    productIds: ["lst_seed_1", "lst_seed_4"],
  },
  {
    id: "ss-4",
    title: "First go-live · intro stream",
    category: "Other",
    startedAtIso: new Date(now - 21 * DAY).toISOString(),
    durationMinutes: 23,
    peakViewers: 84,
    totalViewers: 210,
    ordersCount: 2,
    grossMinor: 3700000,
    posterImage: "/images/lagos-feed-2.png",
    productIds: [],
  },
];

const STORAGE_KEY = "epplaa-seller-streams";

export function useSellerStreams() {
  const [extra, setExtra] = useLocalStorage<SellerStreamRecord[]>(
    STORAGE_KEY,
    [],
  );

  const all = [...extra, ...SEED_SELLER_STREAMS].sort(
    (a, b) =>
      new Date(b.startedAtIso).getTime() - new Date(a.startedAtIso).getTime(),
  );

  function logStream(rec: Omit<SellerStreamRecord, "id">) {
    const id = `ss_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setExtra((prev) => [{ id, ...rec }, ...prev]);
    return id;
  }

  function reset() {
    setExtra([]);
  }

  return { streams: all, logStream, reset };
}

export function summarizeStreams(streams: SellerStreamRecord[]) {
  return streams.reduce(
    (acc, s) => ({
      totalStreams: acc.totalStreams + 1,
      totalMinutes: acc.totalMinutes + s.durationMinutes,
      totalOrders: acc.totalOrders + s.ordersCount,
      grossMinor: acc.grossMinor + s.grossMinor,
      peakViewers: Math.max(acc.peakViewers, s.peakViewers),
    }),
    { totalStreams: 0, totalMinutes: 0, totalOrders: 0, grossMinor: 0, peakViewers: 0 },
  );
}
