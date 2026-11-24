import { Router, type Request } from "express";
import { db, globalContactsTable } from "@workspace/db";
import { eq, and, ilike, or, gte, lte } from "drizzle-orm";

const router = Router();

function getSession(req: Request) {
  const s = req.session as any;
  return { userId: s?.userId as number, role: s?.role as string };
}

function isSuperAdmin(req: Request) {
  return (req.session as any)?.role === "super_admin";
}

function visibilityFilter(req: Request) {
  const { userId } = getSession(req);
  return eq(globalContactsTable.userId, userId);
}

function formatContact(r: typeof globalContactsTable.$inferSelect) {
  return {
    ...r,
    extraFields: r.extraFields as Record<string, string>,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  };
}

// GET /api/contacts/cnpj/:cnpj — proxy to BrasilAPI for CNPJ lookup
router.get("/cnpj/:cnpj", async (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, "");
  if (!cnpj || cnpj.length !== 14) {
    res.status(400).json({ error: "CNPJ deve ter 14 dígitos." });
    return;
  }

  try {
    const response = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers: { "Accept": "application/json", "User-Agent": "AutoEnvioPro/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      if (response.status === 404) {
        res.status(404).json({ error: "CNPJ não encontrado na base da Receita Federal." });
      } else {
        res.status(502).json({ error: "Serviço de consulta CNPJ indisponível. Tente novamente." });
      }
      return;
    }

    const data: any = await response.json();

    res.json({
      cnpj: data.cnpj ?? cnpj,
      company: data.razao_social ?? null,
      fantasyName: data.nome_fantasia ?? null,
      email: data.email ?? null,
      phone: data.ddd_telefone_1 ? `${data.ddd_telefone_1}`.replace(/\D/g, "") : null,
      segment: data.cnae_fiscal_descricao ?? data.atividade_principal?.[0]?.text ?? null,
      openingDate: data.data_inicio_atividade ?? null,
      city: data.municipio ?? null,
      state: data.uf ?? null,
      zipCode: data.cep ? data.cep.replace(/\D/g, "") : null,
      neighborhood: data.bairro ?? null,
      streetAddress: data.logradouro
        ? `${data.logradouro}${data.numero ? ", " + data.numero : ""}`.trim()
        : null,
      status: data.descricao_situacao_cadastral ?? null,
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      res.status(504).json({ error: "Consulta CNPJ demorou muito. Tente novamente." });
    } else {
      res.status(502).json({ error: "Erro ao consultar CNPJ." });
    }
  }
});

// GET /api/contacts
router.get("/", async (req, res) => {
  const filter = visibilityFilter(req);
  const { q, city, segment, openingDateFrom, openingDateTo } = req.query as Record<string, string>;

  let query = db.select().from(globalContactsTable).$dynamic();

  const conditions: any[] = [];

  if (filter) conditions.push(filter);

  if (q) {
    conditions.push(or(
      ilike(globalContactsTable.name, `%${q}%`),
      ilike(globalContactsTable.phone, `%${q}%`),
      ilike(globalContactsTable.cnpj as any, `%${q}%`),
      ilike(globalContactsTable.company as any, `%${q}%`),
      ilike(globalContactsTable.city as any, `%${q}%`),
      ilike(globalContactsTable.segment as any, `%${q}%`),
    ));
  }

  if (city) conditions.push(ilike(globalContactsTable.city as any, `%${city}%`));
  if (segment) conditions.push(ilike(globalContactsTable.segment as any, `%${segment}%`));
  if (openingDateFrom) conditions.push(gte(globalContactsTable.openingDate as any, openingDateFrom));
  if (openingDateTo) conditions.push(lte(globalContactsTable.openingDate as any, openingDateTo));

  if (conditions.length > 0) {
    query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions));
  }

  const rows = await query.orderBy(globalContactsTable.createdAt);
  res.json(rows.map(formatContact));
});

// POST /api/contacts — single contact OR bulk array
router.post("/", async (req, res) => {
  const { userId } = getSession(req);
  const body = req.body;

  if (Array.isArray(body)) {
    if (body.length === 0) {
      res.status(400).json({ error: "Lista de contatos vazia." });
      return;
    }

    const toInsert = body
      .map((c: any) => ({
        userId,
        name: String(c.name ?? "").trim(),
        phone: String(c.phone ?? "").trim(),
        cnpj: c.cnpj ? String(c.cnpj).trim() : null,
        email: c.email ? String(c.email).trim() : null,
        company: c.company ? String(c.company).trim() : null,
        city: c.city ? String(c.city).trim() : null,
        state: c.state ? String(c.state).trim() : null,
        segment: c.segment ? String(c.segment).trim() : null,
        openingDate: c.openingDate ? String(c.openingDate).trim() : null,
        zipCode: c.zipCode ? String(c.zipCode).trim() : null,
        neighborhood: c.neighborhood ? String(c.neighborhood).trim() : null,
        streetAddress: c.streetAddress ? String(c.streetAddress).trim() : null,
        extraFields: (c.extraFields ?? {}) as Record<string, string>,
      }))
      .filter((c) => c.name && c.phone);

    if (toInsert.length === 0) {
      res.status(400).json({ error: "Nenhum contato válido encontrado." });
      return;
    }

    const inserted = await db
      .insert(globalContactsTable)
      .values(toInsert)
      .onConflictDoNothing({ target: [globalContactsTable.userId, globalContactsTable.phone] })
      .returning();

    const skipped = toInsert.length - inserted.length;

    res.status(201).json({
      inserted: inserted.map(formatContact),
      insertedCount: inserted.length,
      skippedCount: skipped,
      message:
        skipped > 0
          ? `${inserted.length} contato(s) importado(s). ${skipped} ignorado(s) por já existirem.`
          : `${inserted.length} contato(s) importado(s) com sucesso.`,
    });
    return;
  }

  const { name, phone, cnpj, email, company, city, state, segment, openingDate, zipCode, neighborhood, streetAddress, extraFields } = body;
  if (!name || !phone) {
    res.status(400).json({ error: "Nome e telefone são obrigatórios." });
    return;
  }

  const values = {
    userId,
    name: String(name).trim(),
    phone: String(phone).trim(),
    cnpj: cnpj ? String(cnpj).trim() : null,
    email: email ? String(email).trim() : null,
    company: company ? String(company).trim() : null,
    city: city ? String(city).trim() : null,
    state: state ? String(state).trim() : null,
    segment: segment ? String(segment).trim() : null,
    openingDate: openingDate ? String(openingDate).trim() : null,
    zipCode: zipCode ? String(zipCode).trim() : null,
    neighborhood: neighborhood ? String(neighborhood).trim() : null,
    streetAddress: streetAddress ? String(streetAddress).trim() : null,
    extraFields: (extraFields ?? {}) as Record<string, string>,
  };

  const [inserted] = await db
    .insert(globalContactsTable)
    .values(values)
    .onConflictDoNothing({ target: [globalContactsTable.userId, globalContactsTable.phone] })
    .returning();

  if (!inserted) {
    res.status(409).json({ error: "Já existe um contato com este número de telefone." });
    return;
  }

  res.status(201).json(formatContact(inserted));
});

// PUT /api/contacts/:id
router.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido." }); return; }

  const { userId } = getSession(req);
  const filter = and(eq(globalContactsTable.id, id), eq(globalContactsTable.userId, userId));

  const { name, phone, cnpj, email, company, city, state, segment, openingDate, zipCode, neighborhood, streetAddress, extraFields } = req.body;
  if (!name || !phone) {
    res.status(400).json({ error: "Nome e telefone são obrigatórios." });
    return;
  }

  const [updated] = await db
    .update(globalContactsTable)
    .set({
      name: String(name).trim(),
      phone: String(phone).trim(),
      cnpj: cnpj ? String(cnpj).trim() : null,
      email: email ? String(email).trim() : null,
      company: company ? String(company).trim() : null,
      city: city ? String(city).trim() : null,
      state: state ? String(state).trim() : null,
      segment: segment ? String(segment).trim() : null,
      openingDate: openingDate ? String(openingDate).trim() : null,
      zipCode: zipCode ? String(zipCode).trim() : null,
      neighborhood: neighborhood ? String(neighborhood).trim() : null,
      streetAddress: streetAddress ? String(streetAddress).trim() : null,
      extraFields: (extraFields ?? {}) as Record<string, string>,
    })
    .where(filter!)
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Contato não encontrado." });
    return;
  }

  res.json(formatContact(updated));
});

// DELETE /api/contacts/:id
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido." }); return; }

  const { userId } = getSession(req);
  const filter = and(eq(globalContactsTable.id, id), eq(globalContactsTable.userId, userId));

  await db.delete(globalContactsTable).where(filter!);
  res.status(204).send();
});

export default router;
