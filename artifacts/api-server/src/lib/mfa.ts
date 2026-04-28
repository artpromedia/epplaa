import crypto from "node:crypto";
import { eq, and, gte, sql } from "drizzle-orm";
import { authenticator } from "otplib";
import qrcode from "qrcode";
import { db } from "./db";
import { newSafeId } from "./ids";
import { logger } from "./logger";

/**
 * TOTP MFA primitives.
 *
 * Storage:
 *   secret_encrypted = base64( iv ‖ tag ‖ ciphertext ) under AES-256-GCM
 *   key derived from MFA_ENCRYPTION_KEY (env). If MFA_ENCRYPTION_KEY is
 *   missing in production this module refuses to mint or verify codes —
 *   silently falling back to plaintext would defeat the purpose.
 *
 * Backup codes:
 *   10 single-use hex codes shown ONCE at enrolment. Stored as
 *   sha256(MFA_BACKUP_PEPPER ‖ code). Verifying a code removes its hash
 *   from the stored array atomically.
 *
 * Velocity gate (used by requireMfa middleware):
 *   Sum of `payments.amount_minor` (NGN) in last 30d. Above 1_000_000 NGN
 *   the user must have an enrolled+asserted TOTP factor to mutate.
 */

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function encryptionKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MFA_ENCRYPTION_KEY is required in production");
    }
    // Dev fallback derived from SESSION_SECRET so local dev is reproducible.
    const seed = process.env.SESSION_SECRET ?? "dev-mfa-fallback";
    return crypto.createHash("sha256").update(`mfa::${seed}`).digest();
  }
  // Accept hex (64 chars) or base64. Otherwise hash to 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === KEY_BYTES) return b64;
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(secret: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(envelope: string): string {
  const key = encryptionKey();
  const buf = Buffer.from(envelope, "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + 16);
  const ct = buf.subarray(IV_BYTES + 16);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

function backupPepper(): string {
  return (
    process.env.MFA_BACKUP_PEPPER ??
    process.env.SESSION_SECRET ??
    "dev-mfa-pepper"
  );
}

function hashBackupCode(code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${backupPepper()}::${code.toLowerCase().trim()}`)
    .digest("hex");
}

function generateBackupCodes(): string[] {
  // 10 codes, 10 hex chars each (40 bits entropy is fine — single-use,
  // rate-limited at the route layer).
  return Array.from({ length: 10 }, () =>
    crypto.randomBytes(5).toString("hex"),
  );
}

export interface TotpSetupResult {
  enrollmentId: string;
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  backupCodes: string[];
}

/**
 * Begin TOTP enrolment. Persists a `pending` row with the encrypted
 * secret + hashed backup codes, and returns the plaintext secret +
 * backup codes ONCE so the SPA can render the QR code and the recovery
 * sheet. Verify must be called within the next ~5 minutes to flip status
 * to `active`; pending rows older than that are pruned by a future job.
 */
export async function setupTotp(
  userId: string,
  accountLabel: string,
): Promise<TotpSetupResult> {
  const secret = authenticator.generateSecret();
  const issuer = "Epplaa";
  const otpauthUrl = authenticator.keyuri(accountLabel, issuer, secret);
  const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);
  const backupCodes = generateBackupCodes();
  const hashedCodes = backupCodes.map(hashBackupCode);
  const id = newSafeId("mfa_");
  // UPSERT — re-enrolment overwrites a previous pending row. The
  // backup-code array is passed as a single parameterised value (pg
  // serialises a JS string[] into a text[] when the literal cast is
  // attached) — never interpolate the array into the SQL string, even
  // though the codes are internally generated; it would be a latent
  // injection sink the moment the input source ever changes.
  await db.execute(sql`
    INSERT INTO mfa_enrollments (id, user_id, kind, secret_encrypted, status, backup_codes_hashed)
    VALUES (${id}, ${userId}, 'totp', ${encryptSecret(secret)}, 'pending', ${hashedCodes}::text[])
    ON CONFLICT (user_id, kind) DO UPDATE SET
      secret_encrypted = EXCLUDED.secret_encrypted,
      status = 'pending',
      backup_codes_hashed = EXCLUDED.backup_codes_hashed,
      updated_at = now();
  `);
  return { enrollmentId: id, secret, otpauthUrl, qrCodeDataUrl, backupCodes };
}

export async function verifyTotpAndActivate(
  userId: string,
  code: string,
): Promise<boolean> {
  const row = await db.execute<{ secret_encrypted: string; status: string }>(sql`
    SELECT secret_encrypted, status FROM mfa_enrollments
    WHERE user_id = ${userId} AND kind = 'totp' LIMIT 1;
  `);
  const r = row.rows[0];
  if (!r) return false;
  const secret = decryptSecret(r.secret_encrypted);
  // window=1 → accept current ±30s step (clock drift tolerance).
  authenticator.options = { window: 1 };
  if (!authenticator.check(code, secret)) return false;
  await db.execute(sql`
    UPDATE mfa_enrollments
    SET status = 'active',
        enrolled_at = COALESCE(enrolled_at, now()),
        last_used_at = now(),
        updated_at = now()
    WHERE user_id = ${userId} AND kind = 'totp';
  `);
  await recordChallenge(userId, "totp");
  return true;
}

export async function verifyTotpAssertion(
  userId: string,
  code: string,
): Promise<boolean> {
  const row = await db.execute<{ secret_encrypted: string; status: string }>(sql`
    SELECT secret_encrypted, status FROM mfa_enrollments
    WHERE user_id = ${userId} AND kind = 'totp' AND status = 'active' LIMIT 1;
  `);
  const r = row.rows[0];
  if (!r) return false;
  const secret = decryptSecret(r.secret_encrypted);
  authenticator.options = { window: 1 };
  if (!authenticator.check(code, secret)) return false;
  await db.execute(sql`
    UPDATE mfa_enrollments SET last_used_at = now(), updated_at = now()
    WHERE user_id = ${userId} AND kind = 'totp';
  `);
  await recordChallenge(userId, "totp");
  return true;
}

export async function consumeBackupCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const hash = hashBackupCode(code);
  const row = await db.execute<{ id: string; backup_codes_hashed: string[] }>(sql`
    SELECT id, backup_codes_hashed FROM mfa_enrollments
    WHERE user_id = ${userId} AND kind = 'totp' AND status = 'active' LIMIT 1;
  `);
  const r = row.rows[0];
  if (!r) return false;
  if (!r.backup_codes_hashed.includes(hash)) return false;
  // Atomic single-use: filter the array within the same UPDATE statement,
  // gated on the hash still being present so concurrent consumers race-free.
  const upd = await db.execute<{ id: string }>(sql`
    UPDATE mfa_enrollments
    SET backup_codes_hashed = array_remove(backup_codes_hashed, ${hash}),
        last_used_at = now(),
        updated_at = now()
    WHERE id = ${r.id} AND ${hash} = ANY(backup_codes_hashed)
    RETURNING id;
  `);
  if (upd.rows.length === 0) return false;
  await recordChallenge(userId, "totp");
  return true;
}

export async function disableMfa(userId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM mfa_enrollments WHERE user_id = ${userId};
  `);
  await db.execute(sql`DELETE FROM mfa_challenges WHERE user_id = ${userId};`);
}

export interface MfaStatus {
  enrolled: boolean;
  kind: "totp" | null;
  enrolledAt: Date | null;
  lastUsedAt: Date | null;
  backupCodesRemaining: number;
  recentlyAsserted: boolean;
}

const ASSERTION_TTL_MS = 15 * 60 * 1000; // 15 min

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const row = await db.execute<{
    kind: string;
    status: string;
    enrolled_at: Date | null;
    last_used_at: Date | null;
    backup_codes_hashed: string[];
  }>(sql`
    SELECT kind, status, enrolled_at, last_used_at, backup_codes_hashed
    FROM mfa_enrollments WHERE user_id = ${userId} AND status = 'active' LIMIT 1;
  `);
  const r = row.rows[0];
  const recently = await hasRecentChallenge(userId);
  if (!r) {
    return {
      enrolled: false,
      kind: null,
      enrolledAt: null,
      lastUsedAt: null,
      backupCodesRemaining: 0,
      recentlyAsserted: recently,
    };
  }
  return {
    enrolled: true,
    kind: r.kind === "totp" ? "totp" : null,
    enrolledAt: r.enrolled_at,
    lastUsedAt: r.last_used_at,
    backupCodesRemaining: r.backup_codes_hashed.length,
    recentlyAsserted: recently,
  };
}

async function recordChallenge(userId: string, kind: string): Promise<void> {
  const id = newSafeId("mfc_");
  const expiresAt = new Date(Date.now() + ASSERTION_TTL_MS);
  await db.execute(sql`
    INSERT INTO mfa_challenges (id, user_id, kind, asserted_at, expires_at)
    VALUES (${id}, ${userId}, ${kind}, now(), ${expiresAt.toISOString()});
  `);
}

export async function hasRecentChallenge(userId: string): Promise<boolean> {
  const row = await db.execute<{ id: string }>(sql`
    SELECT id FROM mfa_challenges
    WHERE user_id = ${userId} AND expires_at > now()
    ORDER BY expires_at DESC LIMIT 1;
  `);
  return row.rows.length > 0;
}

/**
 * Compute rolling 30d gross seller-share payout value (in NGN minor units)
 * for a user acting as a seller. Used by `requireMfa()` to decide if this
 * user is "high-velocity" and therefore must have an active TOTP enrolment
 * + recent assertion.
 *
 * Source: `payouts` table — every settled seller share / manufacturer share
 * lands here. `kind = 'seller_share'` plus `kind = 'manufacturer_share'` are
 * both seller-tier flows; `wallet_withdrawal` is excluded because that's
 * money already attributable to the user (not new gross merchandise).
 *
 * Status filter: count `paid` and `processing` so a seller mid-payout can't
 * dodge the gate by timing requests around payout cycles. If the table shape
 * ever shifts we degrade to 0 (MFA still applies to admins via the role
 * branch in `requireMfa()`, which is the safer-of-two failure modes for
 * availability).
 */
export async function thirtyDayVelocityNgnMinor(userId: string): Promise<number> {
  try {
    const row = await db.execute<{ total: string | null }>(sql`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS total
      FROM payouts
      WHERE (user_id = ${userId} OR seller_id = ${userId})
        AND status IN ('paid', 'processing')
        AND currency_code = 'NGN'
        AND requested_at >= now() - interval '30 days';
    `);
    return Number(row.rows[0]?.total ?? "0") || 0;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "mfa_velocity_query_failed");
    return 0;
  }
}

export const __test__ = {
  hashBackupCode,
  generateBackupCodes,
  encryptionKey,
};

// Re-exports kept for tree-shaking-friendly imports in tests.
export { eq, and, gte };
