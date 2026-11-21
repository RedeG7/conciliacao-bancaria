import { Router } from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// UPLOADS_DIR: no Docker fica no volume /data (mesma pasta servida em app.ts)
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.resolve(__dirname, "..", "uploads"), "templates");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Apenas imagens são permitidas (JPEG, PNG, GIF, WebP)"));
    }
  },
});

const router = Router();

router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Nenhum arquivo enviado" });
    return;
  }
  const url = `/api/uploads/templates/${req.file.filename}`;
  res.json({ url });
});

export default router;
