import { Router } from "express";
import type { CreateGenerationRequest, FailureFlag, ManualScore } from "../../shared/types.ts";
import { ChukuError } from "../../shared/errors.ts";
import { createGeneration, reworkGeneration, historyFor, setFavorite } from "../services/generation-service.ts";
import { updateRecord } from "../services/storage.ts";
import { costGuard } from "../services/cost-guard.ts";
import { config } from "../config/env.ts";

export const generationsRouter = Router();

function errorStatus(code: string): number {
  switch (code) {
    case "GENERATION_LIMIT_REACHED":
      return 429;
    case "UNKNOWN_HAIRSTYLE":
    case "UNKNOWN_PORTRAIT":
    case "INVALID_IMAGE_PATH":
    case "UNSUPPORTED_IMAGE_TYPE":
      return 400;
    case "MISSING_PROVIDER_CREDENTIAL":
      return 503;
    default:
      return 500;
  }
}

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof ChukuError) {
    res.status(errorStatus(error.code)).json({ error: error.code, message: error.message });
    return;
  }
  // Never forward a raw provider error/stack trace to the client.
  res.status(500).json({ error: "INTERNAL_ERROR", message: "unexpected server error" });
}

generationsRouter.get("/generations", async (req, res) => {
  const source = typeof req.query.source === "string" ? req.query.source : undefined;
  const hairstyleId = typeof req.query.hairstyleId === "string" ? req.query.hairstyleId : undefined;
  const history = await historyFor(source, hairstyleId);
  res.json({ generations: history });
});

generationsRouter.get("/generations/totals", (_req, res) => {
  res.json({
    totals: costGuard.totals(),
    lightxConfigured: Boolean(config.lightxApiKey),
  });
});

generationsRouter.post("/generations", async (req, res) => {
  const body = req.body as Partial<CreateGenerationRequest>;
  if (!body || typeof body.source !== "string" || typeof body.hairstyleId !== "string") {
    res.status(400).json({ error: "INVALID_REQUEST", message: "source and hairstyleId are required" });
    return;
  }
  try {
    const record = await createGeneration({ source: body.source as CreateGenerationRequest["source"], hairstyleId: body.hairstyleId });
    res.status(201).json({ generation: record });
  } catch (error) {
    handleError(res, error);
  }
});

generationsRouter.post("/generations/:id/rework", async (req, res) => {
  try {
    const record = await reworkGeneration(req.params.id);
    res.status(201).json({ generation: record });
  } catch (error) {
    handleError(res, error);
  }
});

generationsRouter.patch("/generations/:id/score", async (req, res) => {
  try {
    const score = req.body as ManualScore;
    const updated = await updateRecord(req.params.id, { score });
    res.json({ generation: updated });
  } catch (error) {
    handleError(res, error);
  }
});

generationsRouter.patch("/generations/:id/flags", async (req, res) => {
  try {
    const flags = (req.body as { flags?: FailureFlag[] }).flags ?? [];
    const updated = await updateRecord(req.params.id, { flags });
    res.json({ generation: updated });
  } catch (error) {
    handleError(res, error);
  }
});

generationsRouter.patch("/generations/:id/favorite", async (req, res) => {
  try {
    const favorite = Boolean((req.body as { favorite?: boolean }).favorite);
    const updated = await setFavorite(req.params.id, favorite);
    res.json({ generation: updated });
  } catch (error) {
    handleError(res, error);
  }
});
