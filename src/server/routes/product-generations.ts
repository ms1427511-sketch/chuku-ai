import { Router } from "express";
import type { CreateProductGenerationRequest } from "../../shared/types.ts";
import { GenerationNotFoundError, InvalidOperationError } from "../../shared/errors.ts";
import { createProductGeneration, finalizeGeneration, reconcileIfProcessing, toPublicGeneration } from "../services/product-generation-service.ts";
import { setSessionFavorite, toPublicSession } from "../services/session-service.ts";
import * as generationsRepo from "../db/generations-repo.ts";
import * as sessionsRepo from "../db/sessions-repo.ts";
import { handleError } from "./http-errors.ts";

export const productGenerationsRouter = Router();

productGenerationsRouter.post("/sessions/:id/generations", async (req, res) => {
  try {
    const body = req.body as Partial<CreateProductGenerationRequest>;
    if (!body || typeof body.styleId !== "string" || typeof body.operationId !== "string" || !body.operationId) {
      throw new InvalidOperationError("styleId and operationId are required");
    }
    const generation = await createProductGeneration(req.params.id, body.styleId, body.operationId);
    // Fire-and-forget: the HTTP response returns as soon as the provider
    // job is created (status "processing") — the long poll+download
    // happens here, off the request/response cycle. Never awaited by the
    // route. finalizeGeneration is a no-op (returns the row as-is) unless
    // status is still "processing" with a provider_job_id, so this is
    // safe to call unconditionally.
    void finalizeGeneration(generation.id).catch((error: unknown) => {
      console.error(`finalizeGeneration(${generation.id}) failed:`, error instanceof Error ? error.message : error);
    });
    res.status(202).json({ generation });
  } catch (error) {
    handleError(res, error);
  }
});

productGenerationsRouter.get("/generations/:id", async (req, res) => {
  try {
    const row = generationsRepo.getGeneration(req.params.id);
    if (!row) throw new GenerationNotFoundError(req.params.id);
    const reconciled = await reconcileIfProcessing(row);
    const session = sessionsRepo.getSession(reconciled.session_id);
    res.json({ generation: toPublicGeneration(reconciled, session?.favorite_generation_id === reconciled.id) });
  } catch (error) {
    handleError(res, error);
  }
});

productGenerationsRouter.patch("/generations/:id/favorite", (req, res) => {
  try {
    const row = generationsRepo.getGeneration(req.params.id);
    if (!row) throw new GenerationNotFoundError(req.params.id);
    if (row.status !== "completed") {
      throw new InvalidOperationError(`generation ${row.id} is not completed — only a completed generation can be favorited`);
    }
    const favorite = Boolean((req.body as { favorite?: boolean }).favorite);
    const currentSession = sessionsRepo.getSession(row.session_id);
    const wasFavorite = currentSession?.favorite_generation_id === row.id;
    // Un-favoriting only clears the session's pointer if this generation
    // is the *current* favorite — un-favoriting a generation that isn't
    // must never clear a different generation's favorite status.
    const session = favorite
      ? setSessionFavorite(row.session_id, row.id)
      : wasFavorite
        ? setSessionFavorite(row.session_id, null)
        : toPublicSession(currentSession!);
    res.json({ session, generation: toPublicGeneration(row, favorite) });
  } catch (error) {
    handleError(res, error);
  }
});
