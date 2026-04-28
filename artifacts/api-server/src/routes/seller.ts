import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, schema } from "../lib/db";
import { requireUserId } from "../lib/auth";
import { newListingId } from "../lib/ids";
import { newPayoutId, newPayoutReference } from "../lib/ids";
import { COUNTRY_BY_CODE } from "../lib/static";
import { enqueueNotification } from "../lib/notifications";
import { logger } from "../lib/logger";
import { requiredTierForOrder } from "../lib/kyc";
import { sellerSanctionsBlocked, screenSubject } from "../lib/sanctions";

const router: IRouter = Router();

const COMMISSION_RATE = 0.1;
const HOLD_DAYS = 3;

const DEFAULT_PROFILE = {
  status: "none",
  tier: "starter",
  mode: "buyer",
  application: null,
  stats: null,
};

async function getProfile(userId: string) {
  const [row] = await db.select().from(schema.sellersTable).where(eq(schema.sellersTable.userId, userId)).limit(1);
  if (!row) return { ...DEFAULT_PROFILE };
  return {
    status: row.status,
    tier: row.tier,
    mode: row.mode,
    application: row.application,
    stats: row.stats,
  };
}

async function upsertProfile(userId: string, patch: Partial<typeof schema.sellersTable.$inferInsert>) {
  const [row] = await db
    .insert(schema.sellersTable)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: schema.sellersTable.userId, set: patch })
    .returning();
  return {
    status: row.status,
    tier: row.tier,
    mode: row.mode,
    application: row.application,
    stats: row.stats,
  };
}

router.get("/seller/me", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  res.json(await getProfile(userId));
});

router.post("/seller/apply", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const application = (req.body ?? {}) as Record<string, unknown>;
  const profile = await upsertProfile(userId, {
    application,
    status: "approved",
    mode: "seller",
    stats: {
      lifetimeGMVMinor: 0,
      thisMonthGMVMinor: 0,
      ordersTotal: 0,
      ordersPending: 0,
      listingCount: 0,
      daysAsSeller: 0,
    },
  });
  // Compliance: every newly-onboarded seller (or seller updating their
  // legal identity) gets a sanctions screen. Stub provider blocks names
  // containing "BLOCKED" and KP/IR/SY/CU country codes; persisted result
  // is what `sellerSanctionsBlocked` reads at payout time. We don't fail
  // the apply call on a hit — the seller can still onboard, but payouts
  // will be parked until trust & safety clears them.
  const subjectName =
    (typeof application.legalName === "string" && application.legalName.trim()) ||
    (typeof application.businessName === "string" && application.businessName.trim()) ||
    userId;
  const country = typeof application.country === "string" ? application.country : "NG";
  await screenSubject({ userId, name: subjectName, country });
  res.json(profile);
});

router.post("/seller/mode", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const mode = String((req.body as { mode?: string }).mode ?? "buyer");
  if (mode !== "buyer" && mode !== "seller") {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  res.json(await upsertProfile(userId, { mode }));
});

router.post("/seller/upgrade", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const tier = String((req.body as { tier?: string }).tier ?? "");
  if (!["starter", "pro", "elite"].includes(tier)) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  res.json(await upsertProfile(userId, { tier }));
});

router.get("/seller/listings", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.sellerListingsTable)
    .where(eq(schema.sellerListingsTable.userId, userId))
    .orderBy(desc(schema.sellerListingsTable.createdAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      priceMinor: r.priceMinor,
      countryCode: r.countryCode,
      category: r.category,
      inventory: r.inventory,
      status: r.status,
      createdAtIso: r.createdAt.toISOString(),
    })),
  );
});

router.post("/seller/listings", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { title: string; priceMinor: number; countryCode: string; category?: string; inventory?: number };
  const [row] = await db
    .insert(schema.sellerListingsTable)
    .values({
      id: newListingId(),
      userId,
      title: body.title,
      priceMinor: Number(body.priceMinor),
      countryCode: body.countryCode,
      category: body.category ?? "Other",
      inventory: Number(body.inventory ?? 0),
      status: "active",
    })
    .returning();
  res.status(201).json({
    id: row.id,
    title: row.title,
    priceMinor: row.priceMinor,
    countryCode: row.countryCode,
    category: row.category,
    inventory: row.inventory,
    status: row.status,
    createdAtIso: row.createdAt.toISOString(),
  });
});

router.delete("/seller/listings/:listingId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await db
    .delete(schema.sellerListingsTable)
    .where(and(eq(schema.sellerListingsTable.userId, userId), eq(schema.sellerListingsTable.id, req.params.listingId)));
  res.status(204).end();
});

router.patch("/seller/listings/:listingId", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as Partial<{ title: string; priceMinor: number; category: string; inventory: number; status: "draft" | "active" }>;
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.priceMinor === "number") patch.priceMinor = body.priceMinor;
  if (typeof body.category === "string") patch.category = body.category;
  if (typeof body.inventory === "number") patch.inventory = body.inventory;
  if (body.status === "draft" || body.status === "active") patch.status = body.status;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no_fields" });
    return;
  }
  // Snapshot pre-update inventory so we only fire low_stock on the
  // crossing edge (avoid spamming on every PATCH while already low).
  const [before] = await db
    .select({ inventory: schema.sellerListingsTable.inventory })
    .from(schema.sellerListingsTable)
    .where(and(eq(schema.sellerListingsTable.userId, userId), eq(schema.sellerListingsTable.id, req.params.listingId)))
    .limit(1);
  const [row] = await db
    .update(schema.sellerListingsTable)
    .set(patch)
    .where(and(eq(schema.sellerListingsTable.userId, userId), eq(schema.sellerListingsTable.id, req.params.listingId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // low_stock producer: fire when inventory drops to (0, LOW_STOCK_THRESHOLD]
  // and was previously above the threshold. Restocks above the threshold do
  // not fire. Zero (out of stock) is intentionally still notified — it's
  // the most actionable case for the seller.
  const LOW_STOCK_THRESHOLD = 5;
  const prev = before?.inventory ?? Infinity;
  if (
    typeof patch.inventory === "number" &&
    row.inventory <= LOW_STOCK_THRESHOLD &&
    prev > LOW_STOCK_THRESHOLD
  ) {
    try {
      await enqueueNotification({
        userId,
        eventType: "low_stock",
        payload: {
          title: row.inventory === 0 ? "Out of stock" : "Low stock",
          body: `${row.title} — ${row.inventory} left`,
          url: `/seller/listings/${row.id}`,
          listingId: row.id,
          inventory: row.inventory,
        },
      });
    } catch (err) {
      logger.error({ err: (err as Error).message, listingId: row.id }, "notify_low_stock_failed");
    }
  }
  res.json({
    id: row.id,
    title: row.title,
    priceMinor: row.priceMinor,
    countryCode: row.countryCode,
    category: row.category,
    inventory: row.inventory,
    status: row.status,
    createdAtIso: row.createdAt.toISOString(),
  });
});

function rowToSellerOrder(r: typeof schema.sellerOrdersTable.$inferSelect) {
  return {
    id: r.id,
    buyerName: r.buyerName,
    buyerHandle: r.buyerHandle,
    buyerAvatar: r.buyerAvatar,
    productTitle: r.productTitle,
    productImage: r.productImage,
    qty: r.qty,
    unitPriceMinor: r.unitPriceMinor,
    countryCode: r.countryCode,
    currencyCode: r.currencyCode,
    status: r.status,
    fulfillmentLabel: r.fulfillmentLabel,
    pickupOtp: r.pickupOtp,
    pickupLocationName: r.pickupLocationName,
    trackingNote: r.trackingNote,
    placedAtIso: r.placedAt.toISOString(),
    shippedAtIso: r.shippedAt?.toISOString() ?? null,
    deliveredAtIso: r.deliveredAt?.toISOString() ?? null,
  };
}

router.get("/seller/orders", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.sellerOrdersTable)
    .where(eq(schema.sellerOrdersTable.userId, userId))
    .orderBy(desc(schema.sellerOrdersTable.placedAt));
  res.json(rows.map(rowToSellerOrder));
});

router.post("/seller/orders/:sellerOrderId/transitions", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { status?: string; trackingNote?: string };
  const status = String(body.status ?? "");
  if (!status) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const patch: Partial<typeof schema.sellerOrdersTable.$inferInsert> = { status };
  if (body.trackingNote !== undefined) patch.trackingNote = body.trackingNote;
  if (status === "shipped") patch.shippedAt = new Date();
  if (status === "delivered" || status === "completed") patch.deliveredAt = new Date();
  const [row] = await db
    .update(schema.sellerOrdersTable)
    .set(patch)
    .where(and(eq(schema.sellerOrdersTable.userId, userId), eq(schema.sellerOrdersTable.id, req.params.sellerOrderId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Buyer-side notifications for status changes that the buyer cares about.
  // Only fires when the seller_order row is linked to a buyer account
  // (buyerUserId column). Historical seed rows have no link and are skipped.
  if (row.buyerUserId) {
    try {
      if (status === "shipped") {
        await enqueueNotification({
          userId: row.buyerUserId,
          eventType: "order_dispatched",
          payload: {
            title: "Your order is on the way",
            body: row.productTitle,
            url: row.orderId ? `/orders/${row.orderId}` : "/account/orders",
            orderId: row.orderId ?? row.id,
          },
        });
      } else if (status === "delivered" || status === "completed") {
        await enqueueNotification({
          userId: row.buyerUserId,
          eventType: "order_delivered",
          payload: {
            title: "Order delivered",
            body: row.productTitle,
            url: row.orderId ? `/orders/${row.orderId}` : "/account/orders",
            orderId: row.orderId ?? row.id,
          },
        });
      }
    } catch (err) {
      logger.error(
        { err: (err as Error).message, sellerOrderId: row.id },
        "notify_seller_order_transition_failed",
      );
    }
  }
  res.json(rowToSellerOrder(row));
});

router.get("/seller/streams", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const rows = await db
    .select()
    .from(schema.sellerStreamsTable)
    .where(eq(schema.sellerStreamsTable.userId, userId))
    .orderBy(desc(schema.sellerStreamsTable.startedAt));
  res.json(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      startedAtIso: r.startedAt.toISOString(),
      durationMinutes: r.durationMinutes,
      peakViewers: r.peakViewers,
      totalViewers: r.totalViewers,
      ordersCount: r.ordersCount,
      grossMinor: r.grossMinor,
      posterImage: r.posterImage,
      productIds: r.productIds,
    })),
  );
});

router.get("/seller/earnings", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const countryCode = String(req.query.countryCode ?? "NG");
  const country = COUNTRY_BY_CODE.get(countryCode);
  const minorPerMajor = country?.currency.minorPerMajor ?? 100;
  const profile = await getProfile(userId);
  const stats = (profile.stats as { lifetimeGMVMinor?: number; thisMonthGMVMinor?: number; ordersTotal?: number; ordersPending?: number } | null) ?? null;
  const lifetimeGmvMinor = stats?.lifetimeGMVMinor ?? 0;
  const thisMonthGmvMinor = stats?.thisMonthGMVMinor ?? 0;
  const commissionMinor = Math.round(lifetimeGmvMinor * COMMISSION_RATE);
  const netLifetimeMinor = lifetimeGmvMinor - commissionMinor;
  const payoutRows = await db
    .select()
    .from(schema.payoutsTable)
    .where(eq(schema.payoutsTable.userId, userId))
    .orderBy(desc(schema.payoutsTable.requestedAt));
  const pendingPayoutMinor = payoutRows.filter((p) => p.status === "pending").reduce((s, p) => s + p.amountMinor, 0);
  const paidOutMinor = payoutRows.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountMinor, 0);
  const availableMinor = Math.max(0, netLifetimeMinor - pendingPayoutMinor - paidOutMinor);
  res.json({
    lifetimeGmvMinor,
    thisMonthGmvMinor,
    commissionMinor,
    netLifetimeMinor,
    pendingPayoutMinor,
    paidOutMinor,
    availableMinor,
    ordersTotal: stats?.ordersTotal ?? 0,
    ordersPending: stats?.ordersPending ?? 0,
    payouts: payoutRows.map((p) => ({
      id: p.id,
      requestedAtIso: p.requestedAt.toISOString(),
      amountMinor: p.amountMinor,
      status: p.status,
      bankLabel: p.bankLabel,
      bankLast4: p.bankLast4,
      reference: p.reference,
      paidAtIso: p.paidAt?.toISOString() ?? null,
      // Surface the block reason so the UI can render an actionable hint
      // (e.g. "kyc_tier_required:2" → "Verify Tier 2 KYC to unlock").
      errorMessage: p.errorMessage,
      requiredKycTier: p.requiredKycTier,
    })),
    payoutThresholdMinor: 5000 * minorPerMajor,
    holdDays: HOLD_DAYS,
  });
});

router.post("/seller/payouts", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = req.body as { amountMinor?: number };
  const amount = Number(body.amountMinor ?? 0);
  if (amount <= 0) {
    res.status(400).json({ error: "bad_request" });
    return;
  }
  const profile = await getProfile(userId);
  const application = profile.application as { payoutBank?: string; payoutAccountLast4?: string } | null;
  // Compliance gate — same rules that protect order-driven payouts.
  // We compute the rolling-30d threshold INCLUDING this withdrawal and
  // require the seller's verified `kycTier` to meet it. We also park the
  // request when the most recent sanctions screen is flagged. The row
  // is still created so the seller can see why it's stuck and so the
  // cron can release it once KYC clears.
  const { requiredTier } = await requiredTierForOrder(userId, amount);
  const sellerKycTier = (profile as { kycTier?: number } | null)?.kycTier ?? 1;
  const sanctionsBlocked = await sellerSanctionsBlocked(userId);
  const blocked = sellerKycTier < requiredTier || sanctionsBlocked;
  const status = blocked ? "blocked" : "pending";
  const errorMessage = sanctionsBlocked
    ? "sanctions_review_required"
    : sellerKycTier < requiredTier
      ? `kyc_tier_required:${requiredTier}`
      : null;
  const [row] = await db
    .insert(schema.payoutsTable)
    .values({
      id: newPayoutId(),
      userId,
      amountMinor: amount,
      status,
      bankLabel: application?.payoutBank ?? "Bank",
      bankLast4: application?.payoutAccountLast4 ?? "0000",
      reference: newPayoutReference(),
      requiredKycTier: requiredTier,
      errorMessage,
    })
    .returning();
  res.status(201).json({
    id: row.id,
    requestedAtIso: row.requestedAt.toISOString(),
    amountMinor: row.amountMinor,
    status: row.status,
    bankLabel: row.bankLabel,
    bankLast4: row.bankLast4,
    reference: row.reference,
    paidAtIso: row.paidAt?.toISOString() ?? null,
  });
});

router.post("/seller/payouts/:payoutId/mark-paid", async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const [row] = await db
    .update(schema.payoutsTable)
    .set({ status: "paid", paidAt: new Date() })
    .where(and(eq(schema.payoutsTable.userId, userId), eq(schema.payoutsTable.id, req.params.payoutId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({
    id: row.id,
    requestedAtIso: row.requestedAt.toISOString(),
    amountMinor: row.amountMinor,
    status: row.status,
    bankLabel: row.bankLabel,
    bankLast4: row.bankLast4,
    reference: row.reference,
    paidAtIso: row.paidAt?.toISOString() ?? null,
  });
});

export default router;
