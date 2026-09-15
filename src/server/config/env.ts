// Server-only config. This module must never be imported from src/client.
// (Enforced structurally by the client/server directory boundary + the
// "browser bundle contains no LIGHTX_API_KEY" build check in
// scripts/check-no-secret-leak.ts.)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");

function loadDotEnvLocal(): void {
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadDotEnvLocal();

export const PROJECT_ROOT = ROOT;

function positiveInt(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Safe default preserved unconditionally: an explicit env override can widen
// the bind host, but this module itself never *defaults* to 0.0.0.0 — see
// Phase 4.1B mission section 5.
const SAFE_DEFAULT_HOST = "127.0.0.1";

function resolveHost(envValue: string | undefined): string {
  const trimmed = envValue?.trim();
  return trimmed || SAFE_DEFAULT_HOST;
}

function csv(envValue: string | undefined): string[] {
  return (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.CHUKU_PORT ?? 4317),
  host: resolveHost(process.env.CHUKU_HOST),
  lightxApiKey: process.env.LIGHTX_API_KEY?.trim() || null,
  // Lab/benchmark-only cost guard (src/server/services/cost-guard.ts) —
  // deliberately separate from the product session guard below, so
  // Stage A/B benchmark runs never share a limit with real product usage.
  generationHardCap: 15,
  automaticRetryLimit: 1,

  // Product session limits (src/server/services/product-usage-guard.ts).
  // Safe pilot defaults, not billing rules — see docs/integration-contract.md.
  includedGenerationsPerSession: positiveInt(process.env.CHUKU_INCLUDED_GENERATIONS, 3),
  maxGenerationsPerSession: positiveInt(process.env.CHUKU_MAX_GENERATIONS_PER_SESSION, 5),

  // Retention — provisional engineering defaults, REQUIRES_PRODUCT_PRIVACY_APPROVAL
  // before being treated as policy. See docs/retention.md.
  sourceRetentionHours: positiveInt(process.env.CHUKU_SOURCE_RETENTION_HOURS, 24),
  resultRetentionHours: positiveInt(process.env.CHUKU_RESULT_RETENTION_HOURS, 72),

  // --- Internal (MEKKY-only) integration surface — Phase 4.1B ---------------
  // Shared secret gating every /internal/* route. Never committed, never
  // logged, never sent to a browser. See security/internal-auth.ts.
  internalAuthSecret: process.env.CHUKU_INTERNAL_AUTH_SECRET?.trim() || null,
  // Host allowlist for the MEKKY-issued Supabase signed source URL. Chuku
  // will refuse to fetch a source from any origin not in this list — see
  // security/source-fetch.ts.
  internalSourceAllowedHosts: csv(process.env.CHUKU_INTERNAL_SOURCE_ALLOWED_HOSTS),
  internalSourceFetchTimeoutMs: positiveInt(process.env.CHUKU_INTERNAL_SOURCE_FETCH_TIMEOUT_MS, 10_000),
  internalSourceMaxBytes: positiveInt(process.env.CHUKU_INTERNAL_SOURCE_MAX_BYTES, 8 * 1024 * 1024),
};

export function hasLightXCredential(): boolean {
  return Boolean(config.lightxApiKey);
}

const MIN_INTERNAL_AUTH_SECRET_LENGTH = 32;

export function hasInternalAuthSecret(): boolean {
  return Boolean(config.internalAuthSecret && config.internalAuthSecret.length >= MIN_INTERNAL_AUTH_SECRET_LENGTH);
}

export { MIN_INTERNAL_AUTH_SECRET_LENGTH };
