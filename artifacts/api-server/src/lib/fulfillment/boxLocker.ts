import type {
  Carrier,
  DispatchRequest,
  DispatchResult,
  RateQuote,
  RateRequest,
  ReverseLabel,
  TrackingEvent,
} from "./types";

/**
 * BoxLocker — Epplaa's internal smart-locker network. Used when the buyer
 * picks an "Epplaa Box" fulfillment option at checkout. There is no
 * external HTTP cost, so this carrier always returns the same single quote
 * (a flat handling fee) and dispatch is a no-op that just produces a
 * deterministic carrierRef the box reservation row can pivot on.
 *
 * Tracking events for box shipments come from two sources:
 *  - Seller / rider scans handled by /seller/orders transitions (stocked
 *    event flows in via the seller dispatch endpoint).
 *  - Buyer collection via POST /box/unlock (unlocks the locker and emits
 *    the delivered event).
 */
export class BoxCarrier implements Carrier {
  readonly code = "box";

  isConfigured(): boolean {
    return true;
  }

  async quote(req: RateRequest): Promise<RateQuote[]> {
    return [
      {
        carrier: this.code,
        service: "box:locker",
        serviceLabel: "Epplaa Box (smart locker)",
        // Flat handling fee (NGN 200 / KES 25 equivalent in minor units).
        priceMinor: 20000,
        currencyCode: req.currencyCode,
        etaLabel: "Ready in 1-2 days",
        etaDaysMin: 1,
        etaDaysMax: 2,
        raw: { kind: "box" },
      },
    ];
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    const ref = `BOX-${req.orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
    return {
      carrier: this.code,
      carrierRef: ref,
      // Tracking URL points at the in-app order page since locker status is
      // fully owned by us and there's no external website to deep-link to.
      trackingUrl: `/orders/${req.orderId}`,
      labelUrl: "",
      status: "label_created",
    };
  }

  async track(_carrierRef: string): Promise<TrackingEvent[]> {
    return [];
  }

  async cancel(_carrierRef: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async reverse(req: DispatchRequest): Promise<ReverseLabel> {
    const ref = `BOXRV-${req.orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
    return {
      carrierRef: ref,
      labelUrl: "",
      trackingUrl: `/orders/${req.orderId}`,
    };
  }
}
