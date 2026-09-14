import { Router } from "express";
import { listEnabledHairstyles } from "../../shared/hairstyles.ts";

export const catalogRouter = Router();

catalogRouter.get("/hairstyles", (_req, res) => {
  res.json({ hairstyles: listEnabledHairstyles() });
});

// Stable product API name for the same catalog (docs/integration-contract.md).
// /hairstyles stays as-is for the existing Lab UI.
catalogRouter.get("/styles", (_req, res) => {
  res.json({ styles: listEnabledHairstyles() });
});
