import { config } from "../config/env.ts";
import type { HairstyleProvider } from "./hairstyle-provider.ts";
import { LightXHairstyleProvider } from "./lightx-provider.ts";
import { FakeHairstyleProvider } from "./fake-provider.ts";

// The single selection point for CHUKU_PROVIDER_MODE — both
// internal-generation-service.ts (MEKKY-origin) and product-generation-
// service.ts (Lab-origin) call this instead of constructing a provider
// directly, so the two call sites can never drift into selecting
// differently. config.providerMode defaults to "lightx" and is validated at
// config load time (config/env.ts) — an invalid value fails boot before this
// module is ever reached, so no "unknown mode" branch exists here.
export function getProvider(): HairstyleProvider {
  if (config.providerMode === "fake") return new FakeHairstyleProvider();
  return new LightXHairstyleProvider(config.lightxApiKey);
}
