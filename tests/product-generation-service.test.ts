import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { useInMemoryDbForTests } from "../src/server/db/connection.ts";
import * as sessionsRepo from "../src/server/db/sessions-repo.ts";
import * as generationsRepo from "../src/server/db/generations-repo.ts";
import { GenerationLimitReachedError, SourceRequiredError, UnknownStyleError } from "../src/shared/errors.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const FIXTURE_PORTRAIT = path.join(FIXTURES_DIR, "fixture-portrait.png");

// Same isolation pattern as generation-service.test.ts: never a real
// network call, never touches test-images/ or a real downloaded file
// outside the test fixtures dir.
vi.mock("../src/server/security/paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/security/paths.ts")>();
  return { ...actual, resolveInputPortrait: () => FIXTURE_PORTRAIT };
});

let mockOutcome: "completed" | "transient-fail" | "permanent-fail" | "still-processing" = "completed";
const createGenerationSpy = vi.fn();
const getGenerationSpy = vi.fn();

vi.mock("../src/server/providers/lightx-provider.ts", () => {
  class FakeProvider {
    async createGeneration(...args: unknown[]) {
      createGenerationSpy(...args);
      return { provider: "lightx", externalJobId: "job-1", status: "queued", createdAt: new Date().toISOString() };
    }
    async getGeneration(...args: unknown[]) {
      getGenerationSpy(...args);
      if (mockOutcome === "completed") {
        return { provider: "lightx", externalJobId: "job-1", status: "completed", resultUrl: "https://example.invalid/result.png", failureCategory: null, failureMessage: null };
      }
      if (mockOutcome === "permanent-fail") {
        return { provider: "lightx", externalJobId: "job-1", status: "failed", resultUrl: null, failureCategory: "invalid_portrait", failureMessage: "simulated no-face" };
      }
      return { provider: "lightx", externalJobId: "job-1", status: "processing", resultUrl: null, failureCategory: null, failureMessage: null };
    }
    async pollUntilTerminal(jobId: string) {
      if (mockOutcome === "completed") {
        return { provider: "lightx", externalJobId: jobId, status: "completed", resultUrl: "https://example.invalid/result.png", failureCategory: null, failureMessage: null };
      }
      if (mockOutcome === "transient-fail") {
        return { provider: "lightx", externalJobId: jobId, status: "failed", resultUrl: null, failureCategory: "provider_timeout", failureMessage: "simulated timeout" };
      }
      return { provider: "lightx", externalJobId: jobId, status: "failed", resultUrl: null, failureCategory: "invalid_portrait", failureMessage: "simulated no-face" };
    }
  }
  return { LightXHairstyleProvider: FakeProvider, ProviderCallError: class extends Error {} };
});

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as Response),
);

const { createProductGeneration, finalizeGeneration, reconcileIfProcessing, toPublicGeneration } = await import(
  "../src/server/services/product-generation-service.ts"
);

function makeActiveSession(overrides: Partial<import("../src/server/db/types.ts").SessionRow> = {}) {
  const now = new Date().toISOString();
  const row = {
    id: "session-1",
    source_portrait_id: "portrait-a",
    external_session_id: null,
    external_owner_id: null,
    favorite_generation_id: null,
    status: "active",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
  sessionsRepo.insertSession(row);
  return row;
}

beforeEach(async () => {
  useInMemoryDbForTests();
  mockOutcome = "completed";
  createGenerationSpy.mockClear();
  getGenerationSpy.mockClear();
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(FIXTURE_PORTRAIT, Buffer.alloc(2048, 1));
});

afterEach(async () => {
  await rm(FIXTURES_DIR, { recursive: true, force: true });
  await rm(path.resolve(import.meta.dirname, "..", "data", "results", "session-1"), { recursive: true, force: true });
});

describe("createProductGeneration", () => {
  it("rejects when the session has no source set", async () => {
    makeActiveSession({ source_portrait_id: null });
    await expect(createProductGeneration("session-1", "buzz-cut", "op-1")).rejects.toBeInstanceOf(SourceRequiredError);
  });

  it("rejects an unknown style id", async () => {
    makeActiveSession();
    await expect(createProductGeneration("session-1", "not-a-style", "op-1")).rejects.toBeInstanceOf(UnknownStyleError);
  });

  it("returns immediately with status processing, awaiting only job creation (not the full poll)", async () => {
    makeActiveSession();
    const generation = await createProductGeneration("session-1", "buzz-cut", "op-1");
    expect(generation.status).toBe("processing");
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: replaying the same operationId returns the same generation without a second provider call", async () => {
    makeActiveSession();
    const first = await createProductGeneration("session-1", "buzz-cut", "op-1");
    const second = await createProductGeneration("session-1", "buzz-cut", "op-1");
    expect(second.id).toBe(first.id);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
    expect(generationsRepo.countBySession("session-1")).toBe(1);
  });

  it("enforces the per-session hard cap (CHUKU_MAX_GENERATIONS_PER_SESSION default 5)", async () => {
    makeActiveSession();
    for (let i = 0; i < 5; i++) {
      await createProductGeneration("session-1", "buzz-cut", `op-${i}`);
    }
    await expect(createProductGeneration("session-1", "buzz-cut", "op-over")).rejects.toBeInstanceOf(GenerationLimitReachedError);
    expect(generationsRepo.countBySession("session-1")).toBe(5);
  });

  it("never exposes provider-specific fields in the public DTO", async () => {
    makeActiveSession();
    const generation = await createProductGeneration("session-1", "buzz-cut", "op-1");
    expect(generation).not.toHaveProperty("provider");
    expect(generation).not.toHaveProperty("providerJobId");
    expect(generation).not.toHaveProperty("failureMessage");
    expect(JSON.stringify(generation)).not.toMatch(/lightx/i);
  });
});

describe("finalizeGeneration", () => {
  it("transitions a processing generation to completed with a local resultUrl and an expiry", async () => {
    makeActiveSession();
    const created = await createProductGeneration("session-1", "buzz-cut", "op-1");
    const finalized = await finalizeGeneration(created.id);
    expect(finalized.status).toBe("completed");
    expect(finalized.resultUrl).toMatch(/^\/product-results\/session-1\//);
    expect(finalized.expiresAt).not.toBeNull();
  });

  it("maps a transient provider failure to PROVIDER_TEMPORARY_FAILURE", async () => {
    makeActiveSession();
    const created = await createProductGeneration("session-1", "buzz-cut", "op-1");
    mockOutcome = "transient-fail";
    const finalized = await finalizeGeneration(created.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.safeErrorCode).toBe("PROVIDER_TEMPORARY_FAILURE");
  });

  it("maps a permanent provider failure to GENERATION_FAILED", async () => {
    makeActiveSession();
    const created = await createProductGeneration("session-1", "buzz-cut", "op-1");
    mockOutcome = "permanent-fail";
    const finalized = await finalizeGeneration(created.id);
    expect(finalized.status).toBe("failed");
    expect(finalized.safeErrorCode).toBe("GENERATION_FAILED");
  });

  it("is a no-op for a generation that is not processing", async () => {
    makeActiveSession();
    const created = await createProductGeneration("session-1", "buzz-cut", "op-1");
    await finalizeGeneration(created.id);
    const secondCall = await finalizeGeneration(created.id);
    expect(secondCall.status).toBe("completed");
  });
});

describe("reconcileIfProcessing (restart recovery)", () => {
  it("resolves a still-processing row via a single free status check, never re-submitting a paid job", async () => {
    makeActiveSession();
    const created = await createProductGeneration("session-1", "buzz-cut", "op-1");
    createGenerationSpy.mockClear();

    const row = generationsRepo.getGeneration(created.id)!;
    const reconciled = await reconcileIfProcessing(row);

    expect(reconciled.status).toBe("completed");
    expect(getGenerationSpy).toHaveBeenCalledTimes(1);
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });

  it("marks a stale processing row failed without any provider contact when there is no provider_job_id", async () => {
    makeActiveSession();
    const row = generationsRepo.insertGenerationIfWithinLimit(
      {
        id: "gen-orphan",
        session_id: "session-1",
        operation_id: "op-orphan",
        style_id: "buzz-cut",
        provider: "lightx",
        provider_job_id: null,
        generation_index: 1,
        status: "processing",
        source_portrait_id: "portrait-a",
        external_generation_id: null,
        request_fingerprint: null,
        result_path: null,
        retry_of: null,
        retry_count: 0,
        safe_error_code: null,
        failure_message: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: null,
        latency_ms: null,
        expires_at: null,
      },
      5,
    ).row;

    const reconciled = await reconcileIfProcessing(row);
    expect(reconciled.status).toBe("failed");
    expect(reconciled.safe_error_code).toBe("PROVIDER_TEMPORARY_FAILURE");
    expect(getGenerationSpy).not.toHaveBeenCalled();
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });

  it("marks a processing row failed once it exceeds the staleness threshold, without re-submitting", async () => {
    makeActiveSession();
    mockOutcome = "still-processing";
    const row = generationsRepo.insertGenerationIfWithinLimit(
      {
        id: "gen-stale",
        session_id: "session-1",
        operation_id: "op-stale",
        style_id: "buzz-cut",
        provider: "lightx",
        provider_job_id: "job-stale",
        generation_index: 1,
        status: "processing",
        source_portrait_id: "portrait-a",
        external_generation_id: null,
        request_fingerprint: null,
        result_path: null,
        retry_of: null,
        retry_count: 0,
        safe_error_code: null,
        failure_message: null,
        created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        completed_at: null,
        latency_ms: null,
        expires_at: null,
      },
      5,
    ).row;

    const reconciled = await reconcileIfProcessing(row);
    expect(reconciled.status).toBe("failed");
    expect(reconciled.safe_error_code).toBe("PROVIDER_TEMPORARY_FAILURE");
    expect(getGenerationSpy).toHaveBeenCalledTimes(1);
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });

  it("leaves a genuinely still-in-flight (young) processing row untouched", async () => {
    makeActiveSession();
    mockOutcome = "still-processing";
    const row = generationsRepo.insertGenerationIfWithinLimit(
      {
        id: "gen-young",
        session_id: "session-1",
        operation_id: "op-young",
        style_id: "buzz-cut",
        provider: "lightx",
        provider_job_id: "job-young",
        generation_index: 1,
        status: "processing",
        source_portrait_id: "portrait-a",
        external_generation_id: null,
        request_fingerprint: null,
        result_path: null,
        retry_of: null,
        retry_count: 0,
        safe_error_code: null,
        failure_message: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: null,
        latency_ms: null,
        expires_at: null,
      },
      5,
    ).row;

    const reconciled = await reconcileIfProcessing(row);
    expect(reconciled.status).toBe("processing");
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });
});

describe("toPublicGeneration", () => {
  it("reflects the favorite flag passed in, independent of the row itself", () => {
    const row = {
      id: "gen-1",
      session_id: "session-1",
      operation_id: "op-1",
      style_id: "buzz-cut",
      provider: "lightx",
      provider_job_id: "job-1",
      generation_index: 1,
      status: "completed",
      source_portrait_id: "portrait-a",
      external_generation_id: null,
      request_fingerprint: null,
      result_path: "session-1/gen-1.png",
      retry_of: null,
      retry_count: 0,
      safe_error_code: null,
      failure_message: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      latency_ms: 1000,
      expires_at: new Date().toISOString(),
    };
    expect(toPublicGeneration(row, true).favorite).toBe(true);
    expect(toPublicGeneration(row, false).favorite).toBe(false);
  });
});
