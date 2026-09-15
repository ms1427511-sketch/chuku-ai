import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import sharp from "sharp";

// Must be set before config/env.ts is first imported (module-load-time
// config, same convention as other env-driven settings in this codebase).
process.env.CHUKU_INTERNAL_SOURCE_ALLOWED_HOSTS = "allowed.supabase.co";
process.env.CHUKU_INTERNAL_SOURCE_FETCH_TIMEOUT_MS = "2000";
process.env.CHUKU_INTERNAL_SOURCE_MAX_BYTES = "5242880";

const { fetchSource, deleteTempSource } = await import("../src/server/security/source-fetch.ts");
const { SourceFetchError } = await import("../src/shared/errors.ts");
const { PRODUCT_TMP_DIR } = await import("../src/server/security/paths.ts");

async function validPngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

function textStreamResponse(init: { status?: number; contentType?: string; body?: Uint8Array; redirect?: boolean }): Response {
  const status = init.redirect ? 302 : (init.status ?? 200);
  const headers = new Map<string, string>();
  if (init.contentType) headers.set("content-type", init.contentType);
  if (init.redirect) headers.set("location", "https://evil.example/steal");
  const body = init.body ?? new Uint8Array();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null } as unknown as Headers,
    body: {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: body };
          },
          cancel: async () => undefined,
        };
      },
    } as unknown as ReadableStream<Uint8Array>,
    arrayBuffer: async () => body.buffer,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(PRODUCT_TMP_DIR, { recursive: true, force: true });
});

describe("fetchSource — URL validation (rejected before any network contact)", () => {
  it("rejects non-https URLs", async () => {
    await expect(fetchSource("http://allowed.supabase.co/x.png", "image/png", 1000)).rejects.toThrow(SourceFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a URL with embedded credentials", async () => {
    await expect(fetchSource("https://user:pass@allowed.supabase.co/x.png", "image/png", 1000)).rejects.toThrow(SourceFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects localhost", async () => {
    await expect(fetchSource("https://localhost/x.png", "image/png", 1000)).rejects.toThrow(SourceFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects private/link-local IPv4 targets", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "172.16.0.5", "192.168.1.5", "169.254.1.1", "0.0.0.0"]) {
      await expect(fetchSource(`https://${host}/x.png`, "image/png", 1000)).rejects.toThrow(SourceFetchError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a host not on the configured allowlist", async () => {
    await expect(fetchSource("https://not-allowed.example.com/x.png", "image/png", 1000)).rejects.toThrow(SourceFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported expected mime type", async () => {
    await expect(fetchSource("https://allowed.supabase.co/x.svg", "image/svg+xml", 1000)).rejects.toThrow(SourceFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchSource — network-layer behavior (fake HTTP source only; validation logic unweakened)", () => {
  it("never follows a redirect", async () => {
    fetchMock.mockResolvedValue(textStreamResponse({ redirect: true }));
    await expect(fetchSource("https://allowed.supabase.co/x.png", "image/png", 1_000_000)).rejects.toThrow(SourceFetchError);
    const [, options] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(options.redirect).toBe("manual");
  });

  it("rejects a body larger than the bound", async () => {
    const oversized = new Uint8Array(10);
    fetchMock.mockResolvedValue(textStreamResponse({ contentType: "image/png", body: oversized }));
    await expect(fetchSource("https://allowed.supabase.co/x.png", "image/png", 5)).rejects.toThrow(SourceFetchError);
  });

  it("rejects a content-type mismatch", async () => {
    const bytes = await validPngBytes();
    fetchMock.mockResolvedValue(textStreamResponse({ contentType: "image/jpeg", body: new Uint8Array(bytes) }));
    await expect(fetchSource("https://allowed.supabase.co/x.png", "image/png", 1_000_000)).rejects.toThrow(SourceFetchError);
  });

  it("rejects bytes that do not decode as a real image of the expected format", async () => {
    fetchMock.mockResolvedValue(textStreamResponse({ contentType: "image/png", body: new Uint8Array([1, 2, 3, 4]) }));
    await expect(fetchSource("https://allowed.supabase.co/x.png", "image/png", 1_000_000)).rejects.toThrow(SourceFetchError);
  });

  it("accepts and persists a valid, allowlisted, correctly-typed image, then deletes it on request", async () => {
    const bytes = await validPngBytes();
    fetchMock.mockResolvedValue(textStreamResponse({ contentType: "image/png", body: new Uint8Array(bytes) }));
    const { tempPath } = await fetchSource("https://allowed.supabase.co/x.png", "image/png", 1_000_000);
    expect(tempPath).toContain(PRODUCT_TMP_DIR);
    await deleteTempSource(tempPath);
  });
});
