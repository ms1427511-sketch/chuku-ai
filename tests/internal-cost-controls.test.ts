import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Phase 4.1C service-side cost controls on the internal path: kill switch,
// per-owner and global breakers, provider-charge record, preservation
// prompt, stuck-dispatch recovery and session purge. Provider is faked;
// zero real network calls.
const SECRET = "internal-auth-cost-controls-secret-0123456789";
process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
process.env.CHUKU_INTERNAL_SOURCE_ALLOWED_HOSTS = "allowed.supabase.co";
process.env.CHUKU_MAX_GENERATIONS_PER_SESSION = "5";
delete process.env.CHUKU_GENERATION_ENABLED;
// Own data dir: other files rm -rf the default one while running in parallel
// (same reason as tests/internal-fake-provider.test.ts).
process.env.CHUKU_PRODUCT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "chuku-cost-controls-test-"));
// PRODUCT_TMP_DIR lives under os.tmpdir(), shared by every test process --
// point this one at a private root so its cleanup cannot race other files.
process.env.TMPDIR = process.env.CHUKU_PRODUCT_DATA_DIR;

type CreateBehaviour = "ok" | "fail-before-submit" | "fail-submit-network" | "fail-submit-5040";
let createBehaviour: CreateBehaviour = "ok";
let pollOutcome: "completed" | "processing" | "failed" = "completed";
const createGenerationSpy = vi.fn();

vi.mock("../src/server/providers/lightx-provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/providers/lightx-provider.ts")>();
  const { ProviderCallError } = actual;
  class FakeProvider {
    async createGeneration(input: { prompt: string }) {
      createGenerationSpy(input);
      if (createBehaviour === "fail-before-submit") throw new ProviderCallError("provider_error", "upload failed", { stage: "before_submit" });
      if (createBehaviour === "fail-submit-network") throw new ProviderCallError("network_error", "socket hang up", { stage: "submit" });
      if (createBehaviour === "fail-submit-5040") {
        throw new ProviderCallError("provider_credits_exhausted", "no credits", { stage: "submit", httpStatus: 200, providerCode: 5040 });
      }
      return { provider: "lightx", externalJobId: "provider-order-secret-1", status: "queued", createdAt: new Date().toISOString() };
    }
    async getGeneration(jobId: string) {
      if (pollOutcome === "completed") {
        return { provider: "lightx", externalJobId: jobId, status: "completed", resultUrl: "https://example.invalid/r.png", failureCategory: null, failureMessage: null };
      }
      if (pollOutcome === "failed") {
        return { provider: "lightx", externalJobId: jobId, status: "failed", resultUrl: null, failureCategory: "provider_error", failureMessage: "x" };
      }
      return { provider: "lightx", externalJobId: jobId, status: "processing", resultUrl: null, failureCategory: null, failureMessage: null };
    }
    async pollUntilTerminal(jobId: string) {
      return this.getGeneration(jobId);
    }
  }
  return { ...actual, LightXHairstyleProvider: FakeProvider };
});

let sourceBytes: Buffer;
let resultBytes: Buffer;
const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input instanceof URL ? input.href : (input as { url?: string })?.url ?? input);
  if (url.includes("allowed.supabase.co")) {
    const chunk = new Uint8Array(sourceBytes);
    return {
      ok: true,
      status: 200,
      headers: { get: (key: string) => (key.toLowerCase() === "content-type" ? "image/png" : null) } as unknown as Headers,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: chunk })),
            cancel: async () => undefined,
          };
        },
      } as unknown as ReadableStream<Uint8Array>,
      arrayBuffer: async () => chunk.buffer,
    } as unknown as Response;
  }
  return { ok: true, arrayBuffer: async () => new Uint8Array(resultBytes).buffer } as Response;
});

const { useInMemoryDbForTests, getDb } = await import("../src/server/db/connection.ts");
const { internalRouter } = await import("../src/server/routes/internal.ts");
const { INTERNAL_AUTH_HEADER } = await import("../src/server/security/internal-auth.ts");
const { PRODUCT_TMP_DIR, PRODUCT_RESULTS_DIR } = await import("../src/server/security/paths.ts");
const { config } = await import("../src/server/config/env.ts");
const { buildProviderPrompt, PRESERVATION_CONSTRAINTS } = await import("../src/server/services/preservation-prompt.ts");
const chargesRepo = await import("../src/server/db/charges-repo.ts");
const generationsRepo = await import("../src/server/db/generations-repo.ts");

const defaults = { ...config };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(internalRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  useInMemoryDbForTests();
  Object.assign(config, defaults, { generationEnabled: true });
  createBehaviour = "ok";
  pollOutcome = "completed";
  createGenerationSpy.mockClear();
  sourceBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 6, b: 7 } } }).png().toBuffer();
  resultBytes = sourceBytes;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  Object.assign(config, defaults);
  await rm(PRODUCT_TMP_DIR, { recursive: true, force: true });
  await rm(PRODUCT_RESULTS_DIR, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  json: Record<string, unknown> & { billing?: { state: string; credits: number | null } };
  raw: string;
}

function request(method: string, urlPath: string, body?: unknown, auth = true): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(auth ? { [INTERNAL_AUTH_HEADER]: SECRET } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let counter = 0;
function createBody(overrides: { owner?: string; session?: string; id?: string; signedUrl?: string } = {}) {
  counter += 1;
  const session = overrides.session ?? "session-1";
  return {
    externalOwnerId: overrides.owner ?? "owner-1",
    externalSessionId: session,
    externalGenerationId: overrides.id ?? `gen-${counter}`,
    operationId: `op-${counter}`,
    style: { key: "buzz-cut" },
    source: {
      signedUrl: overrides.signedUrl ?? "https://allowed.supabase.co/object/sign/x?token=y",
      expectedMimeType: "image/png",
      maxBytes: 1_000_000,
      sourceObjectKey: `customers/owner/sessions/${session}/source/original`,
    },
  };
}

const create = (overrides: Parameters<typeof createBody>[0] = {}) => request("POST", "/internal/generations", createBody(overrides));
const status = (id: string) => request("GET", `/internal/generations/${id}`);

describe("kill switch", () => {
  it("is off by default and only the exact value \"true\" turns it on", { timeout: 30_000 }, async () => {
    expect(defaults.generationEnabled).toBe(false);
    for (const value of ["TRUE", "1", "yes", " ", "false"]) {
      vi.resetModules();
      process.env.CHUKU_GENERATION_ENABLED = value;
      const fresh = await import("../src/server/config/env.ts");
      expect(fresh.config.generationEnabled, value).toBe(false);
    }
    vi.resetModules();
    process.env.CHUKU_GENERATION_ENABLED = "true";
    expect((await import("../src/server/config/env.ts")).config.generationEnabled).toBe(true);
    delete process.env.CHUKU_GENERATION_ENABLED;
    vi.resetModules();
  });

  it("refuses without contacting the provider, records nothing chargeable, and replays the refusal", async () => {
    config.generationEnabled = false;
    const body = createBody();
    const first = await request("POST", "/internal/generations", body);
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ status: "failed", safeErrorCode: "CHUKU_AI_UNAVAILABLE", billing: { state: "not_charged", credits: 0 } });
    expect(createGenerationSpy).not.toHaveBeenCalled();

    // Switching on later never turns an already-refused id into a provider call.
    config.generationEnabled = true;
    const replay = await request("POST", "/internal/generations", body);
    expect(replay.json).toMatchObject({ status: "failed", safeErrorCode: "CHUKU_AI_UNAVAILABLE" });
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });
});

describe("preservation prompt", () => {
  it("appends the identity, hairline, density and beard constraints to every style prompt", () => {
    const prompt = buildProviderPrompt("buzz cut, very short.");
    expect(prompt.startsWith("buzz cut, very short. ")).toBe(true);
    expect(prompt).toContain("preserve identity");
    expect(prompt).toContain("do not lower");
    expect(prompt).toContain("do not add hair");
    expect(prompt).toContain("do not fill thinning, receding or sparse areas");
    expect(prompt).toContain("beard");
  });

  it("is what the provider receives on the internal path", async () => {
    await create();
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
    expect(createGenerationSpy.mock.calls[0]?.[0].prompt).toContain(PRESERVATION_CONSTRAINTS);
  });
});

describe("provider-charge record", () => {
  it("is pending while in flight and charged with the configured credits on completion", async () => {
    config.creditsPerGeneration = 2;
    pollOutcome = "processing";
    const created = await create({ id: "gen-charge" });
    expect(created.json.billing).toEqual({ state: "pending", credits: null });
    expect(chargesRepo.getCharge(generationsRepo.findByExternalGenerationId("gen-charge")!.id)?.state).toBe("submitted");
    pollOutcome = "completed";
    const done = await status("gen-charge");
    expect(done.json).toMatchObject({ status: "completed", billing: { state: "charged", credits: 2 } });
  });

  it("a failure before the paid submit is not charged", async () => {
    createBehaviour = "fail-before-submit";
    expect((await create()).json.billing).toEqual({ state: "not_charged", credits: 0 });
  });

  it("a source that fails validation never reaches the provider and is not charged", async () => {
    const res = await create({ signedUrl: "https://evil.example.com/x" });
    expect(res.json).toMatchObject({ safeErrorCode: "CHUKU_SOURCE_UNAVAILABLE", billing: { state: "not_charged" } });
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });

  it("a network failure during the paid submit is unknown, never free", async () => {
    createBehaviour = "fail-submit-network";
    expect((await create()).json.billing).toEqual({ state: "unknown", credits: null });
  });

  it("a documented no-deduct provider refusal at submit is not charged", async () => {
    createBehaviour = "fail-submit-5040";
    expect((await create()).json.billing).toEqual({ state: "not_charged", credits: 0 });
  });

  it("a provider failure after acceptance is unknown", async () => {
    pollOutcome = "failed";
    await create({ id: "gen-late-fail" });
    expect((await status("gen-late-fail")).json).toMatchObject({ status: "failed", billing: { state: "unknown" } });
  });

  it("a settled charge is never rewritten", async () => {
    await create({ id: "gen-settled" });
    await status("gen-settled");
    const id = generationsRepo.findByExternalGenerationId("gen-settled")!.id;
    chargesRepo.setChargeState(id, "unknown");
    expect(chargesRepo.getCharge(id)?.state).toBe("charged");
  });

  it("never exposes the provider order id", async () => {
    const res = await create({ id: "gen-leak" });
    expect(res.raw).not.toContain("provider-order-secret-1");
    expect((await status("gen-leak")).raw).not.toContain("provider-order-secret-1");
  });
});

describe("idempotency", () => {
  it("concurrent posts of one externalGenerationId make exactly one provider call and one charge", async () => {
    const body = createBody({ id: "gen-race" });
    const results = await Promise.all(Array.from({ length: 5 }, () => request("POST", "/internal/generations", body)));
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.json.externalGenerationId))).toEqual(new Set(["gen-race"]));
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM provider_charges`).get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("breakers", () => {
  it("per-owner daily limit refuses as a quota error without a provider call", async () => {
    config.ownerDailyLimit = 2;
    await create({ session: "s-a" });
    await create({ session: "s-b" });
    const third = await create({ session: "s-c" });
    expect(third.json).toMatchObject({ safeErrorCode: "CHUKU_QUOTA_EXCEEDED", billing: { state: "not_charged" } });
    expect(createGenerationSpy).toHaveBeenCalledTimes(2);
    expect((await create({ owner: "owner-2", session: "s-d" })).json.status).toBe("processing");
  });

  it("per-owner monthly limit refuses as a quota error", async () => {
    config.ownerMonthlyLimit = 1;
    await create();
    expect((await create()).json.safeErrorCode).toBe("CHUKU_QUOTA_EXCEEDED");
  });

  it("global daily and monthly limits refuse as unavailable", async () => {
    config.globalDailyLimit = 1;
    await create({ owner: "a", session: "sa" });
    expect((await create({ owner: "b", session: "sb" })).json.safeErrorCode).toBe("CHUKU_AI_UNAVAILABLE");
    config.globalDailyLimit = 100;
    config.globalMonthlyLimit = 1;
    expect((await create({ owner: "c", session: "sc" })).json.safeErrorCode).toBe("CHUKU_AI_UNAVAILABLE");
  });

  it("not-charged attempts do not count; unknown ones do", async () => {
    config.ownerDailyLimit = 1;
    createBehaviour = "fail-before-submit";
    await create();
    createBehaviour = "fail-submit-network";
    expect((await create()).json.billing?.state).toBe("unknown");
    createBehaviour = "ok";
    expect((await create()).json.safeErrorCode).toBe("CHUKU_QUOTA_EXCEEDED");
  });
});

describe("interrupted dispatch", () => {
  function insertStuck(externalId: string, chargeState: "reserved" | "submitting") {
    const created = new Date(Date.now() - 11 * 60_000).toISOString();
    getDb()
      .prepare(`INSERT INTO sessions (id, status, created_at, updated_at, expires_at, external_session_id) VALUES (?, 'active', ?, ?, ?, ?)`)
      .run(`sess-${externalId}`, created, created, created, `ext-${externalId}`);
    getDb()
      .prepare(
        `INSERT INTO generations (id, session_id, operation_id, style_id, generation_index, status, external_generation_id, created_at)
         VALUES (?, ?, 'op', 'buzz-cut', 1, 'queued', ?, ?)`,
      )
      .run(`row-${externalId}`, `sess-${externalId}`, externalId, created);
    chargesRepo.insertCharge(`row-${externalId}`, "owner-1", chargeState, 1, null);
  }

  it("a dispatch that died before the provider was contacted fails as not charged", async () => {
    insertStuck("gen-stuck-reserved", "reserved");
    expect((await status("gen-stuck-reserved")).json).toMatchObject({ status: "failed", billing: { state: "not_charged" } });
  });

  it("a dispatch that died during the submit fails as unknown", async () => {
    insertStuck("gen-stuck-submitting", "submitting");
    expect((await status("gen-stuck-submitting")).json).toMatchObject({ status: "failed", billing: { state: "unknown" } });
  });
});

describe("session purge", () => {
  it("requires internal auth", async () => {
    expect((await request("DELETE", "/internal/sessions/session-1/artifacts", undefined, false)).status).toBe(401);
  });

  it("deletes local results, keeps the charge, refuses the result afterwards, and is idempotent", async () => {
    await create({ id: "gen-purge", session: "sess-purge" });
    await status("gen-purge");
    const row = generationsRepo.findByExternalGenerationId("gen-purge")!;
    const file = path.join(PRODUCT_RESULTS_DIR, row.result_path!);
    expect(existsSync(file)).toBe(true);

    const purged = await request("DELETE", "/internal/sessions/sess-purge/artifacts");
    expect(purged.json).toEqual({ deletedResults: 1, providerCopyDeletion: "unsupported" });
    expect(existsSync(file)).toBe(false);
    expect((await request("GET", "/internal/generations/gen-purge/result")).status).toBe(404);
    expect((await status("gen-purge")).json).toMatchObject({
      status: "failed",
      safeErrorCode: "CHUKU_CANCELLED",
      resultAvailable: false,
      billing: { state: "charged", credits: 1 },
    });
    expect((await request("DELETE", "/internal/sessions/sess-purge/artifacts")).json).toEqual({ deletedResults: 0, providerCopyDeletion: "unsupported" });
  });

  it("an unknown session is a no-op", async () => {
    expect((await request("DELETE", "/internal/sessions/nope/artifacts")).json).toEqual({ deletedResults: 0, providerCopyDeletion: "unsupported" });
  });

  it("a result arriving after the purge is deleted on sight but still charged", async () => {
    pollOutcome = "processing";
    await create({ id: "gen-late", session: "sess-late" });
    await request("DELETE", "/internal/sessions/sess-late/artifacts");
    pollOutcome = "completed";
    const late = await status("gen-late");
    expect(late.json).toMatchObject({ resultAvailable: false, billing: { state: "charged" } });
    expect(generationsRepo.findByExternalGenerationId("gen-late")!.result_path).toBeNull();
  });

  it("refuses new generations for a purged session", async () => {
    await request("DELETE", "/internal/sessions/sess-closed/artifacts");
    await create({ session: "sess-other" });
    await request("DELETE", "/internal/sessions/sess-other/artifacts");
    const res = await create({ session: "sess-other" });
    expect(res.json).toMatchObject({ safeErrorCode: "CHUKU_CANCELLED", billing: { state: "not_charged" } });
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });
});
