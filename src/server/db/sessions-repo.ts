import { getDb } from "./connection.ts";
import type { SessionRow } from "./types.ts";

export function insertSession(row: SessionRow): SessionRow {
  getDb()
    .prepare(
      `INSERT INTO sessions
        (id, source_portrait_id, external_owner_id, external_session_id, favorite_generation_id, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.source_portrait_id,
      row.external_owner_id,
      row.external_session_id,
      row.favorite_generation_id,
      row.status,
      row.created_at,
      row.updated_at,
      row.expires_at,
    );
  return row;
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

/** Phase 4.1B internal integration only — external_session_id is opaque, MEKKY-supplied, and carries no authorization weight. */
export function findByExternalSessionId(externalSessionId: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE external_session_id = ?`).get(externalSessionId) as SessionRow | undefined;
}

export function updateSession(id: string, patch: Partial<Omit<SessionRow, "id">>): SessionRow {
  const current = getSession(id);
  if (!current) throw new Error(`no session with id ${id}`);
  const merged: SessionRow = { ...current, ...patch, updated_at: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE sessions
       SET source_portrait_id = ?, external_owner_id = ?, external_session_id = ?, favorite_generation_id = ?, status = ?, updated_at = ?, expires_at = ?
       WHERE id = ?`,
    )
    .run(
      merged.source_portrait_id,
      merged.external_owner_id,
      merged.external_session_id,
      merged.favorite_generation_id,
      merged.status,
      merged.updated_at,
      merged.expires_at,
      id,
    );
  return merged;
}

/** Active sessions whose expiry has passed — candidates for retention-service.ts to expire. */
export function listExpiredActiveSessions(nowIso: string): SessionRow[] {
  return getDb().prepare(`SELECT * FROM sessions WHERE status = 'active' AND expires_at < ?`).all(nowIso) as unknown as SessionRow[];
}
