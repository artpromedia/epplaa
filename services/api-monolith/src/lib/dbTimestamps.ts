/**
 * Helpers for normalising timestamp columns returned by raw `db.execute`
 * SQL.
 *
 * Why this file exists:
 *   Drizzle's typed query builder (`db.select(...).from(...)`) runs each
 *   column value through its column type parser, so `timestamptz` arrives
 *   in JS as a real `Date`. `db.execute(sql\`SELECT ...\`)` does NOT — it
 *   returns rows shaped exactly the way the underlying `pg` driver
 *   delivers them, where TIMESTAMPTZ comes back as a string like
 *   `"2026-04-29 02:24:19.178034+00"`. Calling `.toISOString()`,
 *   `.getTime()`, `.toLocaleDateString()`, etc. on that string blows up
 *   with `TypeError: <fn>.toISOString is not a function`, which is
 *   exactly the 500 the `/mfa/status` route was hitting in production.
 *
 *   The TypeScript shape on the `db.execute<{ ... }>` generic is a hint,
 *   not a runtime guarantee — if you write `enrolled_at: Date | null`
 *   the compiler will trust you, but the value at runtime will be a
 *   string.
 *
 * Two safe options when you need a raw `db.execute` SELECT to surface a
 * timestamp:
 *
 *   1. (preferred) Use Drizzle's typed query builder so the column type
 *      parser runs and you really do get a `Date | null`.
 *   2. Type the row as `Date | string | null` and run every value
 *      through `toDateOrNull()` before formatting it.
 *
 * Always prefer option 1 for new code. Option 2 is the escape hatch for
 * queries that genuinely need raw SQL (CTEs, window functions, schema
 * features Drizzle's builder doesn't expose, etc.).
 */

/**
 * Normalize a timestamp column value from `db.execute` raw SQL into a
 * real `Date` (or `null` when the value is missing / unparseable).
 *
 * Accepts the three shapes the driver / Drizzle can hand back:
 *   - `Date`              — passes through unchanged.
 *   - ISO/Postgres string — parsed via `new Date(...)`.
 *   - `null` / `undefined` — collapsed to `null`.
 *
 * Returning `null` for unparseable inputs (rather than throwing) keeps
 * route handlers serializable — a malformed timestamp surfaces as a
 * `null` field in the JSON response instead of a 500. The caller can
 * still distinguish "column was NULL" from "column was garbage" by
 * looking at the source row if it matters; in practice every caller has
 * just been formatting the value for display.
 */
export function toDateOrNull(
  value: Date | string | null | undefined,
): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
