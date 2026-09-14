import { Router } from "express";
import { createReadStream, existsSync } from "node:fs";
import { extname } from "node:path";
import { resolveWithinDir, PRODUCT_RESULTS_DIR } from "../security/paths.ts";
import { ChukuError } from "../../shared/errors.ts";

export const productResultsRouter = Router();

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// Serves only local, already-downloaded product result files — never
// proxies or forwards a raw LightX URL to the browser. Same
// resolveWithinDir traversal defense as routes/images.ts, scoped to the
// separate PRODUCT_RESULTS_DIR root.
productResultsRouter.get("/product-results/*", (req, res) => {
  const relativePath = (req.params as Record<string, string>)[0]!;
  try {
    const filePath = resolveWithinDir(PRODUCT_RESULTS_DIR, relativePath);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.type(MIME_BY_EXT[extname(filePath)] ?? "application/octet-stream");
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error instanceof ChukuError) {
      res.status(400).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
