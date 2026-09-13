import { Router } from "express";
import { listEnabledHairstyles } from "../../shared/hairstyles.ts";

export const catalogRouter = Router();

catalogRouter.get("/hairstyles", (_req, res) => {
  res.json({ hairstyles: listEnabledHairstyles() });
});
