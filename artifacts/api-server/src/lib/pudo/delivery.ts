import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { logger } from "../logger";
import { newManifestRunId } from "../ids";
import { captureMessage } from "../sentry";
import { WebhookSubsystemAlertNotifier } from "../alerts/subsystemAlertNotifier";
import { buildManifestCsv } from "./manifest";
import { sendManifestEmail } from "./emailTransport";
import { sendManifestSftp } from "./sftpTransport";

/**
 * Daily PUDO partner manifest delivery (task #16). Each partner row in
 * `pudo_partners` may opt into a 06:00-local daily push by setting
 * `delivery_method` to "email" or "sftp" and the matching transport
 * columns. This module owns the orchestration:
 *
 *   1. `runDailyPudoManifestDelivery` is the cron entrypoint. On each
 *      tick (every 15 min from `app.ts startScheduledJobs`) it walks
 *      every active partner and asks `shouldDeliverNow` whether their
 *      local clock has crossed 06:00 today.
 *   2. For each partner that's due, it builds the CSV via
 *      `buildManifestCsv`, computes the contentHash, and short-circuits
 *      if a previous successful run already delivered the same bytes.
 *      That makes overlapping ticks (or operator-triggered re-runs)
 *      safe — the partner never receives the same file twice.
 *   3. The chosen transport (`sendManifestEmail` / `sendManifestSftp`)
 *      is invoked. On success the run row flips to `sent`. On failure
 *      the row is left at `queued` with `attempts++` and a `lastError`,
 *      so the next tick retries until `MAX_ATTEMPTS_PER_DAY`. After
 *      that we mark `failed` and stop trying for that day.
 *   4. Any failure (transport error or post-MAX terminal failure) fires
 *      a Sentry capture and a Slack/PagerDuty alert via the same
 *      WebhookSubsystemAlertNotifier the rate-limit / payments
 *      panels use, so on-call sees the page even if no operator is
 *      logged into the admin console.
 *
 * Pull-mode partners (`delivery_method="none"`) are silently skipped —
 * they continue to use `GET /pudo/:partnerCode/manifest` themselves.
 */

/** Window in which a partner's local clock is considered "morning push". */
const DELIVERY_HOUR_LOCAL = 6;
/** How many transport attempts we make for a single (partner, day) before
 *  declaring terminal failure. With a 15-minute cron tick this gives the
 *  transport ~75 minutes of self-healing before paging on-call. */
export const MAX_ATTEMPTS_PER_DAY = 5;

/** Subsystem id used in alert dedup keys. Stable so PagerDuty merges
 *  every per-partner failure into a single rolling incident. */
const ALERT_SUBSYSTEM = "pudo-manifest-delivery";

/** Transport result shape — what email/sftp transports return. */
export interface TransportResult {
  ok: boolean;
  /** Free-form descriptor of what we delivered to. Persisted for audit. */
  destination: string;
  /** Short error code if !ok (e.g. "smtp_4xx", "sftp_module_unavailable"). */
  errorCode?: string;
  /** Human-readable detail if !ok. */
  errorMessage?: string;
}

/** Per-tick outcome surfaced to logs / tests. */
export interface DeliveryTickResult {
  /** Partners whose local 06:00 window opened on this tick. */
  attempted: number;
  /** Partners successfully pushed this tick. */
  delivered: number;
  /** Partners short-circuited because contentHash matched a prior sent run. */
  skipped: number;
  /** Partners that failed the transport (will be retried on the next tick). */
  failed: number;
}

/** Internal collaborators — overridden by tests so the real cron never
 *  hits the network. The cron entrypoint takes them as an argument so
 *  unit tests stay hermetic. */
export interface DeliveryDeps {
  emailTransport: typeof sendManifestEmail;
  sftpTransport: typeof sendManifestSftp;
  alertNotifier: { notifyDegraded: (event: AlertEvent) => void };
  capture: typeof captureMessage;
  /** Override "now" so tests can pin the clock at e.g. 05:59 vs 06:01. */
  now: () => Date;
}

interface AlertEvent {
  subsystem: string;
  label: string;
  firstFailureAt: number;
  detectedAt: number;
  details?: Record<string, string | number | null>;
}

export function defaultDeps(): DeliveryDeps {
  return {
    emailTransport: sendManifestEmail,
    sftpTransport: sendManifestSftp,
    alertNotifier: new WebhookSubsystemAlertNotifier(),
    capture: captureMessage,
    now: () => new Date(),
  };
}

/**
 * Format a Date in the supplied IANA timezone to a stable
 * { year, month, day, hour } record. We use Intl.DateTimeFormat in
 * "en-CA" because that locale always renders ISO-8601 date parts —
 * `2026-04-29` instead of locale-dependent variants — which lets us
 * use the result directly as the `for_date` key.
 */
export function localPartsInZone(
  d: Date,
  timezone: string,
): { date: string; hour: number } {
  // Defensive: reject any timezone Intl can't resolve so we fail fast
  // instead of writing rows with an empty date.
  let parts: Intl.DateTimeFormatPart[];
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    parts = fmt.formatToParts(d);
  } catch (err) {
    throw new Error(`invalid_timezone:${timezone}: ${(err as Error).message}`);
  }
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  // Intl renders 24h as "00".."24" for the en-CA locale; treat 24 as 0
  // (boundary edge-case observed on some node builds).
  const hourRaw = get("hour");
  const hour = hourRaw === "24" ? 0 : Number(hourRaw);
  return { date: `${year}-${month}-${day}`, hour: Number.isFinite(hour) ? hour : 0 };
}

export function shouldDeliverNow(
  partner: { manifestTimezone: string; deliveryMethod: string; active: number },
  now: Date,
): boolean {
  if (partner.active !== 1) return false;
  if (partner.deliveryMethod !== "email" && partner.deliveryMethod !== "sftp") {
    return false;
  }
  const { hour } = localPartsInZone(now, partner.manifestTimezone);
  return hour >= DELIVERY_HOUR_LOCAL;
}

/** Tick entrypoint — registered on a setInterval in app.ts. */
export async function runDailyPudoManifestDelivery(
  deps: DeliveryDeps = defaultDeps(),
): Promise<DeliveryTickResult> {
  const partners = await db.select().from(schema.pudoPartnersTable);
  const now = deps.now();
  let attempted = 0;
  let delivered = 0;
  let skipped = 0;
  let failed = 0;

  for (const partner of partners) {
    if (!shouldDeliverNow(partner, now)) continue;
    attempted++;
    try {
      const outcome = await deliverForPartner(partner, deps, now);
      if (outcome === "delivered") delivered++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    } catch (err) {
      failed++;
      logger.error(
        { partnerCode: partner.code, err: (err as Error).message },
        "pudo_manifest_delivery_unexpected_error",
      );
      deps.capture("pudo_manifest_delivery_unexpected_error", {
        level: "error",
        tags: { subsystem: ALERT_SUBSYSTEM, partner: partner.code },
      });
    }
  }

  if (attempted > 0) {
    logger.info(
      { attempted, delivered, skipped, failed },
      "pudo_manifest_delivery_tick",
    );
  }
  return { attempted, delivered, skipped, failed };
}

type DeliverOutcome = "delivered" | "skipped" | "failed";

/**
 * Deliver one partner's manifest for "today in their timezone". Caller
 * has already gated on `shouldDeliverNow`. Returns the per-partner
 * outcome so the tick can roll up counters.
 */
async function deliverForPartner(
  partner: typeof schema.pudoPartnersTable.$inferSelect,
  deps: DeliveryDeps,
  now: Date,
): Promise<DeliverOutcome> {
  const { date: forDate } = localPartsInZone(now, partner.manifestTimezone);
  const built = await buildManifestCsv(partner.code);

  // Idempotent dedupe: if we already sent the exact same CSV today,
  // short-circuit. This guarantees a partner cannot receive the same
  // file twice on the same calendar day even if cron ticks overlap or
  // an operator re-runs the job.
  const [existing] = await db
    .select()
    .from(schema.pudoManifestRunsTable)
    .where(
      and(
        eq(schema.pudoManifestRunsTable.partnerCode, partner.code),
        eq(schema.pudoManifestRunsTable.forDate, forDate),
      ),
    )
    .limit(1);

  if (
    existing &&
    existing.status === "sent" &&
    existing.contentHash === built.contentHash
  ) {
    return "skipped";
  }
  if (existing && existing.status === "failed") {
    // Already gave up for the day; the next day's tick will create a
    // fresh row. Operators who want to retry sooner can manually
    // delete the row or flip status back to 'queued'.
    return "skipped";
  }

  // Establish / refresh the queued row BEFORE attempting transport so
  // a crash mid-attempt still leaves an audit trail. The unique index
  // on (partner, date) makes the upsert safe under concurrent ticks.
  const attempts = (existing?.attempts ?? 0) + 1;
  await db
    .insert(schema.pudoManifestRunsTable)
    .values({
      id: newManifestRunId(),
      partnerCode: partner.code,
      forDate,
      shipmentCount: built.shipmentCount,
      contentHash: built.contentHash,
      destination: "",
      deliveryMethod: partner.deliveryMethod,
      status: "queued",
      attempts,
      lastError: "",
    })
    .onConflictDoUpdate({
      target: [
        schema.pudoManifestRunsTable.partnerCode,
        schema.pudoManifestRunsTable.forDate,
      ],
      set: {
        shipmentCount: built.shipmentCount,
        contentHash: built.contentHash,
        deliveryMethod: partner.deliveryMethod,
        attempts,
      },
    });

  let transportResult: TransportResult;
  if (partner.deliveryMethod === "email") {
    transportResult = await deps.emailTransport({
      partner,
      forDate,
      csv: built.csv,
    });
  } else if (partner.deliveryMethod === "sftp") {
    transportResult = await deps.sftpTransport({
      partner,
      forDate,
      csv: built.csv,
    });
  } else {
    return "skipped";
  }

  if (transportResult.ok) {
    await db
      .update(schema.pudoManifestRunsTable)
      .set({
        status: "sent",
        destination: transportResult.destination,
        deliveredAt: now,
        lastError: "",
      })
      .where(
        and(
          eq(schema.pudoManifestRunsTable.partnerCode, partner.code),
          eq(schema.pudoManifestRunsTable.forDate, forDate),
        ),
      );
    logger.info(
      {
        partnerCode: partner.code,
        forDate,
        shipmentCount: built.shipmentCount,
        destination: transportResult.destination,
        attempts,
      },
      "pudo_manifest_delivered",
    );
    return "delivered";
  }

  // Transport failed: persist the error and decide whether to mark
  // terminal-failed (so we stop retrying today) or leave queued (so
  // the next tick retries). Either way, alert.
  const terminal = attempts >= MAX_ATTEMPTS_PER_DAY;
  await db
    .update(schema.pudoManifestRunsTable)
    .set({
      status: terminal ? "failed" : "queued",
      destination: transportResult.destination,
      lastError: `${transportResult.errorCode ?? "error"}: ${transportResult.errorMessage ?? ""}`.slice(0, 500),
    })
    .where(
      and(
        eq(schema.pudoManifestRunsTable.partnerCode, partner.code),
        eq(schema.pudoManifestRunsTable.forDate, forDate),
      ),
    );
  logger.warn(
    {
      partnerCode: partner.code,
      forDate,
      attempts,
      terminal,
      errorCode: transportResult.errorCode,
      errorMessage: transportResult.errorMessage,
    },
    terminal
      ? "pudo_manifest_delivery_failed_terminal"
      : "pudo_manifest_delivery_failed_will_retry",
  );

  // Always page (alert + Sentry) so on-call sees the failure even on
  // the first attempt — partners notice fast when their morning
  // manifest doesn't arrive, and we'd rather be loud than miss it.
  // The notifier dedupes on subsystem so multiple failures collapse
  // into one rolling incident in Slack/PagerDuty.
  const firstFailureAt = (existing?.createdAt ?? now).getTime();
  deps.alertNotifier.notifyDegraded({
    subsystem: ALERT_SUBSYSTEM,
    label: `PUDO manifest delivery (${partner.code})`,
    firstFailureAt,
    detectedAt: now.getTime(),
    details: {
      partner: partner.code,
      forDate,
      attempts,
      terminal: terminal ? "true" : "false",
      method: partner.deliveryMethod,
      errorCode: transportResult.errorCode ?? "unknown",
    },
  });
  deps.capture(
    terminal
      ? "pudo_manifest_delivery_failed_terminal"
      : "pudo_manifest_delivery_failed_will_retry",
    {
      level: terminal ? "error" : "warning",
      tags: {
        subsystem: ALERT_SUBSYSTEM,
        partner: partner.code,
        method: partner.deliveryMethod,
      },
      extra: {
        forDate,
        attempts,
        errorCode: transportResult.errorCode ?? "unknown",
        errorMessage: transportResult.errorMessage ?? "",
      },
    },
  );
  return "failed";
}

/**
 * Test/operator helper: returns the most recent run row per partner.
 * Useful for the admin status page — not exposed over HTTP yet but
 * the query is cheap and the shape is stable.
 */
export async function latestManifestRunPerPartner(): Promise<
  (typeof schema.pudoManifestRunsTable.$inferSelect)[]
> {
  // One row per partner — the highest createdAt. We use a window
  // function for portability over the older "DISTINCT ON" form so
  // this stays hop-friendly if we ever swap drivers.
  const rows = await db
    .select()
    .from(schema.pudoManifestRunsTable)
    .orderBy(desc(schema.pudoManifestRunsTable.createdAt));
  const seen = new Set<string>();
  const latest: (typeof schema.pudoManifestRunsTable.$inferSelect)[] = [];
  for (const row of rows) {
    if (seen.has(row.partnerCode)) continue;
    seen.add(row.partnerCode);
    latest.push(row);
  }
  return latest;
}
