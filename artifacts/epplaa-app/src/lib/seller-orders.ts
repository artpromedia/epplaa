// Seller-side fulfillment queue. Frontend-only: a synthesized list of incoming
// orders that the approved seller would see in their Studio. Production would
// hydrate this from the order service filtered by sellerId.

import { useLocalStorage } from "./use-local-storage";
import { CountryCode } from "./countries";

export type SellerOrderStatus =
  | "new"
  | "packing"
  | "ready"
  | "in_transit"
  | "delivered"
  | "cancelled";

export interface SellerOrder {
  id: string;
  buyerName: string;
  buyerHandle: string;
  buyerAvatar?: string;
  productTitle: string;
  productImage: string;
  qty: number;
  unitPriceMinor: number;
  countryCode: CountryCode;
  currencyCode: string;
  status: SellerOrderStatus;
  fulfillmentLabel: string;
  pickupOTP?: string;
  pickupLocationName?: string;
  placedAtIso: string;
  // Set when seller marks shipped / handed to courier.
  shippedAtIso?: string;
  // Set when buyer confirms pickup with OTP, or courier marks delivered.
  deliveredAtIso?: string;
  trackingNote?: string;
}

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;
const now = Date.now();

export const SEED_SELLER_ORDERS: SellerOrder[] = [
  {
    id: "EP-SLR-9F4K",
    buyerName: "Adaeze",
    buyerHandle: "ada_lagosgirl",
    buyerAvatar: "/images/lagos-avatar-2.png",
    productTitle: "Premium Ankara Two-Piece Set",
    productImage: "/images/lagos-product-carousel-1.png",
    qty: 1,
    unitPriceMinor: 2450000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "new",
    fulfillmentLabel: "Box pickup, Yaba",
    pickupOTP: "8821",
    pickupLocationName: "Epplaa Box, Sabo Yaba",
    placedAtIso: new Date(now - 1.5 * HOUR).toISOString(),
  },
  {
    id: "EP-SLR-7Q2M",
    buyerName: "Tunde",
    buyerHandle: "tunde_t",
    buyerAvatar: "/images/lagos-avatar-1.png",
    productTitle: "Premium Ankara Two-Piece Set",
    productImage: "/images/lagos-product-carousel-1.png",
    qty: 2,
    unitPriceMinor: 2450000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "new",
    fulfillmentLabel: "Doorstep, Surulere",
    placedAtIso: new Date(now - 3 * HOUR).toISOString(),
  },
  {
    id: "EP-SLR-3P8L",
    buyerName: "Chioma",
    buyerHandle: "chioma_99",
    productTitle: "Tokyo Glass Skin Serum",
    productImage: "/images/lagos-product-serum.png",
    qty: 1,
    unitPriceMinor: 1850000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "packing",
    fulfillmentLabel: "Box pickup, Lekki Phase 1",
    pickupOTP: "5102",
    pickupLocationName: "Epplaa Box, Admiralty Way",
    placedAtIso: new Date(now - 5 * HOUR).toISOString(),
    trackingNote: "Bubble-wrapped, awaiting courier pickup",
  },
  {
    id: "EP-SLR-6X1J",
    buyerName: "Femi",
    buyerHandle: "femi_x",
    buyerAvatar: "/images/lagos-avatar-1.png",
    productTitle: "AirMax Imports Direct",
    productImage: "/images/lagos-feed-1.png",
    qty: 1,
    unitPriceMinor: 4500000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "ready",
    fulfillmentLabel: "Box pickup, Ikeja",
    pickupOTP: "9384",
    pickupLocationName: "Epplaa Box, Allen Avenue",
    placedAtIso: new Date(now - 1 * DAY).toISOString(),
    shippedAtIso: new Date(now - 6 * HOUR).toISOString(),
  },
  {
    id: "EP-SLR-2W7H",
    buyerName: "Bisi",
    buyerHandle: "bisi_essentials",
    productTitle: "20,000mAh Power Bank",
    productImage: "/images/lagos-feed-2.png",
    qty: 3,
    unitPriceMinor: 1250000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "in_transit",
    fulfillmentLabel: "Doorstep, Ajah",
    placedAtIso: new Date(now - 1.5 * DAY).toISOString(),
    shippedAtIso: new Date(now - 1.1 * DAY).toISOString(),
    trackingNote: "Out with rider Joseph, ETA 4pm",
  },
  {
    id: "EP-SLR-8R5G",
    buyerName: "Olu",
    buyerHandle: "oluwa_g",
    buyerAvatar: "/images/lagos-avatar-1.png",
    productTitle: "Tokyo Glass Skin Serum",
    productImage: "/images/lagos-product-serum.png",
    qty: 1,
    unitPriceMinor: 1850000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "delivered",
    fulfillmentLabel: "Box pickup, Yaba",
    placedAtIso: new Date(now - 4 * DAY).toISOString(),
    shippedAtIso: new Date(now - 3.7 * DAY).toISOString(),
    deliveredAtIso: new Date(now - 3 * DAY).toISOString(),
  },
  {
    id: "EP-SLR-1V0D",
    buyerName: "Amaka",
    buyerHandle: "amaka_b",
    buyerAvatar: "/images/lagos-avatar-2.png",
    productTitle: "Premium Ankara Two-Piece Set",
    productImage: "/images/lagos-product-carousel-1.png",
    qty: 1,
    unitPriceMinor: 2450000,
    countryCode: "NG",
    currencyCode: "NGN",
    status: "delivered",
    fulfillmentLabel: "Doorstep, Magodo",
    placedAtIso: new Date(now - 8 * DAY).toISOString(),
    shippedAtIso: new Date(now - 7.5 * DAY).toISOString(),
    deliveredAtIso: new Date(now - 7 * DAY).toISOString(),
  },
];

const STORAGE_KEY = "epplaa-seller-orders";

export function useSellerOrders() {
  const [overrides, setOverrides] = useLocalStorage<
    Partial<Record<string, Partial<SellerOrder>>>
  >(STORAGE_KEY, {});

  const orders: SellerOrder[] = SEED_SELLER_ORDERS.map((o) => ({
    ...o,
    ...(overrides[o.id] ?? {}),
  }));

  function patch(id: string, patchData: Partial<SellerOrder>) {
    setOverrides((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? {}), ...patchData },
    }));
  }

  function markPacking(id: string, note?: string) {
    patch(id, {
      status: "packing",
      trackingNote: note ?? "Picking + packing",
    });
  }

  function markReady(id: string) {
    patch(id, {
      status: "ready",
      shippedAtIso: new Date().toISOString(),
      trackingNote: "Awaiting courier pickup at your hub",
    });
  }

  function markInTransit(id: string, note: string) {
    patch(id, {
      status: "in_transit",
      shippedAtIso: new Date().toISOString(),
      trackingNote: note,
    });
  }

  function verifyPickup(id: string, otpEntered: string): boolean {
    const target = SEED_SELLER_ORDERS.find((o) => o.id === id);
    if (!target?.pickupOTP) return false;
    if (otpEntered.trim() !== target.pickupOTP) return false;
    patch(id, {
      status: "delivered",
      deliveredAtIso: new Date().toISOString(),
      trackingNote: "Buyer collected with OTP",
    });
    return true;
  }

  function markDelivered(id: string) {
    patch(id, {
      status: "delivered",
      deliveredAtIso: new Date().toISOString(),
      trackingNote: "Marked delivered",
    });
  }

  function reset() {
    setOverrides({});
  }

  return {
    orders,
    markPacking,
    markReady,
    markInTransit,
    verifyPickup,
    markDelivered,
    reset,
  };
}

export const SELLER_ORDER_STATUS_LABEL: Record<SellerOrderStatus, string> = {
  new: "New",
  packing: "Packing",
  ready: "Ready for pickup",
  in_transit: "In transit",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
