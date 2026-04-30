import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { newSafeId } from "../ids";
import { logger } from "../logger";

/**
 * Reasons we will refuse to deliver further mail to an address. Kept as
 * a closed string-union so the schema's free-text `reason` column stays
 * pinned to a small audit-friendly vocabulary at the type level.
 */
export type SuppressionReason =
  | "hard_bounce"
  | "inactive_recipient"
  | "unsubscribe"
  | "account_deleted";

/**
 * Records who/what added a suppression entry. Provider-driven inserts
 * use the provider name so dashboards can break suppressions down by
 * provider; system inserts (account deletion, manual ops actions) use
 * `ndpr` / `system`.
 */
export type SuppressionSource = "postmark" | "sendgrid" | "ndpr" | "system";

/**
 * Normalise an email for the suppression list. Provider-side bounce
 * lookups are case-insensitive and ignore surrounding whitespace, and
 * the unique index on `notification_suppressions.email` requires a
 * stable canonical form so `Foo@Example.com` and `foo@example.com`
 * never both land in the table — otherwise a bounce on one wouldn't
 * suppress the other.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when the address is on the suppression list. Empty / blank
 * strings are NOT considered suppressed (the outbox short-circuits an
 * earlier code path for missing email addresses with a different
 * reason).
 */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const norm = normaliseEmail(email);
  if (!norm) return false;
  const [row] = await db
    .select({ id: schema.notificationSuppressionsTable.id })
    .from(schema.notificationSuppressionsTable)
    .where(eq(schema.notificationSuppressionsTable.email, norm))
    .limit(1);
  return Boolean(row);
}

interface SuppressArgs {
  email: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  userId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Add (or no-op upsert) a suppression entry. Idempotent: a duplicate
 * insert on the same email is dropped by the unique index so the FIRST
 * recorded reason/source wins. Callers MUST pass an already-resolved
 * email (the outbox / NDPR call sites both look up the user's email
 * before calling); this function does not look users up itself.
 */
export async function suppressEmail(args: SuppressArgs): Promise<void> {
  const norm = normaliseEmail(args.email);
  if (!norm) return;
  try {
    await db
      .insert(schema.notificationSuppressionsTable)
      .values({
        id: newSafeId("nsup"),
        email: norm,
        reason: args.reason,
        source: args.source,
        userId: args.userId ?? null,
        details: args.details ?? {},
      })
      .onConflictDoNothing({ target: schema.notificationSuppressionsTable.email });
  } catch (err) {
    // Suppression failures must not break the caller (e.g. an erase
    // job mid-way through anonymising the user). Log and continue —
    // worst case we send one more email to a doomed address.
    logger.warn(
      { err: (err as Error).message, email: norm, reason: args.reason },
      "suppression_insert_failed",
    );
  }
}

/**
 * Suppress a user's currently-recorded email. Used by the account
 * deletion / NDPR erase flow which must add the address to the list
 * BEFORE the user row is anonymised (otherwise we lose the original
 * email and could never link a future bounce back to the suppression).
 *
 * Returns the email that was suppressed (lowercased) so callers can
 * record it in audit payloads, or `null` when the user had no email
 * on file or did not exist.
 */
export async function suppressUserEmail(
  userId: string,
  reason: SuppressionReason,
  source: SuppressionSource,
  details?: Record<string, unknown>,
): Promise<string | null> {
  const [u] = await db
    .select({ email: schema.usersTable.email })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.clerkId, userId))
    .limit(1);
  if (!u?.email) return null;
  // Skip the placeholder addresses NDPR's anonymiser writes — re-running
  // erase on an already-anonymised account would otherwise pollute the
  // suppression list with `<id>@erased.invalid` rows that can never
  // bounce or matter.
  if (u.email.endsWith("@erased.invalid")) return null;
  await suppressEmail({ email: u.email, reason, source, userId, details });
  return normaliseEmail(u.email);
}

/**
 * Provider-error → suppression-reason classifier. Returns null when the
 * error is transient (network blip, 5xx server error from a normally-
 * healthy provider) so the outbox keeps retrying instead of poisoning
 * the address.
 *
 * - Postmark `406` is "Inactive recipient" (the address is on Postmark's
 *   own bounce/spam-complaint suppression list). The send WILL keep
 *   failing until the address is reactivated, so we mirror it locally.
 * - SendGrid responds 5xx for hard bounce / blocked recipient errors
 *   surfaced synchronously by /mail/send (per task #141 brief). 4xx
 *   are validation errors we handle elsewhere; transient `exception`
 *   results stay null so the outbox retries.
 *
 * The classifier is deliberately conservative: anything it does not
 * recognise returns null and the outbox falls through to the normal
 * retry/backoff path.
 */
export function classifyEmailErrorForSuppression(
  provider: "postmark" | "sendgrid" | string | undefined,
  errorCode: string | undefined,
): SuppressionReason | null {
  if (!errorCode) return null;
  if (provider === "postmark") {
    // Postmark error codes are documented at
    // https://postmarkapp.com/developer/api/overview#error-codes —
    // 406 ("Inactive recipient"). 605/606 are also bounce-related but
    // 406 is the one the brief calls out and the only one we have
    // reproducible test fixtures for.
    if (errorCode === "406") return "inactive_recipient";
  }
  if (provider === "sendgrid") {
    // SendGrid sets errorCode to the HTTP status string in our
    // adapter. Treat any 5xx as a hard bounce per the task brief.
    const n = Number(errorCode);
    if (Number.isFinite(n) && n >= 500 && n < 600) return "hard_bounce";
  }
  return null;
}
