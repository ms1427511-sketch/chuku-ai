import express from "express";
import { config } from "./config/env.ts";
import { sanitizeErrorMessage } from "./security/sanitize.ts";
import { catalogRouter } from "./routes/catalog.ts";
import { generationsRouter } from "./routes/generations.ts";
import { imagesRouter } from "./routes/images.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { productGenerationsRouter } from "./routes/product-generations.ts";
import { productResultsRouter } from "./routes/product-results.ts";
import { maintenanceRouter } from "./routes/maintenance.ts";
import { internalRouter } from "./routes/internal.ts";

// Separated from index.ts's app.listen()/startup-reconciliation bootstrap so
// tests can build and exercise the app (route mounting/gating in particular
// — deployment-hardening mission section 8) without binding a real port.
export const app = express();

app.use(express.json({ limit: "1mb" }));

// Deployment-hardening mission section 3: CHUKU_DEPLOYMENT_MODE gates the
// entire standalone Lab/Product HTTP surface. "local" (default) preserves
// current behavior exactly — every route below is mounted, unchanged. In
// "service" mode (the Railway/deployed shape) none of these routers are
// mounted at all: they are route-not-mounted (404), not merely unauthenticated
// — deterministic absence, not reliance on obscurity. /health and
// internalRouter are the only surface ever exposed in service mode.
if (config.deploymentMode === "local") {
  app.use(catalogRouter);
  app.use(generationsRouter);
  app.use(imagesRouter);
  app.use(sessionsRouter);
  app.use(productGenerationsRouter);
  app.use(productResultsRouter);
  app.use(maintenanceRouter);
}
// Additive only — every route here requires internal auth
// (security/internal-auth.ts) and is a distinct surface from the Lab routes
// above. See docs/architecture.md and Phase 4.1B mission section 3. Mounted
// in both deployment modes: local dev must still be able to exercise it.
app.use(internalRouter);

// Deliberately minimal: liveness only. Never discloses provider mode,
// deployment mode, API keys, internal secret state, filesystem paths, or
// job metadata — deployment-hardening mission section 6.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Centralized error handler: last line of defense against ever leaking a
// stack trace, raw provider response, or secret-shaped string in an HTTP
// response body. Every route also does its own local try/catch, but this
// covers anything unexpected (e.g. a synchronous throw, JSON parse error).
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const rawMessage = err instanceof Error ? err.message : "unexpected server error";
  const message = sanitizeErrorMessage(rawMessage, config.lightxApiKey);
  res.status(500).json({ error: "INTERNAL_ERROR", message });
});
