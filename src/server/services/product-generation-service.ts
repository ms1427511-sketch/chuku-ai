import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { ProductGeneration, ProductGenerationStatus } from "../../shared/types.ts";
import { findHairstyle } from "../../shared/hairstyles.ts";
import {
  GenerationNotFoundError,
  InvalidOperationError,
  SessionNotFoundError,
  SourceRequiredError,
  UnknownStyleError,
} from "../../shared/errors.ts";
import { resolveInputPortrait, resolveProductResultDir } from "../security/paths.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { config } from "../config/env.ts";
import { LightXHairstyleProvider, ProviderCallError } from "../providers/lightx-provider.ts";
import { mapFailureCategoryToSafeErrorCode } from "./safe-error-mapping.ts";
import { PORTRAIT_FILENAMES } from "./generation-service.ts";
import * as sessionsRepo from "../db/sessions-repo.ts";
import * as generationsRepo from "../db/generations-repo.ts";
import type { GenerationRow } from "../db/types.ts";

// Restart recovery never re-submits a new paid job. A "processing" record
// found stale (older than this) is marked failed locally, based purely on
// elapsed time — no provider contact needed for that branch. This is well
// beyond the LightX adapter's own ~60s poll ceiling (lightx-provider.ts),
// so a genuinely still-in-flight job is never prematurely killed.
const STALE_PROCESSING_THRESHOLD_MS = 5 * 60_000;

function provider(): LightXHairstyleProvider {
  return new LightXHairstyleProvider(config.lightxApiKey);
}

async function downloadProductResult(resultUrl: string, sessionId: string, generationId: string): Promise<string> {
  const dir = resolveProductResultDir(sessionId);
  await mkdir(dir, { recursive: true });
  const response = await fetch(resultUrl);
  if (!response.ok) throw new Error(`failed to download result image: HTTP ${response.status}`);
  const ext = resultUrl.toLowerCase().includes(".png") ? "png" : "jpg";
  const fileName = `${generationId}.${ext}`;
  await writeFile(path.join(dir, fileName), new Uint8Array(await response.arrayBuffer()));
  // Relative to PRODUCT_RESULTS_DIR — never an absolute filesystem path.
  return path.join(sessionId, fileName);
}

export function toPublicGeneration(row: GenerationRow, favorite: boolean): ProductGeneration {
  return {
    id: row.id,
    sessionId: row.session_id,
    styleId: row.style_id,
    generationIndex: row.generation_index,
    status: row.status as ProductGenerationStatus,
    resultUrl: row.result_path ? `/product-results/${row.result_path}` : null,
    favorite,
    safeErrorCode: (row.safe_error_code as ProductGeneration["safeErrorCode"]) ?? null,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Creates (or, for a replayed operationId, returns) a generation. Awaits
 * only the LightX *job-creation* call (a few seconds) — never the full
 * poll — so the HTTP caller gets a Chuku generation id back quickly with
 * status "processing". Call finalizeGeneration(id) separately (fire-and-
 * forget at the route layer, directly awaitable in tests) to run the long
 * poll+download+terminal-status update.
 */
export async function createProductGeneration(sessionId: string, styleId: string, operationId: string): Promise<ProductGeneration> {
  const session = sessionsRepo.getSession(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  if (session.status !== "active") throw new InvalidOperationError(`session ${sessionId} is no longer active`);
  if (!session.source_portrait_id) throw new SourceRequiredError();
  if (!operationId) throw new InvalidOperationError("operationId is required");

  const hairstyle = findHairstyle(styleId);
  if (!hairstyle) throw new UnknownStyleError(styleId);

  const generationIndex = generationsRepo.nextGenerationIndex(sessionId, styleId);
  const skeleton: GenerationRow = {
    id: randomUUID(),
    session_id: sessionId,
    operation_id: operationId,
    style_id: styleId,
    provider: "lightx",
    provider_job_id: null,
    generation_index: generationIndex,
    status: "queued",
    source_portrait_id: session.source_portrait_id,
    result_path: null,
    retry_of: null,
    retry_count: 0,
    safe_error_code: null,
    failure_message: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    latency_ms: null,
    expires_at: null,
  };

  // Race-free: the count-check-then-insert happens inside one synchronous
  // node:sqlite call (see db/connection.ts) — a concurrent duplicate
  // request cannot be interleaved between the check and the insert. An
  // existing (session, operationId) row is returned as-is without ever
  // touching the provider again.
  const { row, created } = generationsRepo.insertGenerationIfWithinLimit(skeleton, config.maxGenerationsPerSession);
  const favorite = session.favorite_generation_id === row.id;
  if (!created) return toPublicGeneration(row, favorite);

  const fileName = PORTRAIT_FILENAMES[session.source_portrait_id];
  if (!fileName) throw new InvalidOperationError(`session ${sessionId} has an unrecognized source portrait id`);

  try {
    const job = await provider().createGeneration({
      sourceImagePath: resolveInputPortrait(fileName),
      prompt: hairstyle.prompt,
    });
    const updated = generationsRepo.updateGeneration(row.id, {
      status: "processing",
      provider_job_id: job.externalJobId,
      started_at: new Date().toISOString(),
    });
    return toPublicGeneration(updated, favorite);
  } catch (error) {
    const category = error instanceof ProviderCallError ? error.category : "unknown";
    const message = error instanceof Error ? error.message : "unknown error";
    const updated = generationsRepo.updateGeneration(row.id, {
      status: "failed",
      safe_error_code: mapFailureCategoryToSafeErrorCode(category),
      failure_message: sanitizeErrorMessage(message, config.lightxApiKey),
      completed_at: new Date().toISOString(),
    });
    return toPublicGeneration(updated, favorite);
  }
}

/**
 * Long poll + download + terminal-status update for a generation already
 * in "processing" (provider job already created). Directly awaitable —
 * tests call this instead of relying on fire-and-forget timing; the route
 * layer instead does `void finalizeGeneration(id).catch(...)` so the HTTP
 * response for createProductGeneration is never blocked on this.
 */
export async function finalizeGeneration(id: string): Promise<ProductGeneration> {
  const row = generationsRepo.getGeneration(id);
  if (!row) throw new GenerationNotFoundError(id);
  const favorite = isFavorite(row);
  if (row.status !== "processing" || !row.provider_job_id) return toPublicGeneration(row, favorite);

  const startedAt = row.started_at ?? row.created_at;
  try {
    const status = await provider().pollUntilTerminal(row.provider_job_id);
    const completedAt = new Date().toISOString();
    const latencyMs = Date.parse(completedAt) - Date.parse(startedAt);

    if (status.status === "completed" && status.resultUrl) {
      const resultPath = await downloadProductResult(status.resultUrl, row.session_id, row.id);
      const updated = generationsRepo.updateGeneration(id, {
        status: "completed",
        result_path: resultPath,
        completed_at: completedAt,
        latency_ms: latencyMs,
        expires_at: new Date(Date.now() + config.resultRetentionHours * 3_600_000).toISOString(),
      });
      return toPublicGeneration(updated, favorite);
    }

    const updated = generationsRepo.updateGeneration(id, {
      status: "failed",
      safe_error_code: mapFailureCategoryToSafeErrorCode(status.failureCategory ?? "provider_error"),
      failure_message: status.failureMessage ?? "provider returned a non-completed terminal status",
      completed_at: completedAt,
      latency_ms: latencyMs,
    });
    return toPublicGeneration(updated, favorite);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const category = error instanceof ProviderCallError ? error.category : "unknown";
    const message = error instanceof Error ? error.message : "unknown error";
    const updated = generationsRepo.updateGeneration(id, {
      status: "failed",
      safe_error_code: mapFailureCategoryToSafeErrorCode(category),
      failure_message: sanitizeErrorMessage(message, config.lightxApiKey),
      completed_at: completedAt,
      latency_ms: Date.parse(completedAt) - Date.parse(startedAt),
    });
    return toPublicGeneration(updated, favorite);
  }
}

function isFavorite(row: GenerationRow): boolean {
  const session = sessionsRepo.getSession(row.session_id);
  return session?.favorite_generation_id === row.id;
}

/**
 * Restart recovery for one stale "processing" row: at most one free status
 * check against the provider (getGeneration, not createGeneration) — never
 * re-submits a new paid job. Past the staleness threshold with no terminal
 * status, the record is marked failed locally without further provider
 * contact.
 */
export async function reconcileIfProcessing(row: GenerationRow): Promise<GenerationRow> {
  if (row.status !== "processing") return row;

  if (!row.provider_job_id) {
    // Process died before the paid job was even confirmed created —
    // there is nothing to poll and nothing was necessarily charged; never
    // guess by re-submitting.
    return generationsRepo.updateGeneration(row.id, {
      status: "failed",
      safe_error_code: "PROVIDER_TEMPORARY_FAILURE",
      failure_message: "generation was interrupted before a provider job id was recorded",
      completed_at: new Date().toISOString(),
    });
  }

  const startedAt = Date.parse(row.started_at ?? row.created_at);
  const age = Date.now() - startedAt;

  try {
    const status = await provider().getGeneration(row.provider_job_id);
    if (status.status === "completed" && status.resultUrl) {
      const resultPath = await downloadProductResult(status.resultUrl, row.session_id, row.id);
      return generationsRepo.updateGeneration(row.id, {
        status: "completed",
        result_path: resultPath,
        completed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + config.resultRetentionHours * 3_600_000).toISOString(),
      });
    }
    if (status.status === "failed") {
      return generationsRepo.updateGeneration(row.id, {
        status: "failed",
        safe_error_code: mapFailureCategoryToSafeErrorCode(status.failureCategory ?? "provider_error"),
        failure_message: status.failureMessage ?? "provider reported failure during restart reconciliation",
        completed_at: new Date().toISOString(),
      });
    }
    if (age > STALE_PROCESSING_THRESHOLD_MS) {
      return generationsRepo.updateGeneration(row.id, {
        status: "failed",
        safe_error_code: "PROVIDER_TEMPORARY_FAILURE",
        failure_message: `generation exceeded the ${STALE_PROCESSING_THRESHOLD_MS}ms staleness threshold after a restart`,
        completed_at: new Date().toISOString(),
      });
    }
    return row; // still genuinely in flight — a later reconcile/finalize can pick it back up.
  } catch {
    if (age > STALE_PROCESSING_THRESHOLD_MS) {
      return generationsRepo.updateGeneration(row.id, {
        status: "failed",
        safe_error_code: "PROVIDER_TEMPORARY_FAILURE",
        failure_message: "provider status check failed during restart reconciliation",
        completed_at: new Date().toISOString(),
      });
    }
    return row;
  }
}

/** Called once at server startup — reconciles every row left "processing" by a prior process. */
export async function reconcileAllProcessingOnStartup(): Promise<number> {
  const stale = generationsRepo.listByStatus("processing");
  for (const row of stale) {
    await reconcileIfProcessing(row);
  }
  return stale.length;
}
