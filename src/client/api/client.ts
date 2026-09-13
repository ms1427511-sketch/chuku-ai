import type {
  BenchmarkTotals,
  CreateGenerationRequest,
  FailureFlag,
  GenerationRecord,
  HairstyleCatalogEntry,
  ManualScore,
} from "../../shared/types.ts";

// Every call in this module hits the local Chuku server (proxied at /api
// by Vite in dev, same-origin in a built bundle). This file must never
// contain a LightX URL, header, or key — the browser never talks to
// LightX directly (spec section 2).
const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message ?? `request failed: ${response.status}`);
  }
  return body as T;
}

export function fetchHairstyles(): Promise<{ hairstyles: HairstyleCatalogEntry[] }> {
  return request("/hairstyles");
}

export function fetchHistory(source?: string, hairstyleId?: string): Promise<{ generations: GenerationRecord[] }> {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (hairstyleId) params.set("hairstyleId", hairstyleId);
  const qs = params.toString();
  return request(`/generations${qs ? `?${qs}` : ""}`);
}

export function fetchTotals(): Promise<{ totals: BenchmarkTotals; lightxConfigured: boolean }> {
  return request("/generations/totals");
}

export function createGeneration(payload: CreateGenerationRequest): Promise<{ generation: GenerationRecord }> {
  return request("/generations", { method: "POST", body: JSON.stringify(payload) });
}

export function reworkGeneration(id: string): Promise<{ generation: GenerationRecord }> {
  return request(`/generations/${id}/rework`, { method: "POST" });
}

export function updateScore(id: string, score: ManualScore): Promise<{ generation: GenerationRecord }> {
  return request(`/generations/${id}/score`, { method: "PATCH", body: JSON.stringify(score) });
}

export function updateFlags(id: string, flags: FailureFlag[]): Promise<{ generation: GenerationRecord }> {
  return request(`/generations/${id}/flags`, { method: "PATCH", body: JSON.stringify({ flags }) });
}
