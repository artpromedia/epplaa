import { Router, type IRouter } from "express";
import { enqueueNotification } from "../lib/notifications";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * INTERNAL ONLY — broadcast a promo notification to a list of users.
 * This is the producer site for the `promo` event type. Like
 * /referrals/payout it is gated by INTERNAL_API_KEY (x-internal-key
 * header). Per-user delivery still respects the recipient's `promos`
 * preference and quiet hours; this endpoint only enqueues, the outbox
 * worker filters.
 *
 * Body: { userIds: string[], title, body, url? }
 * Returns: { ok, enqueued, attempted } — `attempted` is the number of input
 * userIds; `enqueued` is the actual count of outbox rows written across all
 * users. Preferences (promos toggle) and quiet hours are resolved inside
 * enqueueNotification at enqueue time, so a user with promos disabled
 * contributes 0 rows here — they are not silently delivered later.
 */
const MAX_BROADCAST = 1000;
router.post("/promos/broadcast", async (req, res) => {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    res.status(503).json({ error: "not_configured", detail: "INTERNAL_API_KEY unset" });
    return;
  }
  if (req.header("x-internal-key") !== expected) {
    res.status(403).json({ error: "forbidden", detail: "internal endpoint" });
    return;
  }
  const body = (req.body ?? {}) as {
    userIds?: unknown;
    title?: unknown;
    body?: unknown;
    url?: unknown;
  };
  const userIds = Array.isArray(body.userIds)
    ? body.userIds.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const url = typeof body.url === "string" ? body.url : undefined;
  if (userIds.length === 0 || userIds.length > MAX_BROADCAST || !title || !text) {
    res.status(400).json({
      error: "bad_request",
      detail: `userIds[1..${MAX_BROADCAST}], non-empty title and body required`,
    });
    return;
  }
  // Sum the actual outbox rows written (per-channel) rather than just
  // counting users attempted, so observability reflects what the worker
  // will actually try to deliver. A user with promos disabled or no
  // configured channels contributes 0.
  let enqueued = 0;
  let attempted = 0;
  for (const userId of userIds) {
    attempted++;
    try {
      const r = await enqueueNotification({
        userId,
        eventType: "promo",
        payload: { title, body: text, url },
      });
      enqueued += r.enqueued;
    } catch (err) {
      logger.error({ err: (err as Error).message, userId }, "notify_promo_enqueue_failed");
    }
  }
  res.json({ ok: true, enqueued, attempted });
});

export default router;
