import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const CLIENT_DIR = path.resolve(import.meta.dirname, "..", "src", "client");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

// Structural guarantee that the provider secret can never end up in the
// browser bundle: no client source file may reference the env var name,
// a VITE_-prefixed provider secret, or import server config directly.
describe("client source never references the LightX credential", () => {
  it("contains no LIGHTX_API_KEY string and no server/config import", async () => {
    const files = await walk(CLIENT_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content, `${file} must not reference LIGHTX_API_KEY`).not.toMatch(/LIGHTX_API_KEY/);
      expect(content, `${file} must not reference a VITE_ provider secret`).not.toMatch(/VITE_LIGHTX/);
      expect(content, `${file} must not import server config directly`).not.toMatch(/server\/config\/env/);
    }
  });
});
