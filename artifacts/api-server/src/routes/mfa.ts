import { Router, type IRouter, type Request, type Response, type RequestHandler } from "express";
import { requireUserId } from "../lib/auth";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { userHasAnyRole } from "../lib/roles";
import { apiRateLimit } from "../middlewares/apiRateLimit";
import {
  consumeBackupCode,
  disableMfa,
  getMfaStatus,
  hasRecentChallenge,
  regenerateBackupCodes,
  setupTotp,
  thirtyDayVelocityNgnMinor,
  verifyTotpAndActivate,
  verifyTotpAssertion,
} from "../lib/mfa";

/**
 * Per-user rate limits for the mutating MFA routes.
 *
 * The global `/api` limiter (apiRateLimit({ name: "api" }) in app.ts)
 * caps callers at the per-tier per-minute ceiling — generous enough
 * for normal browsing but useless against an attacker with a stolen
 * primary cookie who only needs a handful of requests to do real
 * damage on these routes:
 *
 *   - regenerate-backup-codes: silently mints a fresh 10-code sheet,
 *     burning the user's existing recovery valve.
 *   - disable: removes the second factor entirely.
 *   - setup: starts a fresh enrolment, which (combined with verify)
 *     would let an attacker substitute their own authenticator.
 *   - verify / backup-code: brute-force surfaces against the 6-digit
 *     TOTP code or the 8-char backup codes.
 *
 * The recent-assertion gate already requires a TOTP within the last
 * 15 minutes for regenerate/disable, but inside that window there is
 * no defence against a stolen session being used to keep minting
 * sheets, nor against an accidental client-side loop. A per-user
 * hourly cap bounds the blast radius without inconveniencing real
 * users — regeneration happens at most a handful of times per year
 * for a typical account, and someone fumbling their TOTP digits
 * doesn't realistically need more than ~20 attempts in an hour.
 *
 * Numbers are conservative defaults rather than env-tunables; if an
 * operator legitimately needs to raise them they can edit here. We
 * use the absolute `max` knob on `apiRateLimit` so the cap is the
 * same regardless of caller tier (anon/buyer/seller/admin) — the
 * per-tier multiplier model doesn't fit "give every identity exactly
 * 5 calls per hour".
 *
 * `perRoute: true` forces each mounted route into its own bucket
 * even when two routes share a limiter factory (e.g. regenerate and
 * disable both use `sensitiveMfaRateLimit`). Without it, the bucket
 * key collapses to `${name}:${tier}:*:${identity}` and a user who
 * legitimately exhausted 5 regenerates would be unable to disable MFA
 * — a particularly nasty failure mode because "disable" is the
 * recovery valve when something is wrong with the authenticator. We
 * want each destructive operation independently capped, not summed.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;
const sensitiveMfaRateLimit = apiRateLimit({
  name: "mfa_sensitive",
  windowMs: ONE_HOUR_MS,
  max: 5,
  perRoute: true,
});
const setupMfaRateLimit = apiRateLimit({
  name: "mfa_setup",
  windowMs: ONE_HOUR_MS,
  max: 10,
  perRoute: true,
});
const verifyMfaRateLimit = apiRateLimit({
  name: "mfa_verify",
  windowMs: ONE_HOUR_MS,
  max: 20,
  perRoute: true,
});

/**
 * MFA endpoints — TOTP enrolment, verification, status, recovery.
 *
 * WebAuthn (admin SPA) is delegated to Clerk's hosted flow; the server-side
 * gate for admin requests checks `requireMfa()` which treats any role in
 * the back-office as "MFA always required". WebAuthn assertion happens at
 * the Clerk session level so we just trust the recently-asserted flag.
 */
const router: IRouter = Router();

// 1_000_000 NGN in minor units (kobo) per task spec.
const HIGH_VELOCITY_THRESHOLD_NGN_MINOR = 1_000_000_00;

router.get("/mfa/status", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const status = await getMfaStatus(userId);
  const velocity = await thirtyDayVelocityNgnMinor(userId);
  const isAdmin = await userHasAnyRole(userId, ["admin", "moderator", "finance_ops", "support"]).catch(() => false);
  const required = isAdmin || velocity >= HIGH_VELOCITY_THRESHOLD_NGN_MINOR;
  res.json({
    ...status,
    enrolledAt: status.enrolledAt?.toISOString() ?? null,
    lastUsedAt: status.lastUsedAt?.toISOString() ?? null,
    required,
    requiredReason: isAdmin
      ? "admin_role"
      : required
        ? "high_velocity"
        : null,
    velocityNgnMinor: velocity,
    velocityThresholdNgnMinor: HIGH_VELOCITY_THRESHOLD_NGN_MINOR,
  });
});

router.post("/mfa/totp/setup", setupMfaRateLimit, async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { accountLabel?: string };
  const label = (body.accountLabel ?? userId).slice(0, 64);
  try {
    const result = await setupTotp(userId, label);
    res.json({
      enrollmentId: result.enrollmentId,
      otpauthUrl: result.otpauthUrl,
      qrCodeDataUrl: result.qrCodeDataUrl,
      secret: result.secret,
      backupCodes: result.backupCodes,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, userId }, "mfa_setup_failed");
    res.status(500).json({ error: "mfa_setup_failed" });
  }
});

router.post("/mfa/totp/verify", verifyMfaRateLimit, async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { code?: string; mode?: "activate" | "assert" };
  const code = String(body.code ?? "").replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(code)) {
    res.status(400).json({ error: "invalid_code", detail: "Enter the 6-digit code from your app." });
    return;
  }
  const ok =
    body.mode === "assert"
      ? await verifyTotpAssertion(userId, code)
      : await verifyTotpAndActivate(userId, code);
  if (!ok) {
    res.status(401).json({ error: "code_rejected", detail: "Code did not match. Try again." });
    return;
  }
  res.json({ ok: true });
});

router.post("/mfa/backup-code", verifyMfaRateLimit, async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { code?: string };
  const code = String(body.code ?? "").trim();
  if (!code || code.length < 6) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }
  const ok = await consumeBackupCode(userId, code);
  if (!ok) {
    res.status(401).json({ error: "code_rejected" });
    return;
  }
  res.json({ ok: true });
});

router.post("/mfa/totp/disable", sensitiveMfaRateLimit, async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  // Disable always requires a fresh assertion to prevent a session-fixation
  // attacker from removing the second factor with only the primary cookie.
  if (!(await hasRecentChallenge(userId))) {
    res.status(403).json({
      error: "mfa_challenge_required",
      detail: "Re-verify your authenticator code before disabling MFA.",
    });
    return;
  }
  await disableMfa(userId);
  res.json({ ok: true });
});

router.post(
  "/mfa/totp/regenerate-backup-codes",
  sensitiveMfaRateLimit,
  async (req: Request, res: Response) => {
    const userId = requireUserId(req, res);
    if (!userId) return;
    // Same gate as /disable: a fresh assertion (last 15 min) is required
    // so a stolen primary cookie can't burn through the existing codes
    // by minting a new sheet.
    if (!(await hasRecentChallenge(userId))) {
      res.status(403).json({
        error: "mfa_challenge_required",
        detail:
          "Re-verify your authenticator code before regenerating backup codes.",
      });
      return;
    }
    try {
      // Security tripwire: capture network context BEFORE rotating so
      // the lib can inline IP/user-agent into the out-of-band email.
      // If an attacker who phished the primary password and a single
      // TOTP code mints new codes to lock the legitimate owner out,
      // the owner sees the alert (with the regen's IP/device) in
      // their inbox instead of finding their sheet silently swapped.
      const ipAddress = clientIpFromRequest(req);
      const userAgent = (req.get("user-agent") ?? "").slice(0, 256);
      const occurredAt = new Date();
      const codes = await regenerateBackupCodes(userId, {
        ipAddress,
        userAgent,
        occurredAt,
      });
      if (!codes) {
        res.status(404).json({
          error: "mfa_not_enrolled",
          detail:
            "No active TOTP enrolment found. Enrol an authenticator first.",
        });
        return;
      }
      // Append-only audit row alongside the email — gives trust &
      // safety a queryable trail when investigating a complaint
      // ("did this user really regenerate on April 3rd from this
      // IP?"). Fire-and-forget so an audit-table hiccup never
      // poisons the user-visible 200.
      void emitBackupCodeRegenerationAuditRow({
        userId,
        ipAddress,
        userAgent,
        occurredAt,
      });
      res.json({ backupCodes: codes });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, userId },
        "mfa_regen_backup_codes_failed",
      );
      res.status(500).json({ error: "mfa_regen_backup_codes_failed" });
    }
  },
);

/**
 * Express middleware factory. Mount on routes that move money or change
 * money-flow configuration:
 *
 *   router.post("/payouts", requireMfa(), handler)
 *
 * Behaviour:
 *  - Reads the rolling 30d velocity. Below threshold AND not an admin →
 *    pass-through.
 *  - Above threshold OR admin role → require active TOTP enrolment.
 *    Returns 403 mfa_required when not enrolled, 403 mfa_challenge_required
 *    when enrolled but no recent assertion (within the last 15 minutes).
 *  - Bearer-only metadata (no userId) → 401 unauthorised.
 */
export function requireMfa(): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const isAdmin = await userHasAnyRole(userId, ["admin", "moderator", "finance_ops", "support"]).catch(() => false);
      let needs = isAdmin;
      if (!needs) {
        const velocity = await thirtyDayVelocityNgnMinor(userId);
        needs = velocity >= HIGH_VELOCITY_THRESHOLD_NGN_MINOR;
      }
      if (!needs) return next();
      const status = await getMfaStatus(userId);
      if (!status.enrolled) {
        res.status(403).json({
          error: "mfa_required",
          detail: "This account requires multi-factor authentication. Set up TOTP in account settings.",
        });
        return;
      }
      if (!status.recentlyAsserted) {
        res.status(403).json({
          error: "mfa_challenge_required",
          detail: "Verify your authenticator code to continue.",
        });
        return;
      }
      next();
    })().catch((err) => {
      logger.error({ err: (err as Error).message }, "require_mfa_failed");
      res.status(500).json({ error: "internal" });
    });
  };
}

/**
 * Best-effort client IP extraction. We honour `X-Forwarded-For` because
 * the API runs behind the workspace proxy and Replit's deployment edge,
 * so `req.socket.remoteAddress` would otherwise just be the proxy. The
 * leftmost hop in `X-Forwarded-For` is the original client. We trim and
 * cap the value so a hostile header can't bloat the audit row or the
 * notification payload.
 */
function clientIpFromRequest(req: Request): string {
  const xff = req.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const direct = req.ip ?? req.socket.remoteAddress ?? "";
  return direct.slice(0, 64);
}

interface BackupCodeRegenerationAuditInput {
  userId: string;
  ipAddress: string;
  userAgent: string;
  occurredAt: Date;
}

/**
 * Fire-and-forget audit-row writer for a successful backup-code
 * regeneration. The out-of-band confirmation email is emitted by the
 * lib (`regenerateBackupCodes`) so it stays close to the actual state
 * change and is shared with non-route callers. We keep the audit row
 * here at the route layer so it lives alongside the request-side
 * context (IP/user-agent) without leaking the audit dependency into
 * the lib.
 *
 * Wrapped so a DB hiccup is logged but never bubbles into the caller's
 * 200 response — the user already saw the new codes, and a missing
 * audit row should not look to the SPA like the regenerate failed.
 */
async function emitBackupCodeRegenerationAuditRow(
  input: BackupCodeRegenerationAuditInput,
): Promise<void> {
  const { userId, ipAddress, userAgent, occurredAt } = input;
  try {
    await recordAudit({
      actorId: userId,
      action: "mfa.backup_codes.regenerated",
      entity: "mfaEnrollment",
      entityId: userId,
      payload: {
        ipAddress,
        userAgent,
        occurredAt: occurredAt.toISOString(),
      },
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, userId },
      "mfa_backup_codes_regenerated_audit_failed",
    );
  }
}

export default router;
