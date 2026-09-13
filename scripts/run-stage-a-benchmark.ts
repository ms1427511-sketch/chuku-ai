import { existsSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, config, hasLightXCredential } from "../src/server/config/env.ts";
import { createGeneration } from "../src/server/services/generation-service.ts";
import { STAGE_A_HAIRSTYLE_IDS } from "../src/shared/hairstyles.ts";
import type { PortraitId } from "../src/shared/types.ts";

const PORTRAITS: PortraitId[] = ["portrait-a", "portrait-b", "portrait-c"];

function missingPortraits(): PortraitId[] {
  return PORTRAITS.filter((p) => !existsSync(path.join(PROJECT_ROOT, "test-images", "input", `${p}.png`)));
}

// Orchestrates exactly the Stage A benchmark: 3 portraits x 5 hairstyles =
// 15 generations max (spec section 12). The server-side cost guard
// (src/server/services/cost-guard.ts) enforces the hard cap independently
// of this loop — this script does not bypass or duplicate that logic, it
// just calls createGeneration() the same way a real UI request would.
async function main() {
  const missing = missingPortraits();
  if (missing.length > 0) {
    console.log(`LIVE BENCHMARK: BLOCKED_BY_TEST_IMAGES`);
    console.log(`Missing: ${missing.map((p) => `test-images/input/${p}.png`).join(", ")}`);
    return;
  }

  if (!hasLightXCredential()) {
    console.log(`LIVE BENCHMARK: BLOCKED_BY_LIGHTX_CREDENTIAL`);
    console.log(`Set LIGHTX_API_KEY in ${path.join(PROJECT_ROOT, ".env.local")}`);
    return;
  }

  console.log(`Starting Stage A benchmark: ${PORTRAITS.length} portraits x ${STAGE_A_HAIRSTYLE_IDS.length} styles (max ${config.generationHardCap} generations).`);

  for (const source of PORTRAITS) {
    for (const hairstyleId of STAGE_A_HAIRSTYLE_IDS) {
      const record = await createGeneration({ source, hairstyleId });
      console.log(`${source} / ${hairstyleId}: ${record.status} (gen #${record.generationIndex}, id ${record.id})`);
    }
  }

  console.log("Stage A benchmark complete. Run `npm run contact-sheet` to build the labeled contact sheet.");
}

main().catch((error) => {
  console.error("Stage A benchmark failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
