import { createHash, randomInt } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { newSafeId } from "./ids";
import { enqueueNotification } from "./notifications";

const OTP_TTL_MS = 5 * 60 * 1000;
const SEND_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SEND_LIMIT_MAX = 3;
const MAX_ATTEMPTS = 5;

export type OtpPurpose = "sign_in" | "phone_link";
export type OtpChannel = "sms" | "whatsapp";

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

export function normalizePhone(input: string): string {
  // Strict E.164. Accept input with spaces/dashes; reject if no + prefix.
  const cleaned = input.replace(/[\s\-()]/g, "");
  if (!cleaned.startsWith("+")) return "";
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) return "";
  return cleaned;
}

/**
 * Issue an OTP. Returns the code only when running without Termii configured
 * (dev mode) so the caller can echo it back to the SPA for self-tests.
 */
export async function startOtp(args: {
  phone: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
}): Promise<{ otpId: string; devCode?: string; rateLimited?: boolean }> {
  const phone = normalizePhone(args.phone);
  if (!phone) throw new Error("invalid_phone");

  // Rate limit: max 3 sends per 10min window per phone.
  const since = new Date(Date.now() - SEND_LIMIT_WINDOW_MS);
  const recent = await db
    .select({ id: schema.otpsTable.id })
    .from(schema.otpsTable)
    .where(and(eq(schema.otpsTable.phone, phone), gt(schema.otpsTable.createdAt, since)));
  if (recent.length >= SEND_LIMIT_MAX) {
    return { otpId: "", rateLimited: true };
  }

  const code = generateCode();
  const id = newSafeId("otp");
  await db.insert(schema.otpsTable).values({
    id,
    phone,
    channel: args.channel,
    purpose: args.purpose,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  const title = "Epplaa verification";
  const body = `Your Epplaa code is ${code}. It expires in 5 minutes.`;
  await enqueueNotification({
    userId: phone, // synthetic — OTP outbox rows are keyed by phone, not Clerk id
    eventType: "otp_code",
    payload: { title, body },
    forcedChannels: [{ channel: args.channel, to: phone }],
  });

  const devEcho = !process.env.TERMII_API_KEY;
  return { otpId: id, devCode: devEcho ? code : undefined };
}

export interface VerifyResult {
  ok: boolean;
  reason?: "not_found" | "expired" | "consumed" | "too_many_attempts" | "wrong_code";
  phone?: string;
  purpose?: OtpPurpose;
}

/**
 * Verify the latest OTP for the given phone. Single-use; consumes the row
 * on success. Tracks attempts so brute-force gets locked out after 5 wrong
 * tries against the same OTP.
 */
export async function verifyOtp(args: { phone: string; code: string }): Promise<VerifyResult> {
  const phone = normalizePhone(args.phone);
  if (!phone) return { ok: false, reason: "not_found" };
  const [latest] = await db
    .select()
    .from(schema.otpsTable)
    .where(eq(schema.otpsTable.phone, phone))
    .orderBy(desc(schema.otpsTable.createdAt))
    .limit(1);
  if (!latest) return { ok: false, reason: "not_found" };
  if (latest.consumedAt) return { ok: false, reason: "consumed" };
  if (latest.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (latest.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  // Atomic compare-and-set: consume the row only if the hash matches AND
  // it's still pending and not expired and under the attempts cap. The
  // RETURNING is empty for any racing duplicate (each call only sees one
  // success). On failure we still bump attempts so brute force is bounded.
  const expectedHash = hashCode(args.code.trim());
  const consumed = await db
    .update(schema.otpsTable)
    .set({ consumedAt: new Date(), attempts: sql`${schema.otpsTable.attempts} + 1` })
    .where(
      and(
        eq(schema.otpsTable.id, latest.id),
        sql`${schema.otpsTable.consumedAt} IS NULL`,
        eq(schema.otpsTable.codeHash, expectedHash),
        sql`${schema.otpsTable.attempts} < ${MAX_ATTEMPTS}`,
        sql`${schema.otpsTable.expiresAt} > NOW()`,
      ),
    )
    .returning({ id: schema.otpsTable.id });
  if (consumed.length === 0) {
    // Bump attempts on a failed (wrong code) try while it's still active.
    await db
      .update(schema.otpsTable)
      .set({ attempts: sql`${schema.otpsTable.attempts} + 1` })
      .where(
        and(
          eq(schema.otpsTable.id, latest.id),
          sql`${schema.otpsTable.consumedAt} IS NULL`,
        ),
      );
    return { ok: false, reason: "wrong_code" };
  }
  return { ok: true, phone, purpose: latest.purpose as OtpPurpose };
}
