import type { GenerationFailureCategory } from "../../shared/types.ts";

export interface CreateGenerationInput {
  /** Absolute local path to the source portrait file. */
  sourceImagePath: string;
  /** Provider-facing instruction text (HairstyleCatalogEntry.prompt, not the display name). */
  prompt: string;
}

// "fake" is the deterministic, network-free provider (providers/fake-provider.ts,
// selected only via CHUKU_PROVIDER_MODE=fake — see config/env.ts). Never
// inferred, never a silent fallback from "lightx".
export type ProviderName = "lightx" | "fake";

export interface GenerationJob {
  provider: ProviderName;
  externalJobId: string;
  status: "queued" | "processing";
  createdAt: string;
}

export interface GenerationStatus {
  provider: ProviderName;
  externalJobId: string;
  status: "processing" | "completed" | "failed";
  /** Set only when status is "completed". A remote or data: URL — the caller downloads/decodes it, never persists the URL itself as storage. */
  resultUrl: string | null;
  failureCategory: GenerationFailureCategory | null;
  failureMessage: string | null;
}

/**
 * The rest of Chuku depends only on this interface, never on
 * LightX-specific request/response shapes — see docs/architecture.md
 * "Provider independence". Swapping providers means implementing this
 * interface again, not touching services/routes/UI.
 */
export interface HairstyleProvider {
  createGeneration(input: CreateGenerationInput): Promise<GenerationJob>;
  getGeneration(jobId: string): Promise<GenerationStatus>;
  /** Bounded poll loop to a terminal status. Never indefinite. */
  pollUntilTerminal(jobId: string): Promise<GenerationStatus>;
}
