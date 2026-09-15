import { randomUUID } from "node:crypto";
import type { CreateGenerationInput, GenerationJob, GenerationStatus, HairstyleProvider } from "./hairstyle-provider.ts";

// Deterministic, network-free stand-in for LightXHairstyleProvider — selected
// only via CHUKU_PROVIDER_MODE=fake (config/env.ts), never a silent fallback
// from "lightx". Exists so a deployed Chuku service can exercise the full
// internal-create -> provider -> processing -> completion -> local result
// file -> authenticated /internal/.../result path end-to-end without a
// LIGHTX_API_KEY or any outbound call to LightX. Deployment-hardening
// mission section 2.
//
// A tiny fixed 16x16 PNG, embedded as a constant rather than derived from
// the caller's source image: the real source temp file is deleted (see
// security/source-fetch.ts's deleteTempSource) by the caller immediately
// after createGeneration() returns, so a later getGeneration(jobId) call —
// possibly after a process restart, with no shared in-memory state — could
// never re-read it. A fixed constant keeps the provider fully stateless and
// jobId-independent, which is what makes it restart/reconciliation-safe.
const FAKE_RESULT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVR4nGOoqDhBEmIY1VAxqqFiuGoAAJp/uBD53yWYAAAAAElFTkSuQmCC";

/** A real, `fetch()`-able (Node's fetch resolves `data:` URLs with no network I/O) result — reused as-is by the existing downloadProductResult() path. */
export const FAKE_RESULT_DATA_URL = `data:image/png;base64,${FAKE_RESULT_PNG_BASE64}`;

export class FakeHairstyleProvider implements HairstyleProvider {
  async createGeneration(_input: CreateGenerationInput): Promise<GenerationJob> {
    return {
      provider: "fake",
      externalJobId: `fake-${randomUUID()}`,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
  }

  async getGeneration(_jobId: string): Promise<GenerationStatus> {
    // Always immediately "completed" — deterministic, jobId-independent, no
    // delay to simulate: there is no real provider latency to emulate here.
    return {
      provider: "fake",
      externalJobId: _jobId,
      status: "completed",
      resultUrl: FAKE_RESULT_DATA_URL,
      failureCategory: null,
      failureMessage: null,
    };
  }

  async pollUntilTerminal(jobId: string): Promise<GenerationStatus> {
    return this.getGeneration(jobId);
  }
}
