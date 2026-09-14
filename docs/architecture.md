# Chuku AI Lab — Architecture

Chuku AI Lab is an isolated R&D benchmark project. It is **not** part of the
MEKKY product and does not modify any MEKKY repository, Supabase project,
staging, or production environment.

## Request flow

```
Browser (React + Vite, http://127.0.0.1:5173)
   │  fetch("/api/...")  — never a LightX URL, never the API key
   ▼
Chuku local server (Express, http://127.0.0.1:4317 — bound to loopback only)
   │  HairstyleProvider interface
   ▼
LightXHairstyleProvider (src/server/providers/lightx-provider.ts)
   │  x-api-key header, read from LIGHTX_API_KEY (server-only env var)
   ▼
LightX API (https://api.lightxeditor.com)
```

The browser **never** calls LightX directly and never receives the API key
in any response, bundle, or environment variable. See "Secret handling"
below for how this is enforced structurally, not just by convention.

## Directory boundary

```
src/
  client/     — React UI. Talks only to the local server via /api/*.
  server/     — Express server, LightX provider, services, security, config.
  shared/     — Types, hairstyle catalog, error classes. No secrets, no
                provider-specific request/response shapes.
```

`src/client/**` must never import anything from `src/server/**`. In
particular, `src/server/config/env.ts` (the only place `LIGHTX_API_KEY` is
read) is never imported by client code. This is checked two ways:

1. **Structurally** — the directory split makes it easy to review during
   any PR (`grep -r "server/config" src/client` should always be empty).
2. **Automatically** — `tests/no-secret-in-client.test.ts` scans every file
   under `src/client/` for the literal string `LIGHTX_API_KEY`, a
   `VITE_LIGHTX*` variable name, or a `server/config/env` import path, and
   fails the test suite if any is found. `scripts/check-no-secret-leak.ts`
   additionally scans the **built** client bundle (`dist/client/`) after
   `vite build`, so even a transitive/accidental leak through bundling
   would be caught before shipping.

## Server

- `src/server/index.ts` — Express bootstrap. Binds to `config.host`, which
  is hardcoded to the literal `"127.0.0.1"` (never `0.0.0.0`) — see
  `src/server/config/env.ts`. A centralized error-handling middleware
  sanitizes any unexpected error (via `security/sanitize.ts`) before it can
  reach an HTTP response, so a raw provider error body or stack trace can
  never leak to a client.
- `src/server/routes/` — `catalog.ts` (hairstyle list), `generations.ts`
  (create/rework/history/score/flags/favorite/totals), `images.ts` (serves
  local source portraits and downloaded results only — never proxies a
  remote LightX URL).
- `src/server/services/` — `generation-service.ts` (orchestration:
  validation, cost guard, provider call, retry policy, result download),
  `cost-guard.ts` (in-memory hard-cap/retry counter), `image-validation.ts`
  (MIME/size checks), `storage.ts` (local JSON history +
  `test-images/results/` file storage).
- `src/server/security/` — `paths.ts` (path-traversal defense via
  `resolveWithinDir`), `sanitize.ts` (strips secret-shaped fields/values
  before anything reaches a log, response, or local JSON file).
- `src/server/providers/` — `hairstyle-provider.ts` (the `HairstyleProvider`
  interface), `lightx-provider.ts` (the only implementation this phase).

## Provider independence

Every part of Chuku above the provider layer — routes, services, UI —
depends only on `HairstyleProvider`:

```ts
interface HairstyleProvider {
  createGeneration(input: CreateGenerationInput): Promise<GenerationJob>;
  getGeneration(jobId: string): Promise<GenerationStatus>;
}
```

`generation-service.ts` never imports LightX-specific types or response
shapes directly — only this interface and the plain `GenerationJob` /
`GenerationStatus` shapes it returns. Swapping to a different provider
(Perfect Corp, fal.ai, Runware/FLUX, AIHairstyles — none implemented this
phase) means writing a new class that implements `HairstyleProvider`, not
touching routes, services, or the UI.

## Secret handling — summary

- `LIGHTX_API_KEY` is read once, server-side, in `src/server/config/env.ts`,
  from `.env.local` (gitignored) or the process environment.
- It is attached only as the `x-api-key` header on direct LightX HTTP
  calls inside `lightx-provider.ts`.
- `security/sanitize.ts` is the single choke point that strips the literal
  key value and any `x-api-key`/`authorization`-shaped field from error
  messages before they reach a log line, an HTTP response, or a locally
  persisted generation record.
- It is never written to `benchmark/results/generations.json` (enforced by
  `sanitizeForLocalStorage` in `storage.ts`), never sent to the browser in
  any API response, and never present in the built client bundle (enforced
  by `scripts/check-no-secret-leak.ts`).

## Cost guard

`src/server/services/cost-guard.ts` is an in-memory, single-process
counter — not a database, per this phase's "no database required" scope.
It exists to protect the operator's own LightX spend, not as a security
boundary against an adversary, so a server restart resetting the counter is
an accepted, documented tradeoff. It independently enforces the 15-
generation Stage A hard cap and the 1-automatic-retry limit on the server
side, so a disabled UI button alone is never the only protection.

## Generation history / rework model

Every generation attempt — original or reworked/retried — is a new,
immutable `GenerationRecord` appended to
`benchmark/results/generations.json`. Nothing is ever overwritten in
place:

- A human "Rework" always creates a new record with `retryOf` pointing at
  the prior attempt.
- A single automatic retry (network/provider-timeout/provider-error only,
  never a bad-but-completed result) also creates a new record, not a
  mutation of the failed one.

This means one source portrait can be used for many hairstyle generations,
and every attempt for every style remains independently visible in history.

## Favorite

`GenerationRecord.favorite` is persisted server-side in the same
`benchmark/results/generations.json` history — not just client UI state, so
it survives a page reload or a fresh `fetchHistory()` call.
`generation-service.setFavorite()` enforces at most one favorite per
(source, hairstyleId): marking a new record favorite first un-favorites any
prior favorite for that same pair, so "Choose This Style" always replaces
rather than accumulates. Exposed via `PATCH /generations/:id/favorite`.

## Product vs. Lab/benchmark separation

The Core Productization phase added a second, entirely separate layer
alongside the Lab described above — additive, not a replacement. The Lab
(`storage.ts`, `benchmark/results/generations.json`, `/generations`,
`/hairstyles`, `cost-guard.ts`) is untouched and remains the benchmark
console. The product layer is new:

```
src/server/db/          — SQLite schema, connection, and repos (sessions, generations)
src/server/services/
  session-service.ts             — ChukuSession CRUD
  product-generation-service.ts  — idempotent create, async finalize, restart-recovery reconcile
  retention-service.ts           — expired-result/session cleanup sweep
  safe-error-mapping.ts          — internal failure category → public ChukuSafeErrorCode
src/server/routes/
  sessions.ts, product-generations.ts, product-results.ts, maintenance.ts, http-errors.ts
```

Both layers share the same `HairstyleProvider`/`LightXHairstyleProvider`
and the same `resolveInputPortrait`/`sanitizeErrorMessage` primitives, but
never share storage: the Lab writes to `benchmark/results/generations.json`
and `test-images/results/`; the product layer writes to `data/chuku.db` and
`data/results/` (both gitignored, both runtime-only). See
`docs/integration-contract.md` for the API surface and
`docs/retention.md`/`docs/error-model.md` for the rest.

## Persistence

Product session/generation state is stored in SQLite via Node's built-in
`node:sqlite` (`DatabaseSync`), not a hand-rolled JSON file and not a new
npm dependency — chosen because it matches this project's existing
`engines: node>=22.6.0` floor. `src/server/db/connection.ts` loads it via
`process.getBuiltinModule("node:sqlite")` rather than a static
`import ... from "node:sqlite"`, specifically to avoid a vite-node module-id
normalization bug that otherwise breaks under `vitest` (vite-node strips
the `node:` prefix from any specifier not on its own hardcoded builtins
allow-list, and the experimental `sqlite` module isn't on it).

- **Bootstrap**: `getDb()` creates `data/` and `data/results/` if missing,
  opens/creates `data/chuku.db`, sets `PRAGMA journal_mode = WAL`, and runs
  the schema (`CREATE TABLE IF NOT EXISTS ...`) — safe to run on every
  startup against an empty or already-populated database.
- **Concurrency/race-freedom**: `DatabaseSync`'s API is fully synchronous —
  there is no `await` boundary between statements, so a
  check-then-insert sequence (e.g. `generations-repo.ts`'s
  `insertGenerationIfWithinLimit`, used for both the idempotency check and
  the per-session hard cap) cannot be interleaved by a concurrent request
  the way the Lab's async JSON read/modify/write (`storage.ts`) can be.
  This is the reason the product layer uses SQLite rather than another
  JSON file.
- **Restart recovery**: `reconcileAllProcessingOnStartup()` runs once at
  server boot (`index.ts`) and lazily on `GET /generations/:id` /
  `GET /sessions/:id/generations`
  (`product-generation-service.ts`'s `reconcileIfProcessing`). For each
  generation left `"processing"` by a prior process, it makes **at most
  one** free provider status check (`getGeneration`, never
  `createGeneration`) — never re-submits a new paid job. Past a 5-minute
  staleness threshold (well beyond the LightX adapter's own ~60s poll
  ceiling) with no terminal status, the record is marked `"failed"` /
  `PROVIDER_TEMPORARY_FAILURE` locally without further provider contact.

## Storage roots

```
test-images/input/, test-images/results/, test-images/contact-sheets/  — Lab/benchmark, immutable evidence, never touched by product code
data/chuku.db, data/results/                                            — product persistence, gitignored, runtime-only
```

Kept structurally separate in `src/server/security/paths.ts` (`TEST_IMAGES_*`
constants vs. `PRODUCT_*` constants) specifically so a bug in product
retention cleanup can never delete Lab/benchmark evidence — see
`docs/retention.md` "Storage-root separation and path safety."
