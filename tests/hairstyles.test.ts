import { describe, expect, it } from "vitest";
import { HAIRSTYLE_CATALOG, findHairstyle, listEnabledHairstyles, STAGE_A_HAIRSTYLE_IDS } from "../src/shared/hairstyles.ts";

describe("hairstyle catalog", () => {
  it("has at least 15 entries", () => {
    expect(HAIRSTYLE_CATALOG.length).toBeGreaterThanOrEqual(15);
  });

  it("has unique, non-empty ids", () => {
    const ids = HAIRSTYLE_CATALOG.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it("keeps customer-facing name distinct from the provider prompt", () => {
    for (const h of HAIRSTYLE_CATALOG) {
      expect(h.name).not.toBe(h.prompt);
      expect(h.prompt.length).toBeGreaterThan(h.name.length);
    }
  });

  it("findHairstyle returns undefined for an unknown id", () => {
    expect(findHairstyle("does-not-exist")).toBeUndefined();
  });

  it("findHairstyle returns the entry for a known enabled id", () => {
    expect(findHairstyle("buzz-cut")?.name).toBe("Buzz Cut");
  });

  it("listEnabledHairstyles is sorted by sortOrder", () => {
    const list = listEnabledHairstyles();
    const sorted = [...list].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(list).toEqual(sorted);
  });

  it("Stage A uses exactly 5 ids, all present in the real catalog", () => {
    expect(STAGE_A_HAIRSTYLE_IDS.length).toBe(5);
    for (const id of STAGE_A_HAIRSTYLE_IDS) {
      expect(findHairstyle(id)).toBeDefined();
    }
  });
});
