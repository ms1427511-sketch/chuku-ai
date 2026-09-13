import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../src/server/config/env.ts";
import { loadHistory } from "../src/server/services/storage.ts";
import { STAGE_A_HAIRSTYLE_IDS } from "../src/shared/hairstyles.ts";
import type { PortraitId } from "../src/shared/types.ts";

const CELL_W = 320;
const CELL_H = 320;
const LABEL_H = 28;
const PORTRAITS: PortraitId[] = ["portrait-a", "portrait-b", "portrait-c"];

async function loadCell(filePath: string | null, label: string): Promise<Buffer> {
  const labelSvg = Buffer.from(
    `<svg width="${CELL_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="19" font-size="14" fill="#fff" font-family="sans-serif">${label}</text></svg>`,
  );

  let imageBuf: Buffer;
  if (filePath) {
    try {
      imageBuf = await sharp(filePath).resize(CELL_W, CELL_H, { fit: "cover" }).toBuffer();
    } catch {
      imageBuf = await sharp({
        create: { width: CELL_W, height: CELL_H, channels: 3, background: { r: 60, g: 20, b: 20 } },
      })
        .png()
        .toBuffer();
    }
  } else {
    // Missing/failed result is shown as a visibly blank/red cell, never hidden
    // or silently skipped — spec section 23: "Do not hide bad outputs."
    imageBuf = await sharp({
      create: { width: CELL_W, height: CELL_H, channels: 3, background: { r: 60, g: 20, b: 20 } },
    })
      .png()
      .toBuffer();
  }

  return sharp({
    create: { width: CELL_W, height: CELL_H + LABEL_H, channels: 3, background: { r: 17, g: 17, b: 17 } },
  })
    .composite([
      { input: imageBuf, top: 0, left: 0 },
      { input: labelSvg, top: CELL_H, left: 0 },
    ])
    .png()
    .toBuffer();
}

async function main() {
  const history = await loadHistory();
  const columns = 1 + STAGE_A_HAIRSTYLE_IDS.length; // original + 5 styles
  const rows = PORTRAITS.length;

  const cells: Buffer[][] = [];
  for (const portrait of PORTRAITS) {
    const row: Buffer[] = [];
    const originalPath = path.join(PROJECT_ROOT, "test-images", "input", `${portrait}.png`);
    row.push(await loadCell(originalPath, `${portrait} (original)`));

    for (const hairstyleId of STAGE_A_HAIRSTYLE_IDS) {
      const record = history
        .filter((r) => r.source === portrait && r.hairstyleId === hairstyleId)
        .sort((a, b) => b.generationIndex - a.generationIndex)[0];
      const resultPath = record?.resultPath
        ? path.join(PROJECT_ROOT, "test-images", "results", record.resultPath)
        : null;
      const label = record ? `${hairstyleId} · ${record.status}` : `${hairstyleId} · no attempt`;
      row.push(await loadCell(resultPath, label));
    }
    cells.push(row);
  }

  const sheetW = columns * CELL_W;
  const sheetH = rows * (CELL_H + LABEL_H);
  const composite: sharp.OverlayOptions[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      composite.push({ input: cells[r]![c]!, top: r * (CELL_H + LABEL_H), left: c * CELL_W });
    }
  }

  const outDir = path.join(PROJECT_ROOT, "test-images", "contact-sheets");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "lightx-stage-a.png");
  await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: { r: 17, g: 17, b: 17 } } })
    .composite(composite)
    .png()
    .toFile(outPath);

  console.log(`Contact sheet written to ${outPath}`);
}

main().catch((error) => {
  console.error("contact sheet generation failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
