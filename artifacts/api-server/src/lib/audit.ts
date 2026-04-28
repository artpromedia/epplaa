import { createHash } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db, schema } from "./db";
import { logger } from "./logger";
import { getUserId } from "./auth";

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
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await ensureChainHeadLoaded();
    const scrubbedPayload = scrubPii(input.payload ?? {}) as Record<string, unknown>;
    const prevHash = chainHead ?? "";
    // Canonical content deliberately omits a write-time timestamp.
    // The chain itself orders rows (via prevHash + DB sequence), and
    // including a recomputed timestamp would prevent verifyAuditChain
    // from rebuilding the exact rowHash later. We bind the immutable
    // facts (actor/action/entity/entityId/piiRead/payload) — that's
    // what tamper detection has to cover.
    const content = canonicalJson({
      actor: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? "",
      piiRead: Boolean(input.piiRead),
      payload: scrubbedPayload,
    });
    const rowHash = createHash("sha256").update(prevHash).update("\n").update(content).digest("hex");
    await db.insert(schema.auditEventsTable).values({
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
  } catch (err) {
    logger.error({ err: (err as Error).message, action: input.action }, "audit_write_failed");
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
