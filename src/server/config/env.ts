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

export const config = {
  port: Number(process.env.CHUKU_PORT ?? 4317),
  host: "127.0.0.1" as const, // never 0.0.0.0 — spec section 2
  lightxApiKey: process.env.LIGHTX_API_KEY?.trim() || null,
  generationHardCap: 15,
  automaticRetryLimit: 1,
};

export function hasLightXCredential(): boolean {
  return Boolean(config.lightxApiKey);
}
