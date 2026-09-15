// Business logic for the /internal/* API (Phase 4.1B: MEKKY backend <->
// Chuku AI service). Deliberately separate from services/product-generation-
// service.ts's createProductGeneration — that function encodes Lab-specific
// assumptions (a fixed PORTRAIT_FILENAMES source, the public session/
// generation contract) that must never run for an internal-origin request.
// Status *polling*/reconciliation (reconcileIfProcessing) is generic enough
// to be shared safely between both origins — see below.
import { randomUUID, createHash } from "node:crypto";
import type { GenerationRow, SessionRow } from "../db/types.ts";
import type {
  InternalCreateGenerationRequest,
  InternalGenerationResponse,
  InternalGenerationStatus,
  InternalSafeErrorCode,
} from "../../shared/internal-types.ts";
import {
  ExternalGenerationConflictError,
  GenerationInProgressError,
  GenerationNotFoundError,
  InvalidOperationError,
  SourceFetchError,
  UnknownStyleError,
} from "../../shared/errors.ts";
import { findHairstyle } from "../../shared/hairstyles.ts";
import { config } from "../config/env.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { deleteTempSource, fetchSource } from "../security/source-fetch.ts";
import { LightXHairstyleProvider, ProviderCallError } from "../providers/lightx-provider.ts";
import { mapFailureCategoryToInternalSafeErrorCode, normalizeSafeErrorCodeForInternal } from "./internal-safe-error-mapping.ts";
import { reconcileIfProcessing } from "./product-generation-service.ts";
import * as sessionsRepo from "../db/sessions-repo.ts";
import * as generationsRepo from "../db/generations-repo.ts";

function provider(): LightXHairstyleProvider {
  return new LightXHairstyleProvider(config.lightxApiKey);
}

function assertValidRequest(req: InternalCreateGenerationRequest): void {
  if (!req.externalOwnerId || !req.externalSessionId || !req.externalGenerationId || !req.operationId) {
    throw new InvalidOperationError("externalOwnerId, externalSessionId, externalGenerationId, and operationId are all required");
  }
  if (!req.style?.key) throw new InvalidOperationError("style.key is required");
  const source = req.source;
  if (!source?.signedUrl || !source.expectedMimeType || !source.maxBytes || !source.sourceObjectKey) {
    throw new InvalidOperationError("source.signedUrl, source.expectedMimeType, source.maxBytes, and source.sourceObjectKey are all required");
  }
}

/**
 * Material-request fingerprint tied to external_generation_id. Deliberately
 * excludes operationId (correlation/replay metadata, not material — mission
 * section 6) and signedUrl (expires/changes on every mint, so a retry with a
 * freshly re-signed URL for the same underlying object must still match).
 */
function computeFingerprint(req: InternalCreateGenerationRequest): string {
  const material = {
    externalOwnerId: req.externalOwnerId,
    externalSessionId: req.externalSessionId,
    styleKey: req.style.key,
    sourceObjectKey: req.source.sourceObjectKey,
    expectedMimeType: req.source.expectedMimeType,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function findOrCreateInternalSession(externalOwnerId: string, externalSessionId: string): SessionRow {
  const existing = sessionsRepo.findByExternalSessionId(externalSessionId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const row: SessionRow = {
    id: randomUUID(),
    source_portrait_id: null,
    external_owner_id: externalOwnerId,
    external_session_id: externalSessionId,
    favorite_generation_id: null,
    status: "active",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + config.sourceRetentionHours * 3_600_000).toISOString(),
  };
  return sessionsRepo.insertSession(row);
}

function toInternalStatus(status: string): InternalGenerationStatus {
  return status === "queued" ? "accepted" : (status as InternalGenerationStatus);
}

function toInternalResponse(row: GenerationRow): InternalGenerationResponse {
  return {
    externalGenerationId: row.external_generation_id ?? "",
    status: toInternalStatus(row.status),
    // row.safe_error_code may have been written either by this module
    // (already an internal CHUKU_* code) or by the reused, Lab-shaped
    // reconcileIfProcessing() poll path — always normalize before exposing.
    safeErrorCode: normalizeSafeErrorCodeForInternal(row.safe_error_code),
    resultAvailable: row.status === "completed" && Boolean(row.result_path),
  };
}

function classifyDispatchFailure(error: unknown): InternalSafeErrorCode {
  if (error instanceof SourceFetchError) return "CHUKU_SOURCE_UNAVAILABLE";
  if (error instanceof ProviderCallError) return mapFailureCategoryToInternalSafeErrorCode(error.category);
  return "CHUKU_AI_UNAVAILABLE";
}

async function dispatchToProvider(row: GenerationRow, req: InternalCreateGenerationRequest): Promise<InternalGenerationResponse> {
  let tempPath: string | null = null;
  try {
    const fetched = await fetchSource(req.source.signedUrl, req.source.expectedMimeType, req.source.maxBytes);
    tempPath = fetched.tempPath;
    // req.style.key was already validated against the catalog by the caller.
    const hairstyle = findHairstyle(req.style.key)!;
    const job = await provider().createGeneration({ sourceImagePath: tempPath, prompt: hairstyle.prompt });
    const updated = generationsRepo.updateGeneration(row.id, {
      status: "processing",
      provider_job_id: job.externalJobId,
      started_at: new Date().toISOString(),
    });
    return toInternalResponse(updated);
  } catch (error) {
    const safeErrorCode = classifyDispatchFailure(error);
    const message = error instanceof Error ? error.message : "unknown error";
    const updated = generationsRepo.updateGeneration(row.id, {
      status: "failed",
      safe_error_code: safeErrorCode,
      failure_message: sanitizeErrorMessage(message, config.lightxApiKey),
      completed_at: new Date().toISOString(),
    });
    return toInternalResponse(updated);
  } finally {
    if (tempPath) await deleteTempSource(tempPath);
  }
}

/**
 * Creates (or, for an exact replay of externalGenerationId, returns without
 * ever re-dispatching) an internal generation. Never re-runs
 * createProductGeneration's Lab-specific business logic. See mission
 * sections 3, 6, and 7 (ambiguous acceptance recovery).
 */
export async function createInternalGeneration(req: InternalCreateGenerationRequest): Promise<InternalGenerationResponse> {
  assertValidRequest(req);
  const fingerprint = computeFingerprint(req);

  // Primary idempotency key: external_generation_id, looked up first and
  // globally (independent of session) — mission section 6. node:sqlite is
  // fully synchronous (db/connection.ts) and nothing below awaits before the
  // insert, so this check-then-insert cannot be interleaved by a concurrent
  // in-process request; the UNIQUE index in schema.ts is the database-level
  // backstop for any other case.
  const existing = generationsRepo.findByExternalGenerationId(req.externalGenerationId);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) {
      throw new ExternalGenerationConflictError(req.externalGenerationId);
    }
    return toInternalResponse(existing);
  }

  const hairstyle = findHairstyle(req.style.key);
  if (!hairstyle) throw new UnknownStyleError(req.style.key);

  const session = findOrCreateInternalSession(req.externalOwnerId, req.externalSessionId);

  const skeleton: GenerationRow = {
    id: randomUUID(),
    session_id: session.id,
    operation_id: req.operationId,
    style_id: req.style.key,
    provider: "lightx",
    provider_job_id: null,
    generation_index: generationsRepo.nextGenerationIndex(session.id, req.style.key),
    status: "queued",
    source_portrait_id: null,
    external_generation_id: req.externalGenerationId,
    request_fingerprint: fingerprint,
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

  const { row, created } = generationsRepo.insertGenerationIfWithinLimit(skeleton, config.maxGenerationsPerSession);
  if (!created) return toInternalResponse(row);

  return dispatchToProvider(row, req);
}

/** GET /internal/generations/:externalGenerationId — opportunistically reconciles a still-processing row, exactly like the Lab's GET /generations/:id. */
export async function getInternalGenerationStatus(externalGenerationId: string): Promise<InternalGenerationResponse> {
  const row = generationsRepo.findByExternalGenerationId(externalGenerationId);
  if (!row) throw new GenerationNotFoundError(externalGenerationId);
  const reconciled = await reconcileIfProcessing(row);
  return toInternalResponse(reconciled);
}

/** GET /internal/generations/:externalGenerationId/result — only resolves a path once the generation is completed with a result on disk. */
export function getInternalGenerationResultRow(externalGenerationId: string): GenerationRow {
  const row = generationsRepo.findByExternalGenerationId(externalGenerationId);
  if (!row) throw new GenerationNotFoundError(externalGenerationId);
  if (row.status === "failed") throw new GenerationNotFoundError(externalGenerationId);
  if (row.status !== "completed" || !row.result_path) {
    throw new GenerationInProgressError(externalGenerationId);
  }
  return row;
}
