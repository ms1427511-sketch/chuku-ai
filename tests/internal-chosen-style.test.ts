import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// MEKKY chosen-style flow (MEKKY migration 20261007100000) on the internal
// path: up to 3 discovery looks on the front photo, then left, right and
// back final views in the style MEKKY locked when the customer chose a look.
// The provider takes one image and one text prompt, so the lock reaches it
// only as prompt text -- these tests prove what is sent, not that the
// provider renders the same haircut on every angle. Provider is faked;
// zero real network calls.
const SECRET = "internal-auth-chosen-style-secret-0123456789";
process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
process.env.CHUKU_INTERNAL_SOURCE_ALLOWED_HOSTS = "allowed.supabase.co";
process.env.CHUKU_MAX_GENERATIONS_PER_SESSION = "5";
delete process.env.CHUKU_MAX_INTERNAL_GENERATIONS_PER_SESSION;
delete process.env.CHUKU_GENERATION_ENABLED;
// Own data dir and tmp root, for the same reasons as
// tests/internal-cost-controls.test.ts.
process.env.CHUKU_PRODUCT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "chuku-chosen-style-test-"));
process.env.TMPDIR = process.env.CHUKU_PRODUCT_DATA_DIR;

const createGenerationSpy = vi.fn();

vi.mock("../src/server/providers/lightx-provider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/providers/lightx-provider.ts")>();
  class FakeProvider {
    async createGeneration(input: { prompt: string }) {
      createGenerationSpy(input);
      return { provider: "lightx", externalJobId: `provider-order-${createGenerationSpy.mock.calls.length}`, status: "queued", createdAt: new Date().toISOString() };
    }
    async getGeneration(jobId: string) {
      return { provider: "lightx", externalJobId: jobId, status: "processing", resultUrl: null, failureCategory: null, failureMessage: null };
    }
    async pollUntilTerminal(jobId: string) {
      return this.getGeneration(jobId);
    }
  }
  return { ...actual, LightXHairstyleProvider: FakeProvider };
});

let sourceBytes: Buffer;
const fetchMock = vi.fn(async () => {
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
});

const { useInMemoryDbForTests } = await import("../src/server/db/connection.ts");
const { internalRouter } = await import("../src/server/routes/internal.ts");
const { INTERNAL_AUTH_HEADER } = await import("../src/server/security/internal-auth.ts");
const { PRODUCT_TMP_DIR, PRODUCT_RESULTS_DIR } = await import("../src/server/security/paths.ts");
const { config } = await import("../src/server/config/env.ts");
const { findHairstyle } = await import("../src/shared/hairstyles.ts");
const { buildFinalViewPrompt, buildProviderPrompt, LOCKED_STYLE_CONSTRAINTS, PRESERVATION_CONSTRAINTS } = await import(
  "../src/server/services/preservation-prompt.ts"
);

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
  createGenerationSpy.mockClear();
  sourceBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 6, b: 7 } } }).png().toBuffer();
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
  json: Record<string, unknown>;
}

function post(body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/internal/generations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), [INTERNAL_AUTH_HEADER]: SECRET },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

let counter = 0;
type Shape = { kind: string; view: string } | null | undefined;
function body(opts: { id?: string; styleKey?: string; generation?: Shape; source?: string } = {}) {
  counter += 1;
  const view = opts.generation?.view ?? "front";
  return {
    externalOwnerId: "owner-1",
    externalSessionId: "session-1",
    externalGenerationId: opts.id ?? `gen-${counter}`,
    operationId: `op-${counter}`,
    style: { key: opts.styleKey ?? "low-fade" },
    ...(opts.generation !== undefined ? { generation: opts.generation } : {}),
    source: {
      signedUrl: "https://allowed.supabase.co/object/sign/x?token=y",
      expectedMimeType: "image/png",
      maxBytes: 1_000_000,
      sourceObjectKey: `customers/owner/sessions/session-1/source/${opts.source ?? (view === "front" ? "original" : view)}`,
    },
  };
}

const lastPrompt = () => createGenerationSpy.mock.calls.at(-1)?.[0].prompt as string;
const lowFade = findHairstyle("low-fade")!.prompt;

describe("final-view prompt", () => {
  for (const view of ["left", "right", "back"] as const) {
    it(`${view}: the locked catalog style first, then the lock, the angle and the preservation constraints`, () => {
      const prompt = buildFinalViewPrompt(lowFade, view);
      expect(prompt.startsWith(`${lowFade}. `)).toBe(true);
      expect(prompt).toContain(LOCKED_STYLE_CONSTRAINTS);
      expect(prompt).toContain(PRESERVATION_CONSTRAINTS);
      expect(prompt).toContain(view === "back" ? "from behind" : `from the ${view} side`);
      expect(prompt.indexOf(LOCKED_STYLE_CONSTRAINTS)).toBeLessThan(prompt.indexOf(PRESERVATION_CONSTRAINTS));
    });
  }

  it("asks for the same haircut and forbids redesign, without promising it", () => {
    expect(LOCKED_STYLE_CONSTRAINTS).toContain("Apply the exact locked hairstyle from the selected look.");
    expect(LOCKED_STYLE_CONSTRAINTS).toContain("do not raise or lower the fade");
    expect(LOCKED_STYLE_CONSTRAINTS).toContain("do not change the top style");
    expect(LOCKED_STYLE_CONSTRAINTS).toContain("do not change the hairline treatment");
    expect(LOCKED_STYLE_CONSTRAINTS).toContain("do not alter density");
    expect(LOCKED_STYLE_CONSTRAINTS).toContain("Only adapt the same haircut to the camera angle");
    for (const view of ["left", "right", "back"] as const) {
      expect(buildFinalViewPrompt(lowFade, view)).not.toMatch(/guarantee|perfect|identical/i);
    }
  });

  it("the three views differ only in the angle sentence", () => {
    const strip = (p: string) => p.replace(/This photo shows [^;]+; show the haircut as seen [^.]+\./, "");
    const left = strip(buildFinalViewPrompt(lowFade, "left"));
    expect(strip(buildFinalViewPrompt(lowFade, "right"))).toBe(left);
    expect(strip(buildFinalViewPrompt(lowFade, "back"))).toBe(left);
  });
});

describe("discovery looks are unchanged", () => {
  it("without a generation field the provider gets the discovery prompt", async () => {
    expect((await post(body())).status).toBe(202);
    expect(lastPrompt()).toBe(buildProviderPrompt(lowFade));
  });

  it("an explicit discovery front look gets the same prompt and the same fingerprint as an old request", async () => {
    await post(body({ id: "gen-old", generation: { kind: "discovery", view: "front" } }));
    expect(lastPrompt()).toBe(buildProviderPrompt(lowFade));
    // A dispatcher from before the chosen-style flow replays the same id
    // without the field: still the same request, not a conflict.
    const replay = await post(body({ id: "gen-old" }));
    expect(replay.status).toBe(202);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });
});

describe("final views", () => {
  for (const view of ["left", "right", "back"] as const) {
    it(`${view}: the provider gets the locked final-view prompt for that angle`, async () => {
      const res = await post(body({ generation: { kind: "final", view } }));
      expect(res.status).toBe(202);
      expect(lastPrompt()).toBe(buildFinalViewPrompt(lowFade, view));
    });
  }

  it("the style comes only from the catalog entry for style.key -- a client prompt is never forwarded", async () => {
    const tampered = { ...body({ generation: { kind: "final", view: "left" } }), style: { key: "low-fade", prompt: "mohawk, dyed green" } };
    await post(tampered);
    expect(lastPrompt()).toBe(buildFinalViewPrompt(lowFade, "left"));
    expect(lastPrompt()).not.toContain("mohawk");
  });

  it("an unknown locked style is refused before any provider call", async () => {
    const res = await post(body({ styleKey: "not-a-style", generation: { kind: "final", view: "back" } }));
    expect(res.json).toMatchObject({ error: "UNKNOWN_STYLE" });
    expect(createGenerationSpy).not.toHaveBeenCalled();
  });

  it("a replay of the same final view is not a second provider call", async () => {
    const first = body({ id: "gen-final", generation: { kind: "final", view: "right" } });
    await post(first);
    const replay = await post({ ...first, operationId: "op-retry" });
    expect(replay.status).toBe(202);
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  it("the same id for a different view is a conflict, never a new provider call", async () => {
    await post(body({ id: "gen-angle", generation: { kind: "final", view: "left" }, source: "left" }));
    const other = await post(body({ id: "gen-angle", generation: { kind: "final", view: "back" }, source: "left" }));
    expect(other.status).toBe(409);
    expect(other.json).toMatchObject({ error: "EXTERNAL_GENERATION_CONFLICT" });
    expect(createGenerationSpy).toHaveBeenCalledTimes(1);
  });

  const invalid: Array<[string, Shape]> = [
    ["a final front view", { kind: "final", view: "front" }],
    ["a discovery look of another angle", { kind: "discovery", view: "back" }],
    ["an unknown view", { kind: "final", view: "top" }],
    ["an unknown kind", { kind: "preview", view: "left" }],
    ["a null generation", null],
  ];
  for (const [label, generation] of invalid) {
    it(`${label} is refused before any provider call`, async () => {
      const res = await post(body({ generation }));
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: "INVALID_OPERATION" });
      expect(createGenerationSpy).not.toHaveBeenCalled();
    });
  }
});

describe("per-session backstop: 6 provider operations", () => {
  it("defaults to 6 on the internal path and leaves the Lab cap alone", () => {
    expect(defaults.maxInternalGenerationsPerSession).toBe(6);
    expect(defaults.maxGenerationsPerSession).toBe(5);
  });

  it("3 looks and left, right and back are submitted; a 7th is refused without a provider call", async () => {
    for (const key of ["buzz-cut", "low-fade", "skin-fade"]) {
      expect((await post(body({ styleKey: key }))).status).toBe(202);
    }
    for (const view of ["left", "right", "back"]) {
      expect((await post(body({ generation: { kind: "final", view } }))).status).toBe(202);
    }
    expect(createGenerationSpy).toHaveBeenCalledTimes(6);

    const seventh = await post(body({ generation: { kind: "final", view: "back" } }));
    expect(seventh.status).toBe(429);
    expect(seventh.json).toMatchObject({ error: "GENERATION_LIMIT_REACHED" });
    expect(createGenerationSpy).toHaveBeenCalledTimes(6);
  });
});
