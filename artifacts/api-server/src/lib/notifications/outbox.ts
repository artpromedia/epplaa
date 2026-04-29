import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { logger } from "../logger";
import { newSafeId } from "../ids";
import { channels } from "./registry";
import { resolveChannelsForEvent } from "./prefs";
import {
  classifyEmailErrorForSuppression,
  isEmailSuppressed,
  suppressEmail,
} from "./suppressions";
import type {
  ChannelKind,
  EventType,
  NotificationChannel,
  NotificationMessage,
} from "./types";

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000];
// If a row sits in `processing` for longer than this it is assumed orphaned
// (worker crashed / killed mid-send) and recovered back to `pending` so a
// subsequent drain can retry it. Generous 15-min lease keeps us well clear
// of any realistic per-send latency, even with the bounded batch below.
const PROCESSING_LEASE_MS = 15 * 60_000;
// Cap how many rows a single drain claims so total processing time stays
// well under the lease window. With this cap and the lease above, even
// pessimistic per-send latency (~3s) keeps the tail row inside the lease.
const CLAIM_BATCH_SIZE = 50;

/**
 * Test-only injection point for the channel adapter used by the
 * sms/whatsapp branch of `drainOutbox`. The exactly-once / lease-recovery
 * tests need a deterministic per-row counting sink that can simulate
 * slow sends without going to a real provider; this seam lets the test
 * substitute a custom send function while the production path keeps
 * resolving adapters via the registry as before.
 *
 * Pass `null` to clear. Production code MUST NOT call this.
 */
export type OutboxTestChannelResolver = (
  kind: ChannelKind,
  pushKind?: "fcm" | "web",
) => NotificationChannel;
let _channelResolverOverrideForTests: OutboxTestChannelResolver | null = null;
export function __setOutboxChannelResolverForTests(
  resolver: OutboxTestChannelResolver | null,
): void {
  _channelResolverOverrideForTests = resolver;
}
function resolveChannel(
  kind: ChannelKind,
  pushKind?: "fcm" | "web",
): NotificationChannel {
  return _channelResolverOverrideForTests
    ? _channelResolverOverrideForTests(kind, pushKind)
    : channels.for(kind, pushKind);
}
// Re-export the constants so tests can pin assertions to the values
// they were designed against and fail loudly if production tightens
// the lease without updating the test guarantees.
export const __OUTBOX_PROCESSING_LEASE_MS = PROCESSING_LEASE_MS;
export const __OUTBOX_CLAIM_BATCH_SIZE = CLAIM_BATCH_SIZE;

interface EnqueueArgs {
  userId: string;
  eventType: EventType;
  payload: Record<string, unknown> & { title: string; body: string; url?: string };
  /** Direct override — bypass pref resolution. Used for OTP only. */
  forcedChannels?: { channel: ChannelKind; to: string }[];
}

/**
 * Resolve prefs + write one outbox row per (user, event, channel) so each
 * channel retries independently and the worker can be parallelised by
 * partitioning on row id.
 */
export async function enqueueNotification(args: EnqueueArgs): Promise<{ enqueued: number }> {
  const { userId, eventType, payload, forcedChannels } = args;
  let plan: { channel: ChannelKind; to: string }[] = [];
  if (forcedChannels && forcedChannels.length > 0) {
    plan = forcedChannels;
  } else {
    const resolved = await resolveChannelsForEvent(userId, eventType);
    if (resolved.channels.length === 0) {
      return { enqueued: 0 };
    }
    for (const c of resolved.channels) {
      let to = "";
      if (c === "sms") to = resolved.smsNumber;
      else if (c === "whatsapp") to = resolved.whatsappNumber;
      else if (c === "push") to = "*"; // resolved at drain time from push_tokens
      else if (c === "email") to = "*"; // email lookup happens at drain time
      if (!to) continue;
      plan.push({ channel: c, to });
    }
  }
  if (plan.length === 0) return { enqueued: 0 };

  const rows = plan.map((p) => ({
    id: newSafeId("nob"),
    userId,
    eventType,
    channel: p.channel,
    payload: { ...payload, _to: p.to } as Record<string, unknown>,
    status: "pending" as const,
    attempts: 0,
    nextAttemptAt: new Date(),
  }));
  await db.insert(schema.notificationsOutboxTable).values(rows);
  return { enqueued: rows.length };
}

/**
 * Drain due rows. Designed to be called by the in-process scheduler every
 * 30s. Each row is claimed atomically (pending -> processing) before the
 * channel adapter is invoked, so concurrent workers cannot double-send.
 */
export async function drainOutbox(): Promise<{ delivered: number; failed: number }> {
  // First: recover any rows that have been "processing" past the lease.
  // Without this, a worker crash would leave rows wedged forever because
  // we only ever claim from `pending`.
  const leaseCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
  await db
    .update(schema.notificationsOutboxTable)
    .set({ status: "pending", lastError: "lease_expired_recovered" })
    .where(
      and(
        eq(schema.notificationsOutboxTable.status, "processing"),
        lt(schema.notificationsOutboxTable.nextAttemptAt, leaseCutoff),
      ),
    );

  // Atomic claim, bounded by CLAIM_BATCH_SIZE so the slowest row in a batch
  // still finishes well inside PROCESSING_LEASE_MS. We bump `nextAttemptAt`
  // to NOW so the lease-recovery query above can detect orphans (and so a
  // failed send rescheduled later won't re-fire instantly).
  //
  // Deterministic FIFO ordering: oldest due rows first (nextAttemptAt asc),
  // then by createdAt then id as tiebreakers. This guarantees the "drain in
  // order" semantic across batches and avoids starvation of an older row
  // when a burst of newer rows is enqueued.
  const dueIds = await db
    .select({ id: schema.notificationsOutboxTable.id })
    .from(schema.notificationsOutboxTable)
    .where(
      and(
        eq(schema.notificationsOutboxTable.status, "pending"),
        lt(schema.notificationsOutboxTable.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(
      schema.notificationsOutboxTable.nextAttemptAt,
      schema.notificationsOutboxTable.createdAt,
      schema.notificationsOutboxTable.id,
    )
    .limit(CLAIM_BATCH_SIZE);
  const claimed = dueIds.length
    ? await db
        .update(schema.notificationsOutboxTable)
        .set({
          status: "processing",
          attempts: sql`${schema.notificationsOutboxTable.attempts} + 1`,
          nextAttemptAt: new Date(),
        })
        .where(
          and(
            eq(schema.notificationsOutboxTable.status, "pending"),
            inArray(
              schema.notificationsOutboxTable.id,
              dueIds.map((r) => r.id),
            ),
          ),
        )
        .returning()
    : [];

  let delivered = 0;
  let failed = 0;
  for (const row of claimed) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const to = String(payload._to ?? "");
    const title = String(payload.title ?? "");
    const body = String(payload.body ?? "");
    const url = payload.url ? String(payload.url) : undefined;
    const ch = row.channel as ChannelKind;

    if (ch === "push") {
      // Fan out to every registered token for this user. Failed sends only
      // affect the originating outbox row's status; per-token errors are
      // logged but don't fail the whole row unless every token fails.
      const tokens = await db
        .select()
        .from(schema.pushTokensTable)
        .where(eq(schema.pushTokensTable.userId, row.userId));
      if (tokens.length === 0) {
        await db
          .update(schema.notificationsOutboxTable)
          .set({ status: "delivered", deliveredAt: new Date() })
          .where(eq(schema.notificationsOutboxTable.id, row.id));
        delivered++;
        continue;
      }
      let anyOk = false;
      for (const t of tokens) {
        const adapter = resolveChannel("push", t.kind === "fcm" ? "fcm" : "web");
        // Web push adapter expects the JSON-serialized PushSubscription as
        // `to`. We persist endpoint/p256dh/auth as discrete columns and
        // rebuild the subscription envelope here so the unique key on
        // (userId, token) can stay the stable endpoint string.
        const to =
          t.kind === "fcm"
            ? t.token
            : JSON.stringify({
                endpoint: t.endpoint || t.token,
                keys: { p256dh: t.p256dh, auth: t.auth },
              });
        const msg: NotificationMessage = { to, title, body, url, payload };
        const result = await adapter.send(msg);
        if (result.ok) {
          anyOk = true;
          await db
            .update(schema.pushTokensTable)
            .set({ lastUsedAt: new Date() })
            .where(eq(schema.pushTokensTable.id, t.id));
        } else if (result.errorCode === "404" || result.errorCode === "410") {
          // Subscription gone — remove the token.
          await db.delete(schema.pushTokensTable).where(eq(schema.pushTokensTable.id, t.id));
        }
      }
      if (anyOk) {
        delivered++;
        await db
          .update(schema.notificationsOutboxTable)
          .set({ status: "delivered", deliveredAt: new Date() })
          .where(eq(schema.notificationsOutboxTable.id, row.id));
      } else {
        await rescheduleOrFail(row.id, row.attempts, "all_push_tokens_failed");
        failed++;
      }
      continue;
    }

    if (ch === "email" && to === "*") {
      const [u] = await db
        .select({ email: schema.usersTable.email })
        .from(schema.usersTable)
        .where(eq(schema.usersTable.clerkId, row.userId))
        .limit(1);
      if (!u?.email) {
        await db
          .update(schema.notificationsOutboxTable)
          .set({ status: "delivered", deliveredAt: new Date(), lastError: "no_email" })
          .where(eq(schema.notificationsOutboxTable.id, row.id));
        delivered++;
        continue;
      }
      // Honour the suppression list BEFORE invoking the provider. A
      // suppressed address (hard bounce, NDPR account-deleted, etc) is
      // a permanent terminal state — re-sending damages our sender
      // reputation and, in the deletion case, is an NDPR breach. We
      // count the row as `delivered` (the message had nowhere to go
      // and never will) with `last_error = 'suppressed'` so dashboards
      // can distinguish real successful sends from suppressed skips.
      if (await isEmailSuppressed(u.email)) {
        await db
          .update(schema.notificationsOutboxTable)
          .set({ status: "delivered", deliveredAt: new Date(), lastError: "suppressed" })
          .where(eq(schema.notificationsOutboxTable.id, row.id));
        delivered++;
        continue;
      }
      const adapter = resolveChannel("email");
      const result = await adapter.send({ to: u.email, title, body, url, payload });
      if (result.ok) {
        delivered++;
        await db
          .update(schema.notificationsOutboxTable)
          .set({ status: "delivered", deliveredAt: new Date() })
          .where(eq(schema.notificationsOutboxTable.id, row.id));
      } else {
        // Permanent provider failures (Postmark "inactive recipient",
        // SendGrid 5xx hard bounce per task #141) populate the
        // suppression list and stop retrying — repeated retries to a
        // known-bad address damage deliverability for legitimate mail.
        // Transient errors stay null and fall through to the normal
        // retry/backoff path below.
        const reason = classifyEmailErrorForSuppression(result.provider, result.errorCode);
        if (reason) {
          await suppressEmail({
            email: u.email,
            reason,
            source: (result.provider === "postmark" || result.provider === "sendgrid")
              ? result.provider
              : "system",
            userId: row.userId,
            details: {
              outboxId: row.id,
              eventType: row.eventType,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
            },
          });
          logger.info(
            {
              outboxId: row.id,
              userId: row.userId,
              reason,
              provider: result.provider,
              errorCode: result.errorCode,
            },
            "email_suppressed_after_provider_error",
          );
          await db
            .update(schema.notificationsOutboxTable)
            .set({ status: "delivered", deliveredAt: new Date(), lastError: "suppressed" })
            .where(eq(schema.notificationsOutboxTable.id, row.id));
          delivered++;
          continue;
        }
        await rescheduleOrFail(row.id, row.attempts, result.errorMessage ?? "email_failed");
        failed++;
      }
      continue;
    }

    const adapter = resolveChannel(ch);
    const result = await adapter.send({ to, title, body, url, payload });
    if (result.ok) {
      delivered++;
      await db
        .update(schema.notificationsOutboxTable)
        .set({ status: "delivered", deliveredAt: new Date() })
        .where(eq(schema.notificationsOutboxTable.id, row.id));
    } else {
      await rescheduleOrFail(row.id, row.attempts, result.errorMessage ?? "send_failed");
      failed++;
    }
  }

  if (delivered + failed > 0) {
    logger.info({ delivered, failed }, "outbox_drain");
  }
  return { delivered, failed };
}

async function rescheduleOrFail(rowId: string, attempts: number, error: string): Promise<void> {
  if (attempts >= MAX_ATTEMPTS) {
    await db
      .update(schema.notificationsOutboxTable)
      .set({ status: "failed", failedAt: new Date(), lastError: error })
      .where(eq(schema.notificationsOutboxTable.id, rowId));
    return;
  }
  // attempts has already been incremented at claim time. After the 1st
  // failure we want a 1-min retry, so index is `attempts-1`.
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[idx] ?? 24 * 3600_000;
  await db
    .update(schema.notificationsOutboxTable)
    .set({
      status: "pending",
      lastError: error,
      nextAttemptAt: new Date(Date.now() + delay),
    })
    .where(eq(schema.notificationsOutboxTable.id, rowId));
}
