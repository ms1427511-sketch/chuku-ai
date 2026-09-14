import type { HairstyleCatalogEntry } from "./types.ts";

// Customer-facing `name` is deliberately separate from the provider
// `prompt`: the prompt is tuned for the LightX model, the name is tuned
// for a customer picking a style from a catalog. Keep both in sync by
// hand when tuning — do not derive one from the other.
export const HAIRSTYLE_CATALOG: HairstyleCatalogEntry[] = [
  {
    id: "buzz-cut",
    name: "Buzz Cut",
    category: "short",
    prompt: "buzz cut, very short uniform length all over, clippers, no fade",
    enabled: true,
    sortOrder: 10,
  },
  {
    id: "crew-cut",
    name: "Crew Cut",
    category: "short",
    prompt: "crew cut, short on sides and back, slightly longer on top, classic masculine cut",
    enabled: true,
    sortOrder: 20,
  },
  {
    id: "skin-fade",
    name: "Skin Fade",
    category: "fade",
    prompt: "skin fade haircut, bald fade at the sides blending into short hair on top",
    enabled: true,
    sortOrder: 30,
  },
  {
    id: "low-fade",
    name: "Low Fade",
    category: "fade",
    prompt: "low fade haircut, fade starting just above the ears, natural gradual blend",
    enabled: true,
    sortOrder: 40,
  },
  {
    id: "mid-fade",
    name: "Mid Fade",
    category: "fade",
    prompt: "mid fade haircut, fade starting at mid-height on the sides, clean gradual blend",
    enabled: true,
    sortOrder: 50,
  },
  {
    id: "taper-fade",
    name: "Taper Fade",
    category: "fade",
    prompt: "taper fade haircut, gradual tapering at the sides and back, longer hair kept on top",
    enabled: true,
    sortOrder: 60,
  },
  {
    id: "french-crop",
    name: "French Crop",
    category: "crop",
    prompt: "French crop haircut, short textured fringe, tight faded sides, cropped top",
    enabled: true,
    sortOrder: 70,
  },
  {
    id: "textured-crop",
    name: "Textured Crop",
    category: "crop",
    prompt: "textured crop haircut, choppy textured top with short faded sides",
    enabled: true,
    sortOrder: 80,
  },
  {
    id: "textured-fringe",
    name: "Textured Fringe",
    category: "crop",
    prompt: "textured fringe haircut, wispy textured bangs falling over the forehead, short sides",
    enabled: true,
    sortOrder: 90,
  },
  {
    id: "side-part",
    name: "Side Part",
    category: "classic",
    prompt: "classic side part haircut, neat comb line part, groomed and polished",
    enabled: true,
    sortOrder: 100,
  },
  {
    id: "slick-back",
    name: "Slick Back",
    category: "classic",
    prompt: "slick back haircut, hair combed straight back, sleek glossy finish",
    enabled: true,
    sortOrder: 110,
  },
  {
    id: "pompadour",
    name: "Pompadour",
    category: "classic",
    prompt: "pompadour haircut, voluminous swept-up hair on top, tapered sides",
    enabled: true,
    sortOrder: 120,
  },
  {
    id: "curly-top",
    name: "Curly Top",
    category: "curly",
    prompt: "curly top haircut, natural curls kept longer on top, short trimmed sides",
    enabled: true,
    sortOrder: 130,
  },
  {
    id: "curly-fade",
    name: "Curly Fade",
    category: "curly",
    prompt: "curly fade haircut, natural curls on top blending into a tight fade on the sides",
    enabled: true,
    sortOrder: 140,
  },
  {
    id: "curly-taper",
    name: "Curly Taper",
    category: "curly",
    prompt: "curly taper haircut, natural curls on top with a gradual tapered blend at the sides",
    enabled: true,
    sortOrder: 150,
  },
];

export function findHairstyle(id: string): HairstyleCatalogEntry | undefined {
  return HAIRSTYLE_CATALOG.find((h) => h.id === id && h.enabled);
}

export function listEnabledHairstyles(): HairstyleCatalogEntry[] {
  return [...HAIRSTYLE_CATALOG].filter((h) => h.enabled).sort((a, b) => a.sortOrder - b.sortOrder);
}

// Stage A benchmark deliberately uses only 5 of the 15 catalog entries
// (spec section 12) — not a separate list, so the benchmark never drifts
// out of sync with the real catalog's ids/prompts.
export const STAGE_A_HAIRSTYLE_IDS = ["buzz-cut", "skin-fade", "textured-crop", "pompadour", "curly-fade"] as const;
