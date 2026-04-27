import { SEED_STREAMS, SEED_PRODUCTS } from "./seed";

export interface DropAlert {
  id: string;
  kind: "live" | "new_listing";
  sellerName: string;
  hostAvatar?: string;
  title: string;
  detail: string;
  href: string;
  createdAtIso: string;
}

const SYNTHETIC_DAY_MS = 1000 * 60 * 60 * 24;

export function generateDropAlerts(followedSellers: string[]): DropAlert[] {
  if (followedSellers.length === 0) return [];

  const alerts: DropAlert[] = [];
  const now = Date.now();

  SEED_STREAMS.forEach((stream, idx) => {
    if (!followedSellers.includes(stream.hostName)) return;
    alerts.push({
      id: `live-${stream.id}`,
      kind: "live",
      sellerName: stream.hostName,
      hostAvatar: stream.hostAvatar,
      title: `${stream.hostName} is live now`,
      detail: stream.title,
      href: `/live/${stream.id}`,
      createdAtIso: new Date(now - idx * 1000 * 60 * 7).toISOString(),
    });
  });

  SEED_PRODUCTS.forEach((p, idx) => {
    if (!followedSellers.includes(p.sellerName)) return;
    alerts.push({
      id: `drop-${p.id}`,
      kind: "new_listing",
      sellerName: p.sellerName,
      hostAvatar: p.sellerAvatar,
      title: `New from ${p.sellerName}`,
      detail: p.title,
      href: `/product/${p.id}`,
      createdAtIso: new Date(now - SYNTHETIC_DAY_MS - idx * 1000 * 60 * 30).toISOString(),
    });
  });

  return alerts.sort(
    (a, b) =>
      new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime(),
  );
}
