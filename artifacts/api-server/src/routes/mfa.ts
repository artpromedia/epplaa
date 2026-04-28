import { Router, type IRouter, type Request, type Response, type RequestHandler } from "express";
import { requireUserId } from "../lib/auth";
import { logger } from "../lib/logger";
import { userHasAnyRole } from "../lib/roles";
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

router.post("/mfa/totp/setup", async (req: Request, res: Response) => {
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

router.post("/mfa/totp/verify", async (req: Request, res: Response) => {
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

router.post("/mfa/backup-code", async (req: Request, res: Response) => {
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

router.post("/mfa/totp/disable", async (req: Request, res: Response) => {
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
      const codes = await regenerateBackupCodes(userId);
      if (!codes) {
        res.status(404).json({
          error: "mfa_not_enrolled",
          detail:
            "No active TOTP enrolment found. Enrol an authenticator first.",
        });
        return;
      }
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

export default router;
