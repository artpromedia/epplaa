import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { requireRole } from "../lib/roles";
import { runDailyReconciliation } from "../lib/reconciliation";
import { processDuePayouts } from "../lib/payments";
import { approveVerification, rejectVerification } from "../lib/kyc";
import {
  getAuditChainVerifierSnapshot,
  runAuditChainVerification,
} from "../lib/auditChainVerifier";
import { probeDbLatency } from "../lib/dbLatencyProbe";
import { getQueueHealthSnapshot } from "../lib/queueDepth";
import { getReplicaId } from "./health";
import {
  reportDegraded,
  reportRecovered,
} from "../lib/replicaDegradedAlerts";
import {
  AdminReportReplicaDegradedBody,
  AdminReportReplicaRecoveredBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * Legacy env-allowlist admin gate. Kept for the finance/recon endpoints
 * below that have always used it. The KYC review routes have been
 * migrated to the role-based gate (`requireRole(['admin'])` from
 * lib/roles) so that role-granted admins (the canonical model used by
 * the admin console) can act on the KYC queue without also having to
 * be listed in `EPPLAA_ADMIN_USER_IDS`.
 *
 * Operators bootstrapped via `EPPLAA_ADMIN_USER_IDS` are still granted
 * the `admin` role automatically by `initAdminSchema()` at boot, so
 * existing env-listed admins keep working through the role gate.
 */
function getAdminIds(): Set<string> {
  return new Set(
    String(process.env.EPPLAA_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const userId = requireUserId(req, res);
  if (!userId) return;
  if (!getAdminIds().has(userId)) {
    res.status(403).json({ error: "forbidden", detail: "admin_only" });
    return;
  }
  next();
}

const ADMIN_ONLY = ["admin"] as const;

router.get("/admin/db-health", requireAdmin, async (_req, res) => {
  const snapshot = await probeDbLatency({ db, replicaId: getReplicaId() });
  res.json(snapshot);
});

router.get("/admin/queue-health", requireAdmin, async (_req, res) => {
  const snapshot = await getQueueHealthSnapshot(db);
  res.json(snapshot);
});

/**
 * Admin status panel ("/admin/status") fan-out for "the panel saw a
 * degraded replica for more than one consecutive poll". The panel
 * reports here on every cycle while a replica is unhealthy AND on the
 * cycle a previously-unhealthy replica returns to healthy. The
 * server-side dedup table in `lib/replicaDegradedAlerts` is what
 * collapses N operators × M tabs of the panel into a single Sentry
 * page per outage window per replicaId.
 *
 * Auth: same `requireAdmin` envelope as the other status surfaces on
 * this router so an unauthenticated browser can never spoof a fake
 * page on-call. The panel itself is gated by the admin-console route
 * guard, but defence in depth.
 */
router.post(
  "/admin/replica-degraded-alerts",
  requireAdmin,
  async (req, res) => {
    const parsed = AdminReportReplicaDegradedBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "bad_request", detail: parsed.error.message });
      return;
    }
    const out = reportDegraded({
      replicaId: parsed.data.replicaId,
      httpStatus: parsed.data.httpStatus,
      failingChecks: parsed.data.failingChecks,
      failures: parsed.data.failures,
      consecutivePolls: parsed.data.consecutivePolls,
    });
    res.json(out);
  },
);

router.post(
  "/admin/replica-degraded-alerts/recovery",
  requireAdmin,
  async (req, res) => {
    const parsed = AdminReportReplicaRecoveredBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "bad_request", detail: parsed.error.message });
      return;
    }
    const out = reportRecovered({ replicaId: parsed.data.replicaId });
    res.json(out);
  },
);

router.get("/admin/payment-gateway-health", requireAdmin, async (_req, res) => {
  const rows = await db.select().from(schema.gatewayHealthTable);
  res.json(
    rows.map((r) => ({
      gateway: r.gateway,
      successCount: r.successCount,
      failureCount: r.failureCount,
      windowStartedAtIso: r.windowStartedAt.toISOString(),
      circuitOpenUntilIso: r.circuitOpenUntil?.toISOString() ?? null,
      lastEventAtIso: r.lastEventAt?.toISOString() ?? null,
    })),
  );
});

router.get("/admin/reconciliation-runs", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.reconciliationRunsTable)
    .orderBy(desc(schema.reconciliationRunsTable.ranAt))
    .limit(50);
  res.json(
    rows.map((r) => ({
      id: r.id,
      gateway: r.gateway,
      windowStartIso: r.windowStart.toISOString(),
      windowEndIso: r.windowEnd.toISOString(),
      ledgerCount: r.ledgerCount,
      settlementCount: r.settlementCount,
      matchedCount: r.matchedCount,
      mismatches: r.mismatches,
      status: r.status,
      errorMessage: r.errorMessage,
      ranAtIso: r.ranAt.toISOString(),
    })),
  );
});

router.post("/admin/reconciliation/run", requireAdmin, async (_req, res) => {
  const runs = await runDailyReconciliation();
  res.json({ ok: true, runs: runs.length });
});

router.post("/admin/payouts/run-due", requireAdmin, async (_req, res) => {
  const result = await processDuePayouts();
  res.json({ ok: true, ...result });
});

router.get("/admin/payment-intents", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.paymentIntentsTable)
    .orderBy(desc(schema.paymentIntentsTable.createdAt))
    .limit(50);
  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      purpose: r.purpose,
      orderId: r.orderId,
      gateway: r.gateway,
      reference: r.reference,
      amountMinor: r.amountMinor,
      currencyCode: r.currencyCode,
      status: r.status,
      paidAtIso: r.paidAt?.toISOString() ?? null,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

// ---- KYC review queue (admin) ----
// We expose a thin admin surface so a compliance reviewer can list
// pending KYC verifications and approve/reject them. Approval promotes
// the seller's `kycTier` and sets `nextKycReviewAt` (used by the
// quarterly resweep). Rejection records the reason and emits an audit
// event. Both actions are guarded by the same admin allow-list above.

router.get("/admin/kyc/pending", requireRole(ADMIN_ONLY), async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.kycVerificationsTable)
    .where(eq(schema.kycVerificationsTable.status, "pending_review"))
    .orderBy(desc(schema.kycVerificationsTable.submittedAt))
    .limit(100);
  res.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      kind: r.kind,
      status: r.status,
      submittedAtIso: r.submittedAt?.toISOString() ?? null,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

router.post("/admin/kyc/:id/approve", requireRole(ADMIN_ONLY), async (req, res) => {
  const reviewerId = requireUserId(req, res);
  if (!reviewerId) return;
  const id = String(req.params.id ?? "");
  // The seller's tier promotion is computed inside `approveVerification`
  // from the verification row's `targetTier`; we only need the reviewer's
  // optional note here.
  const note = String(req.body?.note ?? "approved").trim();
  const result = await approveVerification(id, reviewerId, note);
  if (!result.ok) {
    res.status(404).json({ error: "not_found", detail: result.reason });
    return;
  }
  res.json({ ok: true, kycTier: result.kycTier });
});

// ---- In-prod audit-chain integrity probe (admin) ----
//
// Exposes the same `runAuditChainVerification` path that the periodic
// scheduler uses (see `lib/auditChainVerifier.ts`), so an operator can
// force an immediate verify against the live `audit_events` table — for
// example after a suspected DB restore, before/after maintenance, or
// when investigating a Sentry `audit_chain_tamper_detected` alert.
//
// On a non-null result this endpoint pages audit/compliance owners via
// the same Sentry capture + log-tag path the scheduled tick uses; the
// HTTP response just carries the structured result for the operator.
//
// Mounted at `/internal/audit-chain/verify` (not `/admin/...`) per the
// task spec — the path advertises that the surface is for internal
// operations callers only. The `requireAdmin` env-allowlist gate is
// the canonical admin gate for ops endpoints because it does not
// depend on a DB role lookup (so it still authorises operators when
// the very table being investigated has issues).
router.post("/internal/audit-chain/verify", requireAdmin, async (req, res) => {
  const result = await runAuditChainVerification(Date.now(), "admin-endpoint");
  if (result.error !== null) {
    // The probe itself failed (DB unreachable, query timeout). Surface
    // 503 so the caller can distinguish this from a clean run or a
    // tamper detection — same triage split the snapshot's
    // `lastVerifyError` field documents.
    req.log.warn(
      { err: result.error, durationMs: result.durationMs },
      "audit_chain_verify_admin_probe_failed",
    );
    res.status(503).json({
      ok: false,
      error: "verify_failed",
      detail: result.error,
      durationMs: result.durationMs,
    });
    return;
  }
  if (result.offendingSeq !== null) {
    // Tamper detected. The captureMessage + structured log have
    // already been emitted from inside runAuditChainVerification; the
    // 409 status conveys "the chain is in an invalid state" without
    // implying the request itself was malformed (4xx) or the server
    // failed to handle it (5xx).
    res.status(409).json({
      ok: false,
      error: "audit_chain_tamper_detected",
      offendingSeq: result.offendingSeq,
      durationMs: result.durationMs,
      verifiedAtIso: new Date(result.verifiedAt).toISOString(),
    });
    return;
  }
  res.json({
    ok: true,
    offendingSeq: null,
    durationMs: result.durationMs,
    verifiedAtIso: new Date(result.verifiedAt).toISOString(),
    snapshot: getAuditChainVerifierSnapshot(),
  });
});

router.post("/admin/kyc/:id/reject", requireRole(ADMIN_ONLY), async (req, res) => {
  const reviewerId = requireUserId(req, res);
  if (!reviewerId) return;
  const id = String(req.params.id ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  if (!reason) {
    res.status(400).json({ error: "bad_request", detail: "reason is required" });
    return;
  }
  const result = await rejectVerification(id, reviewerId, reason);
  if (!result.ok) {
    res.status(404).json({ error: "not_found", detail: result.reason });
    return;
  }
  res.json({ ok: true });
});

// ---- PUDO partner configuration (admin) — task #175 ----
//
// Operator surface for the daily-push delivery configuration on the
// `pudo_partners` table (see lib/pudo/schema.ts). Until this surface
// existed, partners had to be inserted/updated by hand via psql, which
// was a footgun in two ways:
//   - SFTP env-var NAMES (sftpPasswordEnvVar / sftpKeyEnvVar) had to be
//     remembered in lockstep with the deploy's actual env config; a
//     typo silently fell back to the empty default and the cron would
//     skip delivery without paging.
//   - Soft-disabling a partner required a manual UPDATE; an operator
//     who didn't know the column name would either edit the wrong
//     column or `DELETE FROM pudo_partners WHERE code=...`, which
//     would cascade-break the fulfillment_locations FK.
//
// All routes are gated by `requireRole(['admin'])` (the canonical
// admin gate used by KYC/sanctions); secrets are NEVER stored on the
// row — only the *names* of env vars holding them, so the row itself
// is safe to render in the UI in plain text.

interface PudoPartnerRowDto {
  code: string;
  name: string;
  countryCode: string;
  contactEmail: string;
  active: boolean;
  manifestTimezone: string;
  deliveryMethod: "none" | "email" | "sftp";
  manifestEmail: string;
  sftpHost: string;
  sftpPort: number;
  sftpUsername: string;
  sftpPasswordEnvVar: string;
  sftpKeyEnvVar: string;
  sftpRemoteDir: string;
  hasApiKey: boolean;
  createdAtIso: string;
}

function rowToPartnerDto(r: typeof schema.pudoPartnersTable.$inferSelect): PudoPartnerRowDto {
  return {
    code: r.code,
    name: r.name,
    countryCode: r.countryCode,
    contactEmail: r.contactEmail,
    active: r.active === 1,
    manifestTimezone: r.manifestTimezone,
    deliveryMethod: (r.deliveryMethod as "none" | "email" | "sftp") ?? "none",
    manifestEmail: r.manifestEmail,
    sftpHost: r.sftpHost,
    sftpPort: r.sftpPort,
    sftpUsername: r.sftpUsername,
    sftpPasswordEnvVar: r.sftpPasswordEnvVar,
    sftpKeyEnvVar: r.sftpKeyEnvVar,
    sftpRemoteDir: r.sftpRemoteDir,
    // Surface presence of the API key without leaking it. The UI shows
    // a "Rotate" button rather than the value; an operator who needs
    // to read the secret pulls it from secret storage, not this UI.
    hasApiKey: !!r.apiKey && r.apiKey.length > 0,
    createdAtIso: r.createdAt.toISOString(),
  };
}

router.get("/admin/pudo-partners", requireRole(ADMIN_ONLY), async (_req, res) => {
  const rows = await db
    .select()
    .from(schema.pudoPartnersTable)
    .orderBy(schema.pudoPartnersTable.code);
  res.json({ items: rows.map(rowToPartnerDto) });
});

/**
 * Validate a partner mutation payload. Centralised so create+update can
 * share the same rules, and so the UI can surface a precise error per
 * field rather than a generic 400. Returns the cleaned partial row on
 * success or an error string on failure.
 */
function validatePartnerInput(
  body: Record<string, unknown>,
  requireCode: boolean,
): { ok: true; values: Partial<typeof schema.pudoPartnersTable.$inferInsert> } | { ok: false; error: string } {
  const trim = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const code = trim(body.code);
  const name = trim(body.name);
  const countryCode = trim(body.countryCode).toUpperCase();
  const deliveryMethod = trim(body.deliveryMethod) || "none";
  if (requireCode && !code) {
    return { ok: false, error: "code is required" };
  }
  if (requireCode && !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) {
    return { ok: false, error: "code must be lowercase kebab/snake (≤32 chars)" };
  }
  if (requireCode && !name) {
    return { ok: false, error: "name is required" };
  }
  if (requireCode && !/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, error: "countryCode must be ISO 3166-1 alpha-2" };
  }
  if (!["none", "email", "sftp"].includes(deliveryMethod)) {
    return { ok: false, error: "deliveryMethod must be one of none|email|sftp" };
  }
  const manifestEmail = trim(body.manifestEmail);
  if (deliveryMethod === "email" && manifestEmail === "") {
    return { ok: false, error: "manifestEmail required when deliveryMethod=email" };
  }
  const sftpHost = trim(body.sftpHost);
  if (deliveryMethod === "sftp" && sftpHost === "") {
    return { ok: false, error: "sftpHost required when deliveryMethod=sftp" };
  }
  const sftpPortRaw = body.sftpPort;
  const sftpPort = typeof sftpPortRaw === "number" && Number.isInteger(sftpPortRaw) && sftpPortRaw > 0 && sftpPortRaw < 65536
    ? sftpPortRaw
    : 22;
  const values: Partial<typeof schema.pudoPartnersTable.$inferInsert> = {
    name,
    countryCode,
    contactEmail: trim(body.contactEmail),
    manifestTimezone: trim(body.manifestTimezone) || "Africa/Lagos",
    deliveryMethod,
    manifestEmail,
    sftpHost,
    sftpPort,
    sftpUsername: trim(body.sftpUsername),
    sftpPasswordEnvVar: trim(body.sftpPasswordEnvVar),
    sftpKeyEnvVar: trim(body.sftpKeyEnvVar),
    sftpRemoteDir: trim(body.sftpRemoteDir) || "/",
  };
  if (typeof body.active === "boolean") {
    values.active = body.active ? 1 : 0;
  }
  if (requireCode) {
    values.code = code;
  }
  return { ok: true, values };
}

router.post("/admin/pudo-partners", requireRole(ADMIN_ONLY), async (req, res) => {
  const v = validatePartnerInput(req.body as Record<string, unknown>, true);
  if (!v.ok) {
    res.status(400).json({ error: "bad_request", detail: v.error });
    return;
  }
  const code = v.values.code as string;
  const existing = await db
    .select({ code: schema.pudoPartnersTable.code })
    .from(schema.pudoPartnersTable)
    .where(eq(schema.pudoPartnersTable.code, code))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "already_exists", detail: `partner ${code} already exists` });
    return;
  }
  const [inserted] = await db
    .insert(schema.pudoPartnersTable)
    .values({
      code,
      name: v.values.name ?? "",
      countryCode: v.values.countryCode ?? "",
      contactEmail: v.values.contactEmail ?? "",
      active: v.values.active ?? 1,
      manifestTimezone: v.values.manifestTimezone ?? "Africa/Lagos",
      deliveryMethod: v.values.deliveryMethod ?? "none",
      manifestEmail: v.values.manifestEmail ?? "",
      sftpHost: v.values.sftpHost ?? "",
      sftpPort: v.values.sftpPort ?? 22,
      sftpUsername: v.values.sftpUsername ?? "",
      sftpPasswordEnvVar: v.values.sftpPasswordEnvVar ?? "",
      sftpKeyEnvVar: v.values.sftpKeyEnvVar ?? "",
      sftpRemoteDir: v.values.sftpRemoteDir ?? "/",
    })
    .returning();
  res.status(201).json(rowToPartnerDto(inserted));
});

router.patch("/admin/pudo-partners/:code", requireRole(ADMIN_ONLY), async (req, res) => {
  const code = String(req.params.code).trim();
  if (!code) {
    res.status(400).json({ error: "bad_request", detail: "code is required" });
    return;
  }
  const v = validatePartnerInput(req.body as Record<string, unknown>, false);
  if (!v.ok) {
    res.status(400).json({ error: "bad_request", detail: v.error });
    return;
  }
  // Strip undefined keys so a partial PATCH only touches what was sent.
  // The validator emits the full set, so we explicitly pull from the
  // raw body to decide which fields to set.
  const body = req.body as Record<string, unknown>;
  const set: Partial<typeof schema.pudoPartnersTable.$inferInsert> = {};
  if (typeof body.name === "string") set.name = v.values.name;
  if (typeof body.countryCode === "string") set.countryCode = v.values.countryCode;
  if (typeof body.contactEmail === "string") set.contactEmail = v.values.contactEmail;
  if (typeof body.manifestTimezone === "string") set.manifestTimezone = v.values.manifestTimezone;
  if (typeof body.deliveryMethod === "string") set.deliveryMethod = v.values.deliveryMethod;
  if (typeof body.manifestEmail === "string") set.manifestEmail = v.values.manifestEmail;
  if (typeof body.sftpHost === "string") set.sftpHost = v.values.sftpHost;
  if (typeof body.sftpPort === "number") set.sftpPort = v.values.sftpPort;
  if (typeof body.sftpUsername === "string") set.sftpUsername = v.values.sftpUsername;
  if (typeof body.sftpPasswordEnvVar === "string") set.sftpPasswordEnvVar = v.values.sftpPasswordEnvVar;
  if (typeof body.sftpKeyEnvVar === "string") set.sftpKeyEnvVar = v.values.sftpKeyEnvVar;
  if (typeof body.sftpRemoteDir === "string") set.sftpRemoteDir = v.values.sftpRemoteDir;
  if (typeof body.active === "boolean") set.active = v.values.active;
  if (Object.keys(set).length === 0) {
    res.status(400).json({ error: "bad_request", detail: "no fields to update" });
    return;
  }
  const updated = await db
    .update(schema.pudoPartnersTable)
    .set(set)
    .where(eq(schema.pudoPartnersTable.code, code))
    .returning();
  if (updated.length === 0) {
    res.status(404).json({ error: "not_found", detail: `partner ${code} not found` });
    return;
  }
  res.json(rowToPartnerDto(updated[0]));
});

export default router;
