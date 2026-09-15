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
import { reconcileAllProcessingOnStartup } from "./services/product-generation-service.ts";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(catalogRouter);
app.use(generationsRouter);
app.use(imagesRouter);
app.use(sessionsRouter);
app.use(productGenerationsRouter);
app.use(productResultsRouter);
app.use(maintenanceRouter);
// Additive only — every route here requires internal auth
// (security/internal-auth.ts) and is a distinct surface from the Lab routes
// above. See docs/architecture.md and Phase 4.1B mission section 3.
app.use(internalRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, lightxConfigured: Boolean(config.lightxApiKey) });
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

// Host is configurable via CHUKU_HOST but the safe default is always
// 127.0.0.1 — this module never defaults to 0.0.0.0 itself (config/env.ts).
// This server proxies a provider secret and must never be reachable from
// outside localhost unless an operator explicitly opts in.
app.listen(config.port, config.host, () => {
  console.log(`Chuku AI Lab server listening on http://${config.host}:${config.port}`);
  // Restart recovery: reconcile any generation left "processing" by a
  // prior process — at most one free status check per record, never a
  // new paid provider call. See product-generation-service.ts.
  reconcileAllProcessingOnStartup()
    .then((count) => {
      if (count > 0) console.log(`Reconciled ${count} generation(s) left "processing" from a prior run.`);
    })
    .catch((error: unknown) => {
      console.error("Startup reconciliation failed:", error instanceof Error ? error.message : error);
    });
});
