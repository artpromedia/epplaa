import { sql } from "drizzle-orm";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Boot-time bootstrap that locks down the remaining user-linked tables
 * with a `user_id → users.clerk_id` FK and engages PostgreSQL row-level
 * security so the database itself enforces the per-user data
 * partitioning that today only lives in WHERE clauses in app code (#226).
 *
 * Sibling of `moneyFlowFk.ts`, which already covered orders +
 * payment_intents. This module covers the long tail: cart, wishlist,
 * notifications, follows, KYC, sanctions, sellers, payouts, and so on.
 *
 * Why FK + RLS together:
 *   - FK prevents dangling user_id values (deleted users / typo'd
 *     clerk_ids) from accumulating. Same orphan-cleanup policy as
 *     `moneyFlowFk.ts` — placeholder users are inserted (NEVER deleted)
 *     to preserve the financial / audit row while making the situation
 *     visible. Privacy policy v4.1 §11.1.4 keeps payments / orders for
 *     7 years; the same logic guards every other user-linked table.
 *
 *   - RLS adds a database-layer "even if app code forgets WHERE
 *     user_id = $1" backstop. We enable RLS without FORCE so the
 *     current single-role connection (which is the table owner) is
 *     unaffected today. The policy uses `current_setting('app.current_user_id', true)`
 *     so a future per-request session-variable binding (set by the
 *     auth middleware before each request, cleared after) gets row
 *     isolation for free without rewriting every query. Until that
 *     binding lands, the policy is permissive — RLS infrastructure is
 *     in place and ready, but enforcement is opt-in. The transition
 *     story (FORCE RLS, drop the unset/empty branch of the policy)
 *     happens once auth middleware is updated to issue
 *     `SET LOCAL app.current_user_id = $1` per-request.
 *
 * The whole bootstrap runs in a single transaction so a partial failure
 * cannot leave the DB with FK constraints applied but orphan cleanup
 * skipped (or vice versa). Each step is idempotent — `ON CONFLICT DO
 * NOTHING`, `pg_constraint` lookup before `ADD CONSTRAINT`,
 * `IF NOT EXISTS` for the policy.
 *
 * Constraint names match Drizzle's auto-naming convention so a future
 * `drizzle-kit push` against a fresh DB sees the same names and treats
 * this bootstrap as a no-op.
 */

/**
 * The tables this bootstrap locks down. Each entry's `userIdColumn` is
 * the column that holds the Clerk user id (always `user_id` for these
 * tables — kept explicit for symmetry with `moneyFlowFk.ts`'s named
 * constants and so a future table that uses a different column name
 * can be added without changing the bootstrap shape).
 *
 * Tables explicitly NOT in this list:
 *   - `orders` and `payment_intents` — handled by `moneyFlowFk.ts` so
 *     their FKs are installed in tighter coordination with the
 *     `payment_intents.order_id → orders.id` cross-table FK.
 *   - `users` itself — the target of the FKs.
 *   - `pudo_partners` — keyed on `code`, not user_id.
 *   - Tables that reference `seller_user_id` / `manufacturer_user_id`
 *     instead of `user_id` (e.g. `products`). Those are ALSO Clerk ids
 *     but have separate semantics (the column name doc'ments who they
 *     belong to). They will be a follow-up.
 */
export const USER_LINKED_TABLES: ReadonlyArray<{
  table: string;
  userIdColumn: string;
}> = [
  { table: "roles", userIdColumn: "user_id" },
  { table: "cart_items", userIdColumn: "user_id" },
  { table: "checkout_drafts", userIdColumn: "user_id" },
  { table: "follows", userIdColumn: "user_id" },
  { table: "kyc_verifications", userIdColumn: "user_id" },
  { table: "manufacturers", userIdColumn: "user_id" },
  { table: "ndpr_requests", userIdColumn: "user_id" },
  { table: "notification_prefs", userIdColumn: "user_id" },
  { table: "notifications_outbox", userIdColumn: "user_id" },
  { table: "onboarding", userIdColumn: "user_id" },
  { table: "payouts", userIdColumn: "user_id" },
  { table: "recent_searches", userIdColumn: "user_id" },
  { table: "recently_viewed", userIdColumn: "user_id" },
  { table: "referrals", userIdColumn: "user_id" },
  { table: "returns", userIdColumn: "user_id" },
  { table: "reviews", userIdColumn: "user_id" },
  { table: "safety_reports", userIdColumn: "user_id" },
  { table: "sanctions_screenings", userIdColumn: "user_id" },
  { table: "seller_listings", userIdColumn: "user_id" },
  { table: "seller_orders", userIdColumn: "user_id" },
  { table: "seller_streams", userIdColumn: "user_id" },
  { table: "sellers", userIdColumn: "user_id" },
  { table: "shipments", userIdColumn: "user_id" },
  { table: "stream_chat_messages", userIdColumn: "user_id" },
  { table: "streams", userIdColumn: "user_id" },
  { table: "wallet_settings", userIdColumn: "user_id" },
  { table: "wallet_txns", userIdColumn: "user_id" },
  { table: "wishlist", userIdColumn: "user_id" },
];

/**
 * Session variable the RLS policy reads. The auth middleware sets this
 * via `SET LOCAL app.current_user_id = $1` per-request when the
 * narrowing transition lands (currently unset, which makes the
 * permissive policy match everything).
 */
export const RLS_SESSION_VAR = "app.current_user_id";

export interface UserLinkedTablesInitResult {
  placeholderUsersInserted: number;
  fkConstraintsAdded: string[];
  rlsEnabled: string[];
  policiesCreated: string[];
  /** Tables we tried to lock down but skipped because they don't exist
   *  yet — surfaced in the boot log so a deploy that's behind on schema
   *  pushes is visible without crashing. */
  tablesSkippedMissing: string[];
}

export function fkConstraintName(table: string, column: string): string {
  // Match Drizzle's `<table>_<col>_<ref_table>_<ref_col>_fk` convention
  // so a future drizzle-kit push against a fresh DB is a no-op against
  // the constraints this bootstrap installed.
  return `${table}_${column}_users_clerk_id_fk`;
}

export function rlsPolicyName(table: string): string {
  return `${table}_user_isolation`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function initUserLinkedTablesFkAndRls(): Promise<UserLinkedTablesInitResult> {
  return await db.transaction(async (tx: Tx) => {
    const result: UserLinkedTablesInitResult = {
      placeholderUsersInserted: 0,
      fkConstraintsAdded: [],
      rlsEnabled: [],
      policiesCreated: [],
      tablesSkippedMissing: [],
    };

    for (const entry of USER_LINKED_TABLES) {
      const { table, userIdColumn } = entry;

      // Skip if the table doesn't exist yet — a deploy behind on
      // schema pushes shouldn't crash boot. Drizzle-kit push at the
      // next opportunity will create the table, and the next bootstrap
      // run will install the FK + RLS. The boot log surfaces what was
      // skipped so on-call sees a missing table without a hard fail.
      const tableExists = await checkTableExists(tx, table);
      if (!tableExists) {
        result.tablesSkippedMissing.push(table);
        continue;
      }

      // Step 1: backfill placeholder users for any orphan user_id.
      // Same policy as moneyFlowFk.ts — NEVER hard-delete the orphan
      // row; insert a placeholder users row so the FK can attach
      // without losing the audit trail. ON CONFLICT DO NOTHING keeps
      // it safe against a racing real signup.
      const placeholders = await tx.execute(sql`
        INSERT INTO users (clerk_id, email, display_name)
        SELECT DISTINCT ${sql.identifier(userIdColumn)},
               'orphan-' || ${sql.identifier(userIdColumn)} || '@anonymized.invalid',
               '(orphan placeholder)'
        FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(userIdColumn)} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM users u WHERE u.clerk_id = ${sql.identifier(table)}.${sql.identifier(userIdColumn)}
          )
        ON CONFLICT (clerk_id) DO NOTHING;
      `);
      result.placeholderUsersInserted +=
        (placeholders as { rowCount?: number | null }).rowCount ?? 0;

      // Step 2: add the FK if it doesn't already exist.
      const constraint = fkConstraintName(table, userIdColumn);
      const fkExists = await tx.execute(sql`
        SELECT 1 FROM pg_constraint WHERE conname = ${constraint} LIMIT 1;
      `);
      const fkRows = (fkExists as { rows?: unknown[] }).rows ?? [];
      if (fkRows.length === 0) {
        await tx.execute(sql`
          ALTER TABLE ${sql.identifier(table)}
          ADD CONSTRAINT ${sql.identifier(constraint)}
          FOREIGN KEY (${sql.identifier(userIdColumn)}) REFERENCES users (clerk_id);
        `);
        result.fkConstraintsAdded.push(constraint);
      }

      // Step 3: enable RLS on the table (idempotent — repeated ENABLE
      // is a no-op in Postgres). We deliberately do NOT FORCE RLS yet:
      // the app's single connection role IS the table owner today, so
      // FORCEing would lock the app out without a per-request
      // current_user_id binding in place. Enabling without FORCE
      // installs the infrastructure; the FORCE transition happens
      // once the auth middleware sets the session variable.
      await tx.execute(sql`
        ALTER TABLE ${sql.identifier(table)} ENABLE ROW LEVEL SECURITY;
      `);
      result.rlsEnabled.push(table);

      // Step 4: create the user-isolation policy if missing. Permissive
      // when `app.current_user_id` is unset (or empty) so today's app
      // code keeps working unchanged; restrictive once a per-request
      // SET LOCAL binding is in place. The `, true` second arg to
      // current_setting() makes it return NULL instead of erroring
      // when the GUC has never been SET in this session.
      const policy = rlsPolicyName(table);
      const policyExists = await tx.execute(sql`
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table} AND policyname = ${policy}
        LIMIT 1;
      `);
      const polRows = (policyExists as { rows?: unknown[] }).rows ?? [];
      if (polRows.length === 0) {
        const sessionVarLiteral = sql.raw(`'${RLS_SESSION_VAR}'`);
        await tx.execute(sql`
          CREATE POLICY ${sql.identifier(policy)} ON ${sql.identifier(table)}
          USING (
            current_setting(${sessionVarLiteral}, true) IS NULL
            OR current_setting(${sessionVarLiteral}, true) = ''
            OR ${sql.identifier(userIdColumn)} = current_setting(${sessionVarLiteral}, true)
          )
          WITH CHECK (
            current_setting(${sessionVarLiteral}, true) IS NULL
            OR current_setting(${sessionVarLiteral}, true) = ''
            OR ${sql.identifier(userIdColumn)} = current_setting(${sessionVarLiteral}, true)
          );
        `);
        result.policiesCreated.push(policy);
      }
    }

    if (
      result.placeholderUsersInserted > 0 ||
      result.fkConstraintsAdded.length > 0 ||
      result.rlsEnabled.length > 0 ||
      result.policiesCreated.length > 0 ||
      result.tablesSkippedMissing.length > 0
    ) {
      logger.info(
        {
          placeholderUsersInserted: result.placeholderUsersInserted,
          fkConstraintsAdded: result.fkConstraintsAdded.length,
          rlsEnabled: result.rlsEnabled.length,
          policiesCreated: result.policiesCreated.length,
          tablesSkippedMissing: result.tablesSkippedMissing,
        },
        "user_linked_tables_fk_rls_init_applied",
      );
    } else {
      logger.info({}, "user_linked_tables_fk_rls_init_already_present");
    }

    return result;
  });
}

async function checkTableExists(tx: Tx, table: string): Promise<boolean> {
  const r = await tx.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${table}
    LIMIT 1;
  `);
  const rows = (r as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}
