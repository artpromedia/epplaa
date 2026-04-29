import type { Request, Response, NextFunction, RequestHandler } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { logger } from "./logger";
import { getUserId, hasMfaVerifiedSession } from "./auth";
import { newRoleId } from "./ids";

/**
 * Canonical role names. Backend is the source of truth — frontend only
 * displays these labels; never trust client-claimed roles.
 */
export const ROLE_NAMES = ["admin", "moderator", "finance_ops", "support"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

const ROLE_DEFAULTS: Array<{ name: RoleName; description: string }> = [
  { name: "admin", description: "Full operator privileges including role grants and takedowns" },
  { name: "moderator", description: "Trust & Safety case queue, takedowns, content actions" },
  { name: "finance_ops", description: "Payout queue: hold, release, clawback" },
  { name: "support", description: "Read-only access to disputes, cases, and audit history" },
];

/**
 * Boot-time bootstrap: creates the new admin tables (additive only — every
 * PK is `text` to match the rest of the project), seeds the default role
 * rows, and grants `admin` to anyone listed in `EPPLAA_ADMIN_USER_IDS`.
 *
 * Mirrors the `initAuditChain` pattern used by `lib/audit.ts`: a single
 * idempotent boot call that uses raw `CREATE TABLE IF NOT EXISTS` /
 * `ADD COLUMN IF NOT EXISTS` instead of going through `drizzle-kit push`.
 * `drizzle-kit push --force` is unsafe in this codebase because every PK is
 * a `text` app-generated ID — a force push would attempt to convert PK types.
 */
export async function initAdminSchema(): Promise<void> {
  // --- New tables (additive only, all `text` PKs) ---
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roles (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id text NOT NULL,
      role_id text NOT NULL,
      granted_by text,
      granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_id)
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_roles_user_idx ON user_roles (user_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS moderation_cases (
      id text PRIMARY KEY,
      kind text NOT NULL,
      target_kind text NOT NULL,
      target_id text NOT NULL,
      severity text NOT NULL DEFAULT 'normal',
      state text NOT NULL DEFAULT 'open',
      assigned_to text,
      sla_due_at timestamptz,
      decision text,
      decision_reason text NOT NULL DEFAULT '',
      decided_at timestamptz,
      decided_by text,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_user_id text,
      source_report_id text,
      takedown_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS moderation_cases_state_idx ON moderation_cases (state);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS moderation_cases_kind_idx ON moderation_cases (kind);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS moderation_cases_assignee_idx ON moderation_cases (assigned_to);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS moderation_cases_target_idx ON moderation_cases (target_kind, target_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS moderation_scans (
      id text PRIMARY KEY,
      target_kind text NOT NULL,
      target_id text NOT NULL,
      provider text NOT NULL,
      decision text NOT NULL,
      scores jsonb NOT NULL DEFAULT '{}'::jsonb,
      csam_match boolean NOT NULL DEFAULT false,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      scanned_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS moderation_scans_target_idx ON moderation_scans (target_kind, target_id);`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS moderation_scans_scanned_at_idx ON moderation_scans (scanned_at);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS payout_actions (
      id text PRIMARY KEY,
      payout_id text NOT NULL,
      action text NOT NULL,
      actor_user_id text NOT NULL,
      reason text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS payout_actions_payout_idx ON payout_actions (payout_id);`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS takedowns (
      id text PRIMARY KEY,
      target_kind text NOT NULL,
      target_id text NOT NULL,
      reason_code text NOT NULL,
      actor_user_id text NOT NULL,
      notified_at timestamptz,
      notes text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS takedowns_target_idx ON takedowns (target_kind, target_id);`);

  // --- Additive columns on existing tables (nullable, no defaults that
  //     would force a table rewrite). Safe to re-run.
  await db.execute(sql`ALTER TABLE safety_reports ADD COLUMN IF NOT EXISTS case_id text;`);
  await db.execute(sql`ALTER TABLE returns ADD COLUMN IF NOT EXISTS case_id text;`);

  // --- Seed default roles (idempotent) ---
  for (const r of ROLE_DEFAULTS) {
    await db
      .insert(schema.rolesTable)
      .values({ id: newRoleId(), name: r.name, description: r.description })
      .onConflictDoNothing({ target: schema.rolesTable.name });
  }

  // --- Bootstrap admin grants from env (`EPPLAA_ADMIN_USER_IDS`,
  //     comma-separated Clerk user ids) ---
  const adminIds = String(process.env.EPPLAA_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (adminIds.length > 0) {
    const [adminRole] = await db
      .select({ id: schema.rolesTable.id })
      .from(schema.rolesTable)
      .where(eq(schema.rolesTable.name, "admin"))
      .limit(1);
    if (adminRole) {
      for (const userId of adminIds) {
        await db
          .insert(schema.userRolesTable)
          .values({ userId, roleId: adminRole.id, grantedBy: "boot:env" })
          .onConflictDoNothing();
      }
      logger.info({ count: adminIds.length }, "admin_bootstrap_granted");
    }
  }
}

/**
 * Returns the unique role names granted to `userId`. Empty array when no
 * grants exist (or when the user does not exist).
 */
export async function listRolesForUser(userId: string): Promise<RoleName[]> {
  if (!userId) return [];
  const rows = await db
    .select({ name: schema.rolesTable.name })
    .from(schema.userRolesTable)
    .innerJoin(schema.rolesTable, eq(schema.rolesTable.id, schema.userRolesTable.roleId))
    .where(eq(schema.userRolesTable.userId, userId));
  return rows.map((r) => r.name as RoleName).filter((n) => (ROLE_NAMES as readonly string[]).includes(n));
}

export async function userHasAnyRole(userId: string, allowed: readonly RoleName[]): Promise<boolean> {
  const roles = await listRolesForUser(userId);
  if (roles.includes("admin")) return true; // admin implies all
  return roles.some((r) => allowed.includes(r));
}

/**
 * `requireRole(['admin','moderator'])`: 401 unauthed, 403 forbidden,
 * else 403 mfa_required if the Clerk session is not MFA-verified.
 * `admin` implicitly satisfies every gate. The MFA check uses Clerk's
 * `fva` claim (see `hasMfaVerifiedSession`) — distinct from the
 * recency-bound `requireMfa()` layered on money mutations.
 */
export function requireRole(allowed: readonly RoleName[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "unauthorized", detail: "Sign-in required" });
      return;
    }
    try {
      const ok = await userHasAnyRole(userId, allowed);
      if (!ok) {
        res.status(403).json({ error: "forbidden", detail: "operator_role_required" });
        return;
      }
      // Run the MFA check after the role check so non-operators get
      // the (more accurate) forbidden response.
      if (!hasMfaVerifiedSession(req)) {
        res.status(403).json({
          error: "mfa_required",
          detail:
            "Operators must verify a second factor (TOTP, passkey, " +
            "WebAuthn, or backup code) for the current session before " +
            "acting on cases, payouts, or role grants.",
          enrollUrl: "/admin/security",
        });
        return;
      }
      next();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "require_role_failed");
      res.status(500).json({ error: "internal_error" });
    }
  };
}

export async function grantRole(userId: string, roleName: RoleName, grantedBy: string): Promise<boolean> {
  const [role] = await db
    .select({ id: schema.rolesTable.id })
    .from(schema.rolesTable)
    .where(eq(schema.rolesTable.name, roleName))
    .limit(1);
  if (!role) return false;
  await db
    .insert(schema.userRolesTable)
    .values({ userId, roleId: role.id, grantedBy })
    .onConflictDoNothing();
  return true;
}

export async function revokeRole(userId: string, roleName: RoleName): Promise<boolean> {
  const [role] = await db
    .select({ id: schema.rolesTable.id })
    .from(schema.rolesTable)
    .where(eq(schema.rolesTable.name, roleName))
    .limit(1);
  if (!role) return false;
  await db
    .delete(schema.userRolesTable)
    .where(
      and(
        eq(schema.userRolesTable.userId, userId),
        eq(schema.userRolesTable.roleId, role.id),
      ),
    );
  return true;
}
