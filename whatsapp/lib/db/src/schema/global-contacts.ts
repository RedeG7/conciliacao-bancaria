import { pgTable, text, serial, timestamp, integer, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const globalContactsTable = pgTable("global_contacts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  cnpj: text("cnpj"),
  email: text("email"),
  company: text("company"),
  city: text("city"),
  state: text("state"),
  segment: text("segment"),
  openingDate: text("opening_date"),
  zipCode: text("zip_code"),
  neighborhood: text("neighborhood"),
  streetAddress: text("street_address"),
  extraFields: jsonb("extra_fields").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("uq_global_contacts_user_phone").on(table.userId, table.phone),
]);

export const insertGlobalContactSchema = createInsertSchema(globalContactsTable).omit({ id: true, createdAt: true });
export type InsertGlobalContact = z.infer<typeof insertGlobalContactSchema>;
export type GlobalContact = typeof globalContactsTable.$inferSelect;
