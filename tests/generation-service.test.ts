import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { costGuard } from "../src/server/services/cost-guard.ts";
import { UnknownHairstyleError, UnknownPortraitError } from "../src/shared/errors.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const FIXTURE_PORTRAIT = path.join(FIXTURES_DIR, "fixture-portrait.png");

// The provider and the on-disk result download are both mocked here so
// this suite never makes a real network call and never touches
// test-images/ (the benchmark's real, human-reviewed asset directory).
vi.mock("../src/server/security/paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/security/paths.ts")>();
  return { ...actual, resolveInputPortrait: () => FIXTURE_PORTRAIT };
});

let mockOutcome: "completed" | "transient-fail" | "permanent-fail" = "completed";

vi.mock("../src/server/providers/lightx-provider.ts", () => {
  class FakeProvider {
    async createGeneration() {
      return { provider: "lightx", externalJobId: "job-1", status: "queued", createdAt: new Date().toISOString() };
    }
    async pollUntilTerminal() {
      if (mockOutcome === "completed") {
        return { provider: "lightx", externalJobId: "job-1", status: "completed", resultUrl: "https://example.invalid/result.png", failureCategory: null, failureMessage: null };
      }
      if (mockOutcome === "transient-fail") {
        return { provider: "lightx", externalJobId: "job-1", status: "failed", resultUrl: null, failureCategory: "provider_timeout", failureMessage: "simulated timeout" };
      }
      return { provider: "lightx", externalJobId: "job-1", status: "failed", resultUrl: null, failureCategory: "invalid_portrait", failureMessage: "simulated no-face" };
    }
  }
  return { LightXHairstyleProvider: FakeProvider, ProviderCallError: class extends Error {} };
});

// In-memory fake persistence — this suite must never read or write the
// real benchmark/results/generations.json, which is reserved for genuine
// provider evidence.
let memoryStore: import("../src/shared/types.ts").GenerationRecord[] = [];
let idCounter = 0;

vi.mock("../src/server/services/storage.ts", () => ({
  loadHistory: async () => memoryStore,
  appendRecord: async (record: import("../src/shared/types.ts").GenerationRecord) => {
    memoryStore.push(record);
  },
  updateRecord: async (id: string, patch: Record<string, unknown>) => {
    const index = memoryStore.findIndex((r) => r.id === id);
    if (index === -1) throw new Error(`no generation record with id ${id}`);
    memoryStore[index] = { ...memoryStore[index], ...patch } as import("../src/shared/types.ts").GenerationRecord;
    return memoryStore[index];
  },
  getRecord: async (id: string) => memoryStore.find((r) => r.id === id),
  nextGenerationIndex: async (source: string, hairstyleId: string) =>
    memoryStore.filter((r) => r.source === source && r.hairstyleId === hairstyleId).length + 1,
  newRecordId: () => `test-id-${++idCounter}`,
  downloadResult: async () => "portrait-a/buzz-cut/generation-1.png",
}));

const { createGeneration, reworkGeneration, setFavorite } = await import("../src/server/services/generation-service.ts");
const { loadHistory } = await import("../src/server/services/storage.ts");

beforeEach(async () => {
  costGuard.reset();
  memoryStore = [];
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(FIXTURE_PORTRAIT, Buffer.alloc(2048, 1));
  mockOutcome = "completed";
});

afterEach(async () => {
  await rm(FIXTURES_DIR, { recursive: true, force: true });
});

describe("createGeneration", () => {
  it("rejects an unknown hairstyle id", async () => {
    await expect(createGeneration({ source: "portrait-a", hairstyleId: "not-a-real-style" })).rejects.toBeInstanceOf(UnknownHairstyleError);
  });

  it("rejects an unknown portrait id", async () => {
    await expect(createGeneration({ source: "portrait-z" as never, hairstyleId: "buzz-cut" })).rejects.toBeInstanceOf(UnknownPortraitError);
  });

  it("produces a completed record with a local result path on success", async () => {
    const record = await createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" });
    expect(record.status).toBe("completed");
    expect(record.resultPath).toBe("portrait-a/buzz-cut/generation-1.png");
  });

  it("automatically retries once on a transient failure, creating a second record", async () => {
    mockOutcome = "transient-fail";
    const result = await createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" });
    expect(result.status).toBe("failed");
    expect(result.retryOf).not.toBeNull();

    const history = await loadHistory();
    const related = history.filter((r) => r.hairstyleId === "buzz-cut" && r.source === "portrait-a");
    expect(related.length).toBe(2);
    expect(related[0]!.id).not.toBe(related[1]!.id);
  });

  it("does not automatically retry a non-transient failure", async () => {
    mockOutcome = "permanent-fail";
    await createGeneration({ source: "portrait-a", hairstyleId: "skin-fade" });

    const history = await loadHistory();
    const related = history.filter((r) => r.hairstyleId === "skin-fade" && r.source === "portrait-a");
    expect(related.length).toBe(1);
  });

  it("enforces the generation hard cap", async () => {
    const cap = costGuard.totals().hardCap;
    for (let i = 0; i < cap; i++) costGuard.reserveSlot(false);
    await expect(createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" })).rejects.toThrow("Generation hard cap reached");
  });
});

describe("reworkGeneration", () => {
  it("creates a brand-new record instead of overwriting the original", async () => {
    const original = await createGeneration({ source: "portrait-a", hairstyleId: "pompadour" });
    const reworked = await reworkGeneration(original.id);

    expect(reworked.id).not.toBe(original.id);
    expect(reworked.retryOf).toBe(original.id);

    const history = await loadHistory();
    const originalStillPresent = history.find((r) => r.id === original.id);
    expect(originalStillPresent).toBeDefined();
    expect(originalStillPresent!.status).toBe("completed");
  });
});

describe("setFavorite", () => {
  it("defaults new generations to not favorite", async () => {
    const record = await createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" });
    expect(record.favorite).toBe(false);
  });

  it("marks a generation favorite", async () => {
    const record = await createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" });
    const updated = await setFavorite(record.id, true);
    expect(updated.favorite).toBe(true);
  });

  it("un-favorites any prior favorite for the same source+hairstyle when a new one is chosen", async () => {
    const first = await createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" });
    await setFavorite(first.id, true);
    const second = await reworkGeneration(first.id);

    await setFavorite(second.id, true);

    const history = await loadHistory();
    const firstAfter = history.find((r) => r.id === first.id)!;
    const secondAfter = history.find((r) => r.id === second.id)!;
    expect(firstAfter.favorite).toBe(false);
    expect(secondAfter.favorite).toBe(true);
  });

  it("does not affect favorites for a different source or hairstyle", async () => {
    const buzz = await createGeneration({ source: "portrait-a", hairstyleId: "buzz-cut" });
    const pompadour = await createGeneration({ source: "portrait-a", hairstyleId: "pompadour" });
    await setFavorite(buzz.id, true);
    await setFavorite(pompadour.id, true);

    const history = await loadHistory();
    expect(history.find((r) => r.id === buzz.id)!.favorite).toBe(true);
    expect(history.find((r) => r.id === pompadour.id)!.favorite).toBe(true);
  });
});
