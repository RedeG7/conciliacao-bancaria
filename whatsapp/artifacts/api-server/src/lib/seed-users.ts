import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

export async function seedSuperAdmin() {
  const existing = await db.select().from(usersTable).limit(1);
  if (existing.length > 0) return;

  const username = process.env.AUTH_USERNAME || "admin";
  const password = process.env.AUTH_PASSWORD || "admin123";
  const passwordHash = await bcrypt.hash(password, 10);

  await db.insert(usersTable).values({
    username,
    passwordHash,
    name: "Administrador",
    role: "super_admin",
    isActive: true,
  });

  logger.info({ username }, "Seeded initial super admin user");
}
