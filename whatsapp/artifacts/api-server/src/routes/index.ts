import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import campaignsRouter from "./campaigns";
import templatesRouter from "./templates";
import whatsappRouter from "./whatsapp";
import authRouter from "./auth";
import usersRouter from "./users";
import globalContactsRouter from "./global-contacts";
import conversationsRouter from "./conversations";
import uploadRouter from "./upload";

const router: IRouter = Router();

// Public routes
router.use("/auth", authRouter);
router.use(healthRouter);

// Auth guard — protects everything below
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any)?.authenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "Não autorizado. Faça login para continuar." });
}

router.use(requireAuth);
router.use("/campaigns", campaignsRouter);
router.use("/templates", templatesRouter);
router.use("/whatsapp", whatsappRouter);
router.use("/users", usersRouter);
router.use("/contacts", globalContactsRouter);
router.use("/conversations", conversationsRouter);
router.use("/upload", uploadRouter);

export default router;
