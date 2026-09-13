import { beforeEach, describe, expect, it } from "vitest";
import { costGuard } from "../src/server/services/cost-guard.ts";
import { GenerationLimitReachedError } from "../src/shared/errors.ts";

describe("costGuard", () => {
  beforeEach(() => {
    costGuard.reset();
  });

  it("starts at zero with the full hard cap remaining", () => {
    const totals = costGuard.totals();
    expect(totals.requested).toBe(0);
    expect(totals.remaining).toBe(totals.hardCap);
  });

  it("increments requested (and retries) on reserveSlot", () => {
    costGuard.reserveSlot(false);
    costGuard.reserveSlot(true);
    const totals = costGuard.totals();
    expect(totals.requested).toBe(2);
    expect(totals.retries).toBe(1);
  });

  it("throws GENERATION_LIMIT_REACHED once the hard cap is hit", () => {
    const cap = costGuard.totals().hardCap;
    for (let i = 0; i < cap; i++) costGuard.reserveSlot(false);
    expect(() => costGuard.reserveSlot(false)).toThrow(GenerationLimitReachedError);
  });

  it("tracks success/failure counts independently of requested", () => {
    costGuard.reserveSlot(false);
    costGuard.recordSuccess();
    costGuard.reserveSlot(false);
    costGuard.recordFailure();
    const totals = costGuard.totals();
    expect(totals.succeeded).toBe(1);
    expect(totals.failed).toBe(1);
  });
});
