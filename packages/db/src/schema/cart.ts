import { pgTable, text, integer, primaryKey, timestamp } from "drizzle-orm/pg-core";

export const cartItemsTable = pgTable(
  "cart_items",
  {
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull(),
    qty: integer("qty").notNull().default(1),
    variantNotes: text("variant_notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

export type CartItem = typeof cartItemsTable.$inferSelect;
