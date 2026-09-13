import { Router } from "express";
import { createReadStream, existsSync } from "node:fs";
import { extname } from "node:path";
import { resolveInputPortrait, resolveWithinDir, TEST_IMAGES_RESULTS_DIR } from "../security/paths.ts";
import { ChukuError } from "../../shared/errors.ts";

export const imagesRouter = Router();

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const INPUT_FILENAMES: Record<string, string> = {
  "portrait-a": "portrait-a.png",
  "portrait-b": "portrait-b.png",
  "portrait-c": "portrait-c.png",
};

// Serves local benchmark images only (source portraits + downloaded
// results already saved under test-images/). Never proxies or forwards a
// remote LightX URL to the browser.
imagesRouter.get("/input/:source", (req, res) => {
  const fileName = INPUT_FILENAMES[req.params.source];
  if (!fileName) {
    res.status(404).json({ error: "UNKNOWN_PORTRAIT" });
    return;
  }
  try {
    const filePath = resolveInputPortrait(fileName);
    res.type(MIME_BY_EXT[extname(filePath)] ?? "application/octet-stream");
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error instanceof ChukuError) {
      res.status(404).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

imagesRouter.get("/results/*", (req, res) => {
  const relativePath = (req.params as Record<string, string>)[0]!;
  try {
    const filePath = resolveWithinDir(TEST_IMAGES_RESULTS_DIR, relativePath);
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
