# CHUKU AI LAB

An isolated R&D benchmark project for evaluating AI hairstyle generation
(currently via [LightX](https://www.lightxeditor.com/)) against real
product requirements — **before** any integration into MEKKY.

**This is not the MEKKY product.** It is a standalone project with its own
git history, dependencies, and environment, independent of the MEKKY
backend, MEKKY mobile, and MEKKY customer repositories. It does not modify
any of those repositories, MEKKY's Supabase project, or MEKKY staging/
production in any way.

## What this is for

A single source portrait photo can be run through many hairstyle
generations without needing a new photo each time. The most important
quality bar this Lab exists to test: **LightX must change the hair while
keeping the person** — identity, face geometry, skin tone, ears, beard,
expression, pose, clothes, and background should all be preserved. A
result where the person looks meaningfully different is a failure,
regardless of how good the haircut itself looks.

This console lets a human:
- pick one of 3 fixed test portraits,
- try any of 15 named hairstyles against it,
- rework/retry without losing the original photo or overwriting prior
  results,
- compare multiple generations for the same portrait+style side by side,
- manually score each result (Identity Preservation, Haircut Accuracy,
  Realism, Hairline Quality, Fade Quality, Beard Preservation, Artifact
  Control, Barber Usability — each 0–10, `UNSCORED` by default),
- flag failures (`IDENTITY_FAILURE`, `HAIRCUT_FAILURE`),
- and build a labeled contact sheet for review.

See `docs/architecture.md`, `docs/lightx.md`, `docs/benchmark.md`, and
`docs/privacy.md` for full detail on each of those.

## Architecture, in one line

Browser UI → local Chuku server (127.0.0.1 only) → LightX. The browser
**never** talks to LightX directly and never receives the provider API
key. See `docs/architecture.md` for the full breakdown and how this is
enforced (not just by convention).

## Setup

```
npm install
cp .env.example .env.local
```

Edit `.env.local` and set:

```
LIGHTX_API_KEY=your-key-here
```

`.env.local` is gitignored and must never be committed. `LIGHTX_API_KEY` is
read only by `src/server/config/env.ts` (server-side) — never by any file
under `src/client/`, never exposed via a `VITE_*` variable, and never
present in the built browser bundle (`npm run check:no-secret-leak`
verifies this after every build).

**Security note:** this server binds strictly to `127.0.0.1` (see
`src/server/config/env.ts`) — it is never reachable from outside your own
machine, and it must stay that way, since it is the only thing holding
your LightX API key.

## Test images

Stage A benchmarking expects three **synthetic** test portraits (not real
people, not real MEKKY customers) at:

```
test-images/input/portrait-a.png
test-images/input/portrait-b.png
test-images/input/portrait-c.png
```

If they're missing, the Lab itself still works — you just can't run a live
benchmark until they're added. See `docs/benchmark.md`.

## Running it

Start the server and the UI in two terminals:

```
npm run dev:server   # Express API on http://127.0.0.1:4317
npm run dev:client   # Vite UI on http://127.0.0.1:5173, proxies /api to the server
```

Open `http://127.0.0.1:5173`.

## Generation, rework, and history

Every "Try This Style" or "Rework" click creates a **new** generation
record — nothing is ever overwritten. Rework always keeps the same source
photo and creates a fresh attempt, so you can compare multiple results for
the same portrait+style side by side, or try a different style entirely
without re-uploading anything (there's no upload in this Lab at all — the
3 test portraits are fixed local files).

History for the current source portrait is shown at the bottom of the
page; click any entry to load it back into the result view and continue
reworking or scoring it.

## Benchmark limits (cost protection)

- Hard cap: **15 generations** per server run (in-memory counter, resets on
  restart — see `docs/architecture.md` → "Cost guard").
- Automatic retry: **at most 1**, and only for a genuine transient failure
  (network/timeout/provider error) — never for a completed-but-bad-looking
  result. Bad visual quality is a human "Rework" decision, not an automatic
  retry.
- The UI disables generation once the cap is hit, but the real enforcement
  is server-side (`GENERATION_LIMIT_REACHED`), independent of the UI.

## Contact sheet and Stage A benchmark

```
npm run benchmark:stage-a   # runs the fixed 3-portrait x 5-style benchmark
npm run contact-sheet       # builds test-images/contact-sheets/lightx-stage-a.png
```

Both are safe to run with images/key missing — they report a clear
`BLOCKED_BY_TEST_IMAGES` / `BLOCKED_BY_LIGHTX_CREDENTIAL` message and exit
without calling LightX. See `docs/benchmark.md` for full detail.

## Tests and quality gates

```
npm test         # vitest
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run build     # typecheck + vite build + no-secret-in-bundle check
```

## Not production integration

This is a **benchmark console**, not the MEKKY mobile hairstyle UX. Nothing
here is wired into any MEKKY app, backend, or database. See
`docs/privacy.md` for the (also provisional, not-yet-approved) privacy
considerations that would apply to a real product integration.
