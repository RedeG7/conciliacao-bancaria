import app from "./app";
import { logger } from "./lib/logger";
import { whatsappService, getPhoneVariants, canonicalPhone } from "./lib/whatsapp-service";
import { seedSuperAdmin } from "./lib/seed-users";
import { db, conversationsTable, messagesTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";

async function mergeDuplicateConversations() {
  try {
    const allConvs = await db.select().from(conversationsTable).orderBy(conversationsTable.id);
    const groups = new Map<string, typeof allConvs>();
    for (const conv of allConvs) {
      const canon = canonicalPhone(conv.phone);
      if (!groups.has(canon)) groups.set(canon, []);
      groups.get(canon)!.push(conv);
    }
    let mergedCount = 0;
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.id - b.id);
      const primary = group[0];
      const duplicates = group.slice(1);
      const dupIds = duplicates.map((d) => d.id);
      for (const dupId of dupIds) {
        await db.update(messagesTable).set({ conversationId: primary.id }).where(eq(messagesTable.conversationId, dupId));
      }
      const lastMsg = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, primary.id)).orderBy(desc(messagesTable.timestamp)).limit(1);
      const unreadSum = duplicates.reduce((s, d) => s + (d.unreadCount ?? 0), 0);
      await db.update(conversationsTable).set({
        phone: canonicalPhone(primary.phone),
        unreadCount: (primary.unreadCount ?? 0) + unreadSum,
        lastMessageBody: lastMsg[0]?.body ?? primary.lastMessageBody,
        lastMessageAt: lastMsg[0]?.timestamp ?? primary.lastMessageAt,
        contactName: primary.contactName ?? duplicates.find((d) => d.contactName)?.contactName ?? null,
      }).where(eq(conversationsTable.id, primary.id));
      await db.delete(conversationsTable).where(inArray(conversationsTable.id, dupIds));
      mergedCount += duplicates.length;
      logger.info({ primaryId: primary.id, mergedIds: dupIds, phone: canonicalPhone(primary.phone) }, "Startup: merged duplicate conversations");
    }
    if (mergedCount > 0) logger.info({ mergedCount }, "Startup: duplicate conversation merge complete");
  } catch (err) {
    logger.warn({ err }, "Startup: could not merge duplicate conversations");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  seedSuperAdmin().catch((err) => {
    logger.warn({ err }, "Could not seed super admin");
  });

  mergeDuplicateConversations();

  whatsappService.tryRestoreSession().catch((err) => {
    logger.warn({ err }, "WhatsApp: could not restore session");
  });
});
