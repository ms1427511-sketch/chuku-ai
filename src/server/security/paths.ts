import path from "node:path";
import { existsSync } from "node:fs";
import { PROJECT_ROOT } from "../config/env.ts";
import { InvalidImagePathError } from "../../shared/errors.ts";

export const TEST_IMAGES_INPUT_DIR = path.join(PROJECT_ROOT, "test-images", "input");
export const TEST_IMAGES_RESULTS_DIR = path.join(PROJECT_ROOT, "test-images", "results");
export const CONTACT_SHEETS_DIR = path.join(PROJECT_ROOT, "test-images", "contact-sheets");

/**
 * Resolves `relativePath` against `baseDir` and throws unless the result is
 * still strictly inside `baseDir` — the only defense that actually matters
 * against path traversal (`../../etc/passwd`-style input); string-matching
 * on the raw input alone is not sufficient (symlink/encoding tricks), so
 * this always compares the fully resolved absolute path.
 */
export function resolveWithinDir(baseDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, relativePath);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InvalidImagePathError(`path escapes allowed directory: ${relativePath}`);
  }
  return resolved;
}

export function resolveInputPortrait(portraitFileName: string): string {
  const resolved = resolveWithinDir(TEST_IMAGES_INPUT_DIR, portraitFileName);
  if (!existsSync(resolved)) {
    throw new InvalidImagePathError(`file does not exist: ${portraitFileName}`);
  }
  return resolved;
}

export function resolveResultDir(source: string, hairstyleId: string): string {
  // Both segments always come from validated catalog/portrait ids
  // (never raw user text), but resolveWithinDir is still applied — a
  // second, structural layer of defense rather than trusting the caller.
  return resolveWithinDir(TEST_IMAGES_RESULTS_DIR, path.join(source, hairstyleId));
}
