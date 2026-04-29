import { eq, sql, and, inArray, ne } from "drizzle-orm";
import { enqueueNotification } from "./notifications";
import { dispatchShipmentForOrder } from "./fulfillment/dispatch";
import {
  DevMockGateway,
  FlutterwaveGateway,
  GatewayRouter,
  PaystackGateway,
  type GatewayHealthSnapshot,
  type GatewayName,
  type HealthStore,
  type PaymentGateway,
} from "@workspace/payments";
import { db, schema } from "./db";
import { logger } from "./logger";
import { detectNonHostnameProductionSignals } from "./productionSignals";
import {
  getPaymentGatewayWatcher,
  registerPaymentGatewayWatcher,
} from "./subsystemHealth";
import { gatewayCircuitMonitor } from "./alerts/gatewayHealthAlerts";

/**
 * Boot-time sanity check: production deploys MUST set at least one of
 * `PAYSTACK_SECRET_KEY` or `FLUTTERWAVE_SECRET_KEY` (and
 * `FLUTTERWAVE_WEBHOOK_HASH` if Flutterwave is the only gateway —
 * see notes below).
 *
 * If neither real gateway is configured, `selectPrimaryAndSecondary`
 * (below) selects the `DevMockGateway` for both slots — a fake
 * payment processor that always returns `{ ok: true }` without
 * touching a real card. On a production deploy that means
 * **buyers cannot actually pay**: the checkout flow will appear to
 * succeed (and order rows will be created), but no real authorization
 * has happened. The `payments_initialized` info log surfaces
 * `mode: "dev-mock"` at boot but it's exactly the kind of one-line
 * boot signal that gets lost in normal startup chatter.
 *
 * The check WARNS when:
 *
 *   - production-shape is detected (any of `NODE_ENV=production`,
 *     `REPLIT_DEPLOYMENT=1`, `DEPLOYMENT_ENVIRONMENT=production`),
 *   - AND neither `PAYSTACK_SECRET_KEY` nor `FLUTTERWAVE_SECRET_KEY`
 *     is set / non-empty.
 *
 * It also warns when only `FLUTTERWAVE_SECRET_KEY` is set without
 * `FLUTTERWAVE_WEBHOOK_HASH` (the gateway will accept charges but
 * cannot verify webhooks — silent settlement loss).
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure: an internal-only deploy may legitimately ship without
 * real payments while it's being stood up. Operators wire a Sentry /
 * log-aggregator alert on the
 * `payment_provider_missing_for_production` message tag.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type PaymentProviderConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertPaymentProviderConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): PaymentProviderConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const paystack = (env.PAYSTACK_SECRET_KEY ?? "").trim();
  const flutterwave = (env.FLUTTERWAVE_SECRET_KEY ?? "").trim();
  const flutterwaveHash = (env.FLUTTERWAVE_WEBHOOK_HASH ?? "").trim();
  const hasPaystack = paystack !== "";
  const hasFlutterwave = flutterwave !== "";
  const flutterwaveOnly = !hasPaystack && hasFlutterwave;
  if (hasPaystack || hasFlutterwave) {
    if (flutterwaveOnly && flutterwaveHash === "") {
      // Charges would work, webhook verification would silently
      // accept any payload — settlement events could be spoofed or
      // dropped without notice.
      const signalDetails = productionSignals
        .map((s) => s.detail)
        .join("; ");
      const reason =
        "FLUTTERWAVE_SECRET_KEY is set but FLUTTERWAVE_WEBHOOK_HASH is " +
        "not, and Flutterwave is the only configured gateway. The " +
        "gateway will accept charges but cannot verify webhooks, so " +
        "settlement events may be spoofed or silently dropped. " +
        `Detected production signal(s): ${signalDetails}. ` +
        "Set FLUTTERWAVE_WEBHOOK_HASH — see " +
        "docs/runbooks/production-secrets.md (Payments section).";
      log.warn(
        {
          node_env: env.NODE_ENV,
          replit_deployment: env.REPLIT_DEPLOYMENT,
          deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
          paystack_secret_key: hasPaystack ? "[set]" : null,
          flutterwave_secret_key: hasFlutterwave ? "[set]" : null,
          flutterwave_webhook_hash: null,
          missing: ["FLUTTERWAVE_WEBHOOK_HASH"],
          production_signals: productionSignals.map((s) => s.signal),
        },
        `payment_provider_missing_for_production: ${reason}`,
      );
      return { ok: false, reason };
    }
    return { ok: true };
  }
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "Neither PAYSTACK_SECRET_KEY nor FLUTTERWAVE_SECRET_KEY is set on " +
    "this production deploy. lib/payments.ts selectPrimaryAndSecondary " +
    "falls back to DevMockGateway, which always returns { ok: true } " +
    "without touching a real card. Buyers cannot actually pay — the " +
    "checkout will appear to succeed but no real authorization has " +
    "happened. " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set at least one of PAYSTACK_SECRET_KEY or FLUTTERWAVE_SECRET_KEY " +
    "(and FLUTTERWAVE_WEBHOOK_HASH if Flutterwave is the only " +
    "gateway) — see docs/runbooks/production-secrets.md " +
    "(Payments section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      paystack_secret_key: null,
      flutterwave_secret_key: null,
      flutterwave_webhook_hash: null,
      missing: ["PAYSTACK_SECRET_KEY", "FLUTTERWAVE_SECRET_KEY"],
      production_signals: productionSignals.map((s) => s.signal),
    },
    `payment_provider_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}
import { newPaymentAttemptId, newPaymentIntentId, newPaymentReference } from "./ids";
import { requiredTierForOrder } from "./kyc";
import { sellerSanctionsBlocked, manufacturerSanctionsBlocked } from "./sanctions";
import { recordAudit } from "./audit";

/**
 * 5-minute rolling window for the gateway health counters. The router opens
 * the circuit breaker when the failure rate exceeds 40% with at least 5
 * samples in the window.
 */
const HEALTH_WINDOW_MS = 5 * 60 * 1000;

class DbHealthStore implements HealthStore {
  async read(gateway: GatewayName): Promise<GatewayHealthSnapshot> {
    const [row] = await db
      .select()
      .from(schema.gatewayHealthTable)
      .where(eq(schema.gatewayHealthTable.gateway, gateway))
      .limit(1);
    if (!row) {
      return { gateway, successCount: 0, failureCount: 0, successRate: 1, circuitOpenUntil: null };
    }
    // Reset rolling window if it's older than HEALTH_WINDOW_MS.
    if (Date.now() - row.windowStartedAt.getTime() > HEALTH_WINDOW_MS) {
      await db
        .update(schema.gatewayHealthTable)
        .set({ successCount: 0, failureCount: 0, windowStartedAt: new Date() })
        .where(eq(schema.gatewayHealthTable.gateway, gateway));
      return { gateway, successCount: 0, failureCount: 0, successRate: 1, circuitOpenUntil: row.circuitOpenUntil };
    }
    const total = row.successCount + row.failureCount;
    return {
      gateway,
      successCount: row.successCount,
      failureCount: row.failureCount,
      successRate: total === 0 ? 1 : row.successCount / total,
      circuitOpenUntil: row.circuitOpenUntil,
    };
  }

  async record(gateway: GatewayName, ok: boolean): Promise<void> {
    // Snapshot the previous breaker state BEFORE writing — we feed it
    // into the alert monitor so the next "successful op after the
    // breaker has expired" can be detected as the recovery edge. If
    // the row doesn't exist yet, `previousOpenUntilMs` is null which
    // the monitor treats as "no prior incident to recover from".
    const [priorRow] = await db
      .select({ circuitOpenUntil: schema.gatewayHealthTable.circuitOpenUntil })
      .from(schema.gatewayHealthTable)
      .where(eq(schema.gatewayHealthTable.gateway, gateway))
      .limit(1);
    const previousOpenUntilMs = priorRow?.circuitOpenUntil
      ? priorRow.circuitOpenUntil.getTime()
      : null;
    await db
      .insert(schema.gatewayHealthTable)
      .values({
        gateway,
        successCount: ok ? 1 : 0,
        failureCount: ok ? 0 : 1,
        lastEventAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.gatewayHealthTable.gateway,
        set: {
          successCount: ok
            ? sql`${schema.gatewayHealthTable.successCount} + 1`
            : schema.gatewayHealthTable.successCount,
          failureCount: ok
            ? schema.gatewayHealthTable.failureCount
            : sql`${schema.gatewayHealthTable.failureCount} + 1`,
          lastEventAt: new Date(),
        },
      });
    // Also feed the in-process SubsystemFailureWatcher so the same
    // success/failure stream that powers the in-DB circuit breaker
    // also drives the duration-based stuck-degraded alert via
    // /healthz's `subsystems` map. We deliberately do this AFTER the
    // DB write so a failure to persist the counter row doesn't also
    // hide the health signal from /healthz — but a thrown DB error
    // would skip the watcher update, which is fine because the call
    // site (`GatewayRouter.recordAndMaybeTrip`) already treats a
    // health-store throw as "best effort".
    //
    // Watchers are only registered for real, configured gateways
    // (registered at module init below). The dev-mock gateway is
    // never registered: its "success" is fake and a permanently-
    // healthy `paymentGatewayDevmock` entry would actively mislead
    // on-call. `getPaymentGatewayWatcher` returns undefined for
    // unregistered gateways, so we silently no-op rather than
    // throwing.
    const watcher = getPaymentGatewayWatcher(gateway);
    if (watcher) {
      if (ok) watcher.recordSuccess();
      else watcher.record();
    }
    // Out-of-band recovery detection: if the breaker has expired and
    // the next operation succeeds, we page on-call with the paired
    // "all clear". The monitor swallows its own errors so the payment
    // hot path never breaks because Slack/PagerDuty is unreachable.
    gatewayCircuitMonitor.observeRecord(gateway, ok, previousOpenUntilMs);
  }

  async openCircuit(gateway: GatewayName, until: Date): Promise<void> {
    // Read the current breaker state BEFORE we overwrite it so the
    // alert monitor can tell whether this is a brand-new healthy →
    // degraded transition (page on-call) or just an extension of an
    // already-open breaker the router is re-tripping every cycle the
    // failure rate stays high (no re-page).
    const [priorRow] = await db
      .select({ circuitOpenUntil: schema.gatewayHealthTable.circuitOpenUntil })
      .from(schema.gatewayHealthTable)
      .where(eq(schema.gatewayHealthTable.gateway, gateway))
      .limit(1);
    const previousOpenUntilMs = priorRow?.circuitOpenUntil
      ? priorRow.circuitOpenUntil.getTime()
      : null;
    await db
      .update(schema.gatewayHealthTable)
      .set({ circuitOpenUntil: until })
      .where(eq(schema.gatewayHealthTable.gateway, gateway));
    logger.warn({ gateway, until: until.toISOString() }, "circuit_opened");
    // Fire-and-forget out-of-band paging: the monitor decides whether
    // the transition is novel (i.e. the breaker was closed or expired
    // before this call) and applies a per-gateway flap cooldown so a
    // breaker that opens-closes-opens repeatedly inside one minute
    // pages once, not once per cycle.
    gatewayCircuitMonitor.notifyCircuitOpened(
      gateway,
      previousOpenUntilMs,
      until.getTime(),
    );
  }
}

const healthStore = new DbHealthStore();

const paystack = new PaystackGateway(process.env.PAYSTACK_SECRET_KEY);
const flutterwave = new FlutterwaveGateway(
  process.env.FLUTTERWAVE_SECRET_KEY,
  process.env.FLUTTERWAVE_WEBHOOK_HASH,
);
const devMock = new DevMockGateway();

/**
 * The "primary" gateway is whichever one is configured. If both are configured,
 * Paystack is primary and Flutterwave is the failover (per spec). If only one
 * is configured, that gateway serves both primary and secondary slots — the
 * router will simply not failover. The DevMockGateway is ONLY used when no
 * real gateway keys are configured at all; under no circumstance can a live
 * gateway charge fall over to dev-mock (which would silently fake success).
 *
 * Exported (with injectable gateway args) so the regression suite can pin
 * the dev-mock containment rule with synthetic gateways — the alternative,
 * re-importing the module under different env permutations, was both slow
 * and fragile because it tangled with the module-init side effects (watcher
 * registration, payments_initialized log).
 */
export function selectPrimaryAndSecondary(
  paystackGw: PaymentGateway = paystack,
  flutterwaveGw: PaymentGateway = flutterwave,
  devMockGw: PaymentGateway = devMock,
): {
  primary: PaymentGateway;
  secondary: PaymentGateway;
  effectiveMode: "live" | "live-only-paystack" | "live-only-flutterwave" | "dev-mock";
} {
  if (paystackGw.isConfigured() && flutterwaveGw.isConfigured()) {
    return { primary: paystackGw, secondary: flutterwaveGw, effectiveMode: "live" };
  }
  if (paystackGw.isConfigured()) {
    // No failover available — secondary === primary so a primary failure
    // surfaces as a real error instead of silently routing to dev-mock.
    return { primary: paystackGw, secondary: paystackGw, effectiveMode: "live-only-paystack" };
  }
  if (flutterwaveGw.isConfigured()) {
    return { primary: flutterwaveGw, secondary: flutterwaveGw, effectiveMode: "live-only-flutterwave" };
  }
  return { primary: devMockGw, secondary: devMockGw, effectiveMode: "dev-mock" };
}

const selection = selectPrimaryAndSecondary();
export const gatewayRouter = new GatewayRouter(selection.primary, selection.secondary, healthStore);
export const gateways = { paystack, flutterwave, devMock };
export const PAYMENTS_MODE = selection.effectiveMode;

// Register a SubsystemFailureWatcher per real, configured gateway so
// /healthz's `subsystems` map exposes a stable entry per gateway from
// boot — even before the first charge — and the duration alert
// (`scripts/checkHealthzDegraded.ts`) can iterate them. We only
// register configured real gateways: a dev-mock fallback would
// publish a permanently-healthy `paymentGatewayDevmock` entry that
// hides the matching `payment_provider_missing_for_production` boot
// warning, and an unconfigured gateway would publish a stuck-healthy
// entry that confuses on-call during triage.
//
// Registration is idempotent so a hot-reload that re-evaluates this
// module does not lose the existing in-process streak state.
for (const gw of [paystack, flutterwave]) {
  if (gw.isConfigured()) {
    registerPaymentGatewayWatcher(gw.name);
  }
}

logger.info(
  { mode: PAYMENTS_MODE, primary: selection.primary.name, secondary: selection.secondary.name },
  "payments_initialized",
);

export interface SanitizedAttempt {
  intentId: string;
  gateway: GatewayName;
  kind: "charge" | "verify" | "refund" | "payout";
  status: "ok" | "error";
  errorCode?: string;
  errorMessage?: string;
  gatewayReference?: string;
  responseSummary?: unknown;
}

export async function logAttempt(a: SanitizedAttempt): Promise<void> {
  await db.insert(schema.paymentAttemptsTable).values({
    id: newPaymentAttemptId(),
    intentId: a.intentId,
    gateway: a.gateway,
    kind: a.kind,
    status: a.status,
    errorCode: a.errorCode ?? null,
    errorMessage: a.errorMessage ?? null,
    gatewayReference: a.gatewayReference ?? null,
    responseSummary: (a.responseSummary as Record<string, unknown> | undefined) ?? null,
  });
}

export interface CreateIntentInput {
  userId: string;
  email: string;
  purpose: "order" | "wallet_topup";
  orderId?: string;
  amountMinor: number;
  vatMinor?: number;
  currencyCode: string;
  metadata?: Record<string, unknown>;
  /**
   * Callback URL builder — receives the pre-generated intent id so the URL
   * can include both `orderId` and `intentId` for the frontend processing
   * page. (The intent id has to exist before we call the gateway because the
   * URL is sent in the same charge request.)
   */
  buildCallbackUrl: (intentId: string) => string;
  /** When true, skip gateway and immediately mark intent as succeeded (cash on delivery). */
  manualConfirm?: boolean;
}

export interface CreateIntentResult {
  intent: typeof schema.paymentIntentsTable.$inferSelect;
  authorizationUrl?: string;
  gateway: GatewayName;
}

/** Strip secrets from a gateway response before storing it in the audit log. */
function sanitizeResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const json = JSON.stringify(value, (_k, v) => {
    if (typeof v === "string" && /sk_(?:live|test)_/.test(v)) return "[REDACTED]";
    return v;
  });
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Splits are ledger-based: the platform charges full and disburses via
// scheduled `payouts` rows after the T+1/T+7 hold so we can claw back on
// refund. Gateway transfer-split codes are not used because they would
// disburse at charge time and defeat the hold + refund-clawback policy.
export async function createPaymentIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
  const reference = newPaymentReference();
  const intentId = newPaymentIntentId();
  const callbackUrl = input.buildCallbackUrl(intentId);

  if (input.manualConfirm) {
    const [intent] = await db
      .insert(schema.paymentIntentsTable)
      .values({
        id: intentId,
        userId: input.userId,
        purpose: input.purpose,
        orderId: input.orderId ?? null,
        gateway: "cod",
        reference,
        amountMinor: input.amountMinor,
        vatMinor: input.vatMinor ?? 0,
        currencyCode: input.currencyCode,
        status: "succeeded",
        metadata: input.metadata ?? {},
        paidAt: new Date(),
      })
      .returning();
    return { intent, gateway: "devmock" };
  }

  const primaryName = await gatewayRouter.pickPrimaryName();
  const [intent] = await db
    .insert(schema.paymentIntentsTable)
    .values({
      id: intentId,
      userId: input.userId,
      purpose: input.purpose,
      orderId: input.orderId ?? null,
      gateway: primaryName,
      reference,
      amountMinor: input.amountMinor,
      vatMinor: input.vatMinor ?? 0,
      currencyCode: input.currencyCode,
      status: "pending",
      metadata: input.metadata ?? {},
    })
    .returning();

  const { result, gateway } = await gatewayRouter.withFailover(primaryName, (gw) =>
    gw.charge({
      intentId: intent.id,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
      email: input.email,
      reference,
      callbackUrl,
      purpose: input.purpose,
      metadata: input.metadata,
    }),
  );

  await logAttempt({
    intentId: intent.id,
    gateway,
    kind: "charge",
    status: result.ok ? "ok" : "error",
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    gatewayReference: result.reference,
    responseSummary: sanitizeResponse(result.rawResponse),
  });

  if (!result.ok) {
    await db
      .update(schema.paymentIntentsTable)
      .set({ status: "failed" })
      .where(eq(schema.paymentIntentsTable.id, intent.id));
    throw new Error(`gateway_charge_failed:${result.errorMessage ?? "unknown"}`);
  }

  // Store actual gateway used (may differ from primary if failover triggered).
  const [updated] = await db
    .update(schema.paymentIntentsTable)
    .set({ gateway, authorizationUrl: result.authorizationUrl ?? null, status: "processing" })
    .where(eq(schema.paymentIntentsTable.id, intent.id))
    .returning();

  return { intent: updated, authorizationUrl: result.authorizationUrl, gateway };
}

/** Verify (re-check) an intent's status with its gateway and update DB rows. */
export async function reverifyIntent(intentId: string): Promise<typeof schema.paymentIntentsTable.$inferSelect> {
  const [intent] = await db
    .select()
    .from(schema.paymentIntentsTable)
    .where(eq(schema.paymentIntentsTable.id, intentId))
    .limit(1);
  if (!intent) throw new Error("intent_not_found");
  if (intent.status === "succeeded" || intent.status === "refunded") return intent;
  const gw = gatewayRouter.byName(intent.gateway as GatewayName);
  const result = await gw.verify(intent.reference);
  await logAttempt({
    intentId: intent.id,
    gateway: intent.gateway as GatewayName,
    kind: "verify",
    status: result.ok ? "ok" : "error",
    errorMessage: result.errorMessage,
    gatewayReference: intent.reference,
  });
  if (result.ok) {
    return await markIntentSucceeded(intent.id, result.paidAt ?? new Date());
  }
  if (result.status === "failed" || result.status === "abandoned") {
    const [row] = await db
      .update(schema.paymentIntentsTable)
      .set({ status: "failed" })
      .where(eq(schema.paymentIntentsTable.id, intent.id))
      .returning();
    // Notify the buyer that their payment failed so they can retry.
    try {
      const [order] = await db
        .select({ id: schema.ordersTable.id, userId: schema.ordersTable.userId })
        .from(schema.ordersTable)
        .where(eq(schema.ordersTable.paymentIntentId, intent.id))
        .limit(1);
      if (order) {
        await enqueueNotification({
          userId: order.userId,
          eventType: "order_payment_failed",
          payload: {
            title: "Payment failed",
            body: "We couldn't process your payment. Tap to retry.",
            url: `/orders/${order.id}`,
            orderId: order.id,
          },
        });
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, intentId: intent.id }, "notify_payment_failed_error");
    }
    return row;
  }
  return intent;
}

/**
 * Move an intent to `succeeded`. If linked to an order, also flip the order
 * to placed/ready/out_for_delivery and schedule the seller payout based on
 * tier (T+1 trusted, T+7 starter).
 *
 * Concurrency: this is the convergence point for two callers that can fire
 * simultaneously — the inbound webhook AND a frontend `verify` poll. We use
 * a conditional UPDATE with `WHERE status != 'succeeded'` so exactly one
 * caller is allowed to do the side-effects (wallet credit, order finalize,
 * payout scheduling). The losing caller observes `updated` is empty and
 * skips side-effects; idempotency for any side-effects we already commit is
 * additionally guarded by unique indexes on `wallet_txns(intent_id)` and
 * `payouts(order_id, seller_id)` for `seller_share` rows.
 */
export async function markIntentSucceeded(
  intentId: string,
  paidAt: Date,
): Promise<typeof schema.paymentIntentsTable.$inferSelect> {
  const winners = await db
    .update(schema.paymentIntentsTable)
    .set({ status: "succeeded", paidAt })
    .where(
      and(
        eq(schema.paymentIntentsTable.id, intentId),
        ne(schema.paymentIntentsTable.status, "succeeded"),
      ),
    )
    .returning();
  if (winners.length === 0) {
    // Either the intent doesn't exist OR another caller already finalized.
    const [existing] = await db
      .select()
      .from(schema.paymentIntentsTable)
      .where(eq(schema.paymentIntentsTable.id, intentId))
      .limit(1);
    if (!existing) throw new Error("intent_not_found");
    return existing;
  }
  const intent = winners[0];

  if (intent.purpose === "wallet_topup") {
    // Hard idempotency via the partial unique index on wallet_txns.intent_id.
    const inserted = await db
      .insert(schema.walletTxnsTable)
      .values({
        id: `wt_${Date.now().toString(36)}_${intent.id.slice(-4)}`,
        userId: intent.userId,
        kind: "topup",
        amountMinor: intent.amountMinor,
        label: "Wallet top-up",
        status: "succeeded",
        intentId: intent.id,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      await enqueueNotification({
        userId: intent.userId,
        eventType: "wallet_credit",
        payload: {
          title: "Wallet topped up",
          body: `${intent.currencyCode} ${(intent.amountMinor / 100).toFixed(2)} added to your wallet.`,
          url: `/wallet`,
        },
      }).catch(() => undefined);
    }
  } else if (intent.purpose === "order" && intent.orderId) {
    await finalizeOrderAfterPayment(intent.orderId, intent.id, intent.gateway, intent.reference, paidAt);
  }

  return intent;
}

/**
 * Mark an order as paid and schedule the seller payout(s). One payout row is
 * inserted per distinct seller in the order. The unique partial index on
 * `payouts(order_id, seller_id) WHERE kind='seller_share'` guarantees we
 * cannot double-pay even if this function runs concurrently for the same
 * order.
 *
 * Buyer vs seller correctness: `order.userId` is the BUYER. Sellers are
 * derived from `products.seller_user_id` for each item in `order.items`. If a
 * product has no seller mapping (legacy/seed data), the platform absorbs the
 * share and we log a warning instead of paying it to the buyer.
 */
async function finalizeOrderAfterPayment(
  orderId: string,
  intentId: string,
  gateway: string,
  reference: string,
  paidAt: Date,
): Promise<void> {
  const [order] = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, orderId))
    .limit(1);
  if (!order) return;
  if (order.paidAt) return; // idempotent for the order columns

  const fulfillment = (order.fulfillment as { optionId?: string }) ?? {};
  const optionId = String(fulfillment.optionId ?? "");
  const isPickup = ["box", "pickup", "locker", "pudo", "paxi"].some((s) => optionId.includes(s));
  const newStatus = isPickup ? "ready_for_pickup" : "out_for_delivery";

  await db
    .update(schema.ordersTable)
    .set({
      status: newStatus,
      gateway,
      gatewayReference: reference,
      paymentIntentId: intentId,
      paidAt,
    })
    .where(and(eq(schema.ordersTable.id, orderId), sql`${schema.ordersTable.paidAt} IS NULL`));

  // Buyer notifications for paid + dispatched/ready-for-pickup. We do this
  // once here (not in the webhook + verify caller path) so the message
  // fires exactly once thanks to the `paidAt IS NULL` guard above.
  await enqueueNotification({
    userId: order.userId,
    eventType: "order_paid",
    payload: {
      title: "Payment received",
      body: `Payment for order ${orderId} confirmed.`,
      url: `/orders/${orderId}`,
      orderId,
    },
  }).catch(() => undefined);
  await enqueueNotification({
    userId: order.userId,
    eventType: isPickup ? "order_ready_for_pickup" : "order_dispatched",
    payload: {
      title: isPickup ? "Ready for pickup" : "On the way",
      body: isPickup
        ? `Pickup code: ${order.pickupOtp ?? ""}. Show this at the Box.`
        : `Order ${orderId} is on the way to you.`,
      url: `/orders/${orderId}`,
      orderId,
    },
  }).catch(() => undefined);

  // Carrier dispatch — creates the shipment row, calls the chosen carrier,
  // creates the box reservation if it's a locker order, and seeds the
  // tracking timeline. Errors here MUST NOT roll back the payment, so we
  // log and move on; an admin can retry via the seller dashboard.
  await dispatchShipmentForOrder(orderId).catch((err) => {
    logger.error({ err: (err as Error).message, orderId }, "post_payment_dispatch_failed");
  });

  // ---- Compute split per seller ----
  const items = (order.items as Array<{ productId: string; qty: number; priceMinor: number }>) ?? [];
  if (items.length === 0) {
    logger.warn({ orderId }, "order_has_no_items_no_payout");
    return;
  }
  const productIds = Array.from(new Set(items.map((i) => i.productId).filter(Boolean)));
  const products = productIds.length > 0
    ? await db
        .select({
          id: schema.productsTable.id,
          sellerUserId: schema.productsTable.sellerUserId,
          manufacturerUserId: schema.productsTable.manufacturerUserId,
          manufacturerShareBp: schema.productsTable.manufacturerShareBp,
        })
        .from(schema.productsTable)
        .where(inArray(schema.productsTable.id, productIds))
    : [];
  const productMeta = new Map<string, { sellerUserId: string | null; manufacturerUserId: string | null; manufacturerShareBp: number }>();
  for (const p of products) {
    productMeta.set(p.id, {
      sellerUserId: p.sellerUserId,
      manufacturerUserId: p.manufacturerUserId,
      manufacturerShareBp: p.manufacturerShareBp ?? 0,
    });
  }

  // Per-line split: platform 10%, manufacturer (if attributed) X bp, seller remainder.
  // Then aggregate by recipient so each (order, recipient) is one payout row.
  const PLATFORM_BP = 1000; // 10%
  const grossPerSeller = new Map<string, number>();
  const grossPerManufacturer = new Map<string, number>();
  let unattributedMinor = 0;
  for (const it of items) {
    const lineGross = Number(it.priceMinor ?? 0) * Number(it.qty ?? 0);
    if (lineGross <= 0) continue;
    const meta = productMeta.get(it.productId);
    const sellerUserId = meta?.sellerUserId ?? null;
    if (!sellerUserId) {
      unattributedMinor += lineGross;
      continue;
    }
    const mfgBp = Math.max(0, Math.min(meta?.manufacturerShareBp ?? 0, 10000 - PLATFORM_BP));
    const mfgId = meta?.manufacturerUserId ?? null;
    const platformShare = Math.round((lineGross * PLATFORM_BP) / 10000);
    const manufacturerShare = mfgId ? Math.round((lineGross * mfgBp) / 10000) : 0;
    const sellerShare = lineGross - platformShare - manufacturerShare;
    if (sellerShare > 0) {
      grossPerSeller.set(sellerUserId, (grossPerSeller.get(sellerUserId) ?? 0) + sellerShare);
    }
    if (mfgId && manufacturerShare > 0) {
      grossPerManufacturer.set(mfgId, (grossPerManufacturer.get(mfgId) ?? 0) + manufacturerShare);
    }
  }
  if (unattributedMinor > 0) {
    logger.warn({ orderId, unattributedMinor }, "order_has_unattributed_lines_platform_absorbed");
  }

  // Seller payouts — tier-based hold (1d trusted / 7d starter).
  const holdMillis: number[] = [];
  for (const [sellerId, sellerNet] of grossPerSeller.entries()) {
    const seller = await loadSellerForUser(sellerId);
    const tier = seller?.tier ?? "starter";
    const holdDays = tier === "trusted" ? 1 : 7;
    const sellerHoldUntil = new Date(paidAt.getTime() + holdDays * 24 * 3600 * 1000);
    holdMillis.push(sellerHoldUntil.getTime());
    if (sellerNet <= 0) continue;
    // KYC tier gate: compute the rolling-30d threshold INCLUDING this
    // order's contribution. If the seller's verified `kycTier` is below
    // the requirement, the payout is inserted as `blocked` and held until
    // KYC clears (re-evaluated by `processDuePayouts`).
    const { requiredTier } = await requiredTierForOrder(sellerId, sellerNet);
    const sellerKycTier = seller?.kycTier ?? 1;
    const kycSatisfied = sellerKycTier >= requiredTier;
    // Sanctions gate — if the most recent screening is flagged or blocked,
    // park the payout regardless of tier.
    const sanctionsBlocked = await sellerSanctionsBlocked(sellerId);
    const status = !kycSatisfied || sanctionsBlocked ? "blocked" : "pending";
    const errorMessage = sanctionsBlocked
      ? "sanctions_review_required"
      : !kycSatisfied
        ? `kyc_tier_required:${requiredTier}`
        : null;
    await db
      .insert(schema.payoutsTable)
      .values({
        id: `po_${Date.now().toString(36)}_${orderId.slice(-4).toLowerCase()}_${sellerId.slice(-4)}`,
        userId: sellerId,
        sellerId,
        orderId,
        intentId,
        amountMinor: sellerNet,
        currencyCode: order.currencyCode,
        status,
        kind: "seller_share",
        holdUntil: sellerHoldUntil,
        reference: `PO-${orderId}-${sellerId.slice(-6)}`,
        gateway,
        requiredKycTier: requiredTier,
        errorMessage,
      })
      .onConflictDoNothing(); // unique (order_id, seller_id) for seller_share

    logger.info(
      {
        orderId,
        intentId,
        sellerId,
        sellerNet,
        holdUntil: sellerHoldUntil.toISOString(),
        status,
        requiredTier,
        sellerKycTier,
        sanctionsBlocked,
      },
      "seller_payout_scheduled",
    );
  }

  // Manufacturer payouts — weekly batch via Flutterwave international rail.
  // We use a 7-day hold so the daily payouts cron picks them up only on the
  // weekly settlement boundary. Manufacturer onboarding/KYC and bank details
  // are owned by a separate cross-border task, but sanctions screening is
  // platform-wide: we screen the manufacturer here at first attribution
  // ("onboarding" from the payouts system's POV) so they enter the
  // sanctions_screenings cohort that the quarterly resweep walks. If the
  // screen comes back blocked/flagged the row lands in `blocked` state
  // immediately rather than scheduling a disbursement.
  const MANUFACTURER_HOLD_DAYS = 7;
  for (const [manufacturerId, mfgNet] of grossPerManufacturer.entries()) {
    if (mfgNet <= 0) continue;
    const mfgHoldUntil = new Date(paidAt.getTime() + MANUFACTURER_HOLD_DAYS * 24 * 3600 * 1000);
    holdMillis.push(mfgHoldUntil.getTime());
    const mfgBlocked = await manufacturerSanctionsBlocked(manufacturerId);
    await db
      .insert(schema.payoutsTable)
      .values({
        id: `po_${Date.now().toString(36)}_${orderId.slice(-4).toLowerCase()}_m${manufacturerId.slice(-4)}`,
        userId: manufacturerId,
        sellerId: manufacturerId, // recipient
        orderId,
        intentId,
        amountMinor: mfgNet,
        currencyCode: order.currencyCode,
        status: mfgBlocked ? "blocked" : "pending",
        errorMessage: mfgBlocked ? "sanctions_review_required" : null,
        kind: "manufacturer_share",
        holdUntil: mfgHoldUntil,
        reference: `MO-${orderId}-${manufacturerId.slice(-6)}`,
        // Manufacturer payouts ALWAYS use Flutterwave for international rail,
        // regardless of which gateway charged the buyer.
        gateway: "flutterwave",
      })
      .onConflictDoNothing();

    logger.info(
      { orderId, intentId, manufacturerId, mfgNet, holdUntil: mfgHoldUntil.toISOString() },
      "manufacturer_payout_scheduled",
    );
  }

  // Stamp the order's hold_until to the LATEST recipient hold so buyer
  // surfaces show when the order is fully settled.
  if (holdMillis.length > 0) {
    await db
      .update(schema.ordersTable)
      .set({ holdUntil: new Date(Math.max(...holdMillis)) })
      .where(eq(schema.ordersTable.id, orderId));
  }
}

/**
 * Refund clawback: when a paid order is refunded, cancel any pending payouts
 * that haven't been released yet. Settled (paid) payouts cannot be reversed
 * automatically — those are recorded as `refund_attempts` rows with a
 * `clawback_required` reason for finance to handle off-platform.
 */
export async function clawbackPayoutsForRefund(orderId: string, refundReason: string): Promise<{ cancelled: number; clawbackRequired: number }> {
  /*
   * Refund clawback covers ALL payout legs for the order — currently
   * `seller_share` and `manufacturer_share`. Filtering by a single kind
   * would leak funds: if the manufacturer leg has been settled while
   * the buyer is being refunded, finance must be alerted via a
   * `clawback_required` audit row regardless of which leg it is.
   */
  const all = await db
    .select()
    .from(schema.payoutsTable)
    .where(
      and(
        eq(schema.payoutsTable.orderId, orderId),
        inArray(schema.payoutsTable.kind, ["seller_share", "manufacturer_share"]),
      ),
    );
  let cancelled = 0;
  let clawbackRequired = 0;
  for (const p of all) {
    if (p.status === "pending" || p.status === "scheduled") {
      const result = await db
        .update(schema.payoutsTable)
        .set({ status: "cancelled", errorMessage: `clawback: ${refundReason}` })
        .where(and(eq(schema.payoutsTable.id, p.id), inArray(schema.payoutsTable.status, ["pending", "scheduled"])))
        .returning();
      if (result.length > 0) cancelled++;
    } else if (p.status === "processing" || p.status === "paid") {
      /*
       * Funds already in flight or sent — finance must claw back. The
       * audit row id is deterministic per (order, payout) so retries
       * (webhook replay, recovery sweep) are idempotent: the
       * onConflictDoNothing prevents duplicate clawback_required
       * artifacts even if the refund is finalized multiple times.
       */
      const auditId = `rfa_clb_${p.id}`;
      const ins = await db
        .insert(schema.refundAttemptsTable)
        .values({
          id: auditId,
          intentId: p.intentId ?? "",
          orderId,
          amountMinor: p.amountMinor,
          reason: `clawback_required: ${refundReason}`,
          status: "pending",
          gateway: p.gateway ?? "manual",
        })
        .onConflictDoNothing({ target: schema.refundAttemptsTable.id })
        .returning();
      if (ins.length > 0) {
        clawbackRequired++;
        logger.warn({ orderId, payoutId: p.id, status: p.status }, "refund_clawback_required");
      }
    }
  }
  return { cancelled, clawbackRequired };
}

async function loadSellerForUser(userId: string) {
  const [row] = await db
    .select()
    .from(schema.sellersTable)
    .where(eq(schema.sellersTable.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the disbursement destination for a payout. Sellers and wallet
 * withdrawals route through the seller profile (or the payout row itself
 * for wallet kind). Manufacturer payouts route through the manufacturer
 * profile — bank fields are stored in `manufacturers.application` jsonb
 * so this returns a seller-shaped `{ application }` slice that the
 * downstream gateway-call code can consume without a fork.
 */
async function loadPayoutDestination(
  payout: typeof schema.payoutsTable.$inferSelect,
): Promise<{ application: { bankCode?: string; bankAccount?: string; bankName?: string } | null } | null> {
  if (payout.kind === "manufacturer_share") {
    const [mfr] = await db
      .select()
      .from(schema.manufacturersTable)
      .where(eq(schema.manufacturersTable.userId, payout.userId))
      .limit(1);
    if (!mfr) return null;
    const app = (mfr.application as
      | { bankCode?: string; bankAccount?: string; bankName?: string }
      | null) ?? null;
    return { application: app };
  }
  const seller = await loadSellerForUser(payout.userId);
  if (!seller) return null;
  // The downstream payout-call code reads `application.bankCode`,
  // `application.bankAccount`, `application.bankName`. Sellers store
  // those in `sellers.application` jsonb; cast through to the shared
  // shape so both branches return the same projected slice.
  return {
    application: (seller.application as
      | { bankCode?: string; bankAccount?: string; bankName?: string }
      | null) ?? null,
  };
}

/**
 * Run all due payouts whose hold has expired. Called by the payouts cron.
 * Returns the count of payouts processed.
 */
export async function processDuePayouts(): Promise<{ processed: number; failed: number }> {
  // First pass — re-evaluate `blocked` payouts. A payout is blocked when
  // the seller's KYC tier was below the rolling-30d threshold OR the most
  // recent sanctions screen flagged them. If those conditions are now
  // resolved we promote `blocked` → `pending` so the second pass can claim
  // them. We hold the gate by re-checking sanctions live and comparing
  // sellers.kycTier to the snapshot stored on the payout row.
  const blocked = await db
    .select()
    .from(schema.payoutsTable)
    .where(eq(schema.payoutsTable.status, "blocked"));
  for (const payout of blocked) {
    // Wallet withdrawals are non-seller and not subject to either gate.
    if (payout.kind === "wallet_withdrawal") continue;
    // Manufacturer payouts use a sanctions-only gate (no KYC tier — that's
    // a seller-flow concept). manufacturerSanctionsBlocked() bootstraps a
    // screening row from the user record on first encounter so we don't
    // need a separate manufacturer onboarding flow to satisfy the
    // "every onboarded seller AND manufacturer is screened" requirement.
    if (payout.kind === "manufacturer_share") {
      const blocked = await manufacturerSanctionsBlocked(payout.userId);
      if (!blocked) {
        await db
          .update(schema.payoutsTable)
          .set({ status: "pending", errorMessage: null })
          .where(eq(schema.payoutsTable.id, payout.id));
        await recordAudit({
          actorId: null,
          action: "payout.unblocked",
          entity: "payout",
          entityId: payout.id,
          payload: { userId: payout.userId, kind: "manufacturer_share", amountMinor: payout.amountMinor },
        });
      }
      continue;
    }
    const seller = await loadSellerForUser(payout.userId);
    const sellerKycTier = (seller as { kycTier?: number } | null)?.kycTier ?? 1;
    const required = payout.requiredKycTier ?? 1;
    const sanctionsBlocked = await sellerSanctionsBlocked(payout.userId);
    if (sellerKycTier >= required && !sanctionsBlocked) {
      await db
        .update(schema.payoutsTable)
        .set({ status: "pending", errorMessage: null })
        .where(eq(schema.payoutsTable.id, payout.id));
      logger.info(
        { payoutId: payout.id, sellerKycTier, required },
        "payout_unblocked_kyc_satisfied",
      );
      await recordAudit({
        actorId: null,
        action: "payout.unblocked",
        entity: "payout",
        entityId: payout.id,
        payload: { userId: payout.userId, sellerKycTier, required, amountMinor: payout.amountMinor },
      });
    }
  }

  // Atomic claim: flip pending→processing in a single UPDATE...RETURNING
  // so concurrent workers cannot double-pay the same payout. The gateway
  // call below operates only on rows we successfully claimed.
  const due = await db
    .update(schema.payoutsTable)
    .set({ status: "processing" })
    .where(
      and(
        eq(schema.payoutsTable.status, "pending"),
        sql`${schema.payoutsTable.holdUntil} <= now()`,
      ),
    )
    .returning();
  // Live re-check at claim time. A seller's compliance posture can change
  // between scheduling and disbursement (sanctions hit, tier downgrade,
  // verification revoked). For each just-claimed payout, re-verify and
  // park anything that no longer passes — bouncing it back to `blocked`
  // so the next sweep can release it once cleared.
  //
  // Wallet withdrawals belong to non-seller users and are exempt.
  // Manufacturer-share payouts run a sanctions-only check (no KYC tier);
  // manufacturerSanctionsBlocked() bootstraps a screening row from the
  // user record on first encounter so unscreened manufacturers don't
  // slip through.
  const stillDue: typeof due = [];
  for (const payout of due) {
    if (payout.kind === "wallet_withdrawal") {
      stillDue.push(payout);
      continue;
    }
    if (payout.kind === "manufacturer_share") {
      const blocked = await manufacturerSanctionsBlocked(payout.userId);
      if (blocked) {
        await db
          .update(schema.payoutsTable)
          .set({ status: "blocked", errorMessage: "sanctions_review_required" })
          .where(eq(schema.payoutsTable.id, payout.id));
        await recordAudit({
          actorId: null,
          action: "payout.reblocked",
          entity: "payout",
          entityId: payout.id,
          payload: { userId: payout.userId, kind: "manufacturer_share", reason: "sanctions_review_required", amountMinor: payout.amountMinor },
        });
      } else {
        stillDue.push(payout);
      }
      continue;
    }
    const seller = await loadSellerForUser(payout.userId);
    const sellerKycTier = (seller as { kycTier?: number } | null)?.kycTier ?? 1;
    const required = payout.requiredKycTier ?? 1;
    const sanctionsBlocked = await sellerSanctionsBlocked(payout.userId);
    if (sellerKycTier < required || sanctionsBlocked) {
      const reason = sanctionsBlocked
        ? "sanctions_review_required"
        : `kyc_tier_required:${required}`;
      await db
        .update(schema.payoutsTable)
        .set({ status: "blocked", errorMessage: reason })
        .where(eq(schema.payoutsTable.id, payout.id));
      logger.warn(
        { payoutId: payout.id, sellerKycTier, required, sanctionsBlocked },
        "payout_reblocked_at_claim_time",
      );
      await recordAudit({
        actorId: null,
        action: "payout.reblocked",
        entity: "payout",
        entityId: payout.id,
        payload: {
          userId: payout.userId,
          sellerKycTier,
          required,
          sanctionsBlocked,
          reason,
          amountMinor: payout.amountMinor,
        },
      });
      continue;
    }
    stillDue.push(payout);
  }
  let processed = 0;
  let failed = 0;
  for (const payout of stillDue) {
    // Wallet withdrawals carry the destination on the payout row itself.
    // Seller payouts resolve from the seller profile; manufacturer payouts
    // resolve from the manufacturer profile (Flutterwave international
    // rail). loadPayoutDestination handles the dispatch and returns a
    // seller-shaped `{ application }` slice in both cases.
    const dest =
      payout.kind === "wallet_withdrawal" ? null : await loadPayoutDestination(payout);
    const application = dest?.application ?? null;
    const bankCode = (payout.bankCode || application?.bankCode || "").trim();
    const accountNumber = ((payout as { bankAccount?: string }).bankAccount || application?.bankAccount || "").trim();
    const accountName =
      (payout as { bankAccountName?: string }).bankAccountName?.trim() ||
      application?.bankName ||
      "Epplaa Seller";
    if (!bankCode || !accountNumber) {
      // Mark as scheduled — finance can complete manually.
      await db
        .update(schema.payoutsTable)
        .set({ status: "scheduled", errorMessage: "missing_bank_details" })
        .where(eq(schema.payoutsTable.id, payout.id));
      continue;
    }
    const gw = gatewayRouter.byName((payout.gateway as GatewayName | null) ?? "devmock");
    const result = await gw.payout({
      reference: payout.reference,
      amountMinor: payout.amountMinor,
      currencyCode: payout.currencyCode,
      bankCode,
      accountNumber,
      accountName,
      reason: `Payout for order ${payout.orderId ?? ""}`.trim(),
    });
    await logAttempt({
      intentId: payout.intentId ?? "",
      gateway: gw.name,
      kind: "payout",
      status: result.ok ? "ok" : "error",
      gatewayReference: result.transferReference,
      errorMessage: result.errorMessage,
    });
    if (result.ok) {
      processed++;
      const finalStatus = result.status === "processed" ? "paid" : "processing";
      await db
        .update(schema.payoutsTable)
        .set({
          status: finalStatus,
          gateway: gw.name,
          gatewayReference: result.transferReference,
          paidAt: result.status === "processed" ? new Date() : null,
        })
        .where(eq(schema.payoutsTable.id, payout.id));
      await recordAudit({
        actorId: null,
        action: `payout.${finalStatus}`,
        entity: "payout",
        entityId: payout.id,
        payload: {
          userId: payout.userId,
          amountMinor: payout.amountMinor,
          currencyCode: payout.currencyCode,
          gateway: gw.name,
          gatewayReference: result.transferReference,
          orderId: payout.orderId,
        },
      });
      // Mark the order settled only when ALL its payout legs are
      // resolved (paid or cancelled). Setting settledAt on the first
      // successful leg would mislead finance dashboards into thinking
      // the order is fully disbursed while later legs are still in
      // flight or stuck.
      if (payout.orderId) {
        const remaining = await db
          .select({ id: schema.payoutsTable.id })
          .from(schema.payoutsTable)
          .where(
            and(
              eq(schema.payoutsTable.orderId, payout.orderId),
              sql`${schema.payoutsTable.status} NOT IN ('paid', 'cancelled')`,
            ),
          );
        if (remaining.length === 0) {
          await db
            .update(schema.ordersTable)
            .set({ settledAt: new Date() })
            .where(eq(schema.ordersTable.id, payout.orderId));
        }
      }
      // Wallet withdrawals are user-initiated, so the matching wallet_txn
      // (kind='withdrawal', payout_id=this) must move out of 'pending' once
      // the gateway confirms the transfer. Without this the user's history
      // shows a permanently-pending row even though funds are gone.
      if (payout.kind === "wallet_withdrawal" && finalStatus === "paid") {
        await db
          .update(schema.walletTxnsTable)
          .set({ status: "succeeded" })
          .where(
            and(
              eq(schema.walletTxnsTable.payoutId, payout.id),
              eq(schema.walletTxnsTable.kind, "withdrawal"),
            ),
          );
      }
    } else {
      failed++;
      await db
        .update(schema.payoutsTable)
        .set({ status: "failed", errorMessage: result.errorMessage ?? "payout_failed" })
        .where(eq(schema.payoutsTable.id, payout.id));
      // Compensating credit so user funds are not stranded after a failed
      // withdrawal. Mark the original debit row as failed and write a
      // counterbalancing positive 'refund' row referencing the same payout.
      if (payout.kind === "wallet_withdrawal") {
        await reverseFailedWithdrawal(payout.id, payout.userId, payout.amountMinor, result.errorMessage ?? "payout_failed");
      }
    }
  }
  if (processed + failed > 0) {
    logger.info({ processed, failed }, "payouts_processed");
  }
  return { processed, failed };
}

/**
 * On a failed withdrawal payout, mark the original debit wallet_txn as
 * 'failed' and insert a compensating credit so the user's balance is made
 * whole. The compensating credit is keyed off the payout id via the
 * `wallet_txns_withdrawal_payout_uniq` index — but that index is scoped to
 * `kind='withdrawal'`, so a 'refund' row for the same payout id is allowed.
 * To keep this idempotent across cron retries we additionally check for an
 * existing reversal row before inserting.
 */
async function reverseFailedWithdrawal(payoutId: string, userId: string, amountMinor: number, reason: string): Promise<void> {
  await db
    .update(schema.walletTxnsTable)
    .set({ status: "failed" })
    .where(
      and(
        eq(schema.walletTxnsTable.payoutId, payoutId),
        eq(schema.walletTxnsTable.kind, "withdrawal"),
      ),
    );
  const existing = await db
    .select({ id: schema.walletTxnsTable.id })
    .from(schema.walletTxnsTable)
    .where(
      and(
        eq(schema.walletTxnsTable.payoutId, payoutId),
        eq(schema.walletTxnsTable.kind, "refund"),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(schema.walletTxnsTable).values({
    id: `wt_rv_${Date.now().toString(36)}_${payoutId.slice(-6)}`,
    userId,
    kind: "refund",
    amountMinor: Math.abs(amountMinor),
    label: `Withdrawal failed — refunded`,
    refId: payoutId,
    payoutId,
    status: "succeeded",
  });
  logger.info({ payoutId, userId, amountMinor, reason }, "wallet_withdrawal_reversed");
}
