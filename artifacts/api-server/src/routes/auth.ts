import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import { db, schema } from "../lib/db";
import { startOtp, verifyOtp, normalizePhone, type OtpChannel } from "../lib/otp";
import { ensureWalletBootstrapped } from "../lib/wallet";
import { logger } from "../lib/logger";
import { requireUserId } from "../lib/auth";

const router: IRouter = Router();

/**
 * Public: start a phone OTP for sign-in/sign-up. Returns the dev code when
 * Termii isn't configured so the SPA can complete e2e tests offline.
 */
router.post("/auth/otp/start", async (req: Request, res: Response) => {
  const body = req.body as { phone?: string; channel?: OtpChannel; phoneCountry?: string };
  const phone = normalizePhone(String(body.phone ?? ""));
  const channel: OtpChannel = body.channel === "sms" ? "sms" : "whatsapp";
  if (!phone) {
    res.status(400).json({ error: "invalid_phone", detail: "Use international format e.g. +234..." });
    return;
  }
  try {
    const out = await startOtp({ phone, channel, purpose: "sign_in" });
    if (out.rateLimited) {
      res.status(429).json({ error: "rate_limited", detail: "Too many requests. Try again in a few minutes." });
      return;
    }
    res.json({ ok: true, otpId: out.otpId, devCode: out.devCode });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "otp_start_failed");
    res.status(500).json({ error: "otp_start_failed" });
  }
});

/**
 * Public: verify the OTP and return a Clerk sign-in token the SPA hands to
 * `setActive({ session })` to complete sign-in.
 *
 * Falls back to a `noClerk` payload when CLERK_SECRET_KEY isn't set so dev
 * environments can still test the OTP loop end to end.
 */
router.post("/auth/otp/verify", async (req: Request, res: Response) => {
  const body = req.body as { phone?: string; code?: string; phoneCountry?: string };
  const phone = normalizePhone(String(body.phone ?? ""));
  const code = String(body.code ?? "").trim();
  if (!phone || !code) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  const result = await verifyOtp({ phone, code });
  if (!result.ok) {
    const status = result.reason === "wrong_code" ? 401 : 400;
    res.status(status).json({ error: result.reason ?? "verify_failed" });
    return;
  }

  if (!process.env.CLERK_SECRET_KEY) {
    // No Clerk in dev — return a stub so the OTP loop is still testable.
    res.json({ ok: true, noClerk: true, phone });
    return;
  }
  try {
    const clerkUser = await findOrCreateClerkUserByPhone(phone);
    if (!clerkUser?.id) {
      res.status(500).json({ error: "user_provision_failed" });
      return;
    }
    // Persist phone + verified time on our users table so prefs / pickup OTP
    // copies have a fallback recipient.
    await db
      .insert(schema.usersTable)
      .values({
        clerkId: clerkUser.id,
        email: clerkUser.email ?? "",
        displayName: clerkUser.displayName ?? "",
        avatarUrl: "",
        countryCode: body.phoneCountry || "NG",
        phone,
        phoneCountry: body.phoneCountry || "NG",
        phoneVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.usersTable.clerkId,
        set: { phone, phoneCountry: body.phoneCountry || "NG", phoneVerifiedAt: new Date() },
      });
    await ensureWalletBootstrapped(clerkUser.id);
    const ticket = await clerkClient.signInTokens.createSignInToken({ userId: clerkUser.id, expiresInSeconds: 600 });
    res.json({ ok: true, ticket: ticket.token, userId: clerkUser.id });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "otp_verify_clerk_failed");
    res.status(502).json({ error: "clerk_provision_failed", detail: (err as Error).message });
  }
});

/**
 * Authenticated: link a verified phone to the existing Clerk user.
 * Used when a user signed in with email and now wants to add their phone.
 */
router.patch("/me/phone", async (req: Request, res: Response) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { phone?: string; code?: string; phoneCountry?: string };
  const phone = normalizePhone(String(body.phone ?? ""));
  const code = String(body.code ?? "").trim();
  if (!phone || !code) {
    res.status(400).json({ error: "missing_fields" });
    return;
  }
  const result = await verifyOtp({ phone, code });
  if (!result.ok) {
    res.status(400).json({ error: result.reason ?? "verify_failed" });
    return;
  }
  await db
    .update(schema.usersTable)
    .set({ phone, phoneCountry: body.phoneCountry || "NG", phoneVerifiedAt: new Date() })
    .where(eq(schema.usersTable.clerkId, userId));
  res.json({ ok: true, phone });
});

interface ClerkUserShape {
  id: string;
  email?: string;
  displayName?: string;
}

/**
 * Look up a Clerk user by phone; create one if missing. Uses the admin
 * `users.getUserList({ phoneNumber })` API which returns 0..N matches.
 */
async function findOrCreateClerkUserByPhone(phone: string): Promise<ClerkUserShape | null> {
  try {
    const matches = await clerkClient.users.getUserList({ phoneNumber: [phone], limit: 1 });
    const list = (matches as unknown as { data?: unknown[] }).data ?? (matches as unknown as unknown[]);
    const arr = Array.isArray(list) ? list : [];
    if (arr.length > 0) {
      const u = arr[0] as { id: string; emailAddresses?: { emailAddress: string }[]; firstName?: string; lastName?: string };
      return {
        id: u.id,
        email: u.emailAddresses?.[0]?.emailAddress ?? "",
        displayName: [u.firstName, u.lastName].filter(Boolean).join(" "),
      };
    }
    const created = await clerkClient.users.createUser({ phoneNumber: [phone], skipPasswordChecks: true, skipPasswordRequirement: true });
    return { id: created.id, email: "", displayName: "" };
  } catch (err) {
    logger.error({ err: (err as Error).message }, "clerk_phone_lookup_failed");
    return null;
  }
}

export default router;
