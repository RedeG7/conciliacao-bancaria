import { Router, type Request } from "express";
import { db, campaignsTable, templatesTable, contactsTable, globalContactsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  CreateCampaignBody,
  GetCampaignParams,
  DeleteCampaignParams,
  GetCampaignContactsParams,
  MarkContactSentParams,
} from "@workspace/api-zod";

const router = Router();

function getSession(req: Request) {
  const s = req.session as any;
  return {
    userId: s?.userId as number,
    role: s?.role as string,
  };
}

function isSuperAdmin(req: Request) {
  return (req.session as any)?.role === "super_admin";
}

/** Returns a drizzle WHERE condition that filters campaigns to the current user only. */
function visibilityFilter(req: Request) {
  const { userId } = getSession(req);
  return eq(campaignsTable.userId, userId);
}

function interpolate(template: string, contact: { name: string; phone: string; extraFields: Record<string, string> }) {
  return template
    .replace(/\{nome\}/gi, contact.name)
    .replace(/\{telefone\}/gi, contact.phone)
    .replace(/\{([^}]+)\}/g, (_, key) => {
      const val = contact.extraFields[key] ?? contact.extraFields[key.toLowerCase()] ?? `{${key}}`;
      return val;
    });
}

function formatCampaign(r: any, counts: any) {
  return {
    id: r.id,
    name: r.name,
    templateId: r.templateId,
    templateName: r.templateName ?? "",
    templateBody: r.templateBody ?? "",
    templateImageUrl: r.templateImageUrl ?? null,
    status: r.status ?? "active",
    finishedAt: r.finishedAt ? (r.finishedAt instanceof Date ? r.finishedAt.toISOString() : r.finishedAt) : null,
    totalContacts: Number(counts?.total ?? 0),
    sentCount: Number(counts?.sent ?? 0),
    pendingCount: Number(counts?.pending ?? 0),
    repliesCount: Number(r.repliesCount ?? 0),
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
  };
}

// GET /api/campaigns/stats/summary
router.get("/stats/summary", async (req, res) => {
  const filter = visibilityFilter(req);

  const campaigns = filter
    ? await db.select().from(campaignsTable).where(filter)
    : await db.select().from(campaignsTable);

  const campaignIds = campaigns.map((c) => c.id);

  if (campaignIds.length === 0) {
    res.json({ totalCampaigns: 0, totalContacts: 0, totalSent: 0, totalPending: 0, totalReplies: 0 });
    return;
  }

  const allContacts = await db
    .select()
    .from(contactsTable)
    .where(sql`${contactsTable.campaignId} = ANY(${sql.raw(`ARRAY[${campaignIds.join(",")}]::int[]`)})`)
    .catch(() => []);

  const totalSent = allContacts.filter((c) => c.status === "sent").length;
  const totalPending = allContacts.filter((c) => c.status === "pending").length;
  const totalReplies = campaigns.reduce((sum, c) => sum + (c.repliesCount ?? 0), 0);

  res.json({
    totalCampaigns: campaigns.length,
    totalContacts: allContacts.length,
    totalSent,
    totalPending,
    totalReplies,
  });
});

// GET /api/campaigns
router.get("/", async (req, res) => {
  const filter = visibilityFilter(req);

  const baseQuery = db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      templateId: campaignsTable.templateId,
      templateName: templatesTable.name,
      templateBody: templatesTable.body,
      templateImageUrl: templatesTable.imageUrl,
      status: campaignsTable.status,
      finishedAt: campaignsTable.finishedAt,
      repliesCount: campaignsTable.repliesCount,
      createdAt: campaignsTable.createdAt,
    })
    .from(campaignsTable)
    .leftJoin(templatesTable, eq(campaignsTable.templateId, templatesTable.id))
    .orderBy(campaignsTable.createdAt)
    .$dynamic();

  const rows = await (filter ? baseQuery.where(filter) : baseQuery);

  const contactCounts = await db
    .select({
      campaignId: contactsTable.campaignId,
      total: sql<number>`count(*)`.as("total"),
      sent: sql<number>`sum(case when ${contactsTable.status} = 'sent' then 1 else 0 end)`.as("sent"),
      pending: sql<number>`sum(case when ${contactsTable.status} = 'pending' then 1 else 0 end)`.as("pending"),
    })
    .from(contactsTable)
    .groupBy(contactsTable.campaignId);

  const countMap = Object.fromEntries(contactCounts.map((c) => [c.campaignId, c]));
  res.json(rows.map((r) => formatCampaign(r, countMap[r.id])));
});

// POST /api/campaigns
router.post("/", async (req, res) => {
  const body = CreateCampaignBody.parse(req.body);
  const { userId } = getSession(req);

  const [template] = await db
    .select()
    .from(templatesTable)
    .where(eq(templatesTable.id, body.templateId));

  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const [campaign] = await db
    .insert(campaignsTable)
    .values({ name: body.name, templateId: body.templateId, userId })
    .returning();

  if (body.contacts.length > 0) {
    await db.insert(contactsTable).values(
      body.contacts.map((c) => ({
        campaignId: campaign.id,
        name: c.name,
        phone: c.phone,
        extraFields: c.extraFields as Record<string, string>,
        status: "pending" as const,
        message: interpolate(template.body, { name: c.name, phone: c.phone, extraFields: c.extraFields as Record<string, string> }),
      }))
    );

    // Also upsert into global contacts directory
    try {
      const globalValues = body.contacts.map((c) => {
        const extra = (c.extraFields ?? {}) as Record<string, string>;
        const cnpjVal = extra["cnpj"] ?? extra["CNPJ"] ?? extra["Cnpj"] ?? null;
        const emailVal = extra["email"] ?? extra["Email"] ?? extra["EMAIL"] ?? null;
        const companyVal = extra["empresa"] ?? extra["Empresa"] ?? extra["company"] ?? extra["Company"] ?? null;
        const remaining: Record<string, string> = {};
        Object.entries(extra).forEach(([k, v]) => {
          const lk = k.toLowerCase();
          if (!["cnpj", "email", "empresa", "company"].includes(lk)) remaining[k] = v;
        });
        return {
          userId,
          name: c.name,
          phone: c.phone,
          cnpj: cnpjVal,
          email: emailVal,
          company: companyVal,
          extraFields: remaining,
        };
      });
      await db
        .insert(globalContactsTable)
        .values(globalValues)
        .onConflictDoNothing({ target: [globalContactsTable.userId, globalContactsTable.phone] });
    } catch (_e) {
      // Non-fatal: global contacts upsert failure doesn't break campaign creation
    }
  }

  const contacts = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.campaignId, campaign.id));

  res.status(201).json(formatCampaign(
    { ...campaign, templateName: template.name, templateBody: template.body, templateImageUrl: template.imageUrl ?? null },
    { total: contacts.length, sent: 0, pending: contacts.length }
  ));
});

// Helper: check campaign ownership. Returns the campaign or sends 403/404.
async function checkOwnership(req: Request, res: any, campaignId: number): Promise<typeof campaignsTable.$inferSelect | null> {
  const [campaign] = await db.select().from(campaignsTable).where(eq(campaignsTable.id, campaignId));

  if (!campaign) {
    res.status(404).json({ error: "Campanha não encontrada." });
    return null;
  }

  const { userId } = getSession(req);
  if (campaign.userId !== userId) {
    res.status(403).json({ error: "Acesso negado." });
    return null;
  }

  return campaign;
}

// GET /api/campaigns/:id
router.get("/:id", async (req, res) => {
  const { id } = GetCampaignParams.parse({ id: Number(req.params.id) });

  const campaign = await checkOwnership(req, res, id);
  if (!campaign) return;

  const [row] = await db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      templateId: campaignsTable.templateId,
      templateName: templatesTable.name,
      templateBody: templatesTable.body,
      templateImageUrl: templatesTable.imageUrl,
      status: campaignsTable.status,
      finishedAt: campaignsTable.finishedAt,
      repliesCount: campaignsTable.repliesCount,
      createdAt: campaignsTable.createdAt,
    })
    .from(campaignsTable)
    .leftJoin(templatesTable, eq(campaignsTable.templateId, templatesTable.id))
    .where(eq(campaignsTable.id, id));

  const contacts = await db.select().from(contactsTable).where(eq(contactsTable.campaignId, id));
  const sentCount = contacts.filter((c) => c.status === "sent").length;
  const pendingCount = contacts.filter((c) => c.status === "pending").length;

  res.json(formatCampaign(row, { total: contacts.length, sent: sentCount, pending: pendingCount }));
});

// POST /api/campaigns/:id/finish
router.post("/:id/finish", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido." }); return; }

  const campaign = await checkOwnership(req, res, id);
  if (!campaign) return;

  if (campaign.status === "finished") {
    res.status(400).json({ error: "Campanha já foi finalizada." });
    return;
  }

  const [updated] = await db
    .update(campaignsTable)
    .set({ status: "finished", finishedAt: new Date() })
    .where(eq(campaignsTable.id, id))
    .returning();

  res.json({ ok: true, finishedAt: updated.finishedAt?.toISOString() });
});

// DELETE /api/campaigns/:id
router.delete("/:id", async (req, res) => {
  const { id } = DeleteCampaignParams.parse({ id: Number(req.params.id) });

  const campaign = await checkOwnership(req, res, id);
  if (!campaign) return;

  await db.delete(campaignsTable).where(eq(campaignsTable.id, id));
  res.status(204).send();
});

// GET /api/campaigns/:id/contacts
router.get("/:id/contacts", async (req, res) => {
  const { id } = GetCampaignContactsParams.parse({ id: Number(req.params.id) });

  const campaign = await checkOwnership(req, res, id);
  if (!campaign) return;

  const contacts = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.campaignId, id))
    .orderBy(contactsTable.id);

  res.json(
    contacts.map((c) => ({
      ...c,
      extraFields: c.extraFields as Record<string, string>,
      sentAt: c.sentAt?.toISOString() ?? null,
    }))
  );
});

// PATCH /api/campaigns/:id/contacts/:contactId/sent
router.patch("/:id/contacts/:contactId/sent", async (req, res) => {
  const params = MarkContactSentParams.parse({
    id: Number(req.params.id),
    contactId: Number(req.params.contactId),
  });

  const campaign = await checkOwnership(req, res, params.id);
  if (!campaign) return;

  const [updated] = await db
    .update(contactsTable)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(contactsTable.id, params.contactId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  res.json({
    ...updated,
    extraFields: updated.extraFields as Record<string, string>,
    sentAt: updated.sentAt?.toISOString() ?? null,
  });
});

export default router;
