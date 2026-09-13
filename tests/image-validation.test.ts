import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePortraitFile } from "../src/server/services/image-validation.ts";
import { UnsupportedImageTypeError, InvalidImagePathError } from "../src/shared/errors.ts";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const VALID_PNG = path.join(FIXTURES_DIR, "valid.png");
const TOO_SMALL = path.join(FIXTURES_DIR, "too-small.png");
const WRONG_TYPE = path.join(FIXTURES_DIR, "not-an-image.txt");

beforeAll(async () => {
  await mkdir(FIXTURES_DIR, { recursive: true });
  await writeFile(VALID_PNG, Buffer.alloc(2048, 1));
  await writeFile(TOO_SMALL, Buffer.alloc(10, 1));
  await writeFile(WRONG_TYPE, Buffer.alloc(2048, 1));
});

afterAll(async () => {
  await rm(FIXTURES_DIR, { recursive: true, force: true });
});

describe("validatePortraitFile", () => {
  it("accepts a file with a supported extension and reasonable size", async () => {
    await expect(validatePortraitFile(VALID_PNG)).resolves.toBeUndefined();
  });

  it("rejects an unsupported file extension", async () => {
    await expect(validatePortraitFile(WRONG_TYPE)).rejects.toBeInstanceOf(UnsupportedImageTypeError);
  });

  it("rejects a file that is too small to be a real photo", async () => {
    await expect(validatePortraitFile(TOO_SMALL)).rejects.toBeInstanceOf(InvalidImagePathError);
  });

  it("rejects a path that does not exist", async () => {
    await expect(validatePortraitFile(path.join(FIXTURES_DIR, "missing.png"))).rejects.toBeInstanceOf(InvalidImagePathError);
  });
});
