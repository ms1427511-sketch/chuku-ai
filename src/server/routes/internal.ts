// Internal (MEKKY <-> Chuku) API — Phase 4.1B. Every route here requires
// internal auth (security/internal-auth.ts) and returns only the normalized
// shape in shared/internal-types.ts — never a provider job id, provider
// name, raw provider status, provider URL, provider prompt/debug payload,
// provider error body, API key, or cost information. Purely additive: the
// existing Lab routes (sessions/styles/generations/favorites/history/
// cleanup) are untouched. See docs/architecture.md.
import { Router } from "express";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { InternalCreateGenerationRequest } from "../../shared/internal-types.ts";
import { ChukuError } from "../../shared/errors.ts";
import { internalAuthMiddleware } from "../security/internal-auth.ts";
import { resolveWithinDir, PRODUCT_RESULTS_DIR } from "../security/paths.ts";
import {
  createInternalGeneration,
  getInternalGenerationResultRow,
  getInternalGenerationStatus,
} from "../services/internal-generation-service.ts";
import { handleError } from "./http-errors.ts";

export const internalRouter = Router();

// Scoped to "/internal" (every route below lives under this prefix): a
// bare `.use(internalAuthMiddleware)` would match every path this router
// ever sees once mounted, including unrelated ones like "/health" — since
// it never calls next() on rejection, that would swallow those requests
// with a 401 instead of letting them fall through to their real handler
// (or, correctly, a 404). Deployment-hardening mission section 3/8: route
// absence in service mode must be genuine ("not mounted"), not an
// incidental side effect of this middleware's scope.
internalRouter.use("/internal", internalAuthMiddleware);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

internalRouter.post("/internal/generations", async (req, res) => {
  try {
    const body = req.body as Partial<InternalCreateGenerationRequest> | undefined;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "INVALID_OPERATION", message: "request body is required" });
      return;
    }
    const generation = await createInternalGeneration(body as InternalCreateGenerationRequest);
    res.status(202).json(generation);
  } catch (error) {
    handleError(res, error);
  }
});

internalRouter.get("/internal/generations/:externalGenerationId", async (req, res) => {
  try {
    const generation = await getInternalGenerationStatus(req.params.externalGenerationId);
    res.json(generation);
  } catch (error) {
    handleError(res, error);
  }
});

// Streams local, already-downloaded result bytes only — never proxies or
// forwards a raw provider URL. Same resolveWithinDir traversal defense as
// routes/product-results.ts, scoped to the same PRODUCT_RESULTS_DIR root,
// but gated by internal auth and only reachable once completed.
internalRouter.get("/internal/generations/:externalGenerationId/result", (req, res) => {
  try {
    const row = getInternalGenerationResultRow(req.params.externalGenerationId);
    const filePath = resolveWithinDir(PRODUCT_RESULTS_DIR, row.result_path as string);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: "GENERATION_NOT_FOUND", message: "result file is no longer available" });
      return;
    }
    const stats = statSync(filePath);
    res.setHeader("Content-Length", String(stats.size));
    res.type(MIME_BY_EXT[extname(filePath)] ?? "application/octet-stream");
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error instanceof ChukuError) {
      handleError(res, error);
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
