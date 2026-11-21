import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

function isSuperAdmin(req: Request) {
  return (req.session as any)?.role === "super_admin";
}

function currentUserId(req: Request): number {
  return (req.session as any)?.userId;
}

function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) { next(); return; }
  res.status(403).json({ error: "Acesso restrito a administradores." });
}

const USER_FIELDS = {
  id: usersTable.id,
  username: usersTable.username,
  name: usersTable.name,
  email: usersTable.email,
  cpfCnpj: usersTable.cpfCnpj,
  role: usersTable.role,
  isActive: usersTable.isActive,
  createdAt: usersTable.createdAt,
} as const;

function formatUser(u: any) {
  return { ...u, createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt };
}

// GET /api/users — super_admin: todos; user: apenas si mesmo
router.get("/", async (req, res) => {
  if (isSuperAdmin(req)) {
    const users = await db.select(USER_FIELDS).from(usersTable).orderBy(usersTable.createdAt);
    res.json(users.map(formatUser));
  } else {
    const uid = currentUserId(req);
    const [user] = await db.select(USER_FIELDS).from(usersTable).where(eq(usersTable.id, uid));
    res.json(user ? [formatUser(user)] : []);
  }
});

// POST /api/users — apenas super_admin
router.post("/", requireSuperAdmin, async (req, res) => {
  const { username, password, name, email, cpfCnpj, role } = req.body as {
    username?: string;
    password?: string;
    name?: string;
    email?: string;
    cpfCnpj?: string;
    role?: string;
  };

  if (!username || !password || !name) {
    res.status(400).json({ error: "Usuário, senha e nome são obrigatórios." });
    return;
  }

  const validRole = role === "super_admin" ? "super_admin" : "user";
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const [user] = await db
      .insert(usersTable)
      .values({ username, passwordHash, name, email: email || null, cpfCnpj: cpfCnpj || null, role: validRole, isActive: true })
      .returning();
    logger.info({ username, role: validRole }, "Users: created user");
    res.status(201).json(formatUser(user));
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Nome de usuário já está em uso." });
    } else {
      logger.error({ err }, "Users: failed to create user");
      res.status(500).json({ error: "Erro ao criar usuário." });
    }
  }
});

// PATCH /api/users/:id
// super_admin: pode alterar qualquer campo em qualquer usuário
// user: pode alterar apenas próprio perfil (name, email, cpfCnpj, password)
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const uid = currentUserId(req);
  const admin = isSuperAdmin(req);

  if (!admin && id !== uid) {
    res.status(403).json({ error: "Você só pode editar seu próprio perfil." });
    return;
  }

  const body = req.body as {
    name?: string;
    email?: string;
    cpfCnpj?: string;
    role?: string;
    isActive?: boolean;
    password?: string;
  };

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.email !== undefined) updates.email = body.email || null;
  if (body.cpfCnpj !== undefined) updates.cpfCnpj = body.cpfCnpj || null;
  if (body.password) updates.passwordHash = await bcrypt.hash(body.password, 10);

  // Only super_admin can change role or active status
  if (admin) {
    if (body.role !== undefined) updates.role = body.role === "super_admin" ? "super_admin" : "user";
    if (body.isActive !== undefined) updates.isActive = body.isActive;
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Usuário não encontrado." });
    return;
  }

  res.json(formatUser(updated));
});

// DELETE /api/users/:id — apenas super_admin
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const selfId = currentUserId(req);
  if (selfId === id) {
    res.status(400).json({ error: "Não é possível excluir sua própria conta." });
    return;
  }
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.status(204).send();
});

// GET /api/users/cnpj/:cnpj — apenas super_admin
router.get("/cnpj/:cnpj", requireSuperAdmin, async (req, res) => {
  const raw = req.params.cnpj.replace(/[^0-9]/g, "");
  if (raw.length !== 14) {
    res.status(400).json({ error: "CNPJ inválido. Informe 14 dígitos." });
    return;
  }

  try {
    const response = await fetch(`https://publica.cnpj.ws/cnpj/${raw}`, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      res.status(response.status).json({ error: "CNPJ não encontrado." });
      return;
    }

    const data = await response.json() as any;
    res.json({
      cnpj: data.cnpj,
      razaoSocial: data.razao_social,
      nomeFantasia: data.estabelecimento?.nome_fantasia || null,
      situacao: data.estabelecimento?.situacao_cadastral || null,
      email: data.estabelecimento?.email || null,
      telefone: data.estabelecimento?.ddd1
        ? `(${data.estabelecimento.ddd1}) ${data.estabelecimento.telefone1}`
        : null,
      municipio: data.estabelecimento?.cidade?.nome || null,
      uf: data.estabelecimento?.estado?.sigla || null,
    });
  } catch (err) {
    logger.error({ err }, "CNPJ lookup failed");
    res.status(502).json({ error: "Falha ao consultar CNPJ. Tente novamente." });
  }
});

export default router;
