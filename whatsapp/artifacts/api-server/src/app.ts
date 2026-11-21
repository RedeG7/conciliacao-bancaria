import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import router from "./routes";
import ssoRouter from "./routes/sso";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

// atras do Caddy (HTTPS) na VPS: confia no X-Forwarded-Proto para o cookie
// "secure" funcionar
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required");
}

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === "1",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.resolve(__dirname, "..", "uploads"));
app.use("/api/uploads", express.static(uploadsDir));

app.use("/api", router);

// login unico vindo do Hub (GET /sso?t=<bilhete>) - ver routes/sso.ts
app.use(ssoRouter);

// Na VPS a propria API serve o front (build do Vite em STATIC_DIR); no
// Replit o front era servido a parte. Rotas desconhecidas devolvem o
// index.html (o roteamento e feito no navegador).
const staticDir = process.env.STATIC_DIR;
if (staticDir && fs.existsSync(path.join(staticDir, "index.html"))) {
  app.use(express.static(staticDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
