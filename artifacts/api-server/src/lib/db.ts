import { db } from "@workspace/db";
import * as schema from "@workspace/db/schema";

export { db, schema };

/**
 * Heads up for raw SQL: prefer `db.select(...).from(schema.X)` whenever
 * you need typed columns. The typed query builder runs each value
 * through its column type parser, so TIMESTAMPTZ comes back as a real
 * `Date`. `db.execute(sql\`SELECT ...\`)` does NOT — the underlying pg
 * driver hands you the raw string (e.g. `"2026-04-29 02:24:19.178+00"`)
 * even when you write `db.execute<{ ts: Date }>(...)`. Calling
 * `.toISOString()` / `.getTime()` / `.toLocaleDateString()` on that row
 * blows up with `TypeError`, which is exactly the 500 the `/mfa/status`
 * route hit in production.
 *
 * If you must use raw SQL for a SELECT that touches a timestamp column,
 * type the field as `Date | string | null` and normalise it via
 * `toDateOrNull()` from `./dbTimestamps` before exposing it as a Date.
 */
