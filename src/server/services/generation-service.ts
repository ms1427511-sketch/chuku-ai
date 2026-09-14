import type { CreateGenerationRequest, GenerationRecord, GenerationFailureCategory } from "../../shared/types.ts";
import { findHairstyle } from "../../shared/hairstyles.ts";
import { UnknownHairstyleError, UnknownPortraitError } from "../../shared/errors.ts";
import { resolveInputPortrait } from "../security/paths.ts";
import { validatePortraitFile } from "./image-validation.ts";
import { costGuard } from "./cost-guard.ts";
import { newRecordId, appendRecord, updateRecord, nextGenerationIndex, downloadResult, getRecord } from "./storage.ts";
import { LightXHairstyleProvider, ProviderCallError } from "../providers/lightx-provider.ts";
import { config } from "../config/env.ts";

export const PORTRAIT_FILENAMES: Record<string, string> = {
  "portrait-a": "portrait-a.png",
  "portrait-b": "portrait-b.png",
  "portrait-c": "portrait-c.png",
};

// Only these categories represent a genuine transient/network/provider
// hiccup worth one automatic retry. A bad *visual* result is never in
// this set — spec section 12: "Bad visual quality should NOT
// automatically trigger another paid generation." That's a human rework.
const TRANSIENT_FAILURE_CATEGORIES: ReadonlySet<GenerationFailureCategory> = new Set([
  "network_error",
  "provider_timeout",
  "provider_error",
]);

function provider() {
  return new LightXHairstyleProvider(config.lightxApiKey);
}

async function runProviderAttempt(
  record: GenerationRecord,
  sourceImagePath: string,
  prompt: string,
): Promise<GenerationRecord> {
  const p = provider();
  const startedAt = new Date().toISOString();
  await updateRecord(record.id, { status: "processing", startedAt });

  try {
    const job = await p.createGeneration({ sourceImagePath, prompt });
    const status = await p.pollUntilTerminal(job.externalJobId);
    const completedAt = new Date().toISOString();
    const latencyMs = Date.parse(completedAt) - Date.parse(startedAt);

    if (status.status === "completed" && status.resultUrl) {
      const resultPath = await downloadResult(status.resultUrl, record.source, record.hairstyleId, record.generationIndex);
      costGuard.recordSuccess();
      return updateRecord(record.id, {
        status: "completed",
        providerJobId: job.externalJobId,
        completedAt,
        latencyMs,
        resultPath,
      });
    }

    costGuard.recordFailure();
    return updateRecord(record.id, {
      status: "failed",
      providerJobId: job.externalJobId,
      completedAt,
      latencyMs,
      failureCategory: status.failureCategory ?? "provider_error",
      failureMessage: status.failureMessage ?? "provider returned a non-completed terminal status",
    });
  } catch (error) {
    const completedAt = new Date().toISOString();
    const latencyMs = Date.parse(completedAt) - Date.parse(startedAt);
    const category: GenerationFailureCategory = error instanceof ProviderCallError ? error.category : "unknown";
    const message = error instanceof Error ? error.message : "unknown error";
    costGuard.recordFailure();
    return updateRecord(record.id, {
      status: "failed",
      completedAt,
      latencyMs,
      failureCategory: category,
      failureMessage: message,
    });
  }
}

export async function createGeneration(request: CreateGenerationRequest): Promise<GenerationRecord> {
  const hairstyle = findHairstyle(request.hairstyleId);
  if (!hairstyle) throw new UnknownHairstyleError(request.hairstyleId);

  const fileName = PORTRAIT_FILENAMES[request.source];
  if (!fileName) throw new UnknownPortraitError(request.source);

  const sourceImagePath = resolveInputPortrait(fileName);
  await validatePortraitFile(sourceImagePath);

  const isRetry = Boolean(request.retryOf);
  costGuard.reserveSlot(isRetry);

  const generationIndex = await nextGenerationIndex(request.source, request.hairstyleId);
  const record: GenerationRecord = {
    id: newRecordId(),
    provider: "lightx",
    providerJobId: null,
    source: request.source,
    hairstyleId: request.hairstyleId,
    generationIndex,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    latencyMs: null,
    resultPath: null,
    failureCategory: null,
    failureMessage: null,
    retryOf: request.retryOf ?? null,
    score: null,
    flags: [],
    favorite: false,
  };
  await appendRecord(record);

  let result = await runProviderAttempt(record, sourceImagePath, hairstyle.prompt);

  // One automatic retry, only for a transient failure category, and only
  // if the hard cap still has room. This creates a SECOND record
  // (retryOf = the first attempt's id) — the first attempt's record is
  // never overwritten, per spec section 11's "never overwrite silently".
  if (result.status === "failed" && result.failureCategory && TRANSIENT_FAILURE_CATEGORIES.has(result.failureCategory) && !isRetry) {
    const totals = costGuard.totals();
    if (totals.remaining > 0) {
      const retryRequest: CreateGenerationRequest = { source: request.source, hairstyleId: request.hairstyleId, retryOf: result.id };
      result = await createGeneration(retryRequest);
    }
  }

  return result;
}

export async function reworkGeneration(originalId: string): Promise<GenerationRecord> {
  const original = await getRecord(originalId);
  if (!original) throw new Error(`no generation record with id ${originalId}`);
  // Human-initiated rework: always a brand new record/attempt, regardless
  // of why the previous one ended the way it did.
  return createGeneration({ source: original.source, hairstyleId: original.hairstyleId, retryOf: original.id });
}

export async function historyFor(source?: string, hairstyleId?: string): Promise<GenerationRecord[]> {
  const { loadHistory } = await import("./storage.ts");
  const all = await loadHistory();
  return all.filter((r) => (source ? r.source === source : true) && (hairstyleId ? r.hairstyleId === hairstyleId : true));
}

/**
 * At most one favorite per (source, hairstyleId): marking a record favorite
 * un-favorites any prior favorite for that same pair first, so "choose this
 * style" always replaces rather than accumulates.
 */
export async function setFavorite(id: string, favorite: boolean): Promise<GenerationRecord> {
  const target = await getRecord(id);
  if (!target) throw new Error(`no generation record with id ${id}`);

  if (favorite) {
    const { loadHistory } = await import("./storage.ts");
    const history = await loadHistory();
    const priorFavorites = history.filter(
      (r) => r.id !== id && r.source === target.source && r.hairstyleId === target.hairstyleId && r.favorite,
    );
    for (const prior of priorFavorites) {
      await updateRecord(prior.id, { favorite: false });
    }
  }

  return updateRecord(id, { favorite });
}
