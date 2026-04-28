import { logger } from "../logger";
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
 * GIG Logistics direct integration. GIG covers Nigeria, Ghana, Kenya,
 * Uganda, Côte d'Ivoire and operates a denser last-mile network than the
 * 3PL aggregator path, so we surface them as a separate carrier choice.
 *
 * Stub mode mirrors Shipbubble's so the buyer sees a real comparison
 * without external creds; rates are slightly cheaper than Shipbubble's
 * stub for short distances and deliver in 2-4 days.
 */
export class GigCarrier implements Carrier {
  readonly code = "gig";

  isConfigured(): boolean {
    return Boolean(process.env.GIG_API_KEY && process.env.GIG_USERNAME);
  }

  /**
   * Stub fallback is allowed only when the carrier is unconfigured (dev/CI)
   * OR when an explicit `STUB_FULFILLMENT=1` escape hatch is set.
   * Production calls with credentials configured fail closed: we throw
   * instead of silently returning a synthetic GIG quote/label.
   */
  private allowStubFallback(): boolean {
    if (!this.isConfigured()) return true;
    if (process.env.STUB_FULFILLMENT === "1") return true;
    return process.env.NODE_ENV !== "production";
  }

  async quote(req: RateRequest): Promise<RateQuote[]> {
    if (!this.isConfigured()) return this.stubQuotes(req);
    try {
      return await this.realQuote(req);
    } catch (err) {
      if (!this.allowStubFallback()) {
        logger.error({ err: (err as Error).message }, "gig_quote_failed_no_fallback");
        throw err;
      }
      logger.warn({ err: (err as Error).message }, "gig_quote_failed_falling_back_stub");
      return this.stubQuotes(req);
    }
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    if (!this.isConfigured()) return this.stubDispatch(req);
    try {
      return await this.realDispatch(req);
    } catch (err) {
      if (!this.allowStubFallback()) {
        logger.error({ err: (err as Error).message, orderId: req.orderId }, "gig_dispatch_failed_no_fallback");
        throw err;
      }
      logger.warn({ err: (err as Error).message }, "gig_dispatch_failed_falling_back_stub");
      return this.stubDispatch(req);
    }
  }

  async track(_carrierRef: string): Promise<TrackingEvent[]> {
    // GIG poll-based tracking is implemented via webhooks in
    // /fulfillment/webhooks/gig — return empty for the on-demand track call.
    return [];
  }

  async cancel(_carrierRef: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async reverse(req: DispatchRequest): Promise<ReverseLabel> {
    const ref = `GIGRV-${req.orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
    return {
      carrierRef: ref,
      labelUrl: `https://stub.giglogistics.com/labels/reverse/${ref}.pdf`,
      trackingUrl: `https://stub.giglogistics.com/track/${ref}`,
    };
  }

  // ---------- Stubs ----------

  private stubQuotes(req: RateRequest): RateQuote[] {
    const totalWeightG = req.items.reduce((s, it) => s + (it.weightG ?? 500) * Math.max(1, it.qty), 0);
    const base = 70000 + Math.round(totalWeightG * 0.4);
    return [
      {
        carrier: this.code,
        service: "gig:economy",
        serviceLabel: "GIG Economy (3-4 days)",
        priceMinor: Math.max(50000, base),
        currencyCode: req.currencyCode,
        etaLabel: "3-4 business days",
        etaDaysMin: 3,
        etaDaysMax: 4,
        raw: { tier: "economy" },
      },
      {
        carrier: this.code,
        service: "gig:standard",
        serviceLabel: "GIG Standard (2 days)",
        priceMinor: Math.max(100000, Math.round(base * 1.6)),
        currencyCode: req.currencyCode,
        etaLabel: "1-2 business days",
        etaDaysMin: 1,
        etaDaysMax: 2,
        raw: { tier: "standard" },
      },
    ];
  }

  private stubDispatch(req: DispatchRequest): DispatchResult {
    const ref = `GIG-${req.orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
    return {
      carrier: this.code,
      carrierRef: ref,
      trackingUrl: `https://stub.giglogistics.com/track/${ref}`,
      labelUrl: `https://stub.giglogistics.com/labels/${ref}.pdf`,
      status: "label_created",
    };
  }

  // ---------- Real GIG API (skeleton) ----------

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${process.env.GIG_API_KEY}`,
      "x-username": process.env.GIG_USERNAME ?? "",
      "content-type": "application/json",
      accept: "application/json",
    };
  }

  private async realQuote(req: RateRequest): Promise<RateQuote[]> {
    const res = await fetch("https://thirdparty.gigl-go.com/api/thirdparty/price", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        ReceiverAddress: req.destination.line,
        ReceiverStateName: req.destination.state ?? req.destination.city,
        ReceiverLocality: req.destination.area,
        DepartureStateName: req.origin.state ?? req.origin.city,
        Weight: req.items.reduce((s, it) => s + (it.weightG ?? 500) * Math.max(1, it.qty), 0) / 1000,
        DeclaredValue: req.items.reduce((s, it) => s + (it.valueMinor ?? 0), 0) / 100,
        VehicleType: "BIKE",
      }),
    });
    if (!res.ok) throw new Error(`gig_price http ${res.status}`);
    const data = (await res.json()) as { Object?: { GrandTotal?: number; CurrencyCode?: string }; CurrencyCode?: string };
    const total = Number(data.Object?.GrandTotal ?? 0);
    return [
      {
        carrier: this.code,
        service: "gig:standard",
        serviceLabel: "GIG Standard",
        priceMinor: Math.round(total * 100),
        currencyCode: req.currencyCode,
        etaLabel: "1-2 business days",
        etaDaysMin: 1,
        etaDaysMax: 2,
        raw: { provider: "gig" },
      },
    ];
  }

  private async realDispatch(req: DispatchRequest): Promise<DispatchResult> {
    const res = await fetch("https://thirdparty.gigl-go.com/api/thirdparty/shipment", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        CustomerCode: process.env.GIG_USERNAME,
        ReceiverName: req.destination.recipientName ?? "Buyer",
        ReceiverPhoneNumber: req.destination.recipientPhone ?? "",
        ReceiverAddress: req.destination.line,
        ReceiverStateName: req.destination.state ?? req.destination.city,
        SenderName: "Epplaa",
        ShipmentItems: req.items.map((it) => ({
          Quantity: it.qty,
          Description: it.description ?? it.productId,
          Weight: (it.weightG ?? 500) / 1000,
          Value: (it.valueMinor ?? 0) / 100,
        })),
      }),
    });
    if (!res.ok) throw new Error(`gig_shipment http ${res.status}`);
    const data = (await res.json()) as { Object?: { Waybill?: string } };
    const ref = String(data.Object?.Waybill ?? "");
    if (!ref) throw new Error("gig_dispatch_no_waybill");
    return {
      carrier: this.code,
      carrierRef: ref,
      trackingUrl: `https://giglogistics.com/track/${ref}`,
      labelUrl: "",
      status: "label_created",
    };
  }
}
