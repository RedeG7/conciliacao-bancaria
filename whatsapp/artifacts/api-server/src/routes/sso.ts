// Login unico vindo do Hub (hub.redeg7.com) para o WhatsApp Disparos. O Hub
// confere a sessao do usuario em /api/sso/whatsapp (api.py) e redireciona
// para /sso?t=<bilhete>; o bilhete e assinado (HMAC-SHA256) com o segredo
// compartilhado SSO_SECRET, vale 60 segundos e so pode ser usado uma vez.
// Mesmo formato dos outros apps do Hub (ver rh/src/sso.js).
import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

type Bilhete = {
  sub: string;
  name?: string;
  admin?: boolean;
  global?: boolean;
  exp: number;
  jti: string;
};

const usados = new Map<string, number>(); // jti -> exp, contra reuso

export function verificarBilhete(
  bilhete: unknown,
  segredo: string | undefined,
  agora = Math.floor(Date.now() / 1000),
): Bilhete | null {
  if (!segredo || typeof bilhete !== "string") return null;
  const [corpo, assinatura] = bilhete.split(".");
  if (!corpo || !assinatura) return null;
  const esperada = Buffer.from(crypto.createHmac("sha256", segredo).update(corpo).digest("base64url"));
  const recebida = Buffer.from(assinatura);
  if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) return null;
  let p: Bilhete;
  try {
    p = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || typeof p.sub !== "string" || !p.sub || typeof p.exp !== "number" || p.exp < agora || !p.jti) return null;
  for (const [j, exp] of usados) if (exp < agora) usados.delete(j);
  if (usados.has(p.jti)) return null;
  usados.set(p.jti, p.exp);
  return p;
}

const router = Router();

router.get("/sso", async (req, res) => {
  const p = verificarBilhete(req.query.t, process.env.SSO_SECRET);
  if (!p) {
    res.status(401).send("Link de acesso inválido ou expirado. Volte ao Hub e clique no card de novo.");
    return;
  }

  const username = p.sub.trim().toLowerCase();
  // super administrador do Hub vira super_admin aqui; os demais entram como
  // usuario comum (o super_admin pode promover em Usuarios). O WhatsApp
  // conectado e um so para o app inteiro, por isso nao basta ser admin de
  // um escritorio para virar super_admin.
  const role = p.global ? "super_admin" : "user";

  let [user] = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  if (!user) {
    // senha aleatoria: quem vem pelo Hub nao usa a tela de login
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
    [user] = await db
      .insert(usersTable)
      .values({ username, passwordHash, name: p.name || username, role, isActive: true })
      .returning();
    logger.info({ username, role }, "SSO: usuario criado a partir do Hub");
  } else if (p.global && user.role !== "super_admin") {
    [user] = await db.update(usersTable).set({ role: "super_admin" }).where(eq(usersTable.id, user.id)).returning();
  }

  if (!user.isActive) {
    res.status(403).send("Sua conta está bloqueada no WhatsApp Disparos. Fale com o administrador.");
    return;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).send("Não foi possível iniciar a sessão.");
      return;
    }
    const s = req.session as any;
    s.authenticated = true;
    s.userId = user.id;
    s.username = user.username;
    s.role = user.role;
    s.name = user.name;
    logger.info({ username, role: user.role }, "SSO: login pelo Hub");
    req.session.save(() => res.redirect("/"));
  });
});

export default router;
