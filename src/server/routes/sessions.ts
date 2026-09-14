import { Router } from "express";
import type { CreateSessionSourceRequest } from "../../shared/types.ts";
import { InvalidOperationError } from "../../shared/errors.ts";
import { createSession, getSession, getSessionRowOrThrow, setSessionSource } from "../services/session-service.ts";
import * as generationsRepo from "../db/generations-repo.ts";
import { reconcileIfProcessing, toPublicGeneration } from "../services/product-generation-service.ts";
import { handleError } from "./http-errors.ts";

export const sessionsRouter = Router();

sessionsRouter.post("/sessions", (_req, res) => {
  const session = createSession();
  res.status(201).json({ session });
});

sessionsRouter.get("/sessions/:id", (req, res) => {
  try {
    res.json({ session: getSession(req.params.id) });
  } catch (error) {
    handleError(res, error);
  }
});

sessionsRouter.post("/sessions/:id/source", (req, res) => {
  try {
    const body = req.body as Partial<CreateSessionSourceRequest>;
    if (!body || typeof body.sourcePortraitId !== "string") {
      throw new InvalidOperationError("sourcePortraitId is required");
    }
    const session = setSessionSource(req.params.id, body.sourcePortraitId);
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

sessionsRouter.get("/sessions/:id/generations", async (req, res) => {
  try {
    const sessionRow = getSessionRowOrThrow(req.params.id);
    const rows = generationsRepo.listBySession(sessionRow.id);
    const reconciled = [];
    for (const row of rows) {
      reconciled.push(await reconcileIfProcessing(row));
    }
    const generations = reconciled.map((row) => toPublicGeneration(row, sessionRow.favorite_generation_id === row.id));
    res.json({ generations });
  } catch (error) {
    handleError(res, error);
  }
});
