import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const sellersTable = pgTable("sellers", {
  userId: text("user_id").primaryKey(),
  status: text("status").notNull().default("none"),
  tier: text("tier").notNull().default("starter"),
  mode: text("mode").notNull().default("buyer"),
  application: jsonb("application"),
  stats: jsonb("stats"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Seller = typeof sellersTable.$inferSelect;
