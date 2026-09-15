import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Deployment-hardening mission section 9 — CHUKU_PRODUCT_DATA_DIR (the
// canonical configurable persistent root; see .env.example and
// security/paths.ts). Module-load-time config, same convention as
// tests/provider-mode.test.ts: set env, vi.resetModules(), re-import fresh.
function resetDataDirEnv() {
  delete process.env.CHUKU_PRODUCT_DATA_DIR;
}

afterEach(() => {
  resetDataDirEnv();
  vi.resetModules();
});

describe("CHUKU_PRODUCT_DATA_DIR — path resolution", () => {
  it("defaults to PROJECT_ROOT/data when unset (identical to pre-hardening behavior)", async () => {
    resetDataDirEnv();
    vi.resetModules();
    const { PRODUCT_DATA_DIR, PRODUCT_RESULTS_DIR, PRODUCT_DB_PATH } = await import("../src/server/security/paths.ts");
    const { PROJECT_ROOT } = await import("../src/server/config/env.ts");
    expect(PRODUCT_DATA_DIR).toBe(path.join(PROJECT_ROOT, "data"));
    expect(PRODUCT_RESULTS_DIR).toBe(path.join(PRODUCT_DATA_DIR, "results"));
    expect(PRODUCT_DB_PATH).toBe(path.join(PRODUCT_DATA_DIR, "chuku.db"));
  });

  it("accepts a custom absolute directory and nests results/db under it", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "chuku-data-dir-test-"));
    try {
      resetDataDirEnv();
      process.env.CHUKU_PRODUCT_DATA_DIR = tmpRoot;
      vi.resetModules();
      const { PRODUCT_DATA_DIR, PRODUCT_RESULTS_DIR, PRODUCT_DB_PATH } = await import("../src/server/security/paths.ts");
      expect(PRODUCT_DATA_DIR).toBe(path.resolve(tmpRoot));
      expect(PRODUCT_RESULTS_DIR).toBe(path.join(tmpRoot, "results"));
      expect(PRODUCT_DB_PATH).toBe(path.join(tmpRoot, "chuku.db"));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("PRODUCT_TMP_DIR is never nested under a custom persistent root — short-lived source downloads stay on ephemeral local disk", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "chuku-data-dir-test-"));
    try {
      resetDataDirEnv();
      process.env.CHUKU_PRODUCT_DATA_DIR = tmpRoot;
      vi.resetModules();
      const { PRODUCT_TMP_DIR, PRODUCT_DATA_DIR } = await import("../src/server/security/paths.ts");
      expect(PRODUCT_TMP_DIR.startsWith(PRODUCT_DATA_DIR)).toBe(false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("traversal protection (resolveWithinDir) is unaffected by a custom root", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "chuku-data-dir-test-"));
    try {
      resetDataDirEnv();
      process.env.CHUKU_PRODUCT_DATA_DIR = tmpRoot;
      vi.resetModules();
      const { resolveProductResultDir } = await import("../src/server/security/paths.ts");
      expect(() => resolveProductResultDir("../../etc")).toThrow();
      expect(() => resolveProductResultDir("session-1")).not.toThrow();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("CHUKU_PRODUCT_DATA_DIR — directory initialization and SQLite persistence", () => {
  it("initializes a deeply nested, previously-nonexistent directory safely on first getDb() call", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "chuku-data-dir-test-"));
    const nested = path.join(tmpRoot, "does", "not", "exist", "yet");
    try {
      resetDataDirEnv();
      process.env.CHUKU_PRODUCT_DATA_DIR = nested;
      vi.resetModules();
      expect(existsSync(nested)).toBe(false);
      const { getDb } = await import("../src/server/db/connection.ts");
      expect(() => getDb()).not.toThrow();
      const { PRODUCT_DATA_DIR, PRODUCT_RESULTS_DIR, PRODUCT_DB_PATH } = await import("../src/server/security/paths.ts");
      expect(existsSync(PRODUCT_DATA_DIR)).toBe(true);
      expect(existsSync(PRODUCT_RESULTS_DIR)).toBe(true);
      expect(existsSync(PRODUCT_DB_PATH)).toBe(true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("SQLite continues using WAL mode under a custom root", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "chuku-data-dir-test-"));
    try {
      resetDataDirEnv();
      process.env.CHUKU_PRODUCT_DATA_DIR = tmpRoot;
      vi.resetModules();
      const { getDb } = await import("../src/server/db/connection.ts");
      const row = getDb().prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("a generation row written before a simulated restart is still readable after reopening the same directory", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "chuku-data-dir-test-"));
    try {
      resetDataDirEnv();
      process.env.CHUKU_PRODUCT_DATA_DIR = tmpRoot;
      vi.resetModules();

      const sessionsRepo = await import("../src/server/db/sessions-repo.ts");
      sessionsRepo.insertSession({
        id: "session-restart-1",
        source_portrait_id: null,
        external_owner_id: "owner-restart-1",
        external_session_id: "external-session-restart-1",
        favorite_generation_id: null,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const repoBefore = await import("../src/server/db/generations-repo.ts");
      const row = {
        id: "gen-restart-1",
        session_id: "session-restart-1",
        operation_id: "op-restart-1",
        style_id: "buzz-cut",
        provider: "fake",
        provider_job_id: "job-restart-1",
        generation_index: 1,
        status: "completed",
        source_portrait_id: null,
        external_generation_id: "external-gen-restart-1",
        request_fingerprint: "fingerprint-1",
        result_path: "session-restart-1/gen-restart-1.png",
        retry_of: null,
        retry_count: 0,
        safe_error_code: null,
        failure_message: null,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        latency_ms: 100,
        expires_at: null,
      };
      repoBefore.insertGenerationIfWithinLimit(row, 10);
      expect(repoBefore.findByExternalGenerationId("external-gen-restart-1")).toBeDefined();

      // Simulated process restart: drop every module (including the
      // in-process DatabaseSync singleton in connection.ts) and re-import
      // fresh, pointed at the exact same on-disk directory.
      vi.resetModules();
      process.env.CHUKU_PRODUCT_DATA_DIR = tmpRoot;
      const repoAfter = await import("../src/server/db/generations-repo.ts");
      const reopened = repoAfter.findByExternalGenerationId("external-gen-restart-1");
      expect(reopened).toBeDefined();
      expect(reopened?.status).toBe("completed");
      expect(reopened?.provider).toBe("fake");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
