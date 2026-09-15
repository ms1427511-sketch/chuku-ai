// SSRF-safe download of a MEKKY-issued Supabase signed source URL —
// Phase 4.1B internal integration only. Mobile never supplies a source URL
// directly to Chuku; MEKKY mints a short-lived signed read URL server-side
// and passes it through the internal-auth-gated API. See mission section 8.
//
// Testing note (verbatim mission requirement): "Tests must use local/fake
// HTTP source without weakening production validation. If test-only
// injection required, isolate it in the test harness." This module never
// branches on NODE_ENV/test mode and never relaxes the HTTPS/allowlist/
// redirect/size checks below for tests — test coverage instead stubs the
// global `fetch` (the existing convention in tests/product-generation-
// service.test.ts) so these checks run for real against a fake but
// allowlisted https:// URL, with only the actual network transport faked.
import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import sharp from "sharp";
import { config } from "../config/env.ts";
import { PRODUCT_TMP_DIR, resolveProductTmpFile } from "./paths.ts";
import { SourceFetchError } from "../../shared/errors.ts";

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXT_BY_MIME: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function isLoopbackOrPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network"
  return false;
}

function isLoopbackOrPrivateIPv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local (fc00::/7)
  return false;
}

/**
 * Validates the target URL before any network contact: HTTPS only, no
 * embedded credentials, not localhost, not a private/link-local IP literal,
 * and hostname present in the configured allowlist (fails closed if the
 * allowlist is empty — an unconfigured allowlist must never mean "allow
 * anything").
 */
function assertSafeSourceUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceFetchError("malformed source URL");
  }
  if (url.protocol !== "https:") {
    throw new SourceFetchError("source URL must use https");
  }
  if (url.username || url.password) {
    throw new SourceFetchError("source URL must not embed credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost") {
    throw new SourceFetchError("source URL must not target localhost");
  }
  if (isLoopbackOrPrivateIPv4(hostname) || isLoopbackOrPrivateIPv6(hostname)) {
    throw new SourceFetchError("source URL must not target a private/link-local address");
  }
  if (config.internalSourceAllowedHosts.length === 0 || !config.internalSourceAllowedHosts.includes(url.hostname)) {
    throw new SourceFetchError("source URL host is not on the configured allowlist");
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new SourceFetchError(`source exceeds ${maxBytes} byte limit`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceFetchError(`source exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface FetchedSource {
  /** Absolute local path to the downloaded, validated temp file. Caller must delete via deleteTempSource once no longer needed. */
  tempPath: string;
}

/**
 * Downloads, bounds, and validates a MEKKY-issued signed source URL into a
 * safe local temp file. Never follows a redirect (redirect: "manual" and any
 * redirect response is treated as a failure) — a signed download URL has no
 * legitimate reason to redirect, and this removes the entire
 * unapproved-redirect-origin class of bug outright.
 */
export async function fetchSource(
  signedUrl: string,
  expectedMimeType: string,
  maxBytes: number,
): Promise<FetchedSource> {
  const url = assertSafeSourceUrl(signedUrl);
  if (!ALLOWED_MIME_TYPES.has(expectedMimeType)) {
    throw new SourceFetchError(`unsupported expected mime type: ${expectedMimeType}`);
  }
  const boundedMaxBytes = Math.min(maxBytes, config.internalSourceMaxBytes);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.internalSourceFetchTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", signal: controller.signal });
  } catch (error) {
    throw new SourceFetchError(error instanceof Error ? error.message : "network error");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new SourceFetchError("source URL returned a redirect, which is never followed");
  }
  if (!response.ok) {
    throw new SourceFetchError(`source download failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType && contentType !== expectedMimeType) {
    throw new SourceFetchError(`source content-type ${contentType} did not match expected ${expectedMimeType}`);
  }

  const bytes = await readBoundedBody(response, boundedMaxBytes);

  // Real image decode — catches a mislabeled/corrupt/polyglot file that a
  // Content-Type header alone would miss.
  let decodedFormat: string | undefined;
  try {
    const metadata = await sharp(bytes).metadata();
    decodedFormat = metadata.format;
  } catch {
    throw new SourceFetchError("downloaded source is not a valid, decodable image");
  }
  const expectedFormat = expectedMimeType.split("/")[1] === "jpeg" ? "jpeg" : expectedMimeType.split("/")[1];
  if (decodedFormat !== expectedFormat) {
    throw new SourceFetchError(`decoded image format ${decodedFormat ?? "unknown"} did not match expected ${expectedMimeType}`);
  }

  await mkdir(PRODUCT_TMP_DIR, { recursive: true });
  const ext = EXT_BY_MIME[expectedMimeType] ?? "bin";
  const tempPath = resolveProductTmpFile(`${randomUUID()}.${ext}`);
  const handle = await open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { tempPath };
}

export async function deleteTempSource(tempPath: string): Promise<void> {
  await unlink(tempPath).catch(() => undefined);
}
