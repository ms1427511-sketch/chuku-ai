# Chuku AI Lab — Current State

This document is the authoritative, evidence-based snapshot of where Chuku
AI Lab actually is. It is updated whenever reconciliation between code, git
history, and benchmark evidence reveals drift — not on a schedule. See
`README.md` for setup/usage and `docs/architecture.md`, `docs/lightx.md`,
`docs/benchmark.md`, `docs/privacy.md` for the detail behind each area
summarized here.

## What Chuku is

An isolated R&D benchmark console (not the MEKKY product) for evaluating
AI hairstyle generation via LightX: pick 1 of 3 fixed synthetic test
portraits, try any of 15 catalog hairstyles, rework/retry without losing
prior results, compare generations side by side, manually score results,
flag failures, and build a labeled contact sheet — all before any MEKKY
integration decision.

## Current architecture

Browser (React/Vite) → local Express server (`127.0.0.1` only) →
`HairstyleProvider` interface → `LightXHairstyleProvider`. The browser
never talks to LightX directly and never receives `LIGHTX_API_KEY`
(enforced by `tests/no-secret-in-client.test.ts` and
`scripts/check-no-secret-leak.ts` against the built bundle, not just by
convention). Full detail: `docs/architecture.md`.

## Current provider

LightX v2 (`api.lightxeditor.com/external/api/v2`) — upload URL → PUT
bytes → create hairstyle job → bounded poll (20 attempts × 3s ≈ 60s
ceiling) → download result to local disk immediately (provider URLs are
never treated as durable storage). Documented error codes are mapped to
local `GenerationFailureCategory` values. Full detail: `docs/lightx.md`.

## What has been tested

- **Automated**: 81 vitest tests across cost guard, generation service
  (automatic-retry policy, favorite semantics), hairstyle catalog, image
  validation, the LightX provider adapter, path-traversal/symlink-escape
  defense, secret sanitization, a build-bundle secret-leak scan, and — as of
  the Core Productization phase — the SQLite repos (idempotency, per-session
  limits, expiry queries), session service, product generation service
  (async creation, idempotent replay, restart-recovery reconciliation, safe
  error mapping), and the retention sweep (expiry deletion, non-expiry
  protection, cleanup idempotency, favorite consistency). All passing;
  typecheck, lint, and build also clean as of this phase.
- **Live provider (Stage A)**: one real benchmark run against LightX,
  3 portraits × 5 styles = 15 generations, **all 15 completed
  successfully** (technical success — see "Technical vs. visual review"
  below). Evidence: `benchmark/results/generations.json`,
  `test-images/results/**`, `test-images/contact-sheets/lightx-stage-a.png`.
  This evidence is intentionally local-only (gitignored) — only `.gitkeep`
  placeholders are committed, per `.gitignore`'s "generated benchmark
  artifacts, local-only" policy.

## Technical vs. visual review vs. approval — kept separate on purpose

Four distinct statuses, deliberately never collapsed into one another:

- **TECHNICAL STAGE A: COMPLETE** — all 15 Stage A calls (3 portraits × 5
  styles) returned a completed status with a downloaded result image. This
  says nothing about whether the hair actually looks right or the person's
  identity was preserved.
- **NUMERIC MANUAL SCORING: NOT_RECORDED** — every `ManualScore` in
  `benchmark/results/generations.json` is still `null` (`UNSCORED`) and
  every `flags` array is still empty. No numeric score has ever been
  entered into the Lab UI for any of the 15 results, and none is fabricated
  here or anywhere in this repository.
- **EXTERNAL QUALITATIVE HUMAN REVIEW: COMPLETED** — a human has looked at
  the Stage A contact sheet/results outside of this repository (outside the
  Lab's own scoring UI/`ManualScore` mechanism) and formed a qualitative
  judgment sufficient to proceed with the Core Productization phase below.
  That judgment is not, and cannot be, represented as a number in
  `generations.json` — this line records only that the review happened, not
  a score.
- **Provider approval for MEKKY**: not decided. Deciding LightX is
  acceptable for real customer photos in the actual MEKKY product is a
  separate, explicit human/product decision, still pending, independent of
  the qualitative review above.

## LightX status

**PILOT CANDIDATE / NOT FULLY DIVERSITY-VALIDATED.** Technically working
(15/15 Stage A completions) and qualitatively reviewed externally (see
above), but only exercised against 3 fixed synthetic portraits and 5 of the
15 catalog styles — not a validated result across a representative range of
skin tones, hair textures, ages, or genders. Treat as a pilot-ready
provider for further, broader testing — not as production-approved.

## Stage B

**SKIPPED_BY_PRODUCT_DECISION.** No second benchmark matrix has been run
and none is planned as part of this phase — the product decision was to
move to Core Productization (persistence/sessions/retention/API contract)
on the strength of Stage A + the external qualitative review, rather than
spend further LightX budget on a second matrix run.

## What is complete

- Project foundation, tooling, and quality gates (typecheck/lint/test/build
  all green).
- LightX provider adapter: upload, job creation, polling, error mapping,
  result download.
- Provider abstraction (`HairstyleProvider` interface) — nothing above it
  depends on LightX-specific shapes.
- 15-entry hairstyle catalog; Stage A benchmark subset (5 of 15) kept
  in sync with the catalog by referencing the same ids, not a duplicate
  list.
- Generation lifecycle: create → poll → complete/fail, with one bounded
  automatic retry for transient failures only (never for a bad-but-
  completed visual result — that is always a human "Rework" decision).
- History: every attempt is an immutable, appended `GenerationRecord` —
  nothing overwritten in place.
- Rework / regenerate / try-a-different-style, all via the same
  `createGeneration` path (no bypass of the cost guard or validation).
- **Favorite** — now persisted server-side (`GenerationRecord.favorite`,
  `PATCH /generations/:id/favorite`), not just in-memory client UI state.
  At most one favorite per (source, hairstyleId); choosing a new one
  un-favorites the prior one for that pair. Previously this lived only in
  a client-side `useState` map and was lost on reload — fixed as part of
  this reconciliation.
- Cost guard: server-side 15-generation hard cap and 1-automatic-retry
  limit, independent of the UI.
- Secret isolation: `LIGHTX_API_KEY` is server-only, stripped from
  anything persisted or logged, verified absent from the built client
  bundle by an automated post-build check.
- Path/image validation: extension/size checks, path-traversal defense on
  every filesystem access derived from a request.
- Local UI: portrait/hairstyle pickers, result view, rework, manual
  scoring panel, failure flags, history list — functional benchmark
  console, not a production MEKKY UX. Unchanged by the Core Productization
  phase — it continues to exercise the Lab's own `/generations` path, not
  the new product session/generation path.

### Core Productization phase (this document's latest update)

- **Persistence**: SQLite (`node:sqlite`, `data/chuku.db`) for
  sessions/generations — durable across restarts, race-free by
  construction (synchronous check-then-insert). See `docs/architecture.md`
  "Persistence."
- **Session + generation model**: `ChukuSession` / `ProductGeneration`,
  distinct from and never overwriting the Lab's `GenerationRecord`/
  `benchmark/results/generations.json`.
- **Idempotency**: client-supplied `operationId`, enforced by a SQL unique
  constraint — a replayed request never double-submits to LightX.
- **Two independent generation limits**: a persistent, per-session
  `CHUKU_MAX_GENERATIONS_PER_SESSION` (default 5, hard-enforced), fully
  separate from the pre-existing in-memory Lab/benchmark hard cap (15).
- **Restart recovery**: at most one free provider status check per
  `"processing"` record left by a prior process — never a second paid
  call.
- **Retention**: configurable source/result retention hours, an idempotent
  cleanup sweep, storage-root separation, and symlink-escape-safe deletion
  — see `docs/retention.md`. Explicitly `REQUIRES_PRODUCT_PRIVACY_APPROVAL`.
- **Stable API contract + safe error model**: see
  `docs/integration-contract.md` and `docs/error-model.md`. No LightX
  field, raw provider error, or secret is ever exposed in a product
  response.
- **Async generation creation**: `POST /sessions/:id/generations` returns
  in a few seconds (job-creation latency only), not the full ~36–65s
  generation latency.
- **Zero new live LightX calls** were made to build or verify this phase
  — all provider interaction in tests is mocked; the one manual HTTP smoke
  test run against a live local server only exercised requests that fail
  validation before reaching the provider (unknown session, missing
  source, unknown style, maintenance cleanup) — see the git history for
  this phase's commits.

## What remains

- **Human visual review of Stage A** — the *numeric* `ManualScore` fields
  in `benchmark/results/generations.json` are still all `null`. An
  external qualitative review has happened (see "Technical vs. visual
  review" above) and was judged sufficient to proceed with productization,
  but no one has entered numeric scores into the Lab UI. Doing so remains
  optional future work, not a blocker.
- **Stage B**: `SKIPPED_BY_PRODUCT_DECISION` (see above) — not started, and
  not currently planned.
- **Real per-session file upload** — this phase still reuses the 3 fixed
  synthetic portraits as `sourcePortraitId`; no customer-photo upload
  endpoint exists yet (`docs/integration-contract.md` "What this phase
  does not add").
- **Auth/customer concept** — no `externalOwnerId` is read or written yet;
  the schema reserves the column, but there is no MEKKY/Supabase identity
  integration.
- **Scheduled retention** — `POST /maintenance/cleanup` must be triggered
  externally; no cron/scheduler is added by this phase.
- **Product privacy/legal approval** of the retention figures and overall
  data-handling approach — explicitly still `REQUIRES_PRODUCT_PRIVACY_APPROVAL`.

## Known limitations

- The **Lab/benchmark** cost guard (`cost-guard.ts`) remains an in-memory,
  single-process counter that resets on restart — an accepted, documented
  tradeoff for benchmark runs specifically (`docs/architecture.md` → "Cost
  guard"), unchanged by this phase. The **product** session generation
  limit is a separate, SQLite-backed counter that *does* survive a
  restart (`docs/integration-contract.md` "Generation limits").
- No automated visual/identity-preservation quality check exists or is
  planned in-Lab — LightX's own `5047 INVALID_HUMAN_PORTRAIT` covers
  face-presence validation; quality beyond that is a human review
  responsibility.
- LightX's hairstyle-endpoint credit cost is not published; per-generation
  dollar cost is `UNKNOWN` until observed from a real account dashboard
  (`docs/benchmark.md` → "Cost").
- `node:sqlite` is still an experimental Node API (logs an
  `ExperimentalWarning` on startup) — acceptable for this pilot phase given
  the project's `engines: node>=22.6.0` floor, but worth re-checking against
  Node's stability notes before any production commitment.

## Next integration boundary

This Lab does not talk to any MEKKY repository, Supabase project, staging,
or production environment, and does not intend to until a deliberate MEKKY
integration phase is explicitly scoped — including consent/disclosure UX,
real auth/customer identity, real photo upload, and the retention policy in
`docs/privacy.md`/`docs/retention.md`, all currently marked
`REQUIRES_PRODUCT_PRIVACY_APPROVAL`. **Do not integrate Chuku into MEKKY
yet** — this phase built a stable, standalone API contract *in preparation*
for that future scoping, not the integration itself.
