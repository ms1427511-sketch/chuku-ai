import { describe, expect, it, vi } from "vitest";
import { FakeHairstyleProvider, FAKE_RESULT_DATA_URL } from "../src/server/providers/fake-provider.ts";

describe("FakeHairstyleProvider", () => {
  it("createGeneration returns a queued job with no network call, deterministic shape", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const provider = new FakeHairstyleProvider();
      const job = await provider.createGeneration({ sourceImagePath: "/does/not/matter.png", prompt: "buzz cut" });
      expect(job.provider).toBe("fake");
      expect(job.status).toBe("queued");
      expect(job.externalJobId).toMatch(/^fake-/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getGeneration always completes immediately with a deterministic data: resultUrl, regardless of jobId", async () => {
    const provider = new FakeHairstyleProvider();
    const a = await provider.getGeneration("any-job-id-1");
    const b = await provider.getGeneration("any-job-id-2");
    expect(a.status).toBe("completed");
    expect(a.resultUrl).toBe(FAKE_RESULT_DATA_URL);
    expect(b.resultUrl).toBe(a.resultUrl);
    expect(a.failureCategory).toBeNull();
  });

  it("the resultUrl is itself fetchable with no real network I/O (data: URL)", async () => {
    const provider = new FakeHairstyleProvider();
    const status = await provider.getGeneration("job-x");
    const response = await fetch(status.resultUrl as string);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic bytes
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });

  it("pollUntilTerminal resolves on the first call (no polling delay to simulate)", async () => {
    const provider = new FakeHairstyleProvider();
    const status = await provider.pollUntilTerminal("job-y");
    expect(status.status).toBe("completed");
  });
});
