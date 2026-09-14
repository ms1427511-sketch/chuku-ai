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

// Bind strictly to 127.0.0.1 — never 0.0.0.0. This server proxies a
// provider secret and must never be reachable from outside localhost.
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
