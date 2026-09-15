import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import sharp from "sharp";
import { rm } from "node:fs/promises";

// Must be set before config/env.ts is first imported anywhere in this
// module graph (module-load-time config — same convention used throughout
// this codebase's other env-driven settings).
const SECRET = "internal-auth-test-secret-0123456789abcdef";
process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
process.env.CHUKU_INTERNAL_SOURCE_ALLOWED_HOSTS = "allowed.supabase.co";
process.env.CHUKU_MAX_GENERATIONS_PER_SESSION = "5";

let mockOutcome: "completed" | "still-processing" | "permanent-fail" = "completed";
const createGenerationSpy = vi.fn();
const getGenerationSpy = vi.fn();

// Same fake-provider convention as tests/product-generation-service.test.ts
// — never a real network call, deterministic terminal outcomes controlled
// by mockOutcome.
vi.mock("../src/server/providers/lightx-provider.ts", () => {
  class FakeProvider {
    async createGeneration(...args: unknown[]) {
      createGenerationSpy(...args);
      return { provider: "lightx", externalJobId: "internal-job-1", status: "queued", createdAt: new Date().toISOString() };
    }
    async getGeneration(...args: unknown[]) {
      getGenerationSpy(...args);
      if (mockOutcome === "completed") {
        return {
          provider: "lightx",
          externalJobId: "internal-job-1",
          status: "completed",
          resultUrl: "https://example.invalid/result.png",
          failureCategory: null,
          failureMessage: null,
        };
      }
      if (mockOutcome === "permanent-fail") {
        return {
          provider: "lightx",
          externalJobId: "internal-job-1",
          status: "failed",
          resultUrl: null,
          failureCategory: "invalid_portrait",
          failureMessage: "simulated no-face",
        };
      }
      return { provider: "lightx", externalJobId: "internal-job-1", status: "processing", resultUrl: null, failureCategory: null, failureMessage: null };
    }
    async pollUntilTerminal(jobId: string) {
      return this.getGeneration(jobId);
    }
  }
  return { LightXHairstyleProvider: FakeProvider, ProviderCallError: class extends Error {} };
});

async function validPngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 6, b: 7 } } }).png().toBuffer();
}

function streamingPngResponse(bytes: Buffer): Response {
  const chunk = new Uint8Array(bytes);
  return {
    ok: true,
    status: 200,
    headers: { get: (key: string) => (key.toLowerCase() === "content-type" ? "image/png" : null) } as unknown as Headers,
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: chunk };
          },
          cancel: async () => undefined,
        };
      },
    } as unknown as ReadableStream<Uint8Array>,
    arrayBuffer: async () => chunk.buffer,
  } as unknown as Response;
}

// Dispatches based on target URL: the MEKKY-issued signed source URL
// (SSRF-validated, real network layer faked per mission section 8's
// "isolate it in the test harness" instruction) vs. the fake LightX
// result-image download used by product-generation-service.ts's existing
// downloadProductResult helper.
let sourceBytes: Buffer;
const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input instanceof URL ? input.href : (input as { url?: string })?.url ?? input);
  if (url.includes("allowed.supabase.co")) {
    return streamingPngResponse(sourceBytes);
  }
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
});

const { useInMemoryDbForTests } = await import("../src/server/db/connection.ts");
const { internalRouter } = await import("../src/server/routes/internal.ts");
const { INTERNAL_AUTH_HEADER } = await import("../src/server/security/internal-auth.ts");
const { PRODUCT_TMP_DIR, PRODUCT_RESULTS_DIR } = await import("../src/server/security/paths.ts");
const { reconcileAllProcessingOnStartup } = await import("../src/server/services/product-generation-service.ts");
const generationsRepo = await import("../src/server/db/generations-repo.ts");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(internalRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  useInMemoryDbForTests();
  mockOutcome = "completed";
  createGenerationSpy.mockClear();
  getGenerationSpy.mockClear();
  fetchMock.mockClear();
  sourceBytes = await validPngBytes();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(PRODUCT_TMP_DIR, { recursive: true, force: true });
  await rm(PRODUCT_RESULTS_DIR, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

function request(method: string, urlPath: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = { __raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [INTERNAL_AUTH_HEADER]: SECRET, ...extra };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    externalOwnerId: "owner-1",
    externalSessionId: "session-abc",
    externalGenerationId: "gen-abc-1",
    operationId: "op-1",
    style: { key: "buzz-cut" },
    source: {
      signedUrl: "https://allowed.supabase.co/object/sign/abc?token=xyz",
      expectedMimeType: "image/png",
      maxBytes: 1_000_000,
      sourceObjectKey: "sessions/session-abc/source.png",
    },
    ...overrides,
  };
}

describe("POST /internal/generations — auth", () => {
  it("denies a missing internal auth header", async () => {
    const res = await request("POST", "/internal/generations", { body: createBody() });
    expect(res.status).toBe(401);
  });

  it("denies a wrong internal auth header", async () => {
    const res = await request("POST", "/internal/generations", { headers: authHeaders({ [INTERNAL_AUTH_HEADER]: "wrong" }), body: createBody() });
    expect(res.status).toBe(401);
  });

  it("accepts a correct internal auth header", async () => {
    const res = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    expect(res.status).toBe(202);
  });
});

describe("POST /internal/generations — external-id idempotency", () => {
  it("creates on first call and dispatches to the provider exactly once", async () => {
    const res = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    expect(res.status).toBe(202);
    expect(res.json.externalGenerationId).toBe("gen-abc-1");
    expect(res.json.status).toBe("processing");
    expect(res.json.safeErrorCode).toBeNull();
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("an exact replay (ambiguous acceptance recovery) returns the same row and never resubmits provider work", async () => {
    const first = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const second = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    expect(second.status).toBe(202);
    expect(second.json).toEqual(first.json);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("the same externalGenerationId with materially different content is a conflict, never a second dispatch", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const conflicting = await request("POST", "/internal/generations", {
      headers: authHeaders(),
      body: createBody({ style: { key: "skin-fade" } }),
    });
    expect(conflicting.status).toBe(409);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("a retry with only the signed URL changed (expired/re-signed) is still treated as the same request", async () => {
    const first = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const retried = await request("POST", "/internal/generations", {
      headers: authHeaders(),
      body: createBody({ source: { ...createBody().source, signedUrl: "https://allowed.supabase.co/object/sign/abc?token=different" } }),
    });
    expect(retried.status).toBe(202);
    expect(retried.json).toEqual(first.json);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("enforces the generation hard cap of 5 per session", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request("POST", "/internal/generations", {
        headers: authHeaders(),
        body: createBody({ externalGenerationId: `gen-cap-${i}`, operationId: `op-cap-${i}` }),
      });
      expect(res.status).toBe(202);
    }
    const sixth = await request("POST", "/internal/generations", {
      headers: authHeaders(),
      body: createBody({ externalGenerationId: "gen-cap-over", operationId: "op-cap-over" }),
    });
    expect(sixth.status).toBe(429);
  });
});

describe("POST /internal/generations — source validation failures never reach the provider", () => {
  it("marks the generation failed with CHUKU_SOURCE_UNAVAILABLE when the source host is not allowlisted", async () => {
    const res = await request("POST", "/internal/generations", {
      headers: authHeaders(),
      body: createBody({ source: { ...createBody().source, signedUrl: "https://not-allowed.example.com/x.png" } }),
    });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe("failed");
    expect(res.json.safeErrorCode).toBe("CHUKU_SOURCE_UNAVAILABLE");
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });

  it("marks the generation failed with CHUKU_SOURCE_UNAVAILABLE when the downloaded bytes do not decode as an image", async () => {
    fetchMock.mockImplementationOnce(async () => streamingPngResponse(Buffer.from([1, 2, 3, 4])));
    const res = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody({ externalGenerationId: "gen-badimg" }) });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe("failed");
    expect(res.json.safeErrorCode).toBe("CHUKU_SOURCE_UNAVAILABLE");
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });
});

describe("GET /internal/generations/:externalGenerationId", () => {
  it("denies without internal auth", async () => {
    const res = await request("GET", "/internal/generations/gen-abc-1");
    expect(res.status).toBe(401);
  });

  it("404s for an unknown externalGenerationId", async () => {
    const res = await request("GET", "/internal/generations/does-not-exist", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("reconciles a still-processing row via one poll and never resubmits", async () => {
    mockOutcome = "still-processing";
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const res = await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("processing");
    expect(getGenerationSpy).toHaveBeenCalledTimes(1);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("reflects a provider terminal failure with a mapped safe error code, never the raw category", async () => {
    mockOutcome = "permanent-fail";
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const res = await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("failed");
    expect(res.json.safeErrorCode).toBe("CHUKU_GENERATION_FAILED");
    expect(JSON.stringify(res.json)).not.toMatch(/invalid_portrait|lightx|LightX/i);
  });

  it("reports resultAvailable once completed and reflects only the normalized contract shape", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const res = await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("completed");
    expect(res.json.resultAvailable).toBe(true);
    expect(Object.keys(res.json).sort()).toEqual(["externalGenerationId", "resultAvailable", "safeErrorCode", "status"]);
  });
});

describe("GET /internal/generations/:externalGenerationId/result", () => {
  it("denies without internal auth", async () => {
    const res = await request("GET", "/internal/generations/gen-abc-1/result");
    expect(res.status).toBe(401);
  });

  it("returns 409 before the generation has completed", async () => {
    mockOutcome = "still-processing";
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const res = await request("GET", "/internal/generations/gen-abc-1/result", { headers: authHeaders() });
    expect(res.status).toBe(409);
  });

  it("404s for an unknown externalGenerationId", async () => {
    const res = await request("GET", "/internal/generations/does-not-exist/result", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("streams the local result bytes with a safe content-type and bounded content-length once completed", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    // The result route mirrors routes/product-results.ts and never
    // reconciles on its own — the caller must have polled GET status
    // (which drives reconcileIfProcessing) until "completed" first.
    const status = await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    expect(status.json.status).toBe("completed");
    const res = await request("GET", "/internal/generations/gen-abc-1/result", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\//);
    expect(Number(res.headers["content-length"])).toBeGreaterThan(0);
  });

  it("is safe to call twice after completion (deterministic, no duplicate side effects)", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    const first = await request("GET", "/internal/generations/gen-abc-1/result", { headers: authHeaders() });
    const second = await request("GET", "/internal/generations/gen-abc-1/result", { headers: authHeaders() });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers["content-length"]).toBe(first.headers["content-length"]);
  });
});

describe("internal rows share the generic MEKKY-outage-safe process lifecycle", () => {
  it("reconcileAllProcessingOnStartup (server restart recovery) picks up an internal-origin row with at most one provider status check, never a resubmit", async () => {
    mockOutcome = "still-processing";
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
    getGenerationSpy.mockClear();

    mockOutcome = "completed";
    const reconciledCount = await reconcileAllProcessingOnStartup();
    expect(reconciledCount).toBe(1);
    expect(getGenerationSpy).toHaveBeenCalledTimes(1);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);

    const res = await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    expect(res.json.status).toBe("completed");
  });

  it("sets the same 72h-class expires_at on an internal generation's completion as the Lab path", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    await request("GET", "/internal/generations/gen-abc-1", { headers: authHeaders() });
    const row = generationsRepo.findByExternalGenerationId("gen-abc-1")!;
    expect(row.status).toBe("completed");
    expect(row.expires_at).not.toBeNull();
    const hoursUntilExpiry = (new Date(row.expires_at!).getTime() - Date.now()) / 3_600_000;
    expect(hoursUntilExpiry).toBeGreaterThan(70);
    expect(hoursUntilExpiry).toBeLessThanOrEqual(72);
  });
});
