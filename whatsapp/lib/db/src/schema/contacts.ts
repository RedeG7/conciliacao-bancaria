import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { campaignsTable } from "./campaigns";

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  extraFields: jsonb("extra_fields").notNull().default({}),
  status: text("status").notNull().default("pending"),
  sentAt: timestamp("sent_at"),
  message: text("message").notNull().default(""),
});

export const insertContactSchema = createInsertSchema(contactsTable).omit({ id: true, sentAt: true });
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
