import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One-time-passcode store for phone sign-in / phone-link verification.
 * Codes are stored hashed with sha256 so a DB leak does not expose live OTPs.
 * `purpose` distinguishes sign-in (creates Clerk user) from phone-link
 * (binds phone to existing Clerk user).
 */
export const otpsTable = pgTable(
  "otps",
  {
    id: text("id").primaryKey(),
    phone: text("phone").notNull(),
    channel: text("channel").notNull(),
    purpose: text("purpose").notNull().default("sign_in"),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPhone: index("otps_phone_created_idx").on(t.phone, t.createdAt),
  }),
);

export type OtpRow = typeof otpsTable.$inferSelect;

/**
 * Push subscription tokens. `kind` = web | fcm. For web push the `token`
 * column carries the JSON-serialized PushSubscription, plus `p256dh`/`auth`
 * are exploded for fast lookup. For FCM the `token` is the registration id
 * and the keys are blank.
 */
export const pushTokensTable = pgTable(
  "push_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    token: text("token").notNull(),
    endpoint: text("endpoint").notNull().default(""),
    p256dh: text("p256dh").notNull().default(""),
    auth: text("auth").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserToken: uniqueIndex("push_tokens_user_token_uniq").on(t.userId, t.token),
    byUser: index("push_tokens_user_idx").on(t.userId),
  }),
);

export type PushTokenRow = typeof pushTokensTable.$inferSelect;

/**
 * Outbox row. `eventType` is the business event (e.g. order_paid). The
 * worker resolves prefs+channels+quiet-hours, fans out to each channel
 * adapter, and writes one row per (user, event, channel) so retries are
 * channel-scoped — a transient SMS failure should not cause a re-send to
 * WhatsApp.
 */
export const notificationsOutboxTable = pgTable(
  "notifications_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    channel: text("channel").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStatusNext: index("outbox_status_next_idx").on(t.status, t.nextAttemptAt),
    byUser: index("outbox_user_idx").on(t.userId, t.createdAt),
  }),
);

export type OutboxRow = typeof notificationsOutboxTable.$inferSelect;

/**
 * Suppression list for transactional email. Entries are keyed by the
 * lowercased recipient email (the granularity at which providers reject
 * mail) and explain WHY the address is not allowed to receive further
 * mail. The drain step in `notifications/outbox.ts` short-circuits any
 * email aimed at a suppressed address — marking the row delivered with
 * `last_error = 'suppressed'` rather than letting it count as a real
 * send.
 *
 * `reason` values:
 *   - `hard_bounce`         — provider returned a permanent failure
 *   - `inactive_recipient`  — Postmark code 406 / SendGrid invalid
 *   - `unsubscribe`         — recipient explicitly opted out
 *   - `account_deleted`     — user removed their account (NDPR erase)
 *
 * `source` records which subsystem inserted the row (`postmark`,
 * `sendgrid`, `ndpr`, `system`) so operators can audit suppression
 * trends per provider. `userId` is best-effort — for bounce-driven
 * suppressions we may not know the originating user.
 *
 * The unique index on `email` makes inserts idempotent via
 * `ON CONFLICT DO NOTHING`; the first reason wins so an account
 * deletion does not get overwritten by a subsequent stale bounce.
 */
export const notificationSuppressionsTable = pgTable(
  "notification_suppressions",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    reason: text("reason").notNull(),
    source: text("source").notNull().default(""),
    userId: text("user_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqEmail: uniqueIndex("notification_suppressions_email_uniq").on(t.email),
    byCreatedAt: index("notification_suppressions_created_idx").on(t.createdAt),
  }),
);

export type NotificationSuppressionRow = typeof notificationSuppressionsTable.$inferSelect;
