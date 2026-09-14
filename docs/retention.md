# Chuku AI Lab — Product Retention (Provisional Engineering Defaults)

**`REQUIRES_PRODUCT_PRIVACY_APPROVAL`.** Everything below is an engineering
implementation of the provisional figures already recommended in
`docs/privacy.md` — it is not itself a product privacy policy decision.
Whoever owns MEKKY's privacy/legal decisions must review and approve these
figures (or replace them) before this governs any real customer data.

## What is retained, and for how long

| Asset | Config | Default | Governs |
| --- | --- | --- | --- |
| Session (source portrait selection) | `CHUKU_SOURCE_RETENTION_HOURS` | `24` | `ChukuSession.expiresAt` — how long a session stays `"active"` (able to accept new generations). |
| Generated result file | `CHUKU_RESULT_RETENTION_HOURS` | `72` | `ProductGeneration.expiresAt` — set only once a generation completes; how long its downloaded result file survives on disk. |

Both are read once at process startup (`src/server/config/env.ts`) and
must be positive integers or the built-in default is used.

## Why there is no per-session source *file* to delete yet

This phase reuses the Lab's 3 fixed, shared synthetic portraits
(`test-images/input/portrait-{a,b,c}.png`) as `sourcePortraitId` rather than
accepting a real per-session upload (see `docs/integration-contract.md`
"What this phase does not add"). Those files are shared benchmark assets,
not owned by any one session, and must never be deleted by product
cleanup. So today, `CHUKU_SOURCE_RETENTION_HOURS` governs only the
session's own active/submission lifetime (`sessions.status` transitions
`active` → `expired`) — there is no source *file* deletion step. Once a
real per-session upload exists, that upload's file would need its own
deletion step here, following the same storage-root-scoped pattern used
for results below.

## Retention sweep (`runRetentionCleanup`)

`src/server/services/retention-service.ts`, triggered via
`POST /maintenance/cleanup` (internal-only, see
`docs/integration-contract.md`):

1. **Expired results**: for every `completed` generation whose
   `expires_at` has passed, delete its result file and transition the
   generation to `status: "expired"`, `safeErrorCode: "RESULT_EXPIRED"`,
   `result_path: null`. A subsequent `GET /generations/:id` for that
   record correctly reports `"expired"` with no `resultUrl`, rather than a
   dangling reference to a deleted file.
2. **Expired sessions**: for every `active` session whose `expires_at` has
   passed, transition it to `status: "expired"` (no new generations
   accepted; existing generations/history remain readable until their own
   expiry).

## Idempotency

Both steps are pure status-transition-then-filter operations: once a
generation is `"expired"` it no longer matches
`generations-repo.listExpiredResults`'s `status = 'completed'` filter, and
once a session is `"expired"` it no longer matches
`sessions-repo.listExpiredActiveSessions`'s `status = 'active'` filter.
Running the sweep twice in a row is safe — the second run deletes/marks
nothing new (`tests/retention-service.test.ts`, "is idempotent").

## Favorite consistency on expiry

If the session's `favoriteGenerationId` points at a generation whose
result has since expired and been deleted, the sweep deliberately **does
not** clear that pointer. It still identifies *which* generation was
favorited; the generation's own `status: "expired"` /
`safeErrorCode: "RESULT_EXPIRED"` / `resultUrl: null` correctly reflect
that the asset itself is gone. This avoids silently losing the record of
what a customer chose while still being honest that the file is no longer
available (`tests/retention-service.test.ts`, "keeps the favorite pointer
in place").

## Storage-root separation and path safety

Product cleanup only ever operates under `PRODUCT_RESULTS_DIR`
(`data/results/`, `src/server/security/paths.ts`) — structurally distinct
from the Lab/benchmark roots (`TEST_IMAGES_INPUT_DIR`,
`TEST_IMAGES_RESULTS_DIR`, `CONTACT_SHEETS_DIR`), which product code never
imports a delete path for. Every delete goes through
`assertRealPathWithinDir()` immediately before the `rm` call — a
symlink-dereferencing check on top of the fact that `result_path` is
always a path this same service wrote in the first place
(`product-generation-service.ts`'s `downloadProductResult`), never raw
client input. See `tests/paths.test.ts` ("assertRealPathWithinDir") for
the symlink-escape test and `docs/architecture.md` "Storage roots" for the
full picture.

## What this is not

- Not a deletion-on-request flow for a customer ("delete my data now") —
  `docs/privacy.md` "Deletion" describes that as future, unbuilt product
  work.
- Not a scheduled/cron sweep — `POST /maintenance/cleanup` must be invoked
  externally; this phase does not add a scheduler.
- Not confirmation that LightX itself deletes anything on their
  infrastructure — see `docs/privacy.md` "Provider data handling."
