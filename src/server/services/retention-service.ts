import { rm } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_RESULTS_DIR, assertRealPathWithinDir } from "../security/paths.ts";
import * as sessionsRepo from "../db/sessions-repo.ts";
import * as generationsRepo from "../db/generations-repo.ts";

export interface CleanupSummary {
  expiredResultsDeleted: number;
  expiredSessionsMarked: number;
}

/**
 * Idempotent retention sweep — see docs/retention.md.
 * REQUIRES_PRODUCT_PRIVACY_APPROVAL: the hour-based defaults here are
 * provisional engineering defaults, not an approved product privacy
 * policy.
 *
 * - Deletes result files whose expiresAt has passed and marks the owning
 *   generation "expired" (status transition only, never re-selected by
 *   listExpiredResults on the next run — naturally idempotent).
 * - Marks active sessions whose expiresAt has passed as "expired" (status
 *   transition only; nothing to delete yet, since this phase has no
 *   per-session source file — see docs/retention.md).
 * - Never touches benchmark/Lab storage roots (TEST_IMAGES_*, see
 *   security/paths.ts) — only ever operates under PRODUCT_RESULTS_DIR.
 */
export async function runRetentionCleanup(): Promise<CleanupSummary> {
  const nowIso = new Date().toISOString();

  let expiredResultsDeleted = 0;
  for (const row of generationsRepo.listExpiredResults(nowIso)) {
    if (!row.result_path) continue;
    const filePath = path.join(PRODUCT_RESULTS_DIR, row.result_path);
    // Symlink-aware check, on top of downloadProductResult always writing
    // under PRODUCT_RESULTS_DIR in the first place — defense in depth
    // immediately before a destructive delete.
    await assertRealPathWithinDir(PRODUCT_RESULTS_DIR, filePath);
    await rm(filePath, { force: true });

    generationsRepo.updateGeneration(row.id, {
      status: "expired",
      result_path: null,
      safe_error_code: "RESULT_EXPIRED",
      failure_message: "result asset passed its retention window and was deleted",
    });

    // Favorite consistency: if this was the session's favorite, leave the
    // pointer in place (it still identifies *which* generation was
    // favorited) rather than silently clearing it — the generation's own
    // status/safeErrorCode/resultUrl now correctly reflect that the asset
    // is gone. See docs/retention.md "Favorite consistency on expiry".
    expiredResultsDeleted += 1;
  }

  let expiredSessionsMarked = 0;
  for (const session of sessionsRepo.listExpiredActiveSessions(nowIso)) {
    sessionsRepo.updateSession(session.id, { status: "expired" });
    expiredSessionsMarked += 1;
  }

  return { expiredResultsDeleted, expiredSessionsMarked };
}
