import crypto from "node:crypto";
import { eq, and, gte, sql } from "drizzle-orm";
import { authenticator } from "otplib";
import qrcode from "qrcode";
import { db } from "./db";
import { newSafeId } from "./ids";
import { logger } from "./logger";
import { detectNonHostnameProductionSignals } from "./productionSignals";

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

/**
 * Boot-time sanity check: production deploys MUST set
 * `MFA_ENCRYPTION_KEY`.
 *
 * `encryptionKey()` (below) throws `"MFA_ENCRYPTION_KEY is required
 * in production"` lazily on the first MFA enrollment / verification
 * when `NODE_ENV=production` and the env var is unset. Two problems:
 *
 *   1. The throw is gated on `NODE_ENV === "production"` only —
 *      a deploy that uses `REPLIT_DEPLOYMENT=1` /
 *      `DEPLOYMENT_ENVIRONMENT=production` (other production-shape
 *      signals) without `NODE_ENV=production` would silently encrypt
 *      TOTP secrets under a SESSION_SECRET-derived key. That makes
 *      MFA secrets only as strong as SESSION_SECRET on those deploys.
 *   2. Even on a `NODE_ENV=production` deploy, the failure mode is
 *      lazy: boot looks healthy, then the next user attempting to
 *      enroll MFA gets a 5xx and on-call only finds out via a Sentry
 *      capture from inside the route handler.
 *
 * This boot-time warning catches both — production-shape is detected
 * via `detectNonHostnameProductionSignals` (so all three signals are
 * covered, not just NODE_ENV), and the warning fires at boot rather
 * than at first MFA enrollment.
 *
 * Modelled on the other `assertXxxConfiguredForProduction` helpers
 * (see `docs/runbooks/production-secrets.md`). Warning, not a hard
 * failure — the lazy throw at first enrollment is still the
 * authoritative fail-closed control. Operators wire a Sentry / log-
 * aggregator alert on the
 * `mfa_encryption_key_missing_for_production` message tag.
 *
 * Pure function — takes `env` and a `log` sink so the unit test can
 * exercise the staging-skipped, production-warned, and configured-
 * silent paths without poisoning `process.env` or piping pino output.
 */
export type MfaEncryptionKeyConfigOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function assertMfaEncryptionKeyConfiguredForProduction(
  env: NodeJS.ProcessEnv,
  log: { warn: (obj: unknown, msg: string) => void },
): MfaEncryptionKeyConfigOutcome {
  const productionSignals = detectNonHostnameProductionSignals(env);
  if (productionSignals.length === 0) return { ok: true };
  const raw = env.MFA_ENCRYPTION_KEY;
  if (raw && raw.trim() !== "") return { ok: true };
  const signalDetails = productionSignals.map((s) => s.detail).join("; ");
  const reason =
    "MFA_ENCRYPTION_KEY is not set on this production deploy. The " +
    "lib/mfa.ts encryptionKey() lazy-throw is gated on NODE_ENV=production " +
    "ONLY, so a deploy that uses REPLIT_DEPLOYMENT=1 or " +
    "DEPLOYMENT_ENVIRONMENT=production without NODE_ENV=production would " +
    "silently encrypt TOTP secrets under a SESSION_SECRET-derived key. " +
    "Even on a NODE_ENV=production deploy, the failure mode is lazy " +
    "(boot looks healthy, then the next MFA enrollment 5xxs). " +
    `Detected production signal(s): ${signalDetails}. ` +
    "Set MFA_ENCRYPTION_KEY (32 bytes hex/base64 preferred) — see " +
    "docs/runbooks/production-secrets.md (MFA_ENCRYPTION_KEY section).";
  log.warn(
    {
      node_env: env.NODE_ENV,
      replit_deployment: env.REPLIT_DEPLOYMENT,
      deployment_environment: env.DEPLOYMENT_ENVIRONMENT,
      mfa_encryption_key: raw ? "[set-but-empty]" : null,
      production_signals: productionSignals.map((s) => s.signal),
    },
    `mfa_encryption_key_missing_for_production: ${reason}`,
  );
  return { ok: false, reason };
}

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
 * sheet. Verify must be called within `MFA_PENDING_PRUNE_MAX_AGE_MS`
 * (default ~10 minutes) to flip status to `active`; pending rows older
 * than that are pruned by `pruneStalePendingMfaEnrollments`, which is
 * scheduled at boot in `app.ts`.
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
  // backup-code array is passed as a single Postgres array literal
  // text parameter ({a,b,c}) and cast to text[]. Drizzle's `sql`
  // template tag expands raw JS arrays into a comma-separated list of
  // placeholders ($n,$m,...) which Postgres reads as a row constructor —
  // not what we want. Hashes are sha256 hex ([0-9a-f]{64}) so there is
  // no interpolation risk in the literal; we still parameterise it.
  const codesLiteral = `{${hashedCodes.join(",")}}`;
  await db.execute(sql`
    INSERT INTO mfa_enrollments (id, user_id, kind, secret_encrypted, status, backup_codes_hashed)
    VALUES (${id}, ${userId}, 'totp', ${encryptSecret(secret)}, 'pending', ${codesLiteral}::text[])
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

/**
 * Issue a fresh batch of 10 backup codes for an already-active TOTP
 * enrolment, replacing the stored hashes. Returns the plaintext codes
 * exactly once. Returns null when the user has no active enrolment so
 * the caller can return a 404 (the regenerate flow is meaningless
 * without an existing factor).
 *
 * The UPDATE is gated on `status = 'active'` so a stale `pending` row
 * cannot be used to mint codes for an unverified secret.
 *
 * Side effect: clears `last_low_backup_codes_nudge_threshold` so a user
 * who refills to 10 codes can be nudged again the next time they drain
 * below the threshold. Without this reset, a seller who hit "empty",
 * regenerated, then drained back down would never see a second email.
 */
export async function regenerateBackupCodes(
  userId: string,
): Promise<string[] | null> {
  const codes = generateBackupCodes();
  const hashed = codes.map(hashBackupCode);
  const codesLiteral = `{${hashed.join(",")}}`;
  const upd = await db.execute<{ id: string }>(sql`
    UPDATE mfa_enrollments
    SET backup_codes_hashed = ${codesLiteral}::text[],
        last_low_backup_codes_nudge_threshold = NULL,
        updated_at = now()
    WHERE user_id = ${userId} AND kind = 'totp' AND status = 'active'
    RETURNING id;
  `);
  if (upd.rows.length === 0) return null;
  return codes;
}

/**
 * Default window after which an unconfirmed `pending` enrolment is
 * considered stale and reaped. The QR code is shown to the user once
 * and the SPA expects them to type the 6-digit code within a couple of
 * minutes; ten minutes is generous enough for a slow first-time user
 * but short enough that abandoned enrolments don't sit in the DB
 * encrypting a secret nobody will ever use.
 *
 * Overridable via the `MFA_PENDING_PRUNE_MAX_AGE_MS` env var (positive
 * integer milliseconds). Invalid values fall back to the default with a
 * warning so a typo in the env doesn't silently disable pruning.
 */
export const DEFAULT_MFA_PENDING_PRUNE_MAX_AGE_MS = 10 * 60 * 1000;

function configuredPruneMaxAgeMs(): number {
  const raw = process.env.MFA_PENDING_PRUNE_MAX_AGE_MS;
  if (!raw) return DEFAULT_MFA_PENDING_PRUNE_MAX_AGE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { value: raw },
      "mfa_pending_prune_max_age_invalid_using_default",
    );
    return DEFAULT_MFA_PENDING_PRUNE_MAX_AGE_MS;
  }
  return Math.floor(n);
}

/**
 * Delete `mfa_enrollments` rows whose `status = 'pending'` and whose
 * `updated_at` is older than `maxAgeMs` ago. Active enrolments — even
 * very old ones — are never touched. Returns the number of rows pruned
 * and logs the count for observability.
 *
 * Safe to call concurrently: the DELETE is a single atomic statement
 * and overlapping ticks are a no-op once the first one wins.
 */
export async function pruneStalePendingMfaEnrollments(
  maxAgeMs: number = configuredPruneMaxAgeMs(),
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const res = await db.execute<{ id: string }>(sql`
    DELETE FROM mfa_enrollments
     WHERE status = 'pending'
       AND updated_at < ${cutoff.toISOString()}
    RETURNING id;
  `);
  const pruned = res.rows.length;
  // Always log a concrete count so dashboards / log-based metrics can
  // chart "rows pruned per run" without inferring zeros from missing
  // log lines. Drop to debug on no-op so the noisier 5-min cadence
  // doesn't dominate INFO logs.
  if (pruned > 0) {
    logger.info(
      { pruned, maxAgeMs, cutoff: cutoff.toISOString() },
      "mfa_pending_enrollments_pruned",
    );
  } else {
    logger.debug(
      { pruned: 0, maxAgeMs, cutoff: cutoff.toISOString() },
      "mfa_pending_enrollments_prune_noop",
    );
  }
  return pruned;
}

/**
 * Default forensic-grace window for expired `mfa_challenges`. Anything
 * whose `expires_at` is older than `now() - <grace>` is removed.
 *
 * Why a grace period at all: `hasRecentChallenge()` already filters
 * with `expires_at > now()`, so any row past its expiry is dead weight
 * for the recently-asserted check. We keep a short tail (1 day) so an
 * incident responder reviewing "did this user assert MFA in the last
 * few hours?" still has the row to look at, even after expiry. Beyond
 * that, the row is pure storage cost.
 *
 * Overridable via the `MFA_CHALLENGES_PRUNE_GRACE_MS` env var (positive
 * integer milliseconds). Invalid values fall back to the default with
 * a warning so a typo doesn't silently disable pruning.
 */
export const DEFAULT_MFA_CHALLENGES_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

function configuredChallengesPruneGraceMs(): number {
  const raw = process.env.MFA_CHALLENGES_PRUNE_GRACE_MS;
  if (!raw) return DEFAULT_MFA_CHALLENGES_PRUNE_GRACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { value: raw },
      "mfa_challenges_prune_grace_invalid_using_default",
    );
    return DEFAULT_MFA_CHALLENGES_PRUNE_GRACE_MS;
  }
  return Math.floor(n);
}

/**
 * Delete `mfa_challenges` rows whose `expires_at` is older than
 * `now() - graceMs`. The TTL on a freshly-issued challenge is
 * `ASSERTION_TTL_MS` (15 min); after that it can no longer satisfy
 * `hasRecentChallenge()`, so the only reason to keep it around is a
 * brief forensic tail (default 1 day). Returns the number of rows
 * pruned and logs the count for observability.
 *
 * Single atomic DELETE — safe under concurrent ticks.
 */
export async function pruneExpiredMfaChallenges(
  graceMs: number = configuredChallengesPruneGraceMs(),
): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const res = await db.execute<{ id: string }>(sql`
    DELETE FROM mfa_challenges
     WHERE expires_at < ${cutoff.toISOString()}
    RETURNING id;
  `);
  const pruned = res.rows.length;
  if (pruned > 0) {
    logger.info(
      { pruned, graceMs, cutoff: cutoff.toISOString() },
      "mfa_challenges_pruned",
    );
  } else {
    logger.debug(
      { pruned: 0, graceMs, cutoff: cutoff.toISOString() },
      "mfa_challenges_prune_noop",
    );
  }
  return pruned;
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

/**
 * Normalize a timestamp column from `db.execute` raw SQL into a real
 * `Date`. Drizzle's typed query builder runs values through its column
 * type parsers (giving you a `Date`), but `db.execute(sql\`…\`)` returns
 * the row as the underlying `pg` driver delivered it, where TIMESTAMPTZ
 * arrives as a string like `"2026-04-29 02:24:19.178034+00"`. Calling
 * `.toISOString()` on that string blows up with TypeError, which is
 * exactly the 500 the `/mfa/status` route was hitting in production.
 *
 * Returning `null` for unparseable inputs keeps the route serializable
 * even if the driver ever surfaces something unexpected.
 */
function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const row = await db.execute<{
    kind: string;
    status: string;
    enrolled_at: Date | string | null;
    last_used_at: Date | string | null;
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
    enrolledAt: toDateOrNull(r.enrolled_at),
    lastUsedAt: toDateOrNull(r.last_used_at),
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

/**
 * Threshold the low-backup-codes email nudge fires under. Anything
 * strictly below this counts as "low". Kept generous (3) to match the
 * in-app banner copy that already tells users they have "fewer than 3
 * remaining". Overridable for tests.
 */
export const LOW_BACKUP_CODES_THRESHOLD = 3;

/**
 * Severity strings stored in `mfa_enrollments.last_low_backup_codes_nudge_threshold`.
 * Ordered from least to most severe — `severityRank` is what the job
 * uses to decide if the user has crossed INTO a stricter threshold and
 * therefore deserves a fresh email.
 */
type NudgeThreshold = "low" | "empty";

function severityRank(t: NudgeThreshold | null): number {
  if (t === "empty") return 2;
  if (t === "low") return 1;
  return 0;
}

function thresholdForRemaining(remaining: number): NudgeThreshold | null {
  if (remaining <= 0) return "empty";
  if (remaining < LOW_BACKUP_CODES_THRESHOLD) return "low";
  return null;
}

interface NudgeRow extends Record<string, unknown> {
  user_id: string;
  remaining: number;
  last_threshold: NudgeThreshold | null;
}

export interface NudgeLowBackupCodesResult {
  scanned: number;
  emailed: number;
}

/**
 * Scan active TOTP enrolments and email each user once per crossing
 * into a stricter backup-code threshold ("low" → fewer than
 * `LOW_BACKUP_CODES_THRESHOLD` remaining; "empty" → zero remaining).
 *
 * Loop-safety: every nudge updates `last_low_backup_codes_nudge_threshold`
 * to the threshold we just emailed about. Subsequent ticks compare the
 * current threshold's severity against the stored one and only re-send
 * when it climbs (e.g. previously "low", now "empty"). A user sitting
 * stably at "low" for weeks gets exactly one email; if they then run
 * out, they get one more for "empty". Regenerating codes resets the
 * marker to NULL (see `regenerateBackupCodes`) so a future drain
 * triggers fresh nudges.
 *
 * Channel selection: the underlying `enqueueNotification` resolves the
 * `mfa_backup_codes_low` event to email per the defaults in
 * `notifications/prefs.ts`. The category gate is `null` for this event
 * type, so a seller who has muted promotional categories still receives
 * this security nudge.
 *
 * The DB UPDATE is `RETURNING id` and gated on the previous threshold
 * value still matching, so two overlapping ticks cannot both stamp the
 * row and double-send. The nudge is enqueued only when the UPDATE
 * actually claimed the row.
 */
export async function nudgeLowBackupCodes(): Promise<NudgeLowBackupCodesResult> {
  // Lazy import to break a potential init-order cycle between mfa.ts
  // and the notifications module (notifications imports schema, which
  // touches db on first import; mfa.ts is also pulled in at boot).
  const { enqueueNotification } = await import("./notifications");
  // Only consider rows where the live remaining count is in a nudge
  // band — otherwise we'd scan every active enrolment every day.
  const res = await db.execute<NudgeRow>(sql`
    SELECT user_id,
           COALESCE(array_length(backup_codes_hashed, 1), 0) AS remaining,
           last_low_backup_codes_nudge_threshold AS last_threshold
    FROM mfa_enrollments
    WHERE kind = 'totp'
      AND status = 'active'
      AND COALESCE(array_length(backup_codes_hashed, 1), 0) < ${LOW_BACKUP_CODES_THRESHOLD};
  `);
  const rows = res.rows;
  let emailed = 0;
  for (const row of rows) {
    const remaining = Number(row.remaining ?? 0);
    const current = thresholdForRemaining(remaining);
    if (!current) continue;
    if (severityRank(current) <= severityRank(row.last_threshold)) {
      continue;
    }
    // Atomic claim: only stamp + emit if the row's stored threshold
    // hasn't already been advanced by a concurrent worker AND the
    // remaining count still maps to the same threshold we read from
    // the SELECT snapshot. The `IS NOT DISTINCT FROM` form treats NULL
    // as a value so the guard works for users who have never been
    // nudged before. The remaining-count predicate closes the
    // SELECT-then-UPDATE race where a user regenerated codes (refilled
    // to 10) between the scan and the claim — without it we could
    // stamp + email a "low" nudge for a user who is now at 10.
    const remainingPredicate =
      current === "empty"
        ? sql`COALESCE(array_length(backup_codes_hashed, 1), 0) = 0`
        : sql`COALESCE(array_length(backup_codes_hashed, 1), 0) BETWEEN 1 AND ${LOW_BACKUP_CODES_THRESHOLD - 1}`;
    const stamped = await db.execute<{ id: string }>(sql`
      UPDATE mfa_enrollments
      SET last_low_backup_codes_nudge_threshold = ${current},
          updated_at = now()
      WHERE user_id = ${row.user_id}
        AND kind = 'totp'
        AND status = 'active'
        AND last_low_backup_codes_nudge_threshold IS NOT DISTINCT FROM ${row.last_threshold}
        AND ${remainingPredicate}
      RETURNING id;
    `);
    if (stamped.rows.length === 0) continue;
    const isEmpty = current === "empty";
    const title = isEmpty
      ? "You're out of MFA backup codes"
      : "Your MFA backup codes are running low";
    const body = isEmpty
      ? "You have no backup codes left for two-factor sign-in. Generate a new set now so you don't lose access to your account."
      : `You have ${remaining} backup code${remaining === 1 ? "" : "s"} left for two-factor sign-in. Generate a fresh set so you stay covered if you ever lose your authenticator app.`;
    try {
      await enqueueNotification({
        userId: row.user_id,
        eventType: "mfa_backup_codes_low",
        payload: {
          title,
          body,
          url: "/account/security",
          remaining,
          threshold: current,
        },
      });
      emailed++;
    } catch (err) {
      // Roll the marker back so the next tick retries this user. We
      // logged the failure; we'd rather double-email later than fail
      // silently and lock the user out of ever being warned. The
      // rollback is gated on the marker still equalling the value we
      // just stamped so a concurrent worker that legitimately
      // advanced the marker further (e.g. crossed into "empty") is
      // not regressed back to a weaker threshold by this rollback.
      logger.warn(
        { userId: row.user_id, err: (err as Error).message },
        "mfa_backup_codes_low_enqueue_failed",
      );
      await db
        .execute(sql`
          UPDATE mfa_enrollments
          SET last_low_backup_codes_nudge_threshold = ${row.last_threshold},
              updated_at = now()
          WHERE user_id = ${row.user_id}
            AND kind = 'totp'
            AND status = 'active'
            AND last_low_backup_codes_nudge_threshold IS NOT DISTINCT FROM ${current};
        `)
        .catch(() => undefined);
    }
  }
  if (emailed > 0) {
    logger.info(
      { scanned: rows.length, emailed },
      "mfa_backup_codes_low_nudge_run",
    );
  } else {
    logger.debug(
      { scanned: rows.length, emailed: 0 },
      "mfa_backup_codes_low_nudge_noop",
    );
  }
  return { scanned: rows.length, emailed };
}

export const __test__ = {
  hashBackupCode,
  generateBackupCodes,
  encryptionKey,
  thresholdForRemaining,
  severityRank,
};

// Re-exports kept for tree-shaking-friendly imports in tests.
export { eq, and, gte };
