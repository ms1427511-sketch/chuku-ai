// Internal (MEKKY <-> Chuku) service-to-service DTOs — Phase 4.1B. Distinct
// from the public product DTOs in shared/types.ts: these are the shape of
// the /internal/* API, gated by internal-auth (server/security/internal-auth.ts)
// and never reachable from mobile. See docs/architecture.md.
//
// Deliberate deviation from the mission's illustrative example: the request
// never carries a provider prompt. Chuku resolves the real provider prompt
// itself from style.key via shared/hairstyles.ts — a client-supplied prompt
// string is never trusted or forwarded to the provider.

export interface InternalSourceRequest {
  /** Short-lived Supabase signed read URL, minted server-side by MEKKY. Never supplied by mobile. */
  signedUrl: string;
  expectedMimeType: string;
  maxBytes: number;
  /**
   * MEKKY's stable, server-derived storage object key/path for this source
   * image (or an equivalent stable identifier/hash) — distinct from
   * signedUrl, which expires/changes on every mint. Used as part of the
   * material-request fingerprint so a retried request with a freshly
   * re-signed URL is still recognized as the same request. See mission
   * section 6.
   */
  sourceObjectKey: string;
}

export interface InternalCreateGenerationRequest {
  /** Opaque MEKKY-supplied identifier. Carries no authorization weight inside Chuku — see security/internal-auth.ts. */
  externalOwnerId: string;
  /** Opaque MEKKY-supplied identifier. */
  externalSessionId: string;
  /** Opaque MEKKY-supplied identifier. The durable cross-service dispatch identity — globally unique. */
  externalGenerationId: string;
  /** Correlation/replay metadata only — NOT the idempotency key. See mission section 6. */
  operationId: string;
  style: { key: string };
  source: InternalSourceRequest;
}

export type InternalGenerationStatus = "accepted" | "processing" | "completed" | "failed";

/**
 * Stable, safe error codes for the internal API. Never a raw provider
 * payload, LightX status code/message, hostname, or internal auth state.
 * See mission section 14.
 */
export type InternalSafeErrorCode =
  | "CHUKU_AI_UNAVAILABLE"
  | "CHUKU_GENERATION_FAILED"
  | "CHUKU_GENERATION_TIMEOUT"
  | "CHUKU_SOURCE_UNAVAILABLE"
  | "CHUKU_RESULT_INVALID";

/**
 * Normalized-only response shape. Must never include a LightX job id,
 * provider name, raw provider status, provider URL, provider prompt/debug
 * payload, provider error body, API key, or cost information.
 */
export interface InternalGenerationResponse {
  externalGenerationId: string;
  status: InternalGenerationStatus;
  safeErrorCode: InternalSafeErrorCode | null;
  resultAvailable: boolean;
}
