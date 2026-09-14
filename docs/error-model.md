# Chuku AI Lab — Product Error Model

Every product-layer error response is `{ error: <code>, message: <safe, human-readable string> }`.
A raw provider (LightX) response body, HTTP status text, stack trace, or
secret-shaped string never reaches an error response — see
`src/server/routes/http-errors.ts` (the single choke point every product
route funnels errors through) and `src/server/security/sanitize.ts`.

This is a distinct, smaller set of stable codes from the Lab/benchmark's
own error codes (`UNKNOWN_HAIRSTYLE`, `UNKNOWN_PORTRAIT`,
`MISSING_PROVIDER_CREDENTIAL`, etc. — still used by the existing
`/generations` Lab routes, unchanged). Both sets are `ChukuError` subclasses
(`src/shared/errors.ts`) that carry a `code` string.

## Codes

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `SESSION_NOT_FOUND` | 404 | No session exists with the given id. |
| `SOURCE_REQUIRED` | 400 | A generation was requested before the session's source portrait was set. |
| `INVALID_SOURCE` | 400 | `sourcePortraitId` is not one of the 3 recognized portrait ids. |
| `UNKNOWN_STYLE` | 404 | `styleId` does not match an enabled catalog entry. |
| `GENERATION_NOT_FOUND` | 404 | No generation exists with the given id. Not in the phase-spec minimum list; added because `GET /generations/:id` needs a distinct 404 from `SESSION_NOT_FOUND`. |
| `GENERATION_LIMIT_REACHED` | 429 | The session already has `CHUKU_MAX_GENERATIONS_PER_SESSION` generations. Shared with the pre-existing Lab hard-cap error — same code, two independent counters (see `docs/integration-contract.md` "Generation limits"). |
| `GENERATION_IN_PROGRESS` | 400 | An operation that requires a completed generation (e.g. favoriting) was attempted while it is still queued/processing. |
| `GENERATION_FAILED` | — (a status value, not a thrown error) | Terminal, non-transient provider failure — set as `ProductGeneration.safeErrorCode`, never thrown to an HTTP caller directly. Covers e.g. no-face-detected, unsafe-prompt rejection, provider auth/credit issues — see mapping below. |
| `PROVIDER_TEMPORARY_FAILURE` | 503 (when thrown) / a status value otherwise | A transient provider/network issue (timeout, network error, generic provider 5xx) — the same condition, worth a caller retry. Also used by restart-recovery for a generation whose true outcome could not be re-confirmed after a restart. |
| `RESULT_EXPIRED` | 410 | The generation's result file has passed its retention window and was deleted by the retention sweep (`docs/retention.md`). |
| `INVALID_OPERATION` | 400 | A catch-all for a request that is structurally invalid for the current state — a missing `operationId`, a generation request against a non-`active` session, an invalid favorite toggle, etc. |

## Failure-category → safe-error-code mapping

The LightX provider adapter (`src/server/providers/lightx-provider.ts`)
categorizes failures into an internal `GenerationFailureCategory`
(`invalid_portrait`, `unsafe_prompt`, `provider_credits_exhausted`,
`provider_auth`, `provider_bad_request`, `provider_timeout`,
`provider_error`, `network_error`, `unknown`). The product layer
(`src/server/services/safe-error-mapping.ts`) collapses that internal
taxonomy down to exactly two public outcomes — the internal category
itself, the LightX status code, and any raw message text are never
exposed:

- `network_error`, `provider_timeout`, `provider_error` → `PROVIDER_TEMPORARY_FAILURE`
  (a hiccup that might succeed if the client tries again later).
- Everything else (`invalid_portrait`, `unsafe_prompt`,
  `provider_credits_exhausted`, `provider_auth`, `provider_bad_request`,
  `unknown`) → `GENERATION_FAILED` (a terminal outcome for this attempt —
  the client should not blindly retry the same operationId and expect a
  different result; a genuinely new attempt needs a new `operationId`).

## What never appears in an error response

- The raw LightX response body or `statusCode`.
- `LIGHTX_API_KEY` or any `x-api-key`/`authorization` header value
  (`security/sanitize.ts` strips these before a message is ever attached
  to a stored record or response).
- A Node.js stack trace.
- The internal `GenerationFailureCategory` string — only the mapped
  `ChukuSafeErrorCode` above.
