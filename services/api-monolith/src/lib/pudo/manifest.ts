import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db";

/**
 * Pure(ish) builder for the per-partner daily PUDO manifest CSV. Both
 * `GET /pudo/:partnerCode/manifest` (operator-pull) and the daily
 * push cron (`./delivery.ts`) call into this so the bytes a partner
 * downloads on demand are byte-identical to the bytes they'll be
 * emailed / SFTP'd that morning. That's what makes `contentHash` a
 * useful dedupe key across both code paths.
 *
 * The shape is intentionally narrow — it returns the rendered CSV
 * along with the count of orders included and a stable 16-char hex
 * hash of the bytes. Persistence of the run row is left to the
 * caller because the route writes a row on every fetch (audit trail
 * for "this partner pulled at HH:MM today") whereas the cron writes
 * + updates a single row per (partner, date) tracking transport
 * status.
 */
export interface BuildManifestResult {
  csv: string;
  shipmentCount: number;
  contentHash: string;
  /** Locations (id) operated by this partner. Empty array == no rows. */
  locationIds: string[];
}

export async function buildManifestCsv(
  partnerCode: string,
): Promise<BuildManifestResult> {
  const locations = await db
    .select({
      id: schema.fulfillmentLocationsTable.id,
      name: schema.fulfillmentLocationsTable.name,
      city: schema.fulfillmentLocationsTable.city,
    })
    .from(schema.fulfillmentLocationsTable)
    .where(eq(schema.fulfillmentLocationsTable.partnerCode, partnerCode));

  const locationsById = new Map(locations.map((l) => [l.id, l]));
  const locIds = locations.map((l) => l.id);

  const lines: string[] = [
    "order_id,buyer_name,location_id,location_name,city,pickup_otp,created_at",
  ];

  if (locIds.length === 0) {
    const csv = lines.join("\n");
    return {
      csv,
      shipmentCount: 0,
      contentHash: contentHashOf(csv),
      locationIds: [],
    };
  }

  // Pending PUDO shipments are box-carrier shipments whose order
  // pickup location belongs to this partner and whose status is not
  // yet collected or returned. The IN-list is built via parameter
  // binding so partner-controlled location ids can never inject SQL —
  // even though we own the rows, this is the right pattern for a row
  // that powers an external integration.
  const orders = await db
    .select()
    .from(schema.ordersTable)
    .where(
      and(
        sql`${schema.ordersTable.fulfillment} ->> 'locationId' IN ${sql.raw(
          `(${locIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`,
        )}`,
        sql`${schema.ordersTable.status} IN ('ready_for_pickup','out_for_delivery','placed')`,
      ),
    );

  // Deterministic ordering — without this, two builds milliseconds
  // apart can shuffle rows and the contentHash flips, defeating the
  // dedupe. Sorting by createdAt then id is stable and matches what
  // a partner expects to see in their inbox: oldest pickups first.
  orders.sort((a, b) => {
    const ta = a.createdAt.getTime();
    const tb = b.createdAt.getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  for (const o of orders) {
    const f = (o.fulfillment as Record<string, unknown>) ?? {};
    const locId = String(f.locationId ?? "");
    const loc = locationsById.get(locId);
    const buyer =
      ((o.payment as { recipientName?: string } | null) ?? {}).recipientName ?? "";
    const cells = [
      o.id,
      buyer,
      locId,
      loc?.name ?? "",
      loc?.city ?? "",
      o.pickupOtp ?? "",
      o.createdAt.toISOString(),
    ].map(csvCell);
    lines.push(cells.join(","));
  }

  const csv = lines.join("\n");
  return {
    csv,
    shipmentCount: orders.length,
    contentHash: contentHashOf(csv),
    locationIds: locIds,
  };
}

export function contentHashOf(csv: string): string {
  return createHash("sha256").update(csv).digest("hex").slice(0, 16);
}

export function csvCell(s: string | null | undefined): string {
  const v = String(s ?? "");
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
