import { EventEmitter } from "events";
import { logger } from "./logger";
import path from "path";
import fs from "fs";
import { db, conversationsTable, messagesTable, contactsTable, campaignsTable } from "@workspace/db";
import { eq, desc, sql, inArray } from "drizzle-orm";

/** Returns all phone number variants for a Brazilian number (with and without the extra 9 digit). */
export function getPhoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const variants = new Set([digits]);
  if (digits.startsWith("55") && digits.length >= 12) {
    const local = digits.slice(2); // DDD + number
    if (local.length === 10) {
      // 12-digit total: add 9 after DDD → 13-digit variant
      variants.add("55" + local.slice(0, 2) + "9" + local.slice(2));
    } else if (local.length === 11 && local[2] === "9") {
      // 13-digit total: remove 9 after DDD → 12-digit variant
      variants.add("55" + local.slice(0, 2) + local.slice(3));
    }
  }
  return [...variants];
}

/**
 * Normalizes a Brazilian phone number to the canonical 13-digit format
 * (55 + DDD + 9 + 8 digits). Non-BR numbers are returned unchanged.
 */
export function canonicalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length === 12) {
    // 12-digit BR number → add extra 9 after DDD
    return "55" + digits.slice(2, 4) + "9" + digits.slice(4);
  }
  return digits;
}

export type WaState = "idle" | "connecting" | "qr_ready" | "connected" | "disconnected";

interface WhatsAppServiceState {
  state: WaState;
  qrCode: string | null;
  phone: string | null;
  name: string | null;
  connected: boolean;
}

class WhatsAppService extends EventEmitter {
  private socket: any = null;
  private sessionDir: string;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 8;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Prevents two concurrent connect() calls from racing
  private _connecting = false;
  // Tracks which user owns the active WhatsApp session
  public connectedUserId: number | null = null;
  // Maps @lid JIDs → phone digits for newer WhatsApp mobile accounts
  private lidToPhone: Map<string, string> = new Map();
  // Queue of @lid messages that arrived before the contact mapping was available
  private lidPendingQueue: Array<{ lid: string; msg: any; addedAt: number; attempts: number }> = [];
  // Reference to the raw Baileys key store (used to look up lid-mapping entries)
  private authKeys: any = null;

  /** Strip device number from LID: "123456:15@lid" → "123456@lid" */
  private normalizeLid(lid: string): string {
    if (!lid.endsWith("@lid")) return lid;
    return lid.replace("@lid", "").split(":")[0] + "@lid";
  }

  /**
   * Resolve a LID JID → phone number by reading the session file that
   * Baileys writes automatically: lid-mapping-{lidUser}_reverse.json
   * The file content is a JSON string with the phone number (e.g. "556292771254").
   * Returns null if not found.
   */
  private async resolveLidFromSession(lid: string): Promise<string | null> {
    try {
      const lidUser = lid.replace("@lid", "").split(":")[0];
      const filePath = path.join(this.sessionDir, `lid-mapping-${lidUser}_reverse.json`);
      const content = await fs.promises.readFile(filePath, "utf-8");
      const phone = JSON.parse(content);
      if (typeof phone === "string" && phone.length >= 8) {
        return canonicalPhone(phone);
      }
    } catch {
      // file not found is expected for unknown contacts
    }
    return null;
  }

  /** Preload all known LID→phone mappings from session files into memory */
  private async preloadLidMappings() {
    try {
      const files = await fs.promises.readdir(this.sessionDir);
      let count = 0;
      for (const file of files) {
        if (!file.startsWith("lid-mapping-") || !file.endsWith("_reverse.json")) continue;
        try {
          const content = await fs.promises.readFile(path.join(this.sessionDir, file), "utf-8");
          const phone = JSON.parse(content);
          if (typeof phone === "string" && phone.length >= 8) {
            const lidUser = file.replace("lid-mapping-", "").replace("_reverse.json", "");
            const normalizedPhone = canonicalPhone(phone);
            this.lidToPhone.set(`${lidUser}@lid`, normalizedPhone);
            count++;
          }
        } catch { /* skip corrupt files */ }
      }
      if (count > 0) {
        logger.info({ count }, "WhatsApp: preloaded LID→phone mappings from session");
      }
    } catch (err) {
      logger.warn({ err }, "WhatsApp: could not preload LID mappings");
    }
  }

  /** Retry pending @lid messages that now have a known mapping */
  private async flushPendingLid() {
    if (this.lidPendingQueue.length === 0) return;
    const now = Date.now();
    const stillPending: typeof this.lidPendingQueue = [];
    for (const item of this.lidPendingQueue) {
      let phone = this.lidToPhone.get(item.lid);

      // If not in memory, try reading from session file (Baileys may have written it)
      if (!phone) {
        phone = await this.resolveLidFromSession(item.lid) ?? undefined;
        if (phone) {
          this.lidToPhone.set(item.lid, phone);
          logger.info({ lid: item.lid, phone }, "WhatsApp: LID resolved from session file");
        }
      }

      if (phone) {
        logger.info({ lid: item.lid, phone }, "WhatsApp: retrying pending @lid message");
        await this.processIncomingMsg(item.msg, phone).catch(err =>
          logger.error({ err, lid: item.lid }, "WhatsApp: error processing retried @lid message")
        );
      } else if (now - item.addedAt < 60_000 && item.attempts < 5) {
        stillPending.push({ ...item, attempts: item.attempts + 1 });
      } else {
        logger.warn({ lid: item.lid }, "WhatsApp: giving up on unresolvable @lid message");
      }
    }
    this.lidPendingQueue = stillPending;
    if (stillPending.length > 0) {
      setTimeout(() => this.flushPendingLid(), 5_000);
    }
  }

  /** Core logic: save an incoming message with an already-resolved phone number */
  private async processIncomingMsg(msg: any, phone: string) {
    const body =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      (msg.message?.imageMessage ? `[📷 Imagem${msg.message.imageMessage.caption ? ": " + msg.message.imageMessage.caption : ""}]` : null) ||
      (msg.message?.stickerMessage ? "[🎭 Figurinha]" : null) ||
      (msg.message?.videoMessage ? `[🎥 Vídeo${msg.message.videoMessage.caption ? ": " + msg.message.videoMessage.caption : ""}]` : null) ||
      (msg.message?.documentMessage ? `[📎 Documento: ${msg.message.documentMessage.fileName || "arquivo"}]` : null) ||
      (msg.message?.audioMessage ? "[🎙️ Áudio]" : null) ||
      "[mídia]";

    const pushName: string | null = msg.pushName ?? null;
    const timestamp = new Date(Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000);

    // Use all phone variants (with/without the Brazilian extra "9" digit)
    const phoneVariants = getPhoneVariants(phone);

    // Look up the campaign contact using all phone number variants
    const campaignContact = await db
      .select({ campaignId: contactsTable.campaignId, userId: campaignsTable.userId })
      .from(contactsTable)
      .innerJoin(campaignsTable, eq(contactsTable.campaignId, campaignsTable.id))
      .where(phoneVariants.length > 1 ? inArray(contactsTable.phone, phoneVariants) : eq(contactsTable.phone, phone))
      .orderBy(desc(campaignsTable.createdAt))
      .limit(1);

    const existing = await db
      .select()
      .from(conversationsTable)
      .where(phoneVariants.length > 1 ? inArray(conversationsTable.phone, phoneVariants) : eq(conversationsTable.phone, phone))
      .limit(1);

    // Determine campaignId: prefer the contacts table lookup, fall back to existing conversation
    const userId = campaignContact[0]?.userId ?? null;
    let campaignId = campaignContact[0]?.campaignId ?? null;
    if (!campaignId && existing[0]?.campaignId) {
      campaignId = existing[0].campaignId;
    }

    let convId: number;
    if (existing.length > 0) {
      const [upd] = await db
        .update(conversationsTable)
        .set({
          lastMessageBody: body,
          lastMessageAt: timestamp,
          unreadCount: existing[0].unreadCount + 1,
          contactName: pushName ?? existing[0].contactName,
          ...(campaignId && !existing[0].campaignId ? { campaignId } : {}),
        })
        .where(eq(conversationsTable.id, existing[0].id))
        .returning();
      convId = upd.id;
    } else {
      const [created] = await db
        .insert(conversationsTable)
        .values({ userId, phone, contactName: pushName, campaignId, lastMessageBody: body, lastMessageAt: timestamp, unreadCount: 1 })
        .returning();
      convId = created.id;
    }

    await db.insert(messagesTable).values({ conversationId: convId, body, direction: "in", timestamp });

    if (campaignId) {
      await db
        .update(campaignsTable)
        .set({ repliesCount: sql`${campaignsTable.repliesCount} + 1` })
        .where(eq(campaignsTable.id, campaignId));
    }

    logger.info({ phone, body: body.slice(0, 50), campaignId }, "WhatsApp: incoming message saved");
    this.emit("message_received", { phone, body, convId });
  }
  private state: WhatsAppServiceState = {
    state: "idle",
    qrCode: null,
    phone: null,
    name: null,
    connected: false,
  };

  constructor() {
    super();
    // WHATSAPP_SESSION_DIR: no Docker fica no volume /data (sobrevive a
    // redeploys - sem ela seria preciso ler o QR Code de novo a cada deploy)
    this.sessionDir = path.resolve(process.env.WHATSAPP_SESSION_DIR || path.join(process.cwd(), "whatsapp-session"));
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
    // Restore which user owns this session from disk
    this.connectedUserId = this.loadOwnerUserId();
  }

  private get ownerFile(): string {
    return path.join(this.sessionDir, "owner-user-id.json");
  }

  private loadOwnerUserId(): number | null {
    try {
      if (fs.existsSync(this.ownerFile)) {
        const raw = fs.readFileSync(this.ownerFile, "utf-8");
        const parsed = JSON.parse(raw);
        return typeof parsed === "number" ? parsed : null;
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveOwnerUserId(userId: number | null): void {
    try {
      if (userId === null) {
        if (fs.existsSync(this.ownerFile)) fs.unlinkSync(this.ownerFile);
      } else {
        fs.writeFileSync(this.ownerFile, JSON.stringify(userId), "utf-8");
      }
    } catch { /* ignore */ }
  }

  getStatus(): WhatsAppServiceState {
    return { ...this.state };
  }

  private setState(updates: Partial<WhatsAppServiceState>) {
    this.state = { ...this.state, ...updates };
    this.emit("status_change", this.getStatus());
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._doConnect();
    }, delayMs);
  }

  async connect(userId?: number) {
    // Public entry point — reset attempts and connect fresh
    if (userId !== undefined) {
      this.connectedUserId = userId;
      this.saveOwnerUserId(userId);
    }
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this._doConnect();
  }

  private async _doConnect() {
    // Guard: only one active connection attempt at a time
    if (this._connecting || this.state.connected) {
      logger.info("WhatsApp: already connecting or connected, skipping");
      return;
    }

    this._connecting = true;
    this.setState({ state: "connecting", qrCode: null });

    try {
      const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        makeCacheableSignalKeyStore,
        fetchLatestBaileysVersion,
      } = await import("@whiskeysockets/baileys");

      const { version } = await fetchLatestBaileysVersion();
      const { state: authState, saveCreds } = await useMultiFileAuthState(this.sessionDir);

      // Save raw key store reference so we can query lid-mapping entries directly
      this.authKeys = authState.keys;

      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, logger as any),
        },
        printQRInTerminal: false,
        browser: ["WhatsApp Disparos", "Chrome", "1.0.0"],
        logger: logger as any,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      this.socket = sock;
      this._connecting = false; // socket created — no longer "starting up"

      sock.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          const QRCode = (await import("qrcode")).default;
          const qrDataUrl = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
          this.reconnectAttempts = 0;
          this.setState({ state: "qr_ready", qrCode: qrDataUrl });
          logger.info("WhatsApp: QR code ready");
        }

        if (connection === "open") {
          const user = sock.user;
          const phone = user?.id?.split(":")[0] ?? null;
          const name = user?.name ?? null;
          this.reconnectAttempts = 0;
          this.setState({ state: "connected", connected: true, qrCode: null, phone, name });
          logger.info({ phone, name }, "WhatsApp: connected!");
          // Preload all known LID→phone mappings from session files so messages
          // from mobile WhatsApp users are resolved instantly
          this.preloadLidMappings().catch(() => {});
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          // 515 = "Stream Errored (restart required)" — normal after first QR pairing
          const isRestartRequired = statusCode === 515;

          logger.info({ statusCode, reconnectAttempts: this.reconnectAttempts }, "WhatsApp: connection closed");

          this.socket = null;
          this._connecting = false;

          if (isLoggedOut) {
            this.clearSession();
            this.setState({ state: "idle", connected: false, qrCode: null, phone: null, name: null });
            this.reconnectAttempts = 0;
            return;
          }

          if (isRestartRequired) {
            // 515 after QR scan: reconnect immediately — credentials are already saved
            logger.info("WhatsApp: restart required after pairing, reconnecting now...");
            this.setState({ state: "connecting", connected: false, qrCode: null });
            this.scheduleReconnect(500);
            return;
          }

          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            const delay = Math.min(3000 * this.reconnectAttempts, 30000);
            logger.info({ delay, reconnectAttempts: this.reconnectAttempts }, "WhatsApp: scheduling reconnect");
            this.setState({ state: "connecting", connected: false, qrCode: null });
            this.scheduleReconnect(delay);
          } else {
            this.reconnectAttempts = 0;
            this.clearSession();
            this.setState({ state: "idle", connected: false, qrCode: null, phone: null, name: null });
            logger.warn("WhatsApp: max reconnect attempts reached, resetting to idle");
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);

      // Build LID → phone mapping so we can resolve newer mobile JIDs.
      // Also store both original and normalized (stripped device number) forms.
      const buildLidMapping = (contacts: any[]) => {
        let added = 0;
        for (const c of contacts) {
          const rawId: string = c.id ?? "";
          const rawLid: string = c.lid ?? "";

          let phoneDigits: string | null = null;
          let lidKey: string | null = null;

          if (rawId.endsWith("@s.whatsapp.net") && rawLid.endsWith("@lid")) {
            phoneDigits = rawId.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
            lidKey = rawLid;
          } else if (rawId.endsWith("@lid") && rawLid.endsWith("@s.whatsapp.net")) {
            phoneDigits = rawLid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
            lidKey = rawId;
          }

          if (lidKey && phoneDigits) {
            const normalizedLid = this.normalizeLid(lidKey);
            this.lidToPhone.set(normalizedLid, phoneDigits);
            // Also store with original key in case formats differ
            if (lidKey !== normalizedLid) this.lidToPhone.set(lidKey, phoneDigits);
            added++;
          }
        }
        if (added > 0) {
          logger.info({ added, total: this.lidToPhone.size }, "WhatsApp: LID→phone mappings updated");
          // Try to process any pending messages that were waiting for a mapping
          this.flushPendingLid().catch(err => logger.error({ err }, "flushPendingLid error"));
        }
      };

      sock.ev.on("contacts.upsert", buildLidMapping);
      sock.ev.on("contacts.update", buildLidMapping);

      // 'lid-mapping.update' is the dedicated Baileys event for LID → phone resolution
      // Fired whenever WhatsApp sends us the phone number (pn) for a LID identity
      sock.ev.on("lid-mapping.update" as any, ({ lid, pn }: { lid: string; pn: string }) => {
        if (!lid || !pn) return;
        const normalizedLid = this.normalizeLid(lid);
        const phoneDigits = pn.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
        this.lidToPhone.set(normalizedLid, phoneDigits);
        if (lid !== normalizedLid) this.lidToPhone.set(lid, phoneDigits);
        logger.info({ lid: normalizedLid, pn: phoneDigits }, "WhatsApp: lid-mapping.update → phone resolved");
        this.flushPendingLid().catch(() => {});
      });

      // Listen for incoming messages
      sock.ev.on("messages.upsert", async ({ messages: incomingMsgs, type }: any) => {
        if (type !== "notify") return;

        for (const msg of incomingMsgs) {
          try {
            if (!msg.message || msg.key?.fromMe) continue;

            const jid: string = msg.key?.remoteJid ?? "";
            if (!jid) continue;

            // Skip groups and broadcasts
            if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue;

            if (jid.endsWith("@s.whatsapp.net")) {
              // Standard phone-based JID — process immediately
              const phone = canonicalPhone(jid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, ""));
              await this.processIncomingMsg(msg, phone);

            } else if (jid.endsWith("@lid")) {
              // LID JID from newer WhatsApp mobile clients
              const normalizedLid = this.normalizeLid(jid);

              // 1) Try in-memory map (preloaded from session files on connect)
              let resolved = this.lidToPhone.get(normalizedLid) ?? this.lidToPhone.get(jid);

              // 2) If not in memory, try reading the session file directly
              //    Baileys writes lid-mapping-{lidUser}_reverse.json automatically
              if (!resolved) {
                const fromFile = await this.resolveLidFromSession(normalizedLid);
                if (fromFile) {
                  resolved = fromFile;
                  this.lidToPhone.set(normalizedLid, fromFile);
                  logger.info({ lid: jid, phone: fromFile }, "WhatsApp: @lid resolved from session file");
                }
              }

              if (resolved) {
                const phone = canonicalPhone(resolved);
                logger.info({ lid: jid, phone }, "WhatsApp: resolved @lid → phone, processing message");
                await this.processIncomingMsg(msg, phone);
              } else {
                // Contact mapping not yet available — queue for retry (new contact first message)
                logger.warn({ lid: jid, normalizedLid }, "WhatsApp: @lid not yet mapped, queuing for retry");
                this.lidPendingQueue.push({ lid: normalizedLid, msg, addedAt: Date.now(), attempts: 0 });
                // Schedule first retry in 3 seconds (Baileys should write the file by then)
                setTimeout(() => this.flushPendingLid().catch(() => {}), 3_000);
              }

            }
            // else: unknown JID type — skip silently
          } catch (err) {
            logger.error({ err }, "WhatsApp: failed to process incoming message");
          }
        }
      });
    } catch (err) {
      logger.error({ err }, "WhatsApp: failed to connect");
      this._connecting = false;
      this.setState({ state: "idle", connected: false, qrCode: null });
    }
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this._connecting = false;

    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (err) {
        logger.warn({ err }, "WhatsApp: error during socket end");
      }
      this.socket = null;
    }
    this.connectedUserId = null;
    this.saveOwnerUserId(null);
    this.clearSession();
    this.setState({ state: "idle", connected: false, qrCode: null, phone: null, name: null });
  }

  private clearSession() {
    try {
      if (fs.existsSync(this.sessionDir)) {
        fs.rmSync(this.sessionDir, { recursive: true, force: true });
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }
    } catch (err) {
      logger.warn({ err }, "WhatsApp: failed to clear session");
    }
  }

  /**
   * Resolves the correct WhatsApp JID for a phone number by checking both
   * the 12-digit (without extra 9) and 13-digit (with extra 9) variants via
   * onWhatsApp(). Returns the confirmed JID if found, or falls back to the
   * canonical 13-digit form. This handles the common Brazilian case where a
   * number may be registered under either format.
   */
  private async resolveJid(phone: string): Promise<string> {
    const digits = phone.replace(/\D/g, "");
    const canonical = canonicalPhone(digits);
    const variants = getPhoneVariants(digits);

    if (!this.socket) return `${canonical}@s.whatsapp.net`;

    // Build candidate JIDs from all variants (deduplicated, canonical first)
    const candidates = [...new Set([canonical, ...variants])].map(v => `${v}@s.whatsapp.net`);

    try {
      const results: Array<{ exists: boolean; jid: string }> = await this.socket.onWhatsApp(...candidates);
      const found = results?.find(r => r?.exists);
      if (found?.jid) {
        logger.debug({ phone: digits, jid: found.jid }, "WhatsApp: resolved JID via onWhatsApp");
        return found.jid;
      }
    } catch (err) {
      logger.warn({ err, phone: digits }, "WhatsApp: onWhatsApp lookup failed, using canonical");
    }

    return `${canonical}@s.whatsapp.net`;
  }

  async sendMessage(phone: string, message: string): Promise<{ messageId: string | null; error: string | null }> {
    if (!this.socket || !this.state.connected) {
      return { messageId: null, error: "WhatsApp não está conectado" };
    }

    try {
      const jid = await this.resolveJid(phone);
      const result = await this.socket.sendMessage(jid, { text: message });
      return { messageId: result?.key?.id ?? null, error: null };
    } catch (err: any) {
      logger.error({ err }, "WhatsApp: failed to send message");
      return { messageId: null, error: err?.message ?? "Erro ao enviar mensagem" };
    }
  }

  async sendFile(phone: string, fileBuffer: Buffer, fileName: string, mimeType: string, caption?: string): Promise<{ messageId: string | null; error: string | null }> {
    if (!this.socket || !this.state.connected) {
      return { messageId: null, error: "WhatsApp não está conectado" };
    }

    try {
      const jid = await this.resolveJid(phone);
      const isImage = mimeType.startsWith("image/");
      const isVideo = mimeType.startsWith("video/");
      const isAudio = mimeType.startsWith("audio/");

      let result;
      if (isImage) {
        result = await this.socket.sendMessage(jid, { image: fileBuffer, caption: caption ?? fileName });
      } else if (isVideo) {
        result = await this.socket.sendMessage(jid, { video: fileBuffer, caption: caption ?? fileName });
      } else if (isAudio) {
        result = await this.socket.sendMessage(jid, { audio: fileBuffer, mimetype: mimeType });
      } else {
        result = await this.socket.sendMessage(jid, { document: fileBuffer, fileName, mimetype: mimeType });
      }
      return { messageId: result?.key?.id ?? null, error: null };
    } catch (err: any) {
      logger.error({ err }, "WhatsApp: failed to send file");
      return { messageId: null, error: err?.message ?? "Erro ao enviar arquivo" };
    }
  }

  async tryRestoreSession() {
    const credsFile = path.join(this.sessionDir, "creds.json");
    if (fs.existsSync(credsFile)) {
      logger.info("WhatsApp: found existing session, restoring...");
      await this._doConnect();
    }
  }
}

export const whatsappService = new WhatsAppService();
