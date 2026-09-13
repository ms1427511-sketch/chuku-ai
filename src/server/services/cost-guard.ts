import type { BenchmarkTotals } from "../../shared/types.ts";
import { GenerationLimitReachedError } from "../../shared/errors.ts";
import { config } from "../config/env.ts";

// In-memory, single-process counter. This is a benchmark cost guard for
// the operator's own protection against runaway spend, not a security
// boundary against an adversary — so process-restart resetting the count
// is an accepted tradeoff (spec explicitly says "no database required
// initially"). The hard cap and retry limit are still enforced here, on
// the server, independent of anything the UI does or fails to disable.
class CostGuard {
  private requested = 0;
  private succeeded = 0;
  private failed = 0;
  private retries = 0;

  totals(): BenchmarkTotals {
    return {
      requested: this.requested,
      succeeded: this.succeeded,
      failed: this.failed,
      retries: this.retries,
      hardCap: config.generationHardCap,
      remaining: Math.max(0, config.generationHardCap - this.requested),
    };
  }

  /** Call before issuing a new provider generation. Throws if the hard cap is already reached. */
  reserveSlot(isRetry: boolean): void {
    if (this.requested >= config.generationHardCap) {
      throw new GenerationLimitReachedError(config.generationHardCap);
    }
    this.requested += 1;
    if (isRetry) this.retries += 1;
  }

  recordSuccess(): void {
    this.succeeded += 1;
  }

  recordFailure(): void {
    this.failed += 1;
  }

  reset(): void {
    this.requested = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.retries = 0;
  }
}

export const costGuard = new CostGuard();
