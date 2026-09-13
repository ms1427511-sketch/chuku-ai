import { describe, expect, it } from "vitest";
import { resolveWithinDir, resolveInputPortrait, TEST_IMAGES_INPUT_DIR } from "../src/server/security/paths.ts";
import { InvalidImagePathError } from "../src/shared/errors.ts";

describe("resolveWithinDir", () => {
  it("resolves a safe relative path inside the base dir", () => {
    const resolved = resolveWithinDir(TEST_IMAGES_INPUT_DIR, "portrait-a.png");
    expect(resolved.startsWith(TEST_IMAGES_INPUT_DIR)).toBe(true);
  });

  it("rejects a ../ traversal attempt", () => {
    expect(() => resolveWithinDir(TEST_IMAGES_INPUT_DIR, "../../etc/passwd")).toThrow(InvalidImagePathError);
  });

  it("rejects an absolute path that escapes the base dir", () => {
    expect(() => resolveWithinDir(TEST_IMAGES_INPUT_DIR, "/etc/passwd")).toThrow(InvalidImagePathError);
  });

  it("rejects a nested traversal disguised inside a normal-looking path", () => {
    expect(() => resolveWithinDir(TEST_IMAGES_INPUT_DIR, "sub/../../outside.png")).toThrow(InvalidImagePathError);
  });
});

describe("resolveInputPortrait", () => {
  it("throws InvalidImagePathError when the file does not exist", () => {
    expect(() => resolveInputPortrait("portrait-does-not-exist.png")).toThrow(InvalidImagePathError);
  });
});
