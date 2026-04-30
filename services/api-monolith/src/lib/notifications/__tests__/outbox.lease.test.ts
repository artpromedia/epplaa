import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

/**
 * Exactly-once delivery contract for the notifications outbox.
 *
 * The outbox is the authoritative reliability layer — every business
 * notification (order updates, MFA emails, OTPs, ...) is written here
 * first and then drained by `drainOutbox` which (a) atomically claims
 * a bounded batch of due rows, (b) invokes the channel adapter, and
 * (c) marks the row delivered/failed. The two correctness invariants
 * we cannot allow to regress are:
 *
 *   1. A row whose previous worker died mid-send (status='processing'
 *      past PROCESSING_LEASE_MS) gets reclaimed and delivered EXACTLY
 *      ONCE by a subsequent drain.
 *
 *   2. Two concurrent drains never both claim the same row, so a busy
 *      multi-instance deployment cannot double-send notifications.
 *
 * These tests exercise both invariants against a real Postgres so the
 * atomic SELECT-then-UPDATE-WHERE-status='pending' claim is verified
 * against actual MVCC semantics, not an in-memory fake. They install
 * a counting sink via `__setOutboxChannelResolverForTests` so we can
 * assert per-row send invocations: any double-send manifests as a row
 * id with count >= 2 and the assertion message names the offending id.
 *
 * Skips when DATABASE_URL is unset so local boxes without Postgres
 * can still run the rest of the suite.
 */

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

const TEST_PREFIX = "test_outbox_lease_";
// Antedate test rows so they always sort to the front of the FIFO
// (`ORDER BY next_attempt_at asc, created_at asc, id asc`) regardless
// of whatever leftover pending/processing rows other suites may have
// left in the shared dev Postgres. Without this, leftover rows could
// crowd the CLAIM_BATCH_SIZE=50 window and keep the test rows out of
// the first drain.
const ANTEDATE = new Date("2000-01-01T00:00:00Z");

d("notifications outbox — exactly-once under retries", () => {
  type Db = typeof import("../../db")["db"];
  type Schema = typeof import("../../db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Eq = typeof import("drizzle-orm")["eq"];
  type InArray = typeof import("drizzle-orm")["inArray"];
  type Outbox = typeof import("../outbox");
  type ChannelKind = import("../types").ChannelKind;
  type NotificationChannel = import("../types").NotificationChannel;
  type NotificationMessage = import("../types").NotificationMessage;
  type SendResult = import("../types").SendResult;

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let eq: Eq;
  let inArray: InArray;
  let outbox: Outbox;

  function makeRowId(): string {
    return `${TEST_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  }

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM notifications_outbox WHERE id LIKE ${TEST_PREFIX + "%"};`,
    );
  }

  /**
   * Insert a single outbox row directly so the test can pre-stage
   * `processing` rows past their lease (something `enqueueNotification`
   * cannot do — it always inserts as `pending`).
   */
  async function insertRow(args: {
    id?: string;
    status?: "pending" | "processing" | "delivered" | "failed";
    attempts?: number;
    nextAttemptAt?: Date;
    channel?: ChannelKind;
  }): Promise<string> {
    const id = args.id ?? makeRowId();
    await db.insert(schema.notificationsOutboxTable).values({
      id,
      userId: id, // namespace the user too so concurrent tests don't collide
      eventType: "promo",
      channel: args.channel ?? "sms",
      // The drain reads `payload._to` as the recipient and passes it
      // to the adapter as `msg.to`. We tag every row with its own id
      // there so the counting sink can attribute each send invocation
      // back to a specific outbox row.
      payload: { _to: id, title: "lease test", body: "b" },
      status: args.status ?? "pending",
      attempts: args.attempts ?? 0,
      nextAttemptAt: args.nextAttemptAt ?? ANTEDATE,
    });
    return id;
  }

  /**
   * Build a counting sink. Returns the adapter and a `counts` map
   * keyed by `msg.to` (== row id) so the test can assert exactly-once.
   *
   * The sink is scoped to TEST_PREFIX: leftover rows from sibling
   * suites still get processed (returning ok so they're marked
   * delivered and don't loop forever) but do NOT contribute to the
   * per-row counts, so the exactly-once assertion only ever measures
   * THIS test's rows.
   *
   * `delayMsForRow` lets the caller make individual sends slow without
   * touching real timers, which is essential for the concurrent-drain
   * test where we need to widen the race window between the two
   * SELECT-then-UPDATE pairs.
   */
  function buildSink(opts: {
    delayMsForRow?: (rowId: string) => number;
  } = {}): {
    adapter: NotificationChannel;
    counts: Map<string, number>;
    invocations: string[];
  } {
    const counts = new Map<string, number>();
    const invocations: string[] = [];
    const adapter: NotificationChannel = {
      kind: "sms",
      isConfigured: () => true,
      send: async (msg: NotificationMessage): Promise<SendResult> => {
        const to = msg.to;
        if (to.startsWith(TEST_PREFIX)) {
          invocations.push(to);
          counts.set(to, (counts.get(to) ?? 0) + 1);
          const delay = opts.delayMsForRow?.(to) ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
        return { ok: true, providerMessageId: `pm_${counts.size}` };
      },
    };
    return { adapter, counts, invocations };
  }

  function assertExactlyOnce(counts: Map<string, number>, expectedIds: string[]): void {
    const dupes = [...counts.entries()].filter(([, n]) => n > 1);
    if (dupes.length > 0) {
      const detail = dupes.map(([id, n]) => `${id} sent ${n}x`).join(", ");
      throw new Error(`double-send detected: ${detail}`);
    }
    const missing = expectedIds.filter((id) => (counts.get(id) ?? 0) === 0);
    if (missing.length > 0) {
      throw new Error(`rows never sent: ${missing.join(", ")}`);
    }
    // Belt-and-braces: the total invocation count for our owned rows
    // must equal the expected row count exactly.
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(expectedIds.length);
  }

  async function expectAllDelivered(ids: string[]): Promise<void> {
    const rows = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(inArray(schema.notificationsOutboxTable.id, ids));
    expect(rows).toHaveLength(ids.length);
    const undelivered = rows.filter((r) => r.status !== "delivered");
    if (undelivered.length > 0) {
      throw new Error(
        `rows not marked delivered: ${undelivered
          .map((r) => `${r.id}=${r.status}`)
          .join(", ")}`,
      );
    }
    for (const r of rows) expect(r.deliveredAt).toBeTruthy();
  }

  /**
   * Run drains until every test-owned row reaches a terminal state
   * (delivered or failed). Needed because leftover non-test rows in
   * the shared dev DB can crowd a single drain's CLAIM_BATCH_SIZE
   * window — a couple of follow-up drains soak up the rest of our
   * batch without affecting the per-row exactly-once invariant.
   *
   * Caps iterations so a regression that prevents progress (e.g.
   * rows wedged in `processing`) fails fast with a clear message.
   */
  async function drainUntilSettled(ids: string[], maxRounds = 5): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      const rows = await db
        .select({
          id: schema.notificationsOutboxTable.id,
          status: schema.notificationsOutboxTable.status,
        })
        .from(schema.notificationsOutboxTable)
        .where(inArray(schema.notificationsOutboxTable.id, ids));
      const stillOpen = rows.filter(
        (r) => r.status !== "delivered" && r.status !== "failed",
      );
      if (stillOpen.length === 0) return;
      await outbox.drainOutbox();
    }
    throw new Error(
      `drainUntilSettled gave up after ${maxRounds} rounds — rows remain non-terminal`,
    );
  }

  beforeAll(async () => {
    ({ db, schema } = await import("../../db"));
    ({ sql, eq, inArray } = await import("drizzle-orm"));
    outbox = await import("../outbox");
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    outbox.__setOutboxChannelResolverForTests(null);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("pins the production lease + batch constants the suite was designed against", () => {
    // If the production constants change, the assumptions baked into
    // these tests (lease > test runtime, batch >= 50) need to be
    // re-validated. Failing loudly here is far better than the suite
    // silently passing against a configuration it no longer covers.
    expect(outbox.__OUTBOX_PROCESSING_LEASE_MS).toBe(15 * 60_000);
    expect(outbox.__OUTBOX_CLAIM_BATCH_SIZE).toBe(50);
  });

  it("(a) recovers a row whose send took longer than the lease and delivers it exactly once", async () => {
    // Simulates the canonical "worker crashed mid-send" failure mode:
    // a row was claimed by some prior drain (status='processing'),
    // PROCESSING_LEASE_MS+ has elapsed since the claim, and the worker
    // never came back to mark it delivered. A fresh drain MUST recover
    // the row to `pending`, reclaim it, send, and mark delivered —
    // with EXACTLY ONE invocation of the channel adapter (the prior
    // worker's in-flight send is presumed lost, not duplicated).
    const orphanedId = await insertRow({
      status: "processing",
      attempts: 1,
      // ANTEDATE is decades past the 15-min lease cutoff.
      nextAttemptAt: ANTEDATE,
    });

    const { adapter, counts } = buildSink();
    outbox.__setOutboxChannelResolverForTests(() => adapter);

    await drainUntilSettled([orphanedId]);

    assertExactlyOnce(counts, [orphanedId]);
    await expectAllDelivered([orphanedId]);

    const [row] = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(eq(schema.notificationsOutboxTable.id, orphanedId))
      .limit(1);
    // attempts went from 1 -> 2 because the claim step bumps it.
    expect(row?.attempts).toBe(2);
  }, 30_000);

  it("(b) handles a full CLAIM_BATCH_SIZE batch with mixed slow/fast sends and delivers every row exactly once", async () => {
    // CLAIM_BATCH_SIZE = 50. We insert exactly that many rows, then
    // give every other row a small artificial delay so the batch is
    // truly mixed: the drain must process the slow rows without
    // re-claiming (or skipping) the fast ones, and a tail row must
    // not be double-sent because it sat in `processing` while the
    // earlier slow rows were still awaiting their send promise.
    const ids: string[] = [];
    for (let i = 0; i < outbox.__OUTBOX_CLAIM_BATCH_SIZE; i++) {
      ids.push(await insertRow({}));
    }

    const { adapter, counts, invocations } = buildSink({
      // ~10ms on every 5th row — small enough to keep the suite quick,
      // large enough to interleave with the rest of the loop.
      delayMsForRow: (to) => (ids.indexOf(to) % 5 === 0 ? 10 : 0),
    });
    outbox.__setOutboxChannelResolverForTests(() => adapter);

    await drainUntilSettled(ids);

    assertExactlyOnce(counts, ids);
    expect(invocations).toHaveLength(ids.length);
    await expectAllDelivered(ids);
  }, 60_000);

  it("(c) two concurrent drains never both claim the same row — every row sent exactly once", async () => {
    // The atomic claim is `UPDATE ... SET status='processing' WHERE
    // status='pending' AND id IN (...)` filtered by the row IDs the
    // SELECT just returned. With Postgres MVCC + row-level locks the
    // losing UPDATE sees the new status and skips the row — so two
    // concurrent drainers must between them invoke the sink exactly N
    // times for N pending rows, regardless of how their SELECT/UPDATE
    // pairs interleave.
    //
    // We pre-stage CLAIM_BATCH_SIZE rows so each drain has a full
    // batch to fight over, and we add a small per-send delay so the
    // two drains' SELECT phases overlap before either UPDATE phase
    // commits — that's the race window we care about.
    const N = outbox.__OUTBOX_CLAIM_BATCH_SIZE;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(await insertRow({}));

    const { adapter, counts, invocations } = buildSink({
      delayMsForRow: () => 5,
    });
    outbox.__setOutboxChannelResolverForTests(() => adapter);

    // Fire both drains as concurrently as Promise.all will let us so
    // their SELECT phases overlap before either UPDATE commits. Then
    // settle any tail rows leftover-row crowding may have pushed out
    // of the first batch — neither follow-up drain can resurrect a
    // double-send because the per-row count assertion runs after.
    await Promise.all([outbox.drainOutbox(), outbox.drainOutbox()]);
    await drainUntilSettled(ids);

    // The dispositive assertion: per-row send count is exactly one.
    // A regression that lets two drains both flip the same row to
    // `processing` would surface here as a duplicated row id, and
    // assertExactlyOnce names the offending id in its error message.
    assertExactlyOnce(counts, ids);
    expect(invocations).toHaveLength(N);
    await expectAllDelivered(ids);

    const rows = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(inArray(schema.notificationsOutboxTable.id, ids));
    for (const r of rows) {
      // attempts is bumped exactly once per row since only one drain
      // can flip pending -> processing; the other's UPDATE is a no-op
      // for that row.
      expect(r.attempts).toBe(1);
    }
  }, 60_000);
});

/**
 * Email suppression contract for the outbox (task #141).
 *
 * Co-located with the lease tests because both suites need real DB +
 * the `__setOutboxChannelResolverForTests` seam, and Vitest pools
 * give each test FILE its own worker — keeping these in the same
 * file means they cannot race against the lease tests for shared DB
 * rows (a separate file's drain in another worker would otherwise
 * happily claim and ConsoleChannel-deliver our staged email rows).
 *
 * Three behaviours we cannot allow to regress:
 *
 *   1. Pre-suppressed addresses short-circuit at drain time — the
 *      provider adapter is not called and the row is marked
 *      `delivered` with `last_error = 'suppressed'`.
 *
 *   2. Postmark `406` ("inactive recipient") suppresses the address
 *      AND marks the offending row `delivered/suppressed` so we stop
 *      pummelling a known-bad recipient.
 *
 *   3. SendGrid `5xx` is treated identically as a hard bounce.
 *
 * Skips when DATABASE_URL is unset, matching the lease suite above.
 */
const SUPP_TEST_PREFIX = "test_outbox_supp_";

d("notifications outbox — email suppression", () => {
  type Db = typeof import("../../db")["db"];
  type Schema = typeof import("../../db")["schema"];
  type Sql = typeof import("drizzle-orm")["sql"];
  type Eq = typeof import("drizzle-orm")["eq"];
  type Outbox = typeof import("../outbox");
  type Suppressions = typeof import("../suppressions");
  type ChannelKind = import("../types").ChannelKind;
  type NotificationChannel = import("../types").NotificationChannel;
  type NotificationMessage = import("../types").NotificationMessage;
  type SendResult = import("../types").SendResult;

  let db: Db;
  let schema: Schema;
  let sql: Sql;
  let eq: Eq;
  let outbox: Outbox;
  let supp: Suppressions;
  let registryChannels: typeof import("../registry")["channels"];

  async function cleanup(): Promise<void> {
    await db.execute(
      sql`DELETE FROM notifications_outbox WHERE id LIKE ${SUPP_TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM notification_suppressions WHERE email LIKE ${SUPP_TEST_PREFIX + "%"};`,
    );
    await db.execute(
      sql`DELETE FROM users WHERE clerk_id LIKE ${SUPP_TEST_PREFIX + "%"};`,
    );
  }

  /**
   * Insert a `users` row + a pending email outbox row keyed on the
   * same id so the drain's `users.email` lookup resolves to the email
   * we want to send to. `_to: '*'` is the marker the email branch
   * uses to trigger that lookup at drain time. Antedated so the row
   * sorts to the front of the FIFO and gets claimed in the first
   * batch.
   */
  async function stageEmailRow(opts: { email: string }): Promise<{
    rowId: string;
    userId: string;
    email: string;
  }> {
    const rowId = `${SUPP_TEST_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
    const userId = `${SUPP_TEST_PREFIX}u_${crypto.randomBytes(6).toString("hex")}`;
    await db.insert(schema.usersTable).values({ clerkId: userId, email: opts.email });
    await db.insert(schema.notificationsOutboxTable).values({
      id: rowId,
      userId,
      eventType: "promo",
      channel: "email",
      payload: { _to: "*", title: "hi", body: "b" },
      status: "pending",
      attempts: 0,
      nextAttemptAt: ANTEDATE,
    });
    return { rowId, userId, email: opts.email };
  }

  /**
   * Build an email-channel adapter the test fully controls. Records
   * every call so we can assert "provider was/was not invoked" — the
   * central guarantee of the suppression short-circuit.
   */
  function buildEmailChannel(opts: {
    response?: SendResult;
  } = {}): { adapter: NotificationChannel; calls: NotificationMessage[] } {
    const calls: NotificationMessage[] = [];
    const adapter: NotificationChannel = {
      kind: "email",
      isConfigured: () => true,
      send: async (msg: NotificationMessage): Promise<SendResult> => {
        calls.push(msg);
        return opts.response ?? { ok: true, providerMessageId: "pm_test", provider: "postmark" };
      },
    };
    return { adapter, calls };
  }

  /**
   * Resolver returning the supplied email adapter ONLY for the email
   * channel; other channels fall through to the real registry so an
   * unrelated SMS/push row caught by the same drain doesn't crash.
   */
  function emailOnlyResolver(
    emailAdapter: NotificationChannel,
  ): import("../outbox").OutboxTestChannelResolver {
    return (kind: ChannelKind, pushKind?: "fcm" | "web") => {
      if (kind === "email") return emailAdapter;
      return registryChannels.for(kind, pushKind);
    };
  }

  beforeAll(async () => {
    ({ db, schema } = await import("../../db"));
    ({ sql, eq } = await import("drizzle-orm"));
    outbox = await import("../outbox");
    supp = await import("../suppressions");
    ({ channels: registryChannels } = await import("../registry"));
    await cleanup();
  }, 30_000);

  afterEach(async () => {
    outbox.__setOutboxChannelResolverForTests(null);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("(d) skips a pre-suppressed address: provider not called, row marked delivered/suppressed", async () => {
    const email = `${SUPP_TEST_PREFIX}sup_${crypto.randomBytes(4).toString("hex")}@example.com`;
    await supp.suppressEmail({ email, reason: "account_deleted", source: "ndpr" });
    const { rowId } = await stageEmailRow({ email });

    const { adapter, calls } = buildEmailChannel();
    outbox.__setOutboxChannelResolverForTests(emailOnlyResolver(adapter));

    await outbox.drainOutbox();

    expect(calls.filter((c) => c.to === email)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(eq(schema.notificationsOutboxTable.id, rowId));
    expect(row?.status).toBe("delivered");
    expect(row?.lastError).toBe("suppressed");
    expect(row?.deliveredAt).toBeTruthy();
  }, 30_000);

  it("(e) Postmark 406 response suppresses the address and marks the row delivered/suppressed", async () => {
    const email = `${SUPP_TEST_PREFIX}pm406_${crypto.randomBytes(4).toString("hex")}@example.com`;
    const { rowId } = await stageEmailRow({ email });

    const { adapter } = buildEmailChannel({
      response: {
        ok: false,
        errorCode: "406",
        errorMessage: "Inactive recipient",
        provider: "postmark",
      },
    });
    outbox.__setOutboxChannelResolverForTests(emailOnlyResolver(adapter));

    await outbox.drainOutbox();

    expect(await supp.isEmailSuppressed(email)).toBe(true);
    const [supRow] = await db
      .select()
      .from(schema.notificationSuppressionsTable)
      .where(eq(schema.notificationSuppressionsTable.email, email.toLowerCase()));
    expect(supRow?.reason).toBe("inactive_recipient");
    expect(supRow?.source).toBe("postmark");

    const [row] = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(eq(schema.notificationsOutboxTable.id, rowId));
    expect(row?.status).toBe("delivered");
    expect(row?.lastError).toBe("suppressed");
  }, 30_000);

  it("(f) SendGrid 5xx response suppresses the address as a hard bounce", async () => {
    const email = `${SUPP_TEST_PREFIX}sg5xx_${crypto.randomBytes(4).toString("hex")}@example.com`;
    const { rowId } = await stageEmailRow({ email });

    const { adapter } = buildEmailChannel({
      response: {
        ok: false,
        errorCode: "503",
        errorMessage: "service unavailable",
        provider: "sendgrid",
      },
    });
    outbox.__setOutboxChannelResolverForTests(emailOnlyResolver(adapter));

    await outbox.drainOutbox();

    const [supRow] = await db
      .select()
      .from(schema.notificationSuppressionsTable)
      .where(eq(schema.notificationSuppressionsTable.email, email.toLowerCase()));
    expect(supRow?.reason).toBe("hard_bounce");
    expect(supRow?.source).toBe("sendgrid");
    const [row] = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(eq(schema.notificationsOutboxTable.id, rowId));
    expect(row?.status).toBe("delivered");
    expect(row?.lastError).toBe("suppressed");
  }, 30_000);

  it("(g) transient errors do NOT suppress — they fall through to the normal retry/backoff path", async () => {
    const email = `${SUPP_TEST_PREFIX}trans_${crypto.randomBytes(4).toString("hex")}@example.com`;
    const { rowId } = await stageEmailRow({ email });

    const { adapter } = buildEmailChannel({
      response: {
        ok: false,
        errorCode: "exception",
        errorMessage: "ECONNRESET",
        provider: "postmark",
      },
    });
    outbox.__setOutboxChannelResolverForTests(emailOnlyResolver(adapter));

    await outbox.drainOutbox();

    expect(await supp.isEmailSuppressed(email)).toBe(false);
    const [row] = await db
      .select()
      .from(schema.notificationsOutboxTable)
      .where(eq(schema.notificationsOutboxTable.id, rowId));
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("ECONNRESET");
  }, 30_000);
});
