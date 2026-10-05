// Phase 4.1C: every provider prompt on the internal path carries the same
// identity/hair preservation constraints. They are unconditional -- face
// analysis runs on-device and nothing about the customer's hairline,
// density or beard ever reaches this service, so the safe constraints
// (never lower the hairline, never add density, never fill sparse areas)
// must apply to every customer, not only to those detected as receding.
// These are instructions to the provider, not guarantees: no provider
// promises to follow them, so the app keeps its illustration and hairline
// warnings next to every result.
export const PRESERVATION_CONSTRAINTS = [
  "Change only the haircut and fade; everything else stays as in the photo.",
  "Keep the same person: preserve identity, face shape, facial geometry and all facial features exactly.",
  "Keep the same skin tone and complexion; do not lighten, darken or retouch the skin.",
  "Keep the same head size, head shape and head proportions.",
  "Keep the existing hairline exactly where it is; do not lower, straighten or reshape it.",
  "Keep the existing hair density; do not add hair, do not thicken hair and do not fill thinning, receding or sparse areas.",
  "Keep any beard, moustache and facial hair unchanged.",
  "Only restyle and cut the hair that already exists.",
].join(" ");

export function buildProviderPrompt(stylePrompt: string): string {
  return `${stylePrompt.trim().replace(/[.\s]+$/, "")}. ${PRESERVATION_CONSTRAINTS}`;
}
