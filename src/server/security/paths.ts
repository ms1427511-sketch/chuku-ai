import path from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { PROJECT_ROOT } from "../config/env.ts";
import { InvalidImagePathError } from "../../shared/errors.ts";

// Benchmark/Lab-only storage roots — Stage A/B evidence. Never touched by
// product session/generation code (services/retention-service.ts,
// services/product-storage.ts), so a product cleanup bug can never delete
// benchmark evidence — see docs/retention.md "Storage root separation".
export const TEST_IMAGES_INPUT_DIR = path.join(PROJECT_ROOT, "test-images", "input");
export const TEST_IMAGES_RESULTS_DIR = path.join(PROJECT_ROOT, "test-images", "results");
export const CONTACT_SHEETS_DIR = path.join(PROJECT_ROOT, "test-images", "contact-sheets");

// Product (session/generation) storage roots — real, owned, deletable
// runtime data, distinct from the benchmark roots above.
export const PRODUCT_DATA_DIR = path.join(PROJECT_ROOT, "data");
export const PRODUCT_RESULTS_DIR = path.join(PROJECT_ROOT, "data", "results");
export const PRODUCT_DB_PATH = path.join(PROJECT_ROOT, "data", "chuku.db");
// Phase 4.1B internal integration only: short-lived local copies of a
// MEKKY-issued signed source download, deleted once no longer needed — see
// security/source-fetch.ts. Never a Lab/benchmark root, never provider input
// path reused across requests.
export const PRODUCT_TMP_DIR = path.join(PROJECT_ROOT, "data", "tmp");

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

/**
 * Directory for one product session's downloaded result files. `sessionId`
 * is always a server-generated id (never raw user text), but
 * `resolveWithinDir` is still applied — same structural-defense pattern as
 * `resolveResultDir` above.
 */
export function resolveProductResultDir(sessionId: string): string {
  return resolveWithinDir(PRODUCT_RESULTS_DIR, sessionId);
}

/**
 * A safe temp filename/path for one internal source download: always a
 * server-generated token (never derived from caller input), and always
 * resolved through resolveWithinDir — same structural-defense pattern as
 * resolveProductResultDir.
 */
export function resolveProductTmpFile(tmpToken: string): string {
  return resolveWithinDir(PRODUCT_TMP_DIR, tmpToken);
}

/**
 * A second, stronger check used only before a destructive filesystem
 * operation (deleting a retention-expired result file): resolves the
 * *real* (symlink-dereferenced) path of both the base directory and the
 * candidate, so a symlink planted inside an allowed directory that points
 * outside it is caught too — `resolveWithinDir`'s lexical check alone
 * cannot see through a symlink. Throws unless the real candidate path is
 * still strictly inside the real base directory.
 */
export async function assertRealPathWithinDir(baseDir: string, candidatePath: string): Promise<void> {
  const realBase = await realpath(baseDir).catch(() => path.resolve(baseDir));
  const realCandidate = await realpath(candidatePath).catch(() => path.resolve(candidatePath));
  const relative = path.relative(realBase, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InvalidImagePathError(`resolved real path escapes allowed directory: ${candidatePath}`);
  }
}
