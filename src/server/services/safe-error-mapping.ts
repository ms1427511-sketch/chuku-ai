import type { ChukuSafeErrorCode, GenerationFailureCategory } from "../../shared/types.ts";

// Only these categories represent a transient provider/network hiccup that
// might succeed on its own if retried later by the caller — mirrors
// generation-service.ts's TRANSIENT_FAILURE_CATEGORIES, kept as a separate
// copy since the two failure taxonomies (Lab retry-worthy vs. product
// safe-error-code) are allowed to diverge over time.
const TRANSIENT_CATEGORIES: ReadonlySet<GenerationFailureCategory> = new Set([
  "network_error",
  "provider_timeout",
  "provider_error",
]);

/**
 * Maps an internal, provider-shaped failure category to one of the stable
 * public safe-error codes — never expose the raw category, LightX status
 * code, or message text to a client. See docs/error-model.md.
 */
export function mapFailureCategoryToSafeErrorCode(category: GenerationFailureCategory): ChukuSafeErrorCode {
  return TRANSIENT_CATEGORIES.has(category) ? "PROVIDER_TEMPORARY_FAILURE" : "GENERATION_FAILED";
}
