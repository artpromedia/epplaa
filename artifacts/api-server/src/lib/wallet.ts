import { eq, desc } from "drizzle-orm";
import { db, schema } from "./db";
import { newWalletTxnId } from "./ids";

export async function ensureWalletBootstrapped(userId: string): Promise<void> {
  const existing = await db
    .select({ userId: schema.walletSettingsTable.userId })
    .from(schema.walletSettingsTable)
    .where(eq(schema.walletSettingsTable.userId, userId))
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(schema.walletSettingsTable).values({ userId, currencyCode: "NGN" }).onConflictDoNothing();
  await db
    .insert(schema.walletTxnsTable)
    .values({
      id: newWalletTxnId(),
      userId,
      kind: "promo",
      amountMinor: 200000,
      label: "Welcome credit",
    })
    .onConflictDoNothing();
}

export async function getWalletState(userId: string): Promise<{
  balanceMinor: number;
  currencyCode: string;
  txns: Array<{ id: string; kind: string; amountMinor: number; label: string; refId: string | null; atIso: string }>;
}> {
  await ensureWalletBootstrapped(userId);
  const [settings] = await db
    .select()
    .from(schema.walletSettingsTable)
    .where(eq(schema.walletSettingsTable.userId, userId))
    .limit(1);
  const txnRows = await db
    .select()
    .from(schema.walletTxnsTable)
    .where(eq(schema.walletTxnsTable.userId, userId))
    .orderBy(desc(schema.walletTxnsTable.createdAt));
  const balanceMinor = txnRows.reduce((sum, t) => sum + t.amountMinor, 0);
  return {
    balanceMinor,
    currencyCode: settings?.currencyCode ?? "NGN",
    txns: txnRows.map((t) => ({
      id: t.id,
      kind: t.kind,
      amountMinor: t.amountMinor,
      label: t.label,
      refId: t.refId,
      atIso: t.createdAt.toISOString(),
    })),
  };
}
