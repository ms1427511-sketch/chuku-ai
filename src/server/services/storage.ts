import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GenerationRecord } from "../../shared/types.ts";
import { PROJECT_ROOT } from "../config/env.ts";
import { resolveResultDir } from "../security/paths.ts";
import { sanitizeForLocalStorage } from "../security/sanitize.ts";

const HISTORY_FILE = path.join(PROJECT_ROOT, "benchmark", "results", "generations.json");

async function ensureHistoryFile(): Promise<void> {
  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  if (!existsSync(HISTORY_FILE)) {
    await writeFile(HISTORY_FILE, "[]\n", "utf8");
  }
}

export async function loadHistory(): Promise<GenerationRecord[]> {
  await ensureHistoryFile();
  const raw = await readFile(HISTORY_FILE, "utf8");
  return JSON.parse(raw) as GenerationRecord[];
}

async function saveHistory(records: GenerationRecord[]): Promise<void> {
  await ensureHistoryFile();
  const sanitized = records.map((r) => sanitizeForLocalStorage(r as unknown as Record<string, unknown>));
  await writeFile(HISTORY_FILE, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
}

export async function nextGenerationIndex(source: string, hairstyleId: string): Promise<number> {
  const history = await loadHistory();
  const priorCount = history.filter((r) => r.source === source && r.hairstyleId === hairstyleId).length;
  return priorCount + 1;
}

export async function appendRecord(record: GenerationRecord): Promise<void> {
  const history = await loadHistory();
  history.push(record);
  await saveHistory(history);
}

export async function updateRecord(id: string, patch: Partial<GenerationRecord>): Promise<GenerationRecord> {
  const history = await loadHistory();
  const index = history.findIndex((r) => r.id === id);
  if (index === -1) throw new Error(`no generation record with id ${id}`);
  const current = history[index]!;
  const updated: GenerationRecord = { ...current, ...patch };
  history[index] = updated;
  await saveHistory(history);
  return updated;
}

export async function getRecord(id: string): Promise<GenerationRecord | undefined> {
  const history = await loadHistory();
  return history.find((r) => r.id === id);
}

export function newRecordId(): string {
  return randomUUID();
}

/** Downloads a provider result URL to local disk immediately — never treated as permanent remote storage (spec section 16). */
export async function downloadResult(resultUrl: string, source: string, hairstyleId: string, generationIndex: number): Promise<string> {
  const dir = resolveResultDir(source, hairstyleId);
  await mkdir(dir, { recursive: true });
  const response = await fetch(resultUrl);
  if (!response.ok) throw new Error(`failed to download result image: HTTP ${response.status}`);
  const ext = resultUrl.toLowerCase().includes(".png") ? "png" : "jpg";
  const fileName = `generation-${generationIndex}.${ext}`;
  const filePath = path.join(dir, fileName);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(filePath, bytes);
  // Stored/returned as a path relative to test-images/results/, never an absolute filesystem path.
  return path.join(source, hairstyleId, fileName);
}
