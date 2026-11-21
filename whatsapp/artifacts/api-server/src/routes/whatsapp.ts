import { Router, Request, Response } from "express";
import { whatsappService } from "../lib/whatsapp-service";
import { db, contactsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { SendWhatsappMessageBody } from "@workspace/api-zod";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "..", "uploads");

function extToMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] ?? "image/jpeg";
}

const router = Router();

function getSessionUserId(req: Request): number | null {
  return (req.session as any)?.userId ?? null;
}

/** Returns the WhatsApp status, but only shows connected=true for the user who owns the session. */
function statusForUser(req: Request) {
  const status = whatsappService.getStatus();
  const userId = getSessionUserId(req);
  const owner = whatsappService.connectedUserId;
  if (status.connected && owner !== null && owner !== userId) {
    return { ...status, connected: false, state: "idle" as const, qrCode: null };
  }
  return status;
}

// GET /api/whatsapp/status
router.get("/status", (req, res) => {
  res.json(statusForUser(req));
});

// POST /api/whatsapp/connect
router.post("/connect", async (req, res) => {
  const userId = getSessionUserId(req) ?? undefined;
  await whatsappService.connect(userId);
  res.json(statusForUser(req));
});

// POST /api/whatsapp/disconnect
router.post("/disconnect", async (req, res) => {
  const userId = getSessionUserId(req);
  const owner = whatsappService.connectedUserId;
  // Only the owner can disconnect
  if (owner !== null && owner !== userId) {
    res.status(403).json({ error: "Você não é o dono desta sessão." });
    return;
  }
  await whatsappService.disconnect();
  res.json(statusForUser(req));
});

// GET /api/whatsapp/qr-stream — SSE endpoint for real-time QR/status updates
router.get("/qr-stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent(statusForUser(req));

  const onStatusChange = (_status: object) => {
    // Re-evaluate status filtered for this user so other users don't see foreign connections
    sendEvent(statusForUser(req));
  };

  whatsappService.on("status_change", onStatusChange);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    whatsappService.off("status_change", onStatusChange);
  });
});

// POST /api/whatsapp/send
router.post("/send", async (req, res) => {
  const body = SendWhatsappMessageBody.parse(req.body);

  let result: { messageId: string | null; error: string | null };

  if (body.imageUrl) {
    try {
      const relativePath = body.imageUrl.replace(/^\/api\/uploads\//, "");
      const filePath = path.join(uploadsDir, relativePath);
      const fileBuffer = await readFile(filePath);
      const fileName = path.basename(filePath);
      const mimeType = extToMime(fileName);
      result = await whatsappService.sendFile(body.phone, fileBuffer, fileName, mimeType, body.message);
    } catch (err) {
      res.status(400).json({ success: false, messageId: null, error: "Não foi possível carregar a imagem do template" });
      return;
    }
  } else {
    result = await whatsappService.sendMessage(body.phone, body.message);
  }

  if (result.error) {
    res.status(400).json({ success: false, messageId: null, error: result.error });
    return;
  }

  await db
    .update(contactsTable)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(contactsTable.id, body.contactId));

  res.json({ success: true, messageId: result.messageId, error: null });
});

export default router;
