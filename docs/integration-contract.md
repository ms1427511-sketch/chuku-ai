# Chuku AI Lab — Product Integration Contract

This is the stable, standalone API surface added in the Core Productization
phase. It is **provider-agnostic and MEKKY-agnostic** — no LightX-specific
field is ever exposed, and no MEKKY-specific concept (customer id, staff
role, appointment, Supabase auth) exists yet. This document describes the
contract as it exists today, for future integration *scoping*, not as a
statement that integration is happening now — see `docs/current-state.md`
for the current phase gate.

## No auth yet

There is deliberately no authentication/authorization layer and no
`externalOwnerId`/customer concept in this phase. Every session is
addressable by its own server-generated, unguessable `id` (UUID) — knowing
a session id is currently the only "access control." The schema already
has a nullable `external_owner_id` column (`src/server/db/schema.ts`,
`sessions-repo.ts`) reserved for a future customer/owner id so that adding
real auth later is an additive column read, not a schema redesign — but
nothing reads or writes it yet.

## Resources

### Session (`ChukuSession`)

A session tracks one source portrait selection and its generations. No
"customer" or "appointment" concept — a session is the whole unit of state
for this phase.

```ts
interface ChukuSession {
  id: string;
  sourcePortraitId: "portrait-a" | "portrait-b" | "portrait-c" | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;         // governed by CHUKU_SOURCE_RETENTION_HOURS
  favoriteGenerationId: string | null;
  status: "active" | "expired";
  generationCount: number;
  includedGenerations: number; // CHUKU_INCLUDED_GENERATIONS — informational, not enforced separately from maxGenerations
  maxGenerations: number;      // CHUKU_MAX_GENERATIONS_PER_SESSION — enforced server-side, hard cap
}
```

`sourcePortraitId` deliberately reuses the Lab's existing 3 fixed synthetic
portrait ids rather than an arbitrary uploaded file path — there is no real
upload flow in this phase (see "What this phase does not add" below).

### Product generation (`ProductGeneration`)

```ts
type ProductGenerationStatus = "queued" | "processing" | "completed" | "failed" | "expired";

interface ProductGeneration {
  id: string;
  sessionId: string;
  styleId: string;
  generationIndex: number;         // 1-based, per (session, style)
  status: ProductGenerationStatus;
  resultUrl: string | null;        // local, server-served path — never a raw LightX URL
  favorite: boolean;
  safeErrorCode: ChukuSafeErrorCode | null; // see docs/error-model.md — never a raw provider code
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;        // set once completed — governed by CHUKU_RESULT_RETENTION_HOURS
}
```

Never present on this DTO: `provider`, `providerJobId`, the raw
`failureMessage`, or `LIGHTX_API_KEY`. See `tests/product-generation-service.test.ts`
("never exposes provider-specific fields in the public DTO") for the test
that enforces this.

## Endpoints

All routes are mounted on the same loopback-only Express app as the
existing Lab routes (`src/server/index.ts`, `127.0.0.1` only).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/sessions` | Create a new session. |
| `GET` | `/sessions/:id` | Fetch a session (404 `SESSION_NOT_FOUND` if unknown). |
| `POST` | `/sessions/:id/source` | Set the session's source portrait id. Body: `{ sourcePortraitId }`. |
| `GET` | `/styles` | List the enabled hairstyle catalog (same data as the Lab's `/hairstyles`, stable product name). |
| `POST` | `/sessions/:id/generations` | Create a generation. Body: `{ styleId, operationId }`. Returns `202` immediately with status `"processing"` — see "Async generation" below. |
| `GET` | `/generations/:id` | Fetch one generation (triggers restart-recovery reconciliation if it was left `"processing"` — see `docs/architecture.md`). |
| `GET` | `/sessions/:id/generations` | List every generation for a session. |
| `PATCH` | `/generations/:id/favorite` | Body: `{ favorite: boolean }`. Only a `completed` generation can be favorited (`400 GENERATION_IN_PROGRESS`/`INVALID_OPERATION` otherwise). |
| `POST` | `/maintenance/cleanup` | **Internal only** — runs the retention sweep (`docs/retention.md`). Rejects non-loopback callers with `403`. Not part of the customer-facing contract. |

## Idempotency

`POST /sessions/:id/generations` requires a client-supplied `operationId`.
Replaying the same `(sessionId, operationId)` pair — e.g. after a dropped
HTTP response — always returns the **same** generation record and never
creates a second one or calls the provider a second time. Enforced by a
`UNIQUE(session_id, operation_id)` SQL constraint plus a synchronous
check-then-insert in `src/server/db/generations-repo.ts`, so this holds
even under concurrent duplicate requests — see `docs/architecture.md`
"Concurrency and race-freedom."

## Generation limits

Two independent limits exist, deliberately separate from each other:

- `CHUKU_INCLUDED_GENERATIONS` (default `3`) — informational only in this
  phase, returned on the session so a future UI can show "N of 3
  included." Not enforced as a hard stop.
- `CHUKU_MAX_GENERATIONS_PER_SESSION` (default `5`) — enforced server-side,
  hard cap. A 6th generation attempt for a session returns
  `429 GENERATION_LIMIT_REACHED`, regardless of what the client UI does or
  fails to disable.

Both are **safe pilot defaults, not billing rules** — see `.env.example`.

This is entirely separate from the pre-existing Lab/benchmark cost guard
(`src/server/services/cost-guard.ts`, hard cap 15) — Stage A/B benchmark
runs and real product session usage never share a counter.

## Async generation

`POST /sessions/:id/generations` awaits only the LightX **job-creation**
call (a few seconds — upload + `POST /hairstyle`), then returns `202` with
the generation in `"processing"` status. It never blocks the HTTP response
for the full ~36–65s poll-to-completion latency. The route then triggers
`finalizeGeneration(id)` off the request/response cycle
(`void finalizeGeneration(id).catch(...)` in
`src/server/routes/product-generations.ts`) to run the bounded poll,
download the result, and write the terminal status. Callers should poll
`GET /generations/:id` (or `GET /sessions/:id/generations`) until `status`
is no longer `"processing"`.

## What this phase does not add

- No file upload endpoint — `sourcePortraitId` is one of the 3 existing
  fixed synthetic portraits, not an arbitrary customer photo. A real
  upload flow is future work.
- No auth, no customer/owner concept, no MEKKY-specific fields or routes.
- No billing — the generation limits above are safe defaults, not priced
  plans.
- No automatic scheduled retention sweep — `POST /maintenance/cleanup`
  must be triggered externally (e.g. a future cron); this phase does not
  add one.
