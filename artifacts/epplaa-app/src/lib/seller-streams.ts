// Seller broadcast history, fetched from the server.

import { useMemo } from "react";
import { useListSellerStreams } from "@workspace/api-client-react";

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

export function useSellerStreams() {
  const query = useListSellerStreams();
  const streams = useMemo<SellerStreamRecord[]>(
    () =>
      (query.data ?? []).slice().sort(
        (a, b) =>
          new Date(b.startedAtIso).getTime() - new Date(a.startedAtIso).getTime(),
      ),
    [query.data],
  );

  // Local-only no-ops so the broadcast UI keeps working until the server
  // exposes a logStream endpoint.
  function logStream(_rec: Omit<SellerStreamRecord, "id">) {
    return `tmp_${Date.now()}`;
  }
  function reset() {}

  return { streams, logStream, reset };
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
