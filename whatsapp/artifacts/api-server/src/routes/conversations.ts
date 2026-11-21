import { Router, type Request, type Response } from "express";
import multer from "multer";
import { db, conversationsTable, messagesTable, contactsTable, campaignsTable } from "@workspace/db";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { whatsappService, getPhoneVariants, canonicalPhone } from "../lib/whatsapp-service";
import { logger } from "../lib/logger";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function getSession(req: Request) {
  const s = req.session as any;
  return { userId: s?.userId as number, role: s?.role as string };
}

function isSuperAdmin(req: Request) {
  return (req.session as any)?.role === "super_admin";
}

// GET /api/conversations
router.get("/", async (req: Request, res: Response) => {
  const { userId } = getSession(req);
  const admin = isSuperAdmin(req);

  const rows = await db
    .select()
    .from(conversationsTable)
    .where(admin ? undefined : eq(conversationsTable.userId, userId))
    .orderBy(desc(conversationsTable.lastMessageAt));

  res.json(rows.map((r) => ({
    ...r,
    lastMessageAt: r.lastMessageAt instanceof Date ? r.lastMessageAt.toISOString() : r.lastMessageAt,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  })));
});

// POST /api/conversations/start — start or retrieve a conversation by phone
router.post("/start", async (req: Request, res: Response) => {
  const { userId } = getSession(req);
  const admin = isSuperAdmin(req);
  const { phone, contactName } = req.body as { phone?: string; contactName?: string };

  if (!phone?.trim()) { res.status(400).json({ error: "Telefone obrigatório." }); return; }

  const cleanPhone = canonicalPhone(phone.replace(/[^0-9]/g, ""));
  const phoneVariants = getPhoneVariants(cleanPhone);

  const existing = await db
    .select()
    .from(conversationsTable)
    .where(phoneVariants.length > 1 ? inArray(conversationsTable.phone, phoneVariants) : eq(conversationsTable.phone, cleanPhone))
    .limit(1);

  if (existing.length > 0) {
    const conv = existing[0];
    res.json({
      ...conv,
      lastMessageAt: conv.lastMessageAt instanceof Date ? conv.lastMessageAt.toISOString() : conv.lastMessageAt,
      createdAt: conv.createdAt instanceof Date ? conv.createdAt.toISOString() : conv.createdAt,
    });
    return;
  }

  const [created] = await db
    .insert(conversationsTable)
    .values({
      userId: admin ? null : userId,
      phone: cleanPhone,
      contactName: contactName?.trim() || null,
      campaignId: null,
      lastMessageBody: null,
      lastMessageAt: new Date(),
      unreadCount: 0,
    })
    .returning();

  res.status(201).json({
    ...created,
    lastMessageAt: created.lastMessageAt instanceof Date ? created.lastMessageAt.toISOString() : created.lastMessageAt,
    createdAt: created.createdAt instanceof Date ? created.createdAt.toISOString() : created.createdAt,
  });
});

// POST /api/conversations/merge-duplicates — admin-only: merge conversations with variant phone numbers
router.post("/merge-duplicates", async (req: Request, res: Response) => {
  if (!isSuperAdmin(req)) { res.status(403).json({ error: "Acesso negado." }); return; }

  const allConvs = await db.select().from(conversationsTable).orderBy(conversationsTable.id);

  // Group conversations by canonical phone
  const groups = new Map<string, typeof allConvs>();
  for (const conv of allConvs) {
    const canon = canonicalPhone(conv.phone);
    if (!groups.has(canon)) groups.set(canon, []);
    groups.get(canon)!.push(conv);
  }

  let mergedCount = 0;
  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Keep the oldest conversation (lowest id) as primary
    group.sort((a, b) => a.id - b.id);
    const primary = group[0];
    const duplicates = group.slice(1);

    const dupIds = duplicates.map((d) => d.id);

    // Move all messages from duplicates → primary
    for (const dupId of dupIds) {
      await db.update(messagesTable)
        .set({ conversationId: primary.id })
        .where(eq(messagesTable.conversationId, dupId));
    }

    // Recalculate unread count and last message for primary
    const lastMsg = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, primary.id))
      .orderBy(desc(messagesTable.timestamp))
      .limit(1);

    const unreadSum = duplicates.reduce((s, d) => s + (d.unreadCount ?? 0), 0);

    await db.update(conversationsTable)
      .set({
        phone: canonicalPhone(primary.phone),
        unreadCount: (primary.unreadCount ?? 0) + unreadSum,
        lastMessageBody: lastMsg[0]?.body ?? primary.lastMessageBody,
        lastMessageAt: lastMsg[0]?.timestamp ?? primary.lastMessageAt,
        contactName: primary.contactName ?? duplicates.find((d) => d.contactName)?.contactName ?? null,
      })
      .where(eq(conversationsTable.id, primary.id));

    // Delete duplicate conversations
    await db.delete(conversationsTable).where(inArray(conversationsTable.id, dupIds));

    mergedCount += duplicates.length;
    logger.info({ primaryId: primary.id, mergedIds: dupIds }, "Conversations: merged duplicates");
  }

  res.json({ merged: mergedCount, message: `${mergedCount} conversa(s) duplicada(s) mesclada(s).` });
});

// GET /api/conversations/:id/messages
router.get("/:id/messages", async (req: Request, res: Response) => {
  const { userId } = getSession(req);
  const admin = isSuperAdmin(req);
  const convId = Number(req.params.id);

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada." }); return; }
  if (!admin && conv.userId !== userId) { res.status(403).json({ error: "Acesso negado." }); return; }

  // Mark as read
  await db.update(conversationsTable).set({ unreadCount: 0 }).where(eq(conversationsTable.id, convId));

  const msgs = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(messagesTable.timestamp);

  res.json(msgs.map((m) => ({
    ...m,
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
  })));
});

// POST /api/conversations/:id/reply — send a text message
router.post("/:id/reply", async (req: Request, res: Response) => {
  const { userId } = getSession(req);
  const admin = isSuperAdmin(req);
  const convId = Number(req.params.id);
  const { body } = req.body as { body?: string };

  if (!body?.trim()) { res.status(400).json({ error: "Mensagem não pode estar vazia." }); return; }

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada." }); return; }
  if (!admin && conv.userId !== userId) { res.status(403).json({ error: "Acesso negado." }); return; }

  const { messageId, error: sendError } = await whatsappService.sendMessage(conv.phone, body.trim());
  if (sendError) { res.status(502).json({ error: sendError }); return; }

  const now = new Date();
  const [msg] = await db.insert(messagesTable).values({
    conversationId: convId,
    body: body.trim(),
    direction: "out",
    timestamp: now,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessageBody: body.trim(),
    lastMessageAt: now,
  }).where(eq(conversationsTable.id, convId));

  logger.info({ convId, messageId }, "Conversations: reply sent");

  res.status(201).json({
    ...msg,
    timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
    createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
  });
});

// POST /api/conversations/:id/send-file — send a document/image file
router.post("/:id/send-file", upload.single("file"), async (req: Request, res: Response) => {
  const { userId } = getSession(req);
  const admin = isSuperAdmin(req);
  const convId = Number(req.params.id);

  if (!req.file) { res.status(400).json({ error: "Nenhum arquivo enviado." }); return; }

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada." }); return; }
  if (!admin && conv.userId !== userId) { res.status(403).json({ error: "Acesso negado." }); return; }

  const { buffer, originalname, mimetype } = req.file;

  const { messageId, error: sendError } = await whatsappService.sendFile(conv.phone, buffer, originalname, mimetype);
  if (sendError) { res.status(502).json({ error: sendError }); return; }

  const isImage = mimetype.startsWith("image/");
  const isVideo = mimetype.startsWith("video/");
  const isAudio = mimetype.startsWith("audio/");
  let bodyLabel: string;
  if (isImage) bodyLabel = `[📷 Imagem: ${originalname}]`;
  else if (isVideo) bodyLabel = `[🎥 Vídeo: ${originalname}]`;
  else if (isAudio) bodyLabel = `[🎙️ Áudio: ${originalname}]`;
  else bodyLabel = `[📎 Documento: ${originalname}]`;

  const now = new Date();
  const [msg] = await db.insert(messagesTable).values({
    conversationId: convId,
    body: bodyLabel,
    direction: "out",
    timestamp: now,
  }).returning();

  await db.update(conversationsTable).set({
    lastMessageBody: bodyLabel,
    lastMessageAt: now,
  }).where(eq(conversationsTable.id, convId));

  logger.info({ convId, messageId, fileName: originalname }, "Conversations: file sent");

  res.status(201).json({
    ...msg,
    timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp,
    createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
  });
});

export default router;
