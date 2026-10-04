// Business logic for the /internal/* API (Phase 4.1B: MEKKY backend <->
// Chuku AI service). Deliberately separate from services/product-generation-
// service.ts's createProductGeneration — that function encodes Lab-specific
// assumptions (a fixed PORTRAIT_FILENAMES source, the public session/
// generation contract) that must never run for an internal-origin request.
// Status *polling*/reconciliation (reconcileIfProcessing) is generic enough
// to be shared safely between both origins — see below.
import { randomUUID, createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { GenerationRow, SessionRow } from "../db/types.ts";
import type {
  InternalBilling,
  InternalCreateGenerationRequest,
  InternalGenerationResponse,
  InternalGenerationStatus,
  InternalSafeErrorCode,
  InternalSessionPurgeResponse,
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
import { PRODUCT_RESULTS_DIR, assertRealPathWithinDir } from "../security/paths.ts";
import { deleteTempSource, fetchSource } from "../security/source-fetch.ts";
import { ProviderCallError } from "../providers/lightx-provider.ts";
import { getProvider } from "../providers/provider-factory.ts";
import { mapFailureCategoryToInternalSafeErrorCode, normalizeSafeErrorCodeForInternal } from "./internal-safe-error-mapping.ts";
import { reconcileIfProcessing } from "./product-generation-service.ts";
import { buildProviderPrompt } from "./preservation-prompt.ts";
import * as chargesRepo from "../db/charges-repo.ts";
import * as sessionsRepo from "../db/sessions-repo.ts";
import * as generationsRepo from "../db/generations-repo.ts";

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
  if (status === "queued") return "accepted";
  // Purged artifacts (purgeInternalSessionArtifacts) -- terminal, no result.
  if (status === "expired") return "failed";
  return status as InternalGenerationStatus;
}

function toBilling(row: GenerationRow): InternalBilling {
  const charge = chargesRepo.getCharge(row.id);
  // A generation recorded before the charge table existed: its cost was
  // never tracked, so it can only be reported as unknown, never as free.
  if (!charge) return { state: "unknown", credits: null };
  switch (charge.state) {
    case "charged":
      return { state: "charged", credits: charge.credits };
    case "not_charged":
      return { state: "not_charged", credits: 0 };
    case "unknown":
      return { state: "unknown", credits: null };
    default:
      return { state: "pending", credits: null };
  }
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
    billing: toBilling(row),
  };
}

function classifyDispatchFailure(error: unknown): InternalSafeErrorCode {
  if (error instanceof SourceFetchError) return "CHUKU_SOURCE_UNAVAILABLE";
  if (error instanceof ProviderCallError) return mapFailureCategoryToInternalSafeErrorCode(error.category);
  return "CHUKU_AI_UNAVAILABLE";
}

// LightX documents these as refusing the request without deducting credits
// (docs/lightx.md); an auth rejection never reaches billing either.
const NO_CHARGE_PROVIDER_CODES: ReadonlySet<number> = new Set([5040, 5041, 5044]);
const NO_CHARGE_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Whether a failed dispatch can have cost a credit. Only the /hairstyle
 * submit is paid: a failure before it is never charged; a failure during
 * it is unknown (the request may have been accepted before the connection
 * dropped) unless the provider explicitly refused it.
 */
function chargeStateForDispatchFailure(error: unknown): chargesRepo.ChargeState {
  if (!(error instanceof ProviderCallError) || error.stage !== "submit") return "not_charged";
  if (error.providerCode !== null && NO_CHARGE_PROVIDER_CODES.has(error.providerCode)) return "not_charged";
  if (error.httpStatus !== null && NO_CHARGE_HTTP_STATUSES.has(error.httpStatus)) return "not_charged";
  return "unknown";
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function utcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Kill switch and breakers, checked before anything is recorded as a
 * possible charge. Returns the safe code to refuse with, or null to admit.
 * Per-owner limits surface as a quota error; global limits as the service
 * being unavailable (the customer can do nothing about them).
 */
function admissionRefusal(session: SessionRow, ownerId: string): InternalSafeErrorCode | null {
  if (session.status === "purged") return "CHUKU_CANCELLED";
  if (!config.generationEnabled) return "CHUKU_AI_UNAVAILABLE";
  const now = new Date();
  const day = utcDayStart(now);
  const month = utcMonthStart(now);
  if (chargesRepo.countChargeable(day, ownerId) >= config.ownerDailyLimit) return "CHUKU_QUOTA_EXCEEDED";
  if (chargesRepo.countChargeable(month, ownerId) >= config.ownerMonthlyLimit) return "CHUKU_QUOTA_EXCEEDED";
  if (chargesRepo.countChargeable(day) >= config.globalDailyLimit) return "CHUKU_AI_UNAVAILABLE";
  if (chargesRepo.countChargeable(month) >= config.globalMonthlyLimit) return "CHUKU_AI_UNAVAILABLE";
  return null;
}

async function dispatchToProvider(row: GenerationRow, req: InternalCreateGenerationRequest): Promise<InternalGenerationResponse> {
  let tempPath: string | null = null;
  try {
    const fetched = await fetchSource(req.source.signedUrl, req.source.expectedMimeType, req.source.maxBytes);
    tempPath = fetched.tempPath;
    // req.style.key was already validated against the catalog by the caller.
    const hairstyle = findHairstyle(req.style.key)!;
    chargesRepo.setChargeState(row.id, "submitting");
    const job = await getProvider().createGeneration({ sourceImagePath: tempPath, prompt: buildProviderPrompt(hairstyle.prompt) });
    const updated = generationsRepo.updateGeneration(row.id, {
      status: "processing",
      provider_job_id: job.externalJobId,
      started_at: new Date().toISOString(),
    });
    chargesRepo.setChargeState(row.id, "submitted");
    return toInternalResponse(updated);
  } catch (error) {
    chargesRepo.setChargeState(row.id, chargeStateForDispatchFailure(error), "dispatch_failed");
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
  const refusal = admissionRefusal(session, req.externalOwnerId);
  const now = new Date().toISOString();

  const skeleton: GenerationRow = {
    id: randomUUID(),
    session_id: session.id,
    operation_id: req.operationId,
    style_id: req.style.key,
    provider: config.providerMode,
    provider_job_id: null,
    generation_index: generationsRepo.nextGenerationIndex(session.id, req.style.key),
    // A refused generation is still recorded (failed, never charged) so a
    // replay of the same externalGenerationId returns the same refusal
    // rather than slipping through once the switch or limit changes.
    status: refusal ? "failed" : "queued",
    source_portrait_id: null,
    external_generation_id: req.externalGenerationId,
    request_fingerprint: fingerprint,
    result_path: null,
    retry_of: null,
    retry_count: 0,
    safe_error_code: refusal,
    failure_message: refusal ? "generation not admitted" : null,
    created_at: now,
    started_at: null,
    completed_at: refusal ? now : null,
    latency_ms: null,
    expires_at: null,
  };

  // No await between the breaker counts above, this insert and the charge
  // insert below -- node:sqlite is synchronous, so admission cannot be
  // interleaved by a concurrent request (see db/connection.ts).
  const { row, created } = generationsRepo.insertGenerationIfWithinLimit(skeleton, config.maxGenerationsPerSession);
  if (!created) return toInternalResponse(row);
  chargesRepo.insertCharge(
    row.id,
    req.externalOwnerId,
    refusal ? "not_charged" : "reserved",
    config.creditsPerGeneration,
    refusal ? "not_admitted" : null,
  );
  if (refusal) return toInternalResponse(row);

  return dispatchToProvider(row, req);
}

// The POST is synchronous, so a row still "queued" well after creation
// means the process died mid-dispatch.
const STUCK_QUEUED_MS = 10 * 60_000;

function recoverStuckQueued(row: GenerationRow): GenerationRow {
  if (row.status !== "queued" || Date.now() - Date.parse(row.created_at) < STUCK_QUEUED_MS) return row;
  const charge = chargesRepo.getCharge(row.id);
  // "reserved" = died before the provider was contacted; "submitting" = it
  // may have reached the paid submit.
  chargesRepo.setChargeState(row.id, charge?.state === "reserved" ? "not_charged" : "unknown", "interrupted_dispatch");
  return generationsRepo.updateGeneration(row.id, {
    status: "failed",
    safe_error_code: "CHUKU_AI_UNAVAILABLE",
    failure_message: "generation was interrupted during dispatch",
    completed_at: new Date().toISOString(),
  });
}

/** Settles a submitted charge once the provider job is terminal. */
function settleCharge(row: GenerationRow): void {
  if (chargesRepo.getCharge(row.id)?.state !== "submitted") return;
  if (row.status === "completed") {
    chargesRepo.setChargeState(row.id, "charged", "completed");
  } else if (row.status === "failed") {
    // LightX does not document whether a job that failed after acceptance
    // was charged.
    chargesRepo.setChargeState(row.id, "unknown", "provider_failed_after_submit");
  }
}

async function deleteLocalResult(row: GenerationRow): Promise<boolean> {
  if (!row.result_path) return false;
  const filePath = path.join(PRODUCT_RESULTS_DIR, row.result_path);
  await assertRealPathWithinDir(PRODUCT_RESULTS_DIR, filePath);
  await rm(filePath, { force: true });
  generationsRepo.updateGeneration(row.id, {
    status: "expired",
    result_path: null,
    safe_error_code: "CHUKU_CANCELLED",
    failure_message: "session artifacts were purged",
  });
  return true;
}

/**
 * DELETE /internal/sessions/:externalSessionId/artifacts — MEKKY's session
 * purge. Deletes this service's local result copies (source images are
 * already deleted right after dispatch) and marks the session purged so a
 * provider result that arrives later is deleted on sight instead of kept.
 * Generation and charge records are kept: the cost must stay known.
 * Idempotent; an unknown session is a no-op.
 */
export async function purgeInternalSessionArtifacts(externalSessionId: string): Promise<InternalSessionPurgeResponse> {
  const session = sessionsRepo.findByExternalSessionId(externalSessionId);
  let deletedResults = 0;
  if (session) {
    if (session.status !== "purged") sessionsRepo.updateSession(session.id, { status: "purged" });
    for (const row of generationsRepo.listBySession(session.id)) {
      if (await deleteLocalResult(row)) deletedResults += 1;
    }
  }
  return { deletedResults, providerCopyDeletion: "unsupported" };
}

/** GET /internal/generations/:externalGenerationId — opportunistically reconciles a still-processing row, exactly like the Lab's GET /generations/:id. */
export async function getInternalGenerationStatus(externalGenerationId: string): Promise<InternalGenerationResponse> {
  const row = generationsRepo.findByExternalGenerationId(externalGenerationId);
  if (!row) throw new GenerationNotFoundError(externalGenerationId);
  let current = await reconcileIfProcessing(recoverStuckQueued(row));
  settleCharge(current);
  if (current.result_path && sessionsRepo.getSession(current.session_id)?.status === "purged") {
    await deleteLocalResult(current);
    current = generationsRepo.getGeneration(current.id) ?? current;
  }
  return toInternalResponse(current);
}

/** GET /internal/generations/:externalGenerationId/result — only resolves a path once the generation is completed with a result on disk. */
export function getInternalGenerationResultRow(externalGenerationId: string): GenerationRow {
  const row = generationsRepo.findByExternalGenerationId(externalGenerationId);
  if (!row) throw new GenerationNotFoundError(externalGenerationId);
  if (row.status === "failed" || row.status === "expired") throw new GenerationNotFoundError(externalGenerationId);
  if (row.status !== "completed" || !row.result_path) {
    throw new GenerationInProgressError(externalGenerationId);
  }
  return row;
}
