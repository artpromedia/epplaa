/**
 * backfill-stream-owners — one-time data migration that populates
 * `streams.seller_user_id` for legacy stream rows where it is NULL.
 *
 * Why this exists:
 * `POST /streams/:id/go-live` (see routes/streamLifecycle.ts) now
 * strictly requires the row's `sellerUserId` to match the calling
 * Clerk user. Streams created before that column existed have a NULL
 * `sellerUserId` and so can no longer be brought live by their owner.
 *
 * Resolution strategy:
 * When a stream row is created today, `hostName` is snapshotted from
 * the seller's profile as `application.storeHandle ?? application.storeName ?? "seller"`
 * (see routes/streamLifecycle.ts `POST /streams`). We invert that map
 * by walking every row in `sellers` and indexing each non-empty
 * `application.storeHandle` and `application.storeName` to its
 * owning `userId`. For each NULL-owner stream we look its `hostName`
 * up in that index:
 *
 *   - exactly one matching seller → update sellerUserId
 *   - multiple matching sellers   → skip + report (ambiguous; a
 *     human has to pick the right one because two sellers share a
 *     handle/name and the script can't safely guess)
 *   - no matching seller          → skip + report (the seller may
 *     have been deleted or never finished onboarding; nothing the
 *     script can do)
 *   - hostName is the literal `"seller"` fallback or empty → skip +
 *     report (matching that to a seller named "seller" would be a
 *     false positive — that string is the placeholder used when
 *     neither storeHandle nor storeName was set)
 *
 * Re-run safety:
 * Each UPDATE re-asserts `seller_user_id IS NULL` in its WHERE
 * clause, so a stream that was already backfilled — or one that
 * raced a live `POST /streams/:id/go-live` and got a real owner
 * mid-script — will not be clobbered. Re-running the script after a
 * partial run picks up only rows that are still NULL.
 *
 * Usage:
 *
 *   pnpm --filter @workspace/api-server run backfill-stream-owners
 *
 * The script writes a single JSON summary line to stdout describing
 * what it did so an operator can paste it into the runbook entry.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import * as schema from "@workspace/db/schema";

/** Minimal projection of a sellers row used by the resolver. */
export interface SellerHandleEntry {
  userId: string;
  application: Record<string, unknown> | null;
}

/** Minimal projection of a streams row used by the resolver. */
export interface StreamHandleEntry {
  id: string;
  hostName: string;
}

/** Outcome of resolving a batch of NULL-owner streams against the
 *  seller handle index. Pure data so it is easy to assert in tests. */
export interface ResolverResult {
  /** streamId → sellerUserId for every stream we can confidently
   *  attribute to exactly one seller. */
  resolved: Map<string, string>;
  /** stream ids whose hostName matched more than one seller — the
   *  script refuses to guess and reports them so a human can look. */
  ambiguous: string[];
  /** stream ids whose hostName matched zero sellers. */
  unmatched: string[];
  /** stream ids whose hostName is the literal `"seller"` placeholder
   *  or empty — neither is a real handle and matching them would be
   *  a false positive. */
  generic: string[];
}

/** End-of-run summary written to stdout. */
export interface BackfillSummary {
  check: "backfill_stream_owners";
  /** Number of stream rows with `seller_user_id IS NULL` at the
   *  start of the run. */
  totalNullStreams: number;
  /** Stream rows successfully updated by this run. */
  updated: number;
  /** Stream rows the resolver picked but whose UPDATE matched zero
   *  rows because something raced ahead and set a non-NULL owner
   *  between the SELECT and the UPDATE (the WHERE clause guards
   *  against clobber). Should be 0 in normal runs. */
  raced: number;
  /** Stream rows skipped because their hostName matched multiple
   *  sellers (handle collision). */
  ambiguous: number;
  /** Stream rows skipped because no seller matched their hostName. */
  unmatched: number;
  /** Stream rows skipped because their hostName is the literal
   *  `"seller"` fallback or empty. */
  generic: number;
}

/**
 * Build a `handle → set of sellerUserId` index over every seller's
 * application JSON. A seller contributes to the index under both
 * their `storeHandle` and their `storeName` (when present), because
 * `streams.hostName` may have been snapshotted from either field
 * depending on which one was set when the stream was created.
 *
 * Entries are accumulated as Sets so the resolver can detect handle
 * collisions (same handle/name shared across multiple sellers).
 */
export function buildHandleIndex(
  sellers: SellerHandleEntry[],
): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const seller of sellers) {
    const app = seller.application;
    if (!app || typeof app !== "object") continue;
    const handle = String((app as Record<string, unknown>).storeHandle ?? "").trim();
    const name = String((app as Record<string, unknown>).storeName ?? "").trim();
    for (const candidate of [handle, name]) {
      if (candidate === "" || candidate === "seller") continue;
      let set = idx.get(candidate);
      if (!set) {
        set = new Set();
        idx.set(candidate, set);
      }
      set.add(seller.userId);
    }
  }
  return idx;
}

/**
 * Pure resolver: pair each NULL-owner stream with at most one seller
 * userId via its hostName. Buckets the rest (ambiguous / unmatched /
 * generic) so the surrounding CLI can report them rather than
 * silently dropping them.
 */
export function resolveStreams(
  streams: StreamHandleEntry[],
  handleIndex: Map<string, Set<string>>,
): ResolverResult {
  const resolved = new Map<string, string>();
  const ambiguous: string[] = [];
  const unmatched: string[] = [];
  const generic: string[] = [];
  for (const stream of streams) {
    const host = stream.hostName.trim();
    if (host === "" || host === "seller") {
      generic.push(stream.id);
      continue;
    }
    const matches = handleIndex.get(host);
    if (!matches || matches.size === 0) {
      unmatched.push(stream.id);
      continue;
    }
    if (matches.size > 1) {
      ambiguous.push(stream.id);
      continue;
    }
    const userId = matches.values().next().value as string;
    resolved.set(stream.id, userId);
  }
  return { resolved, ambiguous, unmatched, generic };
}

/**
 * Run the backfill end-to-end against the live database and return
 * the summary. Exported so an integration test (or a future
 * scheduled rehearsal) can drive it without going through the CLI
 * shim at the bottom of the file.
 */
export async function backfillStreamOwners(): Promise<BackfillSummary> {
  // 1. Snapshot every stream that still lacks an owner. Anything
  //    inserted concurrently with `seller_user_id` already set is
  //    correctly excluded.
  const orphanStreams = await db
    .select({
      id: schema.streamsTable.id,
      hostName: schema.streamsTable.hostName,
    })
    .from(schema.streamsTable)
    .where(isNull(schema.streamsTable.sellerUserId));

  // 2. Build the handle → userId index from sellers.application.
  const sellers = await db
    .select({
      userId: schema.sellersTable.userId,
      application: schema.sellersTable.application,
    })
    .from(schema.sellersTable);
  const index = buildHandleIndex(
    sellers.map((s) => ({
      userId: s.userId,
      application: (s.application ?? null) as Record<string, unknown> | null,
    })),
  );

  // 3. Pair each orphan with its (single, unambiguous) owner.
  const { resolved, ambiguous, unmatched, generic } = resolveStreams(
    orphanStreams,
    index,
  );

  // 4. Apply the updates. The `IS NULL` guard in WHERE makes this
  //    idempotent across re-runs and safe against a concurrent
  //    /streams/:id/go-live that racing-races a real owner onto the
  //    same row.
  let updated = 0;
  let raced = 0;
  for (const [streamId, userId] of resolved) {
    const result = await db
      .update(schema.streamsTable)
      .set({ sellerUserId: userId })
      .where(
        and(
          eq(schema.streamsTable.id, streamId),
          isNull(schema.streamsTable.sellerUserId),
        ),
      )
      .returning({ id: schema.streamsTable.id });
    if (result.length === 1) {
      updated += 1;
    } else {
      raced += 1;
    }
  }

  return {
    check: "backfill_stream_owners",
    totalNullStreams: orphanStreams.length,
    updated,
    raced,
    ambiguous: ambiguous.length,
    unmatched: unmatched.length,
    generic: generic.length,
  };
}

/** True when this module is being executed directly (tsx/node), as
 *  opposed to being imported by a test or another script. */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const url = new URL(import.meta.url);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const summary = await backfillStreamOwners();
    process.stdout.write(JSON.stringify(summary) + "\n");
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        check: "backfill_stream_owners",
        outcome: "error",
        error: (err as Error).message,
      }) + "\n",
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }
  await pool.end();
}
