import { createHash } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db, schema } from "./db";
import { logger } from "./logger";
import { getUserId } from "./auth";
import { auditHealthWatcher } from "./subsystemHealth";

interface RecordAuditInput {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  piiRead?: boolean;
}

/**
 * Keys whose VALUES are PII and must be redacted before persistence into
 * the audit log payload. Audit rows record *that* a thing happened, not the
 * raw PII itself — that lives in the source-of-truth tables under their own
 * access controls.
 */
const PII_KEY_RX = /^(email|phone|govId|gov_id|bankAccount|bank_account|cardNumber|card_number|cvv|otp|otpHash|password|secret|token|apiKey|api_key|sessionSecret|session_secret|blobBase64|blob_base64|contentBase64|content_base64|fileBase64|file_base64|inlineBlob|inline_blob)$/i;
const REDACTED = "[REDACTED]";

export function scrubPii(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(scrubPii);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEY_RX.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubPii(v);
      }
    }
    return out;
  }
  return value;
}

let chainHead: string | null = null;
let chainPromise: Promise<void> | null = null;

/**
 * Eager init for app boot: forces the chain-head load (and the append-only
 * trigger install) up front, so the DB-level immutability protection is in
 * place before the first request, not lazily on the first audit write.
 */
export async function initAuditChain(): Promise<void> {
  await ensureChainHeadLoaded();
}

async function ensureChainHeadLoaded(): Promise<void> {
  if (chainHead !== null) return;
  if (chainPromise) return chainPromise;
  chainPromise = (async () => {
    // Install append-only DB-level protection on first load. We block
    // UPDATE and DELETE on `audit_events` at the trigger level, so even
    // if a future code path accidentally calls .update() or .delete()
    // against this table the database refuses. INSERT remains allowed
    // (recordAudit appends rows). This is the immutability backstop that
    // application-level conventions alone can't guarantee.
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION audit_events_append_only()
      RETURNS TRIGGER AS $func$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only (op=%)', TG_OP
          USING ERRCODE = 'check_violation';
      END;
      $func$ LANGUAGE plpgsql;
    `);
    await db.execute(sql`
      DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
    `);
    await db.execute(sql`
      CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
    `);
    await db.execute(sql`
      DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
    `);
    await db.execute(sql`
      CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
    `);
    // Dead-letter table for audit-write failures. recordAudit() is best-
    // effort by design (a failing audit must not break the user-facing
    // request), but "best-effort" cannot mean "silently dropped" for a
    // PCI/financial baseline. Failed appends land here and an operator
    // alarm is raised via a structured `audit_dlq_write` log line. The
    // table is intentionally outside the append-only chain so a chain
    // failure (e.g. pg lock contention) can still record the loss.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS audit_failures (
        id              bigserial PRIMARY KEY,
        ts              timestamptz NOT NULL DEFAULT now(),
        actor_id        text,
        action          text NOT NULL,
        entity          text NOT NULL,
        entity_id       text NOT NULL DEFAULT '',
        pii_read        boolean NOT NULL DEFAULT false,
        payload         jsonb,
        error_message   text NOT NULL,
        retry_count     integer NOT NULL DEFAULT 0
      );
    `);
    // `replayed_at` is the canonical "row has been re-applied to the
    // append-only chain" marker used by the audit-DLQ backlog monitor
    // (lib/auditDlqMonitor.ts) and the runbook's Step 5 alert. Added
    // as a separate ALTER so existing deploys upgrade idempotently
    // without recreating the table or dropping data.
    await db.execute(sql`
      ALTER TABLE audit_failures
      ADD COLUMN IF NOT EXISTS replayed_at timestamptz;
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS audit_failures_unresolved_idx
      ON audit_failures (ts) WHERE retry_count = 0;
    `);
    // Partial index that backs the per-minute backlog probe in
    // auditDlqMonitor.ts: `SELECT count(*) FROM audit_failures WHERE
    // replayed_at IS NULL`. Without it the count scans the whole
    // table on every poll once the DLQ accumulates rows.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS audit_failures_unreplayed_idx
      ON audit_failures (id) WHERE replayed_at IS NULL;
    `);
    const [last] = await db
      .select()
      .from(schema.auditEventsTable)
      .orderBy(desc(schema.auditEventsTable.seq))
      .limit(1);
    chainHead = last?.rowHash ?? "";
  })();
  await chainPromise;
}

function canonicalJson(value: unknown): string {
  // Stable key ordering so the row hash is deterministic.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Append a single hash-chained audit row. Best-effort: failures are logged
 * (with PII scrubbed) and never bubble to the caller — the request that
 * triggered the action must not fail just because the audit insert did.
 */
// Stable advisory-lock key (arbitrary 64-bit constant). Concurrent recordAudit
// calls serialize on this lock so prev_hash linking is atomic across workers.
const AUDIT_CHAIN_LOCK_KEY = 0x4541_5544_4954_4348n; // 'EAUDITCH'

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await ensureChainHeadLoaded();
    const scrubbedPayload = scrubPii(input.payload ?? {}) as Record<string, unknown>;
    // Canonical content deliberately omits a write-time timestamp so that
    // verifyAuditChain can recompute the rowHash from row data alone. We
    // bind the immutable facts (actor/action/entity/entityId/piiRead/
    // payload) — that's what tamper detection has to cover.
    const content = canonicalJson({
      actor: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? "",
      piiRead: Boolean(input.piiRead),
      payload: scrubbedPayload,
    });
    // Serialize the read-prev / compute-hash / insert-row sequence inside a
    // single transaction holding a Postgres advisory lock. Concurrent
    // workers (or interleaved async writes within one process) used to
    // race on the in-memory `chainHead`, producing rows that linked off
    // the same prev_hash and broke chain verification. The advisory lock
    // is released when the transaction commits.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);
      const [last] = await tx
        .select({ rowHash: schema.auditEventsTable.rowHash })
        .from(schema.auditEventsTable)
        .orderBy(desc(schema.auditEventsTable.seq))
        .limit(1);
      const prevHash = last?.rowHash ?? "";
      const rowHash = createHash("sha256").update(prevHash).update("\n").update(content).digest("hex");
      await tx.insert(schema.auditEventsTable).values({
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? "",
        piiRead: Boolean(input.piiRead),
        payload: scrubbedPayload,
        prevHash,
        rowHash,
      });
      chainHead = rowHash;
    });
    // Successful chain-extend: close any in-progress failure streak so
    // /healthz's `subsystems.auditChain` flips back to healthy and the
    // duration alert auto-resolves on the next probe iteration. The
    // watcher cheaply no-ops when there is no streak in progress.
    auditHealthWatcher.recordSuccess();
  } catch (err) {
    const errorMessage = (err as Error).message;
    // Open / extend the audit-pipeline failure streak. /healthz exposes
    // this as `subsystems.auditChain` and `checkHealthzDegraded` pages
    // on-call when the streak duration exceeds the threshold — closing
    // the silent-compliance-gap window where every recordAudit was
    // dead-lettering for many minutes without anyone noticing because
    // the request path itself never broke.
    auditHealthWatcher.record();
    logger.error({ err: errorMessage, action: input.action }, "audit_write_failed");
    // Dead-letter the failed event so it is recoverable. We can't link it
    // into the hash chain (that's exactly what just failed), but we can
    // record that an event WAS lost — operators can later replay or
    // investigate from `audit_failures`. If even the DLQ insert fails we
    // log loudly with `audit_dlq_write_failed`; that is the alarm of last
    // resort and indicates the database itself is unreachable.
    try {
      const scrubbedPayload = scrubPii(input.payload ?? {}) as Record<string, unknown>;
      await db.execute(sql`
        INSERT INTO audit_failures (actor_id, action, entity, entity_id, pii_read, payload, error_message)
        VALUES (${input.actorId ?? null}, ${input.action}, ${input.entity}, ${input.entityId ?? ""}, ${Boolean(input.piiRead)}, ${JSON.stringify(scrubbedPayload)}::jsonb, ${errorMessage})
      `);
    } catch (dlqErr) {
      logger.error(
        { err: (dlqErr as Error).message, action: input.action, originalError: errorMessage },
        "audit_dlq_write_failed",
      );
    }
  }
}

/**
 * Verify the chain integrity from `fromSeq` to current. Returns the seq of
 * the first broken row, or null when the chain is intact.
 */
export async function verifyAuditChain(fromSeq = 0): Promise<number | null> {
  const rows = await db
    .select()
    .from(schema.auditEventsTable)
    .orderBy(schema.auditEventsTable.seq);
  let prev = "";
  for (const row of rows) {
    if (row.seq < fromSeq) {
      prev = row.rowHash;
      continue;
    }
    if (row.prevHash !== prev) return row.seq;
    const content = canonicalJson({
      actor: row.actorId,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      piiRead: row.piiRead,
      payload: row.payload,
    });
    const expected = createHash("sha256").update(prev).update("\n").update(content).digest("hex");
    // Full content rebind: detects in-place mutations of payload/action/
    // entity/entityId that would otherwise leave the prevHash chain intact.
    if (expected !== row.rowHash) return row.seq;
    prev = row.rowHash;
  }
  return null;
}

/**
 * Audit-coverage policy for authenticated GETs.
 *
 * Compliance requires "every PII access is auditable", which is impossible to
 * guarantee with an allowlist that can drift behind new routes. We instead
 * use an OPT-OUT model: by default every authenticated GET writes a hash-
 * chained audit row. Routes that genuinely return no subject-identifying
 * data (catalogue/discovery/anonymous lookups) must be explicitly listed in
 * NON_PII_GET_ALLOWLIST below, which is reviewed alongside any new route.
 * A new endpoint that returns PII will be audited automatically — drift can
 * only mean over-auditing (a new non-PII route also emits a row), never the
 * silent non-coverage the architect flagged.
 *
 * PII_READ_PATTERNS keeps the *named* action/entity/entityIdParam mapping
 * for known-PII routes so audit rows have rich, queryable shapes; routes
 * that fall through to the default land with action `pii.read` and an
 * entity/entityId derived from the URL.
 */
type PiiReadPattern = {
  readonly match: (path: string) => boolean;
  readonly action: string;
  readonly entity: string;
  readonly entityIdParam?: string;
};
/**
 * Authenticated GETs that DO NOT return subject PII. Reviewed alongside any
 * new route. Anything not matched here is treated as PII-bearing and gets
 * an audit row by default. Entries are path patterns matched against the
 * URL path with the `/api` prefix stripped.
 */
const NON_PII_GET_ALLOWLIST: readonly ((p: string) => boolean)[] = [
  (p) => p === "/healthz",
  (p) => p === "/countries",
  (p) => p === "/web-push/vapid-public-key",
  (p) => p === "/payments/mode",
  (p) => p === "/products",
  (p) => /^\/products\/[^/]+$/.test(p),
  (p) => p === "/streams",
  (p) => /^\/streams\/[^/]+$/.test(p),
  (p) => p === "/replays",
  (p) => /^\/replays\/[^/]+$/.test(p),
  (p) => p === "/fulfillment-locations",
  (p) => p === "/reviews",
  (p) => /^\/pudo\/[^/]+\/manifest$/.test(p),
  (p) => p === "/admin/payment-gateway-health",
  // The viewer's own moderation role for a stream — returns the
  // requester's role only, never anyone else's PII.
  (p) => /^\/streams\/[^/]+\/moderation-role$/.test(p),
  // Dev-only payment debug endpoint, never reachable in production.
  (p) => /^\/__devpay\/[^/]+$/.test(p),
];
const PII_READ_PATTERNS: readonly PiiReadPattern[] = [
  { match: (p) => p === "/me", action: "user.me.read", entity: "user" },
  { match: (p) => p === "/cart", action: "cart.read", entity: "cart" },
  { match: (p) => p === "/checkout-draft", action: "checkoutDraft.read", entity: "checkoutDraft" },
  { match: (p) => p === "/wallet", action: "wallet.read", entity: "wallet" },
  { match: (p) => p === "/onboarding", action: "onboarding.read", entity: "user" },
  { match: (p) => p === "/notification-prefs", action: "notificationPrefs.read", entity: "user" },
  { match: (p) => p === "/follows", action: "follows.read", entity: "user" },
  { match: (p) => p === "/wishlist", action: "wishlist.read", entity: "user" },
  { match: (p) => p === "/recently-viewed", action: "recentlyViewed.read", entity: "user" },
  { match: (p) => p === "/recent-searches", action: "recentSearches.read", entity: "user" },
  { match: (p) => p === "/orders", action: "orders.list.read", entity: "order" },
  { match: (p) => /^\/orders\/[^/]+$/.test(p), action: "order.read", entity: "order", entityIdParam: "orderId" },
  { match: (p) => /^\/payments\/intents\/[^/]+$/.test(p), action: "paymentIntent.read", entity: "paymentIntent", entityIdParam: "intentId" },
  { match: (p) => p === "/seller/me", action: "seller.me.read", entity: "seller" },
  { match: (p) => p === "/seller/listings", action: "seller.listings.read", entity: "seller" },
  { match: (p) => p === "/seller/orders", action: "seller.orders.read", entity: "seller" },
  { match: (p) => p === "/seller/streams", action: "seller.streams.read", entity: "seller" },
  { match: (p) => p === "/seller/earnings", action: "seller.earnings.read", entity: "seller" },
  { match: (p) => p === "/referrals/me", action: "referrals.read", entity: "user" },
  { match: (p) => p === "/returns", action: "returns.list.read", entity: "return" },
  { match: (p) => /^\/returns\/[^/]+$/.test(p), action: "return.read", entity: "return", entityIdParam: "returnId" },
  { match: (p) => p === "/safety/reports", action: "safety.reports.read", entity: "user" },
  { match: (p) => p === "/safety/blocked", action: "safety.blocked.read", entity: "user" },
  { match: (p) => p === "/kyc/me", action: "kyc.me.read", entity: "kyc" },
  { match: (p) => /^\/kyc\/documents\/[^/]+$/.test(p), action: "kyc.document.read", entity: "kycDocument", entityIdParam: "id" },
  { match: (p) => p === "/ndpr/requests", action: "ndpr.requests.list.read", entity: "ndprRequest" },
  { match: (p) => /^\/ndpr\/requests\/[^/]+$/.test(p), action: "ndpr.request.read", entity: "ndprRequest", entityIdParam: "id" },
  // Admin reads — extra-sensitive because they expose other users' PII.
  // Listing a stream's moderators returns userIds + display names of
  // viewers the host has deputised — host-only on the route, but we
  // still want a richly-shaped audit row for the read.
  { match: (p) => /^\/streams\/[^/]+\/moderators$/.test(p), action: "stream.moderators.list.read", entity: "streamModerator", entityIdParam: "streamId" },
  { match: (p) => p === "/admin/payment-intents", action: "admin.paymentIntents.read", entity: "paymentIntent" },
  { match: (p) => p === "/admin/kyc/pending", action: "admin.kycPending.read", entity: "kycVerification" },
  { match: (p) => p === "/admin/reconciliation-runs", action: "admin.reconciliationRuns.read", entity: "reconciliationRun" },
];

function matchPiiReadPattern(path: string): PiiReadPattern | undefined {
  return PII_READ_PATTERNS.find((p) => p.match(path));
}

function isAllowlistedNonPiiPath(path: string): boolean {
  return NON_PII_GET_ALLOWLIST.some((m) => m(path));
}

function defaultPiiReadAction(path: string): { action: string; entity: string; entityId: string | null } {
  // Derive a stable action/entity from the URL when no named pattern matches.
  // For `/foo/bar/baz` we use action=`pii.read.foo.bar` and entity='foo';
  // the trailing segment becomes the entityId so per-resource queries still
  // work even for routes we haven't yet promoted to PII_READ_PATTERNS.
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const segs = trimmed.split("/").filter(Boolean);
  const entity = segs[0] ?? "unknown";
  const head = segs.slice(0, Math.min(2, segs.length)).join(".") || "root";
  const tail = segs.length > 1 ? segs[segs.length - 1] : null;
  return { action: `pii.read.${head}`, entity, entityId: tail ?? null };
}

/**
 * Express middleware: writes a single audit row for every successful
 * authenticated GET that returns subject data. Operates as an OPT-OUT
 * policy: a route is audited unless it is in NON_PII_GET_ALLOWLIST,
 * eliminating the silent-coverage drift that an allowlist-only model
 * suffers when new endpoints are added. NDPR/PCI compliance treats every
 * PII access as auditable, not just mutations.
 */
export function auditPiiReads() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET") {
      next();
      return;
    }
    const actorId = getUserId(req);
    if (!actorId) {
      next();
      return;
    }
    const path = (req.originalUrl.split("?")[0] ?? "").replace(/^\/api/, "");
    if (isAllowlistedNonPiiPath(path)) {
      next();
      return;
    }
    const pattern = matchPiiReadPattern(path);
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (pattern) {
        const entityId = pattern.entityIdParam
          ? String(req.params[pattern.entityIdParam] ?? "")
          : actorId;
        void recordAudit({
          actorId,
          action: pattern.action,
          entity: pattern.entity,
          entityId,
          piiRead: true,
          payload: { method: req.method, path },
        });
        return;
      }
      // Unknown path that isn't allowlisted as non-PII — fail-safe to
      // auditing it. Ops can promote it to PII_READ_PATTERNS later for a
      // richer action/entity name.
      const fallback = defaultPiiReadAction(path);
      void recordAudit({
        actorId,
        action: fallback.action,
        entity: fallback.entity,
        entityId: fallback.entityId ?? actorId,
        piiRead: true,
        payload: { method: req.method, path, classified: "default" },
      });
    });
    next();
  };
}

/**
 * Express middleware: writes a single audit row per authenticated mutation
 * (POST/PUT/PATCH/DELETE) on success (2xx). The audit action is derived from
 * the route path so all sensitive endpoints are covered automatically.
 */
export function auditMutations() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (!isMutation) {
      next();
      return;
    }
    const actorId = getUserId(req);
    if (!actorId) {
      next();
      return;
    }
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      // Skip noisy non-PII endpoints to keep the log focused on
      // actionable events. Health, metrics, and read-through cache pings
      // are out of scope.
      const path = req.originalUrl.split("?")[0] ?? "";
      if (path.startsWith("/api/healthz") || path.startsWith("/api/web-push")) return;
      const action = `http.${req.method.toLowerCase()}.${path.replace(/^\/api\//, "")}`;
      void recordAudit({
        actorId,
        action,
        entity: "http",
        entityId: path,
        payload: { status: res.statusCode, body: req.body ?? {} },
      });
    });
    next();
  };
}
