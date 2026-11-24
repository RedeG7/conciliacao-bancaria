import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: "Usuário e senha são obrigatórios." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username.trim().toLowerCase()))
    .limit(1);

  if (!user) {
    logger.warn({ username }, "Auth: user not found");
    res.status(401).json({ error: "Usuário ou senha incorretos." });
    return;
  }

  if (!user.isActive) {
    logger.warn({ username }, "Auth: blocked user tried to login");
    res.status(403).json({ error: "Conta bloqueada. Contate o administrador." });
    return;
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    logger.warn({ username }, "Auth: wrong password");
    res.status(401).json({ error: "Usuário ou senha incorretos." });
    return;
  }

  (req.session as any).authenticated = true;
  (req.session as any).userId = user.id;
  (req.session as any).username = user.username;
  (req.session as any).role = user.role;
  (req.session as any).name = user.name;

  logger.info({ username, role: user.role }, "Auth: user logged in");
  res.json({ ok: true, username: user.username, role: user.role, name: user.name });
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get("/me", (req, res) => {
  if ((req.session as any).authenticated) {
    res.json({
      authenticated: true,
      userId: (req.session as any).userId,
      username: (req.session as any).username,
      role: (req.session as any).role ?? "user",
      name: (req.session as any).name ?? null,
    });
  } else {
    res.json({ authenticated: false, userId: null, username: null, role: null, name: null });
  }
});

export default router;
