import type { GenerationFailureCategory } from "../../shared/types.ts";
import type { InternalSafeErrorCode } from "../../shared/internal-types.ts";

// Mirrors services/safe-error-mapping.ts's separation-of-taxonomies
// rationale: the internal-facing code set is allowed to diverge from the
// public product one. Never expose the raw category, LightX status code, or
// message text — see mission section 14.
const UNAVAILABLE_CATEGORIES: ReadonlySet<GenerationFailureCategory> = new Set([
  "network_error",
  "provider_auth",
  "provider_credits_exhausted",
  "unknown",
]);

/**
 * Maps a provider-shaped failure category (from a completed provider job
 * attempt) to one of the stable internal safe-error codes. Source-fetch
 * failures (before any provider contact) and local-result-validation
 * failures use their own dedicated codes directly — see
 * services/internal-generation-service.ts.
 */
export function mapFailureCategoryToInternalSafeErrorCode(category: GenerationFailureCategory): InternalSafeErrorCode {
  if (category === "provider_timeout") return "CHUKU_GENERATION_TIMEOUT";
  if (UNAVAILABLE_CATEGORIES.has(category)) return "CHUKU_AI_UNAVAILABLE";
  return "CHUKU_GENERATION_FAILED";
}

const INTERNAL_SAFE_ERROR_CODES: ReadonlySet<string> = new Set<InternalSafeErrorCode>([
  "CHUKU_AI_UNAVAILABLE",
  "CHUKU_GENERATION_FAILED",
  "CHUKU_GENERATION_TIMEOUT",
  "CHUKU_SOURCE_UNAVAILABLE",
  "CHUKU_RESULT_INVALID",
]);

// Lab-facing safe-error codes (services/safe-error-mapping.ts) that can end
// up on a shared GenerationRow when a still-processing internal generation
// is reconciled via the reused product-generation-service.ts poll path —
// that function writes the *public Lab* code set, not this internal one.
const LAB_CODE_TO_INTERNAL: Readonly<Record<string, InternalSafeErrorCode>> = {
  GENERATION_FAILED: "CHUKU_GENERATION_FAILED",
  PROVIDER_TEMPORARY_FAILURE: "CHUKU_AI_UNAVAILABLE",
};

/**
 * Normalizes any safe_error_code found on a GenerationRow to the internal
 * contract's minimum code set before it is ever placed on an
 * InternalGenerationResponse — a persisted Lab-shaped code must never leak
 * through unchanged. See mission sections 3 and 14.
 */
export function normalizeSafeErrorCodeForInternal(code: string | null): InternalSafeErrorCode | null {
  if (code === null) return null;
  if (INTERNAL_SAFE_ERROR_CODES.has(code)) return code as InternalSafeErrorCode;
  return LAB_CODE_TO_INTERNAL[code] ?? "CHUKU_GENERATION_FAILED";
}
