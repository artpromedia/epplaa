import { sql } from "drizzle-orm";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Boot-time bootstrap that turns the three money-flow FKs the schema now
 * declares (`orders.user_id` → `users.clerk_id`, `payment_intents.user_id`
 * → `users.clerk_id`, `payment_intents.order_id` → `orders.id`) into real
 * DB-level constraints, after first cleaning up any pre-existing orphan
 * rows so the `ALTER TABLE … ADD CONSTRAINT` statements don't reject.
 *
 * Why this lives here and not in `drizzle-kit push`:
 *  - This repo intentionally does not run `drizzle-kit push --force`
 *    against production — every other schema addition follows the
 *    `initAuditChain` / `initSecuritySchema` / `initRetentionSchema`
 *    pattern of idempotent additive SQL at boot. Adding FKs the same way
 *    keeps the deploy story uniform and avoids the destructive ALTERs a
 *    push could synthesise on existing PKs.
 *  - The constraints have to be added together with the orphan cleanup
 *    in a single transaction. If we pushed the constraint first and ran
 *    cleanup later, the push would fail on any orphan row and roll back,
 *    leaving the system in the same "weekly verifier catches it" state
 *    this task is supposed to remove.
 *
 * Cleanup policy (matches `scripts/src/verifyBackup.ts -> checkFkIntegrity`,
 * which keeps running as defence in depth — the Drizzle-declared FK is the
 * write-time guard, the verifier still catches "someone DROP CONSTRAINTed
 * the FK out of band"):
 *
 *   1. `payment_intents.order_id` orphans: SET NULL. The column is
 *      nullable on purpose (wallet top-ups carry NULL legitimately), so
 *      detaching an orphan intent from its missing order preserves the
 *      ledger row without losing the audit trail. The intent's `purpose`
 *      column still records what kind of money-movement it was.
 *
 *   2. `orders.user_id` and `payment_intents.user_id` orphans: insert a
 *      placeholder `users` row keyed on the orphan id, then attach. Users
 *      are anonymised-in-place by NDPR `applyErase` and NEVER hard-
 *      deleted in production, so an orphan user_id strictly represents
 *      data corruption or stray test data. We absolutely must NOT delete
 *      the orders / intents themselves — Epplaa's privacy policy v4.1
 *      §11.1.4 requires payments / payouts / orders be retained for 7
 *      years for FIRS audits. A placeholder user (email
 *      `orphan-<id>@anonymized.invalid`, displayName `(orphan
 *      placeholder)`) keeps the financial record intact and joinable
 *      while making the situation visible to anyone querying the users
 *      table. The placeholder insert is `ON CONFLICT DO NOTHING` so a
 *      racing real signup (extremely unlikely given clerk_id is opaque)
 *      doesn't blow up the bootstrap.
 *
 * The whole thing runs in a single transaction so a partial failure
 * cannot leave the DB with cleanup applied but constraints missing (or
 * vice versa). Calling the function repeatedly is safe — each step is
 * either idempotent (`ON CONFLICT DO NOTHING`, `pg_constraint` lookup
 * before `ADD CONSTRAINT`) or operates on a strictly narrower set of
 * orphan rows than the previous call.
 *
 * Constraint names match Drizzle's own naming convention
 * (`<table>_<col>_<ref_table>_<ref_col>_fk`) so a future operator running
 * `drizzle-kit push` against a fresh DB sees the same constraint name
 * Drizzle would have generated and treats this bootstrap as a no-op.
 */
export const ORDERS_USER_FK = "orders_user_id_users_clerk_id_fk";
export const INTENTS_ORDER_FK = "payment_intents_order_id_orders_id_fk";
export const INTENTS_USER_FK = "payment_intents_user_id_users_clerk_id_fk";

export interface MoneyFlowFkInitResult {
  detachedIntentOrderIds: number;
  placeholderUsersInserted: number;
  constraintsAdded: string[];
}

export async function initMoneyFlowFkConstraints(): Promise<MoneyFlowFkInitResult> {
  return await db.transaction(async (tx) => {
    // Step 1: detach orphan payment_intents.order_id -> orders.id by
    // setting them to NULL. Counts the affected rows so the boot log
    // can flag a non-zero number (which should never happen in steady
    // state and is a real signal worth investigating).
    const detachResult = await tx.execute(sql`
      UPDATE payment_intents
      SET order_id = NULL
      WHERE order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = payment_intents.order_id);
    `);
    const detachedIntentOrderIds =
      (detachResult as { rowCount?: number | null }).rowCount ?? 0;

    // Step 2: backfill placeholder users for any orphan user_id referenced
    // by orders OR payment_intents. The UNION + DISTINCT keeps a single
    // placeholder row for an id that's orphaned in both tables; the NOT
    // EXISTS guard skips ids that already exist (e.g. a real user that
    // was just inserted by a racing request). ON CONFLICT DO NOTHING is
    // belt-and-braces for the same race.
    //
    // We only touch the strictly-required NOT NULL columns on `users`:
    // `email` (NOT NULL no default) we synthesise from the clerk id;
    // every other NOT NULL column either has a default (`country_code`
    // defaults to `NG`, `display_name` to "", `addresses` / `payment_methods`
    // to `[]`, the timestamps default to `now()`) or is nullable.
    // Touching extra columns would silently break if the users schema
    // adds a new NOT NULL column without a default in the future — the
    // INSERT here would fail and the boot would page on it, which is a
    // safer failure mode than silently bypassing the new column.
    const placeholderResult = await tx.execute(sql`
      INSERT INTO users (clerk_id, email, display_name)
      SELECT DISTINCT orphan_id,
             'orphan-' || orphan_id || '@anonymized.invalid',
             '(orphan placeholder)'
      FROM (
        SELECT user_id AS orphan_id FROM orders
        UNION
        SELECT user_id AS orphan_id FROM payment_intents
      ) AS o
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.clerk_id = o.orphan_id)
      ON CONFLICT (clerk_id) DO NOTHING;
    `);
    const placeholderUsersInserted =
      (placeholderResult as { rowCount?: number | null }).rowCount ?? 0;

    // Step 3: add the three FKs idempotently. Postgres has no
    // `ADD CONSTRAINT IF NOT EXISTS`, so we look up `pg_constraint` and
    // skip the ADD when it's already present. Constraint names match
    // Drizzle's auto-naming so a future `drizzle-kit push` is a no-op.
    const constraintsAdded: string[] = [];

    const orderUserFkAdded = await addFkIfMissing(
      tx,
      ORDERS_USER_FK,
      sql`
        ALTER TABLE orders
        ADD CONSTRAINT ${sql.identifier(ORDERS_USER_FK)}
        FOREIGN KEY (user_id) REFERENCES users (clerk_id);
      `,
    );
    if (orderUserFkAdded) constraintsAdded.push(ORDERS_USER_FK);

    const intentOrderFkAdded = await addFkIfMissing(
      tx,
      INTENTS_ORDER_FK,
      sql`
        ALTER TABLE payment_intents
        ADD CONSTRAINT ${sql.identifier(INTENTS_ORDER_FK)}
        FOREIGN KEY (order_id) REFERENCES orders (id);
      `,
    );
    if (intentOrderFkAdded) constraintsAdded.push(INTENTS_ORDER_FK);

    const intentUserFkAdded = await addFkIfMissing(
      tx,
      INTENTS_USER_FK,
      sql`
        ALTER TABLE payment_intents
        ADD CONSTRAINT ${sql.identifier(INTENTS_USER_FK)}
        FOREIGN KEY (user_id) REFERENCES users (clerk_id);
      `,
    );
    if (intentUserFkAdded) constraintsAdded.push(INTENTS_USER_FK);

    if (
      detachedIntentOrderIds > 0 ||
      placeholderUsersInserted > 0 ||
      constraintsAdded.length > 0
    ) {
      logger.info(
        {
          detachedIntentOrderIds,
          placeholderUsersInserted,
          constraintsAdded,
        },
        "money_flow_fk_init_applied",
      );
    } else {
      logger.info({}, "money_flow_fk_init_already_present");
    }

    return {
      detachedIntentOrderIds,
      placeholderUsersInserted,
      constraintsAdded,
    };
  });
}

/**
 * Idempotent FK install helper. Returns true if the constraint was added
 * by this call, false if it already existed. Centralised so all three
 * FK installs share the exact same pg_constraint guard.
 */
async function addFkIfMissing(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  constraintName: string,
  addSql: ReturnType<typeof sql>,
): Promise<boolean> {
  const exists = await tx.execute(sql`
    SELECT 1 FROM pg_constraint WHERE conname = ${constraintName} LIMIT 1;
  `);
  const rows = (exists as { rows?: unknown[] }).rows ?? [];
  if (rows.length > 0) return false;
  await tx.execute(addSql);
  return true;
}
