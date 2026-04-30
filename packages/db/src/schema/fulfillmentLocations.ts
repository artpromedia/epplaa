import { pgTable, text, real } from "drizzle-orm/pg-core";

export const fulfillmentLocationsTable = pgTable("fulfillment_locations", {
  id: text("id").primaryKey(),
  optionId: text("option_id").notNull(),
  countryCode: text("country_code").notNull(),
  city: text("city").notNull(),
  name: text("name").notNull(),
  addressLine: text("address_line").notNull(),
  hours: text("hours").notNull().default(""),
  distanceLabel: text("distance_label").notNull().default(""),
  mapX: real("map_x").notNull().default(50),
  mapY: real("map_y").notNull().default(50),
  /** "box" (Epplaa-owned smart locker) | "pudo" (third-party shop) | "store". */
  kind: text("kind").notNull().default("pudo"),
  /** Foreign key into pudo_partners.code when kind="pudo". Null for boxes. */
  partnerCode: text("partner_code"),
});

export type FulfillmentLocation = typeof fulfillmentLocationsTable.$inferSelect;
