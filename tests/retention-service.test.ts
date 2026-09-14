import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { useInMemoryDbForTests } from "../src/server/db/connection.ts";
import * as sessionsRepo from "../src/server/db/sessions-repo.ts";
import * as generationsRepo from "../src/server/db/generations-repo.ts";
import { PRODUCT_RESULTS_DIR } from "../src/server/security/paths.ts";
import { runRetentionCleanup } from "../src/server/services/retention-service.ts";
import type { GenerationRow, SessionRow } from "../src/server/db/types.ts";

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date().toISOString();
  return {
    id: "session-1",
    source_portrait_id: "portrait-a",
    external_owner_id: null,
    favorite_generation_id: null,
    status: "active",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function makeCompletedGeneration(overrides: Partial<GenerationRow> = {}): GenerationRow {
  const now = new Date().toISOString();
  return {
    id: "gen-1",
    session_id: "session-1",
    operation_id: "op-1",
    style_id: "buzz-cut",
    provider: "lightx",
    provider_job_id: "job-1",
    generation_index: 1,
    status: "completed",
    source_portrait_id: "portrait-a",
    result_path: null,
    retry_of: null,
    retry_count: 0,
    safe_error_code: null,
    failure_message: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    latency_ms: 1000,
    expires_at: null,
    ...overrides,
  };
}

async function writeResultFile(relativePath: string): Promise<string> {
  const filePath = path.join(PRODUCT_RESULTS_DIR, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fake image bytes");
  return filePath;
}

beforeEach(() => {
  useInMemoryDbForTests();
});

afterEach(async () => {
  await rm(path.join(PRODUCT_RESULTS_DIR, "session-1"), { recursive: true, force: true });
});

describe("runRetentionCleanup", () => {
  it("deletes an expired result file and marks the generation expired", async () => {
    sessionsRepo.insertSession(makeSession());
    const filePath = await writeResultFile("session-1/gen-1.png");
    generationsRepo.insertGenerationIfWithinLimit(
      makeCompletedGeneration({ result_path: "session-1/gen-1.png", expires_at: new Date(Date.now() - 1000).toISOString() }),
      5,
    );

    const summary = await runRetentionCleanup();

    expect(summary.expiredResultsDeleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
    const updated = generationsRepo.getGeneration("gen-1")!;
    expect(updated.status).toBe("expired");
    expect(updated.safe_error_code).toBe("RESULT_EXPIRED");
    expect(updated.result_path).toBeNull();
  });

  it("never deletes a result file that has not yet expired", async () => {
    sessionsRepo.insertSession(makeSession());
    const filePath = await writeResultFile("session-1/gen-fresh.png");
    generationsRepo.insertGenerationIfWithinLimit(
      makeCompletedGeneration({ id: "gen-fresh", result_path: "session-1/gen-fresh.png", expires_at: new Date(Date.now() + 100_000).toISOString() }),
      5,
    );

    const summary = await runRetentionCleanup();

    expect(summary.expiredResultsDeleted).toBe(0);
    expect(existsSync(filePath)).toBe(true);
    expect((await readFile(filePath, "utf8"))).toBe("fake image bytes");
  });

  it("is idempotent: running twice never double-deletes or double-counts", async () => {
    sessionsRepo.insertSession(makeSession());
    await writeResultFile("session-1/gen-1.png");
    generationsRepo.insertGenerationIfWithinLimit(
      makeCompletedGeneration({ result_path: "session-1/gen-1.png", expires_at: new Date(Date.now() - 1000).toISOString() }),
      5,
    );

    const first = await runRetentionCleanup();
    const second = await runRetentionCleanup();

    expect(first.expiredResultsDeleted).toBe(1);
    expect(second.expiredResultsDeleted).toBe(0);
  });

  it("marks an expired active session as expired", async () => {
    sessionsRepo.insertSession(makeSession({ id: "expired-session", expires_at: new Date(Date.now() - 1000).toISOString() }));
    sessionsRepo.insertSession(makeSession({ id: "fresh-session", expires_at: new Date(Date.now() + 100_000).toISOString() }));

    const summary = await runRetentionCleanup();

    expect(summary.expiredSessionsMarked).toBe(1);
    expect(sessionsRepo.getSession("expired-session")!.status).toBe("expired");
    expect(sessionsRepo.getSession("fresh-session")!.status).toBe("active");
  });

  it("keeps the favorite pointer in place on the session even after its result expires", async () => {
    sessionsRepo.insertSession(makeSession({ favorite_generation_id: "gen-1" }));
    await writeResultFile("session-1/gen-1.png");
    generationsRepo.insertGenerationIfWithinLimit(
      makeCompletedGeneration({ result_path: "session-1/gen-1.png", expires_at: new Date(Date.now() - 1000).toISOString() }),
      5,
    );

    await runRetentionCleanup();

    const session = sessionsRepo.getSession("session-1")!;
    expect(session.favorite_generation_id).toBe("gen-1");
    const generation = generationsRepo.getGeneration("gen-1")!;
    expect(generation.status).toBe("expired");
  });
});
