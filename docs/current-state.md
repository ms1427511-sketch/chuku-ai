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

- **Automated**: 39 vitest tests across cost guard, generation service
  (including the automatic-retry policy and, as of this reconciliation,
  favorite semantics), hairstyle catalog, image validation, the LightX
  provider adapter, path-traversal defense, secret sanitization, and a
  build-bundle secret-leak scan. All passing; typecheck, lint, and build
  also clean as of this reconciliation.
- **Live provider (Stage A)**: one real benchmark run against LightX,
  3 portraits × 5 styles = 15 generations, **all 15 completed
  successfully** (technical success — see "Technical vs. visual review"
  below). Evidence: `benchmark/results/generations.json`,
  `test-images/results/**`, `test-images/contact-sheets/lightx-stage-a.png`.
  This evidence is intentionally local-only (gitignored) — only `.gitkeep`
  placeholders are committed, per `.gitignore`'s "generated benchmark
  artifacts, local-only" policy.

## Technical vs. visual review vs. approval — kept separate on purpose

- **Technical generation success**: PASS — all 15 Stage A calls returned a
  completed status with a downloaded result image. This says nothing about
  whether the hair actually looks right or the person's identity was
  preserved.
- **Visual/human review**: not yet done. Every `ManualScore` in
  `benchmark/results/generations.json` is `null` (`UNSCORED`) and every
  `flags` array is empty — no `IDENTITY_FAILURE`/`HAIRCUT_FAILURE` has been
  recorded, because no human has reviewed the contact sheet yet. This is
  reported as `null`, not fabricated as a passing score.
- **Provider approval for MEKKY**: not decided. That is an explicit human
  decision after visual review, ahead of any Phase 4.1/integration work —
  not something this Lab or this document decides.

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
  console, not a production MEKKY UX.

## What remains

- **Human visual review of Stage A** — score the 15 existing results and
  record any `IDENTITY_FAILURE`/`HAIRCUT_FAILURE` flags via the Lab UI.
  Nothing new needs to be generated for this.
- **Stage B**: not started (see below).
- Any of the broader "Chuku Core Productization" themes not yet addressed
  in this reconciliation pass — persistent (non-in-memory) cost-guard
  state across restarts, retention/cleanup policy for local result files,
  and a formal integration contract for a future MEKKY connection — remain
  future work, to be picked up incrementally with evidence, not built
  speculatively ahead of need.

## Known limitations

- The cost guard is an in-memory, single-process counter — it resets on
  server restart. This is a documented, accepted tradeoff for this phase
  (`docs/architecture.md` → "Cost guard"), not a defect.
- No automated visual/identity-preservation quality check exists or is
  planned in-Lab — LightX's own `5047 INVALID_HUMAN_PORTRAIT` covers
  face-presence validation; quality beyond that is a human review
  responsibility.
- LightX's hairstyle-endpoint credit cost is not published; per-generation
  dollar cost is `UNKNOWN` until observed from a real account dashboard
  (`docs/benchmark.md` → "Cost").

## Next integration boundary

This Lab does not talk to any MEKKY repository, Supabase project, staging,
or production environment, and does not intend to until: (1) Stage A
visual review is complete and a human has decided LightX quality is
acceptable, and (2) a deliberate MEKKY integration phase is explicitly
scoped — including consent/disclosure UX and the retention policy in
`docs/privacy.md`, both currently marked `REQUIRES PRODUCT/PRIVACY
APPROVAL`.
