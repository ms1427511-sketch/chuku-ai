import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LightXHairstyleProvider } from "../src/server/providers/lightx-provider.ts";
import { MissingProviderCredentialError } from "../src/shared/errors.ts";

let fixtureDir: string;
let fixturePortrait: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "chuku-lightx-test-"));
  fixturePortrait = path.join(fixtureDir, "portrait.png");
  await writeFile(fixturePortrait, Buffer.alloc(2048, 1));
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("LightXHairstyleProvider with no API key configured", () => {
  it("fails closed on createGeneration instead of calling the network", async () => {
    const provider = new LightXHairstyleProvider(null);
    await expect(provider.createGeneration({ sourceImagePath: fixturePortrait, prompt: "buzz cut" })).rejects.toBeInstanceOf(
      MissingProviderCredentialError,
    );
  });

  it("fails closed on getGeneration instead of calling the network", async () => {
    const provider = new LightXHairstyleProvider(null);
    await expect(provider.getGeneration("some-job-id")).rejects.toBeInstanceOf(MissingProviderCredentialError);
  });
});
