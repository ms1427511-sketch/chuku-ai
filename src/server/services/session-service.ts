import { randomUUID } from "node:crypto";
import type { ChukuSession, PortraitId } from "../../shared/types.ts";
import { SessionNotFoundError, InvalidSourceError } from "../../shared/errors.ts";
import * as sessionsRepo from "../db/sessions-repo.ts";
import * as generationsRepo from "../db/generations-repo.ts";
import { config } from "../config/env.ts";
import type { SessionRow } from "../db/types.ts";

const VALID_PORTRAIT_IDS: ReadonlySet<string> = new Set(["portrait-a", "portrait-b", "portrait-c"]);

// No auth/customer concept yet — see docs/integration-contract.md. Every
// field an `externalOwnerId` would eventually gate is already isolated
// behind sessionId lookups, so adding that column later needs no schema
// redesign (sessions-repo.ts's SessionRow already has the nullable column).
export function toPublicSession(row: SessionRow): ChukuSession {
  return {
    id: row.id,
    sourcePortraitId: (row.source_portrait_id as PortraitId | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    favoriteGenerationId: row.favorite_generation_id,
    status: row.status as ChukuSession["status"],
    generationCount: generationsRepo.countBySession(row.id),
    includedGenerations: config.includedGenerationsPerSession,
    maxGenerations: config.maxGenerationsPerSession,
  };
}

export function createSession(): ChukuSession {
  const now = new Date().toISOString();
  const row: SessionRow = {
    id: randomUUID(),
    source_portrait_id: null,
    external_owner_id: null,
    external_session_id: null,
    favorite_generation_id: null,
    status: "active",
    created_at: now,
    updated_at: now,
    // Session-level expiry tracks CHUKU_SOURCE_RETENTION_HOURS — this is
    // the session's own lifetime/submission window. An individual
    // completed generation's *result* has its own, separate expiresAt
    // governed by CHUKU_RESULT_RETENTION_HOURS (product-generation-service.ts)
    // — see docs/retention.md.
    expires_at: new Date(Date.now() + config.sourceRetentionHours * 3_600_000).toISOString(),
  };
  sessionsRepo.insertSession(row);
  return toPublicSession(row);
}

export function getSessionRowOrThrow(id: string): SessionRow {
  const row = sessionsRepo.getSession(id);
  if (!row) throw new SessionNotFoundError(id);
  return row;
}

export function getSession(id: string): ChukuSession {
  return toPublicSession(getSessionRowOrThrow(id));
}

export function setSessionSource(id: string, sourcePortraitId: string): ChukuSession {
  if (!VALID_PORTRAIT_IDS.has(sourcePortraitId)) throw new InvalidSourceError(sourcePortraitId);
  getSessionRowOrThrow(id);
  const updated = sessionsRepo.updateSession(id, { source_portrait_id: sourcePortraitId });
  return toPublicSession(updated);
}

export function setSessionFavorite(id: string, favoriteGenerationId: string | null): ChukuSession {
  getSessionRowOrThrow(id);
  const updated = sessionsRepo.updateSession(id, { favorite_generation_id: favoriteGenerationId });
  return toPublicSession(updated);
}
