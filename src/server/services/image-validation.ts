import { stat } from "node:fs/promises";
import path from "node:path";
import { UnsupportedImageTypeError, InvalidImagePathError } from "../../shared/errors.ts";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const MAX_BYTES = 5_242_880; // matches LightX's documented cap, docs/lightx.md
const MIN_BYTES = 1024; // reject empty/near-empty files early, before spending a provider call

export async function validatePortraitFile(absolutePath: string): Promise<void> {
  const ext = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new UnsupportedImageTypeError(ext || "(no extension)");
  }
  const stats = await stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new InvalidImagePathError(`not a regular file: ${absolutePath}`);
  }
  if (stats.size < MIN_BYTES) {
    throw new InvalidImagePathError(`file too small to be a real photo (${stats.size} bytes)`);
  }
  if (stats.size > MAX_BYTES) {
    throw new InvalidImagePathError(`file exceeds ${MAX_BYTES} byte limit (${stats.size} bytes)`);
  }
}
