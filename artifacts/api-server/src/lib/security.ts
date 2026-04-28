import { sql } from "drizzle-orm";
import { db } from "./db";

/**
 * Boot-time bootstrap for the security/MFA tables. Mirrors the
 * `initAuditChain` / `initAdminSchema` / `initManufacturerSchema` pattern:
 * idempotent additive SQL (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS) executed at boot, NOT via `drizzle-kit push --force`. Every PK is
 * `text` to match the rest of the project — a force-push would attempt
 * destructive ALTER TABLE statements on existing PKs.
 *
 * Tables:
 *  - mfa_enrollments: persistent per-user TOTP / WebAuthn registration. The
 *    TOTP secret is AES-GCM sealed with `MFA_ENCRYPTION_KEY` so a DB-only
 *    leak can't enumerate working codes. Backup codes are sha256(pepper||code).
 *  - mfa_challenges: short-lived assertion records ("user X just proved they
 *    hold the second factor"). Read by `requireMfa()` to decide if the
 *    current request can mutate high-velocity money.
 *  - rate_limit_events: forensic trail of 429s. Operationally cheap (only
 *    written when a bucket exhausts) but invaluable post-incident to spot
 *    credential-stuffing or scraping bursts that the live counters discarded.
 */
export async function initSecuritySchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mfa_enrollments (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      kind text NOT NULL,
      secret_encrypted text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending',
      backup_codes_hashed text[] NOT NULL DEFAULT ARRAY[]::text[],
      enrolled_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS mfa_enrollments_user_kind_uniq ON mfa_enrollments (user_id, kind);`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS mfa_enrollments_user_idx ON mfa_enrollments (user_id);`,
  );

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mfa_challenges (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      kind text NOT NULL,
      asserted_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS mfa_challenges_user_idx ON mfa_challenges (user_id, expires_at DESC);`,
  );

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rate_limit_events (
      id text PRIMARY KEY,
      identity text NOT NULL,
      route text NOT NULL,
      tier text NOT NULL,
      ts timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS rate_limit_events_identity_ts_idx ON rate_limit_events (identity, ts DESC);`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS rate_limit_events_route_ts_idx ON rate_limit_events (route, ts DESC);`,
  );
}
