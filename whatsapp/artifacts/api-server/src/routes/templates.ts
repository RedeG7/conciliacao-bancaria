import { Router } from "express";
import { db, templatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateTemplateBody,
  UpdateTemplateBody,
  DeleteTemplateParams,
  UpdateTemplateParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const templates = await db
    .select()
    .from(templatesTable)
    .orderBy(templatesTable.createdAt);
  res.json(templates.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })));
});

router.post("/", async (req, res) => {
  const body = CreateTemplateBody.parse(req.body);
  const [template] = await db
    .insert(templatesTable)
    .values({ name: body.name, body: body.body, imageUrl: body.imageUrl ?? null })
    .returning();
  res.status(201).json({ ...template, createdAt: template.createdAt.toISOString() });
});

router.put("/:id", async (req, res) => {
  const { id } = UpdateTemplateParams.parse({ id: Number(req.params.id) });
  const body = UpdateTemplateBody.parse(req.body);
  const [updated] = await db
    .update(templatesTable)
    .set({ name: body.name, body: body.body, imageUrl: body.imageUrl ?? null })
    .where(eq(templatesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

router.delete("/:id", async (req, res) => {
  const { id } = DeleteTemplateParams.parse({ id: Number(req.params.id) });
  await db.delete(templatesTable).where(eq(templatesTable.id, id));
  res.status(204).send();
});

export default router;
