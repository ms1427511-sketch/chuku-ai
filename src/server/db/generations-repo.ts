import { getDb } from "./connection.ts";
import type { GenerationRow } from "./types.ts";
import { GenerationLimitReachedError } from "../../shared/errors.ts";

export function findByOperationId(sessionId: string, operationId: string): GenerationRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM generations WHERE session_id = ? AND operation_id = ?`)
    .get(sessionId, operationId) as GenerationRow | undefined;
}

export function countBySession(sessionId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) as count FROM generations WHERE session_id = ?`).get(sessionId) as { count: number };
  return row.count;
}

export function nextGenerationIndex(sessionId: string, styleId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as count FROM generations WHERE session_id = ? AND style_id = ?`)
    .get(sessionId, styleId) as { count: number };
  return row.count + 1;
}

/**
 * Idempotent, race-free insert: an existing row for (session_id,
 * operation_id) is returned as-is (`created: false`) without touching the
 * per-session count — a client retrying the same operationId (e.g. after a
 * dropped response) must never consume a second slot or submit a second
 * LightX job. Otherwise, checks the per-session hard cap and inserts in the
 * same synchronous call — see connection.ts for why this is race-free.
 */
export function insertGenerationIfWithinLimit(row: GenerationRow, maxPerSession: number): { row: GenerationRow; created: boolean } {
  const db = getDb();
  const existing = findByOperationId(row.session_id, row.operation_id);
  if (existing) return { row: existing, created: false };

  const { count } = db.prepare(`SELECT COUNT(*) as count FROM generations WHERE session_id = ?`).get(row.session_id) as { count: number };
  if (count >= maxPerSession) {
    throw new GenerationLimitReachedError(maxPerSession);
  }

  db.prepare(
    `INSERT INTO generations
      (id, session_id, operation_id, style_id, provider, provider_job_id, generation_index, status,
       source_portrait_id, result_path, retry_of, retry_count, safe_error_code, failure_message,
       created_at, started_at, completed_at, latency_ms, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.session_id,
    row.operation_id,
    row.style_id,
    row.provider,
    row.provider_job_id,
    row.generation_index,
    row.status,
    row.source_portrait_id,
    row.result_path,
    row.retry_of,
    row.retry_count,
    row.safe_error_code,
    row.failure_message,
    row.created_at,
    row.started_at,
    row.completed_at,
    row.latency_ms,
    row.expires_at,
  );
  return { row, created: true };
}

export function getGeneration(id: string): GenerationRow | undefined {
  return getDb().prepare(`SELECT * FROM generations WHERE id = ?`).get(id) as GenerationRow | undefined;
}

export function updateGeneration(id: string, patch: Partial<Omit<GenerationRow, "id">>): GenerationRow {
  const current = getGeneration(id);
  if (!current) throw new Error(`no generation with id ${id}`);
  const merged: GenerationRow = { ...current, ...patch };
  getDb()
    .prepare(
      `UPDATE generations
       SET provider_job_id = ?, status = ?, result_path = ?, retry_count = ?, safe_error_code = ?,
           failure_message = ?, started_at = ?, completed_at = ?, latency_ms = ?, expires_at = ?
       WHERE id = ?`,
    )
    .run(
      merged.provider_job_id,
      merged.status,
      merged.result_path,
      merged.retry_count,
      merged.safe_error_code,
      merged.failure_message,
      merged.started_at,
      merged.completed_at,
      merged.latency_ms,
      merged.expires_at,
      id,
    );
  return merged;
}

export function listBySession(sessionId: string): GenerationRow[] {
  return getDb().prepare(`SELECT * FROM generations WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as unknown as GenerationRow[];
}

export function listByStatus(status: string): GenerationRow[] {
  return getDb().prepare(`SELECT * FROM generations WHERE status = ?`).all(status) as unknown as GenerationRow[];
}

/** Completed, non-favorited results whose expiry has passed — candidates for retention-service.ts to delete. */
export function listExpiredResults(nowIso: string): GenerationRow[] {
  return getDb()
    .prepare(`SELECT * FROM generations WHERE status = 'completed' AND result_path IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?`)
    .all(nowIso) as unknown as GenerationRow[];
}
