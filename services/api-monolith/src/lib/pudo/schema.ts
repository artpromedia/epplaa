import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Boot-time additive schema for the PUDO daily-push delivery (task
 * #16). Mirrors the `initAuditChain` / `initManufacturerSchema`
 * pattern: idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 * statements run at boot so we never need a destructive
 * `drizzle-kit push --force`. The columns themselves are declared in
 * `lib/db/src/schema/shipments.ts` so the typed query builder picks
 * them up — this file is only the runtime migration that brings
 * existing databases in line with the schema definitions on first
 * boot after the deploy.
 */
export async function initPudoDeliverySchema(): Promise<void> {
  // pudo_partners — daily-push delivery configuration. Default
  // `delivery_method='none'` keeps backwards compatibility with
  // partners who still pull from the manifest endpoint themselves.
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS manifest_timezone text NOT NULL DEFAULT 'Africa/Lagos';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS delivery_method text NOT NULL DEFAULT 'none';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS manifest_email text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS sftp_host text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS sftp_port integer NOT NULL DEFAULT 22;`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS sftp_username text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS sftp_password_env_var text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS sftp_key_env_var text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_partners ADD COLUMN IF NOT EXISTS sftp_remote_dir text NOT NULL DEFAULT '/';`,
  );

  // pudo_manifest_runs — delivery audit fields. Existing rows back-fill
  // to ('', '', 'queued', 0, '', NULL) which matches a "we don't know"
  // state — operators only need the new columns to be reliable for
  // rows the cron writes from this point forward.
  await db.execute(
    sql`ALTER TABLE pudo_manifest_runs ADD COLUMN IF NOT EXISTS destination text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_manifest_runs ADD COLUMN IF NOT EXISTS delivery_method text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_manifest_runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'queued';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_manifest_runs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_manifest_runs ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '';`,
  );
  await db.execute(
    sql`ALTER TABLE pudo_manifest_runs ADD COLUMN IF NOT EXISTS delivered_at timestamptz;`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS pudo_manifest_runs_status_idx ON pudo_manifest_runs (status);`,
  );
}
