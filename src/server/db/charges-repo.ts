import { getDb } from "./connection.ts";

// Phase 4.1C provider-charge record (schema.ts provider_charges). Every
// internal generation gets exactly one row, inserted in the same
// synchronous block as the generation itself (see connection.ts for why
// that cannot interleave with another request).
export type ChargeState = "reserved" | "submitting" | "submitted" | "charged" | "not_charged" | "unknown";

export interface ChargeRow {
  generation_id: string;
  owner_id: string;
  state: ChargeState;
  credits: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export function insertCharge(generationId: string, ownerId: string, state: ChargeState, credits: number, reason: string | null): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO provider_charges (generation_id, owner_id, state, credits, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(generationId, ownerId, state, credits, reason, now, now);
}

export function getCharge(generationId: string): ChargeRow | undefined {
  return getDb().prepare(`SELECT * FROM provider_charges WHERE generation_id = ?`).get(generationId) as ChargeRow | undefined;
}

const SETTLED: ReadonlySet<ChargeState> = new Set(["charged", "not_charged"]);

/** Moves a charge forward. A settled charge (charged/not_charged) is final and never rewritten. */
export function setChargeState(generationId: string, state: ChargeState, reason: string | null = null): ChargeRow | undefined {
  const current = getCharge(generationId);
  if (!current || SETTLED.has(current.state)) return current;
  getDb()
    .prepare(`UPDATE provider_charges SET state = ?, reason = COALESCE(?, reason), updated_at = ? WHERE generation_id = ?`)
    .run(state, reason, new Date().toISOString(), generationId);
  return getCharge(generationId);
}

/**
 * Generations that may cost money since `sinceIso`: everything except a
 * charge known not to have been made. An unknown charge always counts.
 */
export function countChargeable(sinceIso: string, ownerId?: string): number {
  const row = (
    ownerId === undefined
      ? getDb().prepare(`SELECT COUNT(*) AS count FROM provider_charges WHERE state <> 'not_charged' AND created_at >= ?`).get(sinceIso)
      : getDb()
          .prepare(`SELECT COUNT(*) AS count FROM provider_charges WHERE state <> 'not_charged' AND created_at >= ? AND owner_id = ?`)
          .get(sinceIso, ownerId)
  ) as { count: number };
  return row.count;
}
