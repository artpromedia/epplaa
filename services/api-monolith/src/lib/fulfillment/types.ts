/**
 * Carrier abstraction. Every shipping provider (Shipbubble, GIG, internal
 * BoxLocker, etc.) implements this interface so the dispatch flow is
 * provider-agnostic. Stub implementations return deterministic fake quotes
 * and a working tracking simulator when env keys are missing — that way
 * dev / CI exercises the full happy path without external HTTP.
 */

export interface ShippingAddress {
  line: string;
  area: string;
  city: string;
  state?: string;
  countryCode: string;
  postcode?: string;
  lat?: number;
  lng?: number;
  /** OkHi place id when verified. */
  placeId?: string;
  /** Recipient contact (denormalized so carriers don't need our user table). */
  recipientName?: string;
  recipientPhone?: string;
}

export interface ShipmentItem {
  productId: string;
  qty: number;
  /** Item weight in grams. Defaults to 500g per unit when unknown. */
  weightG?: number;
  /** Declared value in minor units of the order currency. */
  valueMinor?: number;
  description?: string;
}

export interface RateRequest {
  origin: ShippingAddress;
  destination: ShippingAddress;
  items: ShipmentItem[];
  currencyCode: string;
  /** Optional fulfillment option id chosen at checkout — narrows the carrier set. */
  optionId?: string;
}

export interface RateQuote {
  /** Stable carrier code (shipbubble | gig | box | pudo). */
  carrier: string;
  /** Provider-specific service id (e.g. "shipbubble:gig-standard"). */
  service: string;
  serviceLabel: string;
  /** Price in minor units of the requested currency. */
  priceMinor: number;
  currencyCode: string;
  etaLabel: string;
  etaDaysMin: number;
  etaDaysMax: number;
  /** Provider-specific opaque payload to round-trip back into dispatch(). */
  raw?: Record<string, unknown>;
}

export interface DispatchRequest {
  orderId: string;
  service: string;
  rate: RateQuote;
  origin: ShippingAddress;
  destination: ShippingAddress;
  items: ShipmentItem[];
  currencyCode: string;
}

export interface DispatchResult {
  carrier: string;
  carrierRef: string;
  trackingUrl: string;
  labelUrl: string;
  /** Initial provider status string, normalized into our lifecycle by the caller. */
  status: string;
}

export interface TrackingEvent {
  providerEventId: string;
  status: string;
  rawStatus: string;
  note: string;
  location: string;
  occurredAt: Date;
}

export interface ReverseLabel {
  carrierRef: string;
  labelUrl: string;
  trackingUrl: string;
}

export interface Carrier {
  readonly code: string;
  isConfigured(): boolean;
  quote(req: RateRequest): Promise<RateQuote[]>;
  dispatch(req: DispatchRequest): Promise<DispatchResult>;
  track(carrierRef: string): Promise<TrackingEvent[]>;
  cancel(carrierRef: string): Promise<{ ok: boolean; error?: string }>;
  reverse(req: DispatchRequest): Promise<ReverseLabel>;
}

/**
 * Normalize a provider status string into our lifecycle vocabulary.
 * Anything we don't recognize stays "in_transit" — better than dropping
 * the event entirely, since the rawStatus is preserved alongside.
 */
export function normalizeShipmentStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s.includes("returned") || s.includes("return_to_sender")) return "returned";
  if (s.includes("failed") || s.includes("undelivered")) return "failed";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("arrived") || s.includes("ready_for_pickup") || s.includes("at_pickup_point")) return "arrived";
  if (s.includes("picked_up") || s.includes("collected_pudo")) return "picked_up";
  if (s.includes("label") || s.includes("created")) return "label_created";
  return "in_transit";
}
