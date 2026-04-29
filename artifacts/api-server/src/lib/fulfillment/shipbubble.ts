import { logger } from "../logger";
import {
  detectNonHostnameProductionSignals,
  isProductionEnvironment,
} from "../productionSignals";

/**
 * Boot-time sanity check: production deploys MUST set
 * `SHIPBUBBLE_API_KEY` and `SHIPBUBBLE_SENDER_CODE`, plus
 * `SHIPBUBBLE_WEBHOOK_SECRET` for inbound webhook verification.
 *
 * `ShipbubbleCarrier.isConfigured()` (below) only returns `true`
 * when `SHIPBUBBLE_API_KEY` is set. If unset, every quote / dispatch
 * call returns three deterministic stub service tiers
 * (standard / express / same-day) priced from a small linear
 * function of declared value + weight. The runtime
 * `allowStubFallback()` production-signal guard already refuses to
 * substitute the stub at runtime when production-shape is detected
 * AND keys are configured (so a real-call failure fails closed
 * instead of dispatching a synthetic shipment), but a deploy that
 * never set the keys at all bypasses that guard entirely — the
 * stub IS the carrier on a misconfigured production deploy. Buyers
 * see fake rates and orders ship under fake tracking numbers.
 *
 * `SHIPBUBBLE_SENDER_CODE` is required for the real return-address
 * call (used in dispatch); without it real Shipbubble dispatches
 * return 4xx but the misconfiguration would only surface at the
 * first dispatch attempt.
 *
 * `SHIPBUBBLE_WEBHOOK_SECRET` is required to verify the
 * `x-shipbubble-signature` header on inbound tracking webhooks; if
 * unset, the webhook handler in `routes/fulfillmentWebhooks.ts`
 * cannot authenticate Shipbubble's callbacks and tracking events
 * are silently dropped.
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure — the runtime guards still fail closed at the consumer
 * site for a partial misconfiguration. Operators wire a Sentry /
 * log-aggregator alert on the
 * `shipbubble_credentials_missing_for_production` message tag.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned (each var missing
 * individually + multiple missing), and configured-silent paths
 * without poisoning `process.env` or piping pino output.
 */
export type ShipbubbleConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertShipbubbleConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): ShipbubbleConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const apiKey = (env.SHIPBUBBLE_API_KEY ?? "").trim();
  const senderCode = (env.SHIPBUBBLE_SENDER_CODE ?? "").trim();
  const webhookSecret = (env.SHIPBUBBLE_WEBHOOK_SECRET ?? "").trim();
  const missing: string[] = [];
  if (apiKey === "") missing.push("SHIPBUBBLE_API_KEY");
  if (senderCode === "") missing.push("SHIPBUBBLE_SENDER_CODE");
  if (webhookSecret === "") missing.push("SHIPBUBBLE_WEBHOOK_SECRET");
  if (missing.length === 0) return { ok: true };
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    `${missing.join(" + ")} not set on this production deploy. ` +
    "Without SHIPBUBBLE_API_KEY the carrier returns three deterministic " +
    "stub service tiers and orders ship under fake tracking numbers; " +
    "without SHIPBUBBLE_SENDER_CODE real dispatches 4xx; without " +
    "SHIPBUBBLE_WEBHOOK_SECRET inbound tracking events fail signature " +
    "verification and are silently dropped. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set the missing env var(s) — see docs/runbooks/production-secrets.md " +
    "(Shipbubble section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      shipbubble_api_key: apiKey === "" ? null : "[set]",
      shipbubble_sender_code: senderCode === "" ? null : "[set]",
      shipbubble_webhook_secret: webhookSecret === "" ? null : "[set]",
      missing,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `shipbubble_credentials_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}
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
 * Shipbubble (3PL aggregator covering Nigeria + several West African
 * markets). We treat it as a single carrier from the app's POV — multiple
 * underlying couriers are exposed as different `service` values inside the
 * quote response.
 *
 * Stub mode: when SHIPBUBBLE_API_KEY is unset we return three deterministic
 * service tiers (standard / express / same-day) priced from a small linear
 * function of declared value + weight. That keeps checkout, dispatch, and
 * tracking fully exercisable in dev and CI without an external account.
 */
export class ShipbubbleCarrier implements Carrier {
  readonly code = "shipbubble";

  isConfigured(): boolean {
    return Boolean(process.env.SHIPBUBBLE_API_KEY);
  }

  /**
   * Stub fallback is allowed only when the carrier is unconfigured (dev/CI)
   * OR when an explicit `STUB_FULFILLMENT=1` escape hatch is set. In
   * production with credentials configured we never silently substitute
   * fake quotes/labels on real-call failure — the caller will surface an
   * error so the buyer doesn't get charged against a synthetic shipment.
   *
   * Defense-in-depth (Task #83): even with `STUB_FULFILLMENT=1`, refuse
   * to fall back if any production signal (NODE_ENV / REPLIT_DEPLOYMENT /
   * DEPLOYMENT_ENVIRONMENT / hostname-pattern match) is detected. This
   * prevents a copy-paste of staging env vars (which include the stub
   * escape hatch) into a production deploy from silently substituting
   * synthetic carrier data on real-call failure.
   */
  private allowStubFallback(): boolean {
    if (!this.isConfigured()) return true;
    if (isProductionEnvironment(process.env, logger)) return false;
    if (process.env.STUB_FULFILLMENT === "1") return true;
    return process.env.NODE_ENV !== "production";
  }

  async quote(req: RateRequest): Promise<RateQuote[]> {
    if (this.isConfigured()) {
      try {
        return await this.realQuote(req);
      } catch (err) {
        if (!this.allowStubFallback()) {
          logger.error({ err: (err as Error).message }, "shipbubble_quote_real_failed_no_fallback");
          throw err;
        }
        logger.warn({ err: (err as Error).message }, "shipbubble_quote_real_failed_falling_back_stub");
      }
    }
    return this.stubQuotes(req);
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    if (this.isConfigured()) {
      try {
        return await this.realDispatch(req);
      } catch (err) {
        if (!this.allowStubFallback()) {
          logger.error(
            { err: (err as Error).message, orderId: req.orderId },
            "shipbubble_dispatch_real_failed_no_fallback",
          );
          throw err;
        }
        logger.warn({ err: (err as Error).message, orderId: req.orderId }, "shipbubble_dispatch_real_failed_falling_back_stub");
      }
    }
    return this.stubDispatch(req);
  }

  async track(carrierRef: string): Promise<TrackingEvent[]> {
    if (this.isConfigured()) {
      try {
        return await this.realTrack(carrierRef);
      } catch (err) {
        logger.warn({ err: (err as Error).message, carrierRef }, "shipbubble_track_real_failed");
        return [];
      }
    }
    return [];
  }

  async cancel(carrierRef: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: true };
    try {
      const res = await fetch(`https://api.shipbubble.com/v1/shipping/labels/${encodeURIComponent(carrierRef)}/cancel`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      if (!res.ok) return { ok: false, error: `http ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async reverse(req: DispatchRequest): Promise<ReverseLabel> {
    if (this.isConfigured()) {
      try {
        return await this.realReverse(req);
      } catch (err) {
        if (!this.allowStubFallback()) {
          logger.error({ err: (err as Error).message }, "shipbubble_reverse_failed_no_fallback");
          throw err;
        }
        logger.warn({ err: (err as Error).message }, "shipbubble_reverse_failed_falling_back_stub");
      }
    }
    const ref = `SBRV-${req.orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
    return {
      carrierRef: ref,
      labelUrl: `https://stub.shipbubble.dev/labels/reverse/${ref}.pdf`,
      trackingUrl: `https://stub.shipbubble.dev/track/${ref}`,
    };
  }

  // ---------- Stub helpers ----------

  private stubQuotes(req: RateRequest): RateQuote[] {
    const totalWeightG = req.items.reduce((s, it) => s + (it.weightG ?? 500) * Math.max(1, it.qty), 0);
    const declaredMinor = req.items.reduce((s, it) => s + (it.valueMinor ?? 0), 0);
    // Base price scales gently with weight + declared value. Numbers chosen
    // so an average phone-case order lands at sane sub-NGN-2000 quotes.
    const base = 80000 + Math.round(totalWeightG * 0.5) + Math.round(declaredMinor * 0.005);
    return [
      {
        carrier: this.code,
        service: "shipbubble:standard",
        serviceLabel: "Standard delivery (3-5 days)",
        priceMinor: Math.max(50000, base),
        currencyCode: req.currencyCode,
        etaLabel: "3-5 business days",
        etaDaysMin: 3,
        etaDaysMax: 5,
        raw: { courier: "stub-standard" },
      },
      {
        carrier: this.code,
        service: "shipbubble:express",
        serviceLabel: "Express (1-2 days)",
        priceMinor: Math.max(120000, base * 2),
        currencyCode: req.currencyCode,
        etaLabel: "1-2 business days",
        etaDaysMin: 1,
        etaDaysMax: 2,
        raw: { courier: "stub-express" },
      },
      {
        carrier: this.code,
        service: "shipbubble:sameday",
        serviceLabel: "Same-day (within city)",
        priceMinor: Math.max(180000, base * 3),
        currencyCode: req.currencyCode,
        etaLabel: "Today",
        etaDaysMin: 0,
        etaDaysMax: 1,
        raw: { courier: "stub-sameday" },
      },
    ];
  }

  private stubDispatch(req: DispatchRequest): DispatchResult {
    const ref = `SB-${req.orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
    return {
      carrier: this.code,
      carrierRef: ref,
      trackingUrl: `https://stub.shipbubble.dev/track/${ref}`,
      labelUrl: `https://stub.shipbubble.dev/labels/${ref}.pdf`,
      status: "label_created",
    };
  }

  // ---------- Real Shipbubble API ----------

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${process.env.SHIPBUBBLE_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    };
  }

  private async realQuote(req: RateRequest): Promise<RateQuote[]> {
    const body = {
      sender_address_code: process.env.SHIPBUBBLE_SENDER_CODE,
      reciever_address_code: req.destination.placeId,
      pickup_date: new Date().toISOString().slice(0, 10),
      category_id: 1,
      package_items: req.items.map((it) => ({
        name: it.description ?? it.productId,
        quantity: it.qty,
        weight: Math.max(0.1, (it.weightG ?? 500) / 1000),
        unit_amount: (it.valueMinor ?? 0) / 100,
      })),
    };
    const res = await fetch("https://api.shipbubble.com/v1/shipping/fetch_rates", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`shipbubble_rates http ${res.status}`);
    const data = (await res.json()) as { data?: { courier_rates?: Array<{ courier_id: string; courier_name: string; total: number; pickup_eta: string; delivery_eta: string }>; request_token?: string } };
    const courierRates = data.data?.courier_rates ?? [];
    return courierRates.map((c) => {
      const days = Number((c.delivery_eta ?? "3").match(/\d+/)?.[0] ?? 3);
      return {
        carrier: this.code,
        service: `shipbubble:${c.courier_id}`,
        serviceLabel: c.courier_name,
        priceMinor: Math.round(Number(c.total) * 100),
        currencyCode: req.currencyCode,
        etaLabel: c.delivery_eta,
        etaDaysMin: Math.max(0, days - 1),
        etaDaysMax: days + 1,
        raw: { request_token: data.data?.request_token, service_code: c.courier_id },
      } satisfies RateQuote;
    });
  }

  private async realDispatch(req: DispatchRequest): Promise<DispatchResult> {
    const raw = (req.rate.raw ?? {}) as { request_token?: string; service_code?: string };
    const res = await fetch("https://api.shipbubble.com/v1/shipping/labels", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        request_token: raw.request_token,
        service_code: raw.service_code,
        courier_id: req.service.replace("shipbubble:", ""),
      }),
    });
    if (!res.ok) throw new Error(`shipbubble_dispatch http ${res.status}`);
    const data = (await res.json()) as { data?: { order_id?: string; tracking_url?: string; label_url?: string; status?: string } };
    const ref = String(data.data?.order_id ?? "");
    if (!ref) throw new Error("shipbubble_dispatch_no_order_id");
    return {
      carrier: this.code,
      carrierRef: ref,
      trackingUrl: data.data?.tracking_url ?? `https://www.shipbubble.com/track/${ref}`,
      labelUrl: data.data?.label_url ?? "",
      status: data.data?.status ?? "label_created",
    };
  }

  private async realTrack(carrierRef: string): Promise<TrackingEvent[]> {
    const res = await fetch(`https://api.shipbubble.com/v1/shipping/labels/${encodeURIComponent(carrierRef)}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`shipbubble_track http ${res.status}`);
    const data = (await res.json()) as {
      data?: { tracking_history?: Array<{ id?: string; status?: string; description?: string; location?: string; date?: string }> };
    };
    const history = data.data?.tracking_history ?? [];
    return history.map((h, i) => ({
      providerEventId: String(h.id ?? `${carrierRef}:${i}`),
      status: String(h.status ?? "in_transit"),
      rawStatus: String(h.status ?? ""),
      note: String(h.description ?? ""),
      location: String(h.location ?? ""),
      occurredAt: h.date ? new Date(h.date) : new Date(),
    }));
  }

  private async realReverse(req: DispatchRequest): Promise<ReverseLabel> {
    const res = await fetch("https://api.shipbubble.com/v1/shipping/reverse_labels", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        original_order_id: req.orderId,
        pickup_address: req.destination,
        return_address_code: process.env.SHIPBUBBLE_SENDER_CODE,
      }),
    });
    if (!res.ok) throw new Error(`shipbubble_reverse http ${res.status}`);
    const data = (await res.json()) as { data?: { order_id?: string; tracking_url?: string; label_url?: string } };
    const ref = String(data.data?.order_id ?? "");
    if (!ref) throw new Error("shipbubble_reverse_no_order_id");
    return {
      carrierRef: ref,
      labelUrl: data.data?.label_url ?? "",
      trackingUrl: data.data?.tracking_url ?? `https://www.shipbubble.com/track/${ref}`,
    };
  }
}
