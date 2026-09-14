import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDbForTests } from "../src/server/db/connection.ts";
import * as sessionsRepo from "../src/server/db/sessions-repo.ts";
import * as generationsRepo from "../src/server/db/generations-repo.ts";
import { GenerationLimitReachedError } from "../src/shared/errors.ts";
import type { GenerationRow, SessionRow } from "../src/server/db/types.ts";

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "session-1",
    source_portrait_id: "portrait-a",
    external_owner_id: null,
    favorite_generation_id: null,
    status: "active",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeGeneration(overrides: Partial<GenerationRow> = {}): GenerationRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "gen-1",
    session_id: "session-1",
    operation_id: "op-1",
    style_id: "buzz-cut",
    provider: "lightx",
    provider_job_id: null,
    generation_index: 1,
    status: "queued",
    source_portrait_id: "portrait-a",
    result_path: null,
    retry_of: null,
    retry_count: 0,
    safe_error_code: null,
    failure_message: null,
    created_at: now,
    started_at: null,
    completed_at: null,
    latency_ms: null,
    expires_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  useInMemoryDbForTests();
});

describe("sessions-repo", () => {
  it("inserts and retrieves a session", () => {
    const session = makeSession();
    sessionsRepo.insertSession(session);
    expect(sessionsRepo.getSession(session.id)).toMatchObject({ id: session.id, status: "active" });
  });

  it("updates a session and bumps updated_at", async () => {
    const session = makeSession();
    sessionsRepo.insertSession(session);
    await new Promise((r) => setTimeout(r, 2));
    const updated = sessionsRepo.updateSession(session.id, { favorite_generation_id: "gen-1" });
    expect(updated.favorite_generation_id).toBe("gen-1");
    expect(updated.updated_at).not.toBe(session.updated_at);
  });

  it("lists active sessions past their expiry", () => {
    const expired = makeSession({ id: "expired", expires_at: new Date(Date.now() - 1000).toISOString() });
    const fresh = makeSession({ id: "fresh", expires_at: new Date(Date.now() + 100_000).toISOString() });
    sessionsRepo.insertSession(expired);
    sessionsRepo.insertSession(fresh);

    const results = sessionsRepo.listExpiredActiveSessions(new Date().toISOString());
    expect(results.map((r) => r.id)).toEqual(["expired"]);
  });
});

describe("generations-repo", () => {
  beforeEach(() => {
    sessionsRepo.insertSession(makeSession());
  });

  it("inserts a new generation", () => {
    const { row, created } = generationsRepo.insertGenerationIfWithinLimit(makeGeneration(), 5);
    expect(created).toBe(true);
    expect(generationsRepo.getGeneration(row.id)).toMatchObject({ id: row.id, status: "queued" });
  });

  it("is idempotent: the same (session, operationId) returns the existing row without creating a new one", () => {
    const first = generationsRepo.insertGenerationIfWithinLimit(makeGeneration({ id: "gen-1", operation_id: "op-1" }), 5);
    const second = generationsRepo.insertGenerationIfWithinLimit(
      makeGeneration({ id: "gen-2", operation_id: "op-1", generation_index: 2 }),
      5,
    );
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(generationsRepo.countBySession("session-1")).toBe(1);
  });

  it("enforces the per-session hard cap", () => {
    for (let i = 0; i < 3; i++) {
      generationsRepo.insertGenerationIfWithinLimit(makeGeneration({ id: `gen-${i}`, operation_id: `op-${i}` }), 3);
    }
    expect(() => generationsRepo.insertGenerationIfWithinLimit(makeGeneration({ id: "gen-over", operation_id: "op-over" }), 3)).toThrow(
      GenerationLimitReachedError,
    );
    expect(generationsRepo.countBySession("session-1")).toBe(3);
  });

  it("computes the next generation index per (session, style)", () => {
    expect(generationsRepo.nextGenerationIndex("session-1", "buzz-cut")).toBe(1);
    generationsRepo.insertGenerationIfWithinLimit(makeGeneration({ id: "gen-1", operation_id: "op-1", generation_index: 1 }), 5);
    expect(generationsRepo.nextGenerationIndex("session-1", "buzz-cut")).toBe(2);
    expect(generationsRepo.nextGenerationIndex("session-1", "skin-fade")).toBe(1);
  });

  it("updates a generation record", () => {
    generationsRepo.insertGenerationIfWithinLimit(makeGeneration({ id: "gen-1", operation_id: "op-1" }), 5);
    const updated = generationsRepo.updateGeneration("gen-1", { status: "completed", result_path: "session-1/gen-1.png", latency_ms: 5000 });
    expect(updated.status).toBe("completed");
    expect(updated.result_path).toBe("session-1/gen-1.png");
  });

  it("lists completed results past their expiry", () => {
    generationsRepo.insertGenerationIfWithinLimit(
      makeGeneration({
        id: "expired-result",
        operation_id: "op-expired",
        status: "completed",
        result_path: "session-1/expired-result.png",
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      5,
    );
    generationsRepo.insertGenerationIfWithinLimit(
      makeGeneration({
        id: "fresh-result",
        operation_id: "op-fresh",
        status: "completed",
        result_path: "session-1/fresh-result.png",
        expires_at: new Date(Date.now() + 100_000).toISOString(),
      }),
      5,
    );

    const expired = generationsRepo.listExpiredResults(new Date().toISOString());
    expect(expired.map((r) => r.id)).toEqual(["expired-result"]);
  });
});
