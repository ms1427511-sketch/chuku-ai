import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../src/server/config/env.ts";

// Post-build guard: fails the build if the literal LIGHTX_API_KEY value,
// or the string "LIGHTX_API_KEY" itself, ever ends up inside a file the
// browser will load. Run after `vite build` against dist/client.
const DIST_DIR = path.resolve(import.meta.dirname, "..", "dist", "client");

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

async function main() {
  const files = await walk(DIST_DIR);
  let failed = false;

  for (const file of files) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (content.includes("LIGHTX_API_KEY")) {
      console.error(`FAIL: ${file} contains the literal string "LIGHTX_API_KEY"`);
      failed = true;
    }
    if (config.lightxApiKey && content.includes(config.lightxApiKey)) {
      console.error(`FAIL: ${file} contains the configured LightX API key value`);
      failed = true;
    }
  }

  if (failed) {
    console.error("check-no-secret-leak: FAILED — secret-shaped content found in client bundle.");
    process.exitCode = 1;
    return;
  }
  console.log(`check-no-secret-leak: OK — scanned ${files.length} built client files, no secret found.`);
}

main().catch((error) => {
  console.error("check-no-secret-leak crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
