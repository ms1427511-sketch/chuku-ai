// Shared types between client and server. No secrets, no provider-specific
// request/response shapes here — those stay inside the provider adapter.

export type HairstyleCategory = "short" | "fade" | "crop" | "classic" | "curly";

export interface HairstyleCatalogEntry {
  id: string;
  name: string;
  category: HairstyleCategory;
  /** Sent to the provider as the generation instruction. Never shown to the customer. */
  prompt: string;
  enabled: boolean;
  sortOrder: number;
}

export type PortraitId = "portrait-a" | "portrait-b" | "portrait-c";

export type GenerationStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type GenerationFailureCategory =
  | "invalid_portrait" // provider could not find a human face (LightX 5047)
  | "unsafe_prompt" // provider rejected the prompt (LightX 5041)
  | "provider_credits_exhausted" // LightX 5040
  | "provider_auth" // 403 - bad/missing key
  | "provider_bad_request" // 400
  | "provider_timeout" // polling exceeded bound without a terminal status
  | "provider_error" // generic 5046 / unexpected provider failure
  | "network_error"
  | "generation_limit_reached" // our own server-side cost guard
  | "unknown";

export interface GenerationRecord {
  id: string;
  provider: "lightx";
  providerJobId: string | null;
  source: PortraitId;
  hairstyleId: string;
  /** 1-based index of this attempt for this (source, hairstyle) pair. Never reused. */
  generationIndex: number;
  status: GenerationStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  /** Path relative to test-images/results/, set only once status is completed. */
  resultPath: string | null;
  failureCategory: GenerationFailureCategory | null;
  failureMessage: string | null;
  retryOf: string | null;
  score: ManualScore | null;
  flags: FailureFlag[];
  /** At most one favorite per (source, hairstyleId) — see generation-service.setFavorite. */
  favorite: boolean;
}

export interface ManualScore {
  identityPreservation: number | null;
  haircutAccuracy: number | null;
  realism: number | null;
  hairlineQuality: number | null;
  fadeQuality: number | null; // null also doubles as N/A
  beardPreservation: number | null; // null also doubles as N/A
  artifactControl: number | null;
  barberUsability: number | null;
}

export const UNSCORED: ManualScore = {
  identityPreservation: null,
  haircutAccuracy: null,
  realism: null,
  hairlineQuality: null,
  fadeQuality: null,
  beardPreservation: null,
  artifactControl: null,
  barberUsability: null,
};

export type FailureFlag = "IDENTITY_FAILURE" | "HAIRCUT_FAILURE";

export interface CreateGenerationRequest {
  source: PortraitId;
  hairstyleId: string;
  /** When set, this is a rework/retry of an existing generation (new record, not an overwrite). */
  retryOf?: string;
}

export interface BenchmarkTotals {
  requested: number;
  succeeded: number;
  failed: number;
  retries: number;
  hardCap: number;
  remaining: number;
}
