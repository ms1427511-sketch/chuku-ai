import express from "express";
import { config } from "./config/env.ts";
import { sanitizeErrorMessage } from "./security/sanitize.ts";
import { catalogRouter } from "./routes/catalog.ts";
import { generationsRouter } from "./routes/generations.ts";
import { imagesRouter } from "./routes/images.ts";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(catalogRouter);
app.use(generationsRouter);
app.use(imagesRouter);

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
});
