import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Deployment-hardening mission section 7: exercises the REAL
// FakeHairstyleProvider end-to-end through the internal API (no
// vi.mock of the provider module itself, unlike tests/internal-routes.test.ts)
// — proves the internal-create -> provider -> processing -> completion ->
// local result file -> authenticated result route chain genuinely works
// with CHUKU_PROVIDER_MODE=fake, with zero real network calls.
const SECRET = "internal-auth-fake-provider-test-secret-0123456789";
process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
process.env.CHUKU_INTERNAL_SOURCE_ALLOWED_HOSTS = "allowed.supabase.co";
process.env.CHUKU_MAX_GENERATIONS_PER_SESSION = "5";
process.env.CHUKU_PROVIDER_MODE = "fake";
delete process.env.LIGHTX_API_KEY;
// An isolated CHUKU_PRODUCT_DATA_DIR (mission section 4/9): without this,
// this file would write/rm-rf the same real PROJECT_ROOT/data directory
// other test files also use by default, and full-suite parallel workers
// can race on that shared path (a file mid-write here, rm -rf'd by another
// file's afterEach). A dedicated temp root makes this file collision-free.
process.env.CHUKU_PRODUCT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "chuku-fake-provider-test-"));

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

// Only the MEKKY-issued signed source URL is faked at the network layer
// (mirroring tests/internal-routes.test.ts) — the fake provider's own
// "result" is a real data: URL, resolved by the real, unmocked global
// fetch (proven network-free in tests/fake-provider.test.ts), so it is
// deliberately passed through rather than intercepted here.
const realFetch = globalThis.fetch;
let sourceBytes: Buffer;
const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
  const url = String(input instanceof URL ? input.href : (input as { url?: string })?.url ?? input);
  if (url.startsWith("data:")) return realFetch(input as string);
  if (url.includes("allowed.supabase.co")) return streamingPngResponse(sourceBytes);
  return realFetch(input as RequestInfo, init as RequestInit);
});

const { useInMemoryDbForTests } = await import("../src/server/db/connection.ts");
const { internalRouter } = await import("../src/server/routes/internal.ts");
const { INTERNAL_AUTH_HEADER } = await import("../src/server/security/internal-auth.ts");
const { PRODUCT_RESULTS_DIR } = await import("../src/server/security/paths.ts");
const { config } = await import("../src/server/config/env.ts");
const generationsRepo = await import("../src/server/db/generations-repo.ts");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  expect(config.providerMode).toBe("fake");
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
  await rm(config.productDataDirOverride as string, { recursive: true, force: true });
});

beforeEach(async () => {
  useInMemoryDbForTests();
  fetchMock.mockClear();
  sourceBytes = await validPngBytes();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // Not PRODUCT_TMP_DIR: it's a fixed OS-temp path shared by every
  // concurrently-running test file/process (paths.ts decouples it from
  // CHUKU_PRODUCT_DATA_DIR intentionally — deployment-hardening mission
  // section 4), so rm -rf'ing it here would race with sibling test files.
  // The internal create handler already deletes its own job's temp source
  // file in a finally block, so there is nothing of ours left to clean up.
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
    externalGenerationId: "gen-fake-1",
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

describe("internal generation lifecycle with the real fake provider (CHUKU_PROVIDER_MODE=fake)", () => {
  it("accepts, dispatches to the fake provider, and reaches completed with a downloadable result — zero LIGHTX_API_KEY, zero network provider calls", async () => {
    const created = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    expect(created.status).toBe(202);

    const status = await request("GET", "/internal/generations/gen-fake-1", { headers: authHeaders() });
    expect(status.status).toBe(200);
    expect(status.json.status).toBe("completed");
    expect(status.json.resultAvailable).toBe(true);

    const result = await request("GET", "/internal/generations/gen-fake-1/result", { headers: authHeaders() });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toMatch(/^image\//);
    expect(Number(result.headers["content-length"])).toBeGreaterThan(0);
  });

  it("an exact replay remains idempotent under the fake provider too", async () => {
    const first = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const second = await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    expect(second.json).toEqual(first.json);
  });

  it("a materially different request for the same externalGenerationId is still a conflict under the fake provider", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const conflicting = await request("POST", "/internal/generations", {
      headers: authHeaders(),
      body: createBody({ style: { key: "skin-fade" } }),
    });
    expect(conflicting.status).toBe(409);
  });

  it("internal auth is still enforced in fake-provider mode", async () => {
    const res = await request("POST", "/internal/generations", { body: createBody({ externalGenerationId: "gen-fake-noauth" }) });
    expect(res.status).toBe(401);
  });

  it("the stored provider label reflects fake, never lightx, for a fake-mode generation", async () => {
    await request("POST", "/internal/generations", { headers: authHeaders(), body: createBody() });
    const row = generationsRepo.findByExternalGenerationId("gen-fake-1")!;
    expect(row.provider).toBe("fake");
  });
});
