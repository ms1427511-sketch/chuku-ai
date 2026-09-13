# Chuku AI Lab — Stage A Benchmark

Stage A is a deliberately small, cost-controlled first look at LightX
hairstyle-generation quality. It is **not** a full evaluation and is not a
substitute for human review of the resulting contact sheet.

## Scope (fixed, not to be exceeded without explicit approval)

- **3 source portraits**: `test-images/input/portrait-a.png`,
  `portrait-b.png`, `portrait-c.png` — synthetic test portraits only. Never
  real MEKKY customer photos, never downloaded photos of real people.
- **5 hairstyles** (`STAGE_A_HAIRSTYLE_IDS` in `src/shared/hairstyles.ts`):
  Buzz Cut, Skin Fade, Textured Crop, Pompadour, Curly Top.
- **Maximum 15 provider generations** (3 × 5). Enforced independently by
  the server-side cost guard (`src/server/services/cost-guard.ts`), not
  only by this script's loop bounds.
- **Maximum 1 automatic retry per generation**, and only for a genuine
  transient failure (`network_error`, `provider_timeout`, `provider_error`)
  — never for a completed-but-low-quality result. A poor visual result is
  never itself a "failure" in the system's terms, so it can never trigger
  an automatic extra paid generation.

## Running Stage A

```
npm run benchmark:stage-a
```

This calls `scripts/run-stage-a-benchmark.ts`, which:

1. Checks that all three input portraits exist. If not, it prints
   `LIVE BENCHMARK: BLOCKED_BY_TEST_IMAGES` and the exact missing paths,
   and exits without calling LightX.
2. Checks that `LIGHTX_API_KEY` is configured (`.env.local`). If not, it
   prints `LIVE BENCHMARK: BLOCKED_BY_LIGHTX_CREDENTIAL` and exits without
   calling LightX.
3. Otherwise, runs the 3×5 generation loop via the same
   `generation-service.createGeneration()` path the UI uses — no bypass of
   the cost guard, retry limit, or validation.

## Contact sheet

```
npm run contact-sheet
```

Builds `test-images/contact-sheets/lightx-stage-a.png` from whatever is in
`benchmark/results/generations.json` at the time it's run: each portrait's
original photo, followed by its 5 Stage-A style results, labeled with
hairstyle id and status. **A missing or failed generation is rendered as a
clearly-marked blank/red cell, never silently omitted** — the sheet is
meant to be reviewed by a human, including its failures, before Phase 4.1.

## Latency

Each `GenerationRecord` stores `startedAt`, `completedAt`, and the derived
`latencyMs`. After a Stage A run, compute average/median/fastest/slowest
directly from `benchmark/results/generations.json`. With at most 15
samples, do not compute or report a p95 — that requires far more samples to
be meaningful. If a small-sample tail estimate is ever wanted, it must be
explicitly labeled "small-sample estimate," never presented as a real p95.

## Cost

LightX's hairstyle-endpoint credit cost is not published (see
`docs/lightx.md`). This benchmark records whatever LightX's dashboard shows
as consumed after a real run, labeled "observed, not published," rather
than inventing a per-call figure. Until a real number is observed:

- Cost per generation: **UNKNOWN**
- Cost at 3/5/10 styles per customer × 100/500/1,000/5,000 customers/month:
  **DOLLAR COST UNKNOWN** — cannot be computed without a published or
  observed per-call credit cost.

## What Stage A does *not* do

- It does not evaluate quality automatically. Manual scoring
  (`ManualScore` — Identity Preservation, Haircut Accuracy, Realism,
  Hairline Quality, Fade Quality, Beard Preservation, Artifact Control,
  Barber Usability, each 0–10 or `UNSCORED`) and failure flags
  (`IDENTITY_FAILURE`, `HAIRCUT_FAILURE`) are entered by a human reviewer
  through the Lab UI, per generation. The system never marks a result as
  "good" on its own.
- It does not decide whether LightX is good enough for MEKKY. That is a
  human decision made after reviewing the contact sheet and manual scores,
  ahead of Phase 4.1.
