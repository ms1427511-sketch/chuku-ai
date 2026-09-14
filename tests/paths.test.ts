import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveWithinDir,
  resolveInputPortrait,
  resolveProductResultDir,
  assertRealPathWithinDir,
  TEST_IMAGES_INPUT_DIR,
  PRODUCT_RESULTS_DIR,
} from "../src/server/security/paths.ts";
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

describe("resolveProductResultDir", () => {
  it("resolves a session id to a path strictly inside PRODUCT_RESULTS_DIR", () => {
    const resolved = resolveProductResultDir("session-abc");
    expect(resolved.startsWith(PRODUCT_RESULTS_DIR)).toBe(true);
  });

  it("rejects a session id crafted to traverse out of PRODUCT_RESULTS_DIR", () => {
    expect(() => resolveProductResultDir("../../etc")).toThrow(InvalidImagePathError);
  });

  it("rejects an absolute-path session id", () => {
    expect(() => resolveProductResultDir("/etc/passwd")).toThrow(InvalidImagePathError);
  });
});

describe("assertRealPathWithinDir", () => {
  let tempRoot: string;

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("passes for a real file genuinely inside the base dir", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "chuku-path-safety-"));
    const filePath = path.join(tempRoot, "inside.png");
    await writeFile(filePath, "data");
    await expect(assertRealPathWithinDir(tempRoot, filePath)).resolves.toBeUndefined();
  });

  it("rejects a symlink planted inside the base dir that points outside it", async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "chuku-path-safety-"));
    const insideDir = path.join(tempRoot, "allowed");
    const outsideDir = path.join(tempRoot, "outside");
    await mkdir(insideDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const secretFile = path.join(outsideDir, "secret.png");
    await writeFile(secretFile, "should not be reachable");

    const escapingLink = path.join(insideDir, "escape.png");
    await symlink(secretFile, escapingLink);

    await expect(assertRealPathWithinDir(insideDir, escapingLink)).rejects.toBeInstanceOf(InvalidImagePathError);
  });
});
