import { Router, type IRouter } from "express";
import { getRateLimitStoreKind } from "../middlewares/apiRateLimit";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // `rateLimitStore` lets ops verify a live replica is using the intended
  // bucket backend (see docs/runbooks/rate-limit-store.md). It's a tiny,
  // non-sensitive string so we expose it on the unauthenticated endpoint
  // rather than gating it behind admin auth.
  res.json({
    status: "ok",
    rateLimitStore: getRateLimitStoreKind(),
  });
});

export default router;
