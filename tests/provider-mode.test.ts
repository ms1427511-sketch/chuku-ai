import { afterEach, describe, expect, it, vi } from "vitest";

// Module-load-time config (config/env.ts) — same convention as
// tests/internal-auth.test.ts: set env, vi.resetModules(), re-import fresh.
function resetProviderEnv() {
  delete process.env.CHUKU_PROVIDER_MODE;
  delete process.env.LIGHTX_API_KEY;
}

afterEach(() => {
  resetProviderEnv();
  vi.resetModules();
});

describe("CHUKU_PROVIDER_MODE — config resolution", () => {
  it("defaults to lightx when unset", async () => {
    resetProviderEnv();
    vi.resetModules();
    const { config } = await import("../src/server/config/env.ts");
    expect(config.providerMode).toBe("lightx");
  });

  it("is opt-in only: an explicit fake value is required to select it", async () => {
    resetProviderEnv();
    process.env.CHUKU_PROVIDER_MODE = "fake";
    vi.resetModules();
    const { config } = await import("../src/server/config/env.ts");
    expect(config.providerMode).toBe("fake");
  });

  it("boots successfully in fake mode with no LIGHTX_API_KEY set", async () => {
    resetProviderEnv();
    process.env.CHUKU_PROVIDER_MODE = "fake";
    vi.resetModules();
    const { config, hasLightXCredential } = await import("../src/server/config/env.ts");
    expect(config.providerMode).toBe("fake");
    expect(hasLightXCredential()).toBe(false);
  });

  it("preserves existing lightx-mode behavior when LIGHTX_API_KEY is set", async () => {
    resetProviderEnv();
    process.env.LIGHTX_API_KEY = "test-key-value";
    vi.resetModules();
    const { config, hasLightXCredential } = await import("../src/server/config/env.ts");
    expect(config.providerMode).toBe("lightx");
    expect(hasLightXCredential()).toBe(true);
  });

  it("fails boot clearly on an invalid provider mode value", async () => {
    resetProviderEnv();
    process.env.CHUKU_PROVIDER_MODE = "not-a-real-provider";
    vi.resetModules();
    await expect(import("../src/server/config/env.ts")).rejects.toThrow(/invalid CHUKU_PROVIDER_MODE/);
  });
});

describe("CHUKU_DEPLOYMENT_MODE — config resolution", () => {
  afterEach(() => {
    delete process.env.CHUKU_DEPLOYMENT_MODE;
    vi.resetModules();
  });

  it("defaults to local when unset", async () => {
    delete process.env.CHUKU_DEPLOYMENT_MODE;
    vi.resetModules();
    const { config } = await import("../src/server/config/env.ts");
    expect(config.deploymentMode).toBe("local");
  });

  it("accepts an explicit service value", async () => {
    process.env.CHUKU_DEPLOYMENT_MODE = "service";
    vi.resetModules();
    const { config } = await import("../src/server/config/env.ts");
    expect(config.deploymentMode).toBe("service");
  });

  it("fails boot clearly on an invalid deployment mode value", async () => {
    process.env.CHUKU_DEPLOYMENT_MODE = "production";
    vi.resetModules();
    await expect(import("../src/server/config/env.ts")).rejects.toThrow(/invalid CHUKU_DEPLOYMENT_MODE/);
  });
});

describe("provider-factory.getProvider() — selection never drifts across call sites", () => {
  afterEach(() => {
    resetProviderEnv();
    vi.resetModules();
  });

  it("selects LightXHairstyleProvider by default", async () => {
    resetProviderEnv();
    vi.resetModules();
    const { getProvider } = await import("../src/server/providers/provider-factory.ts");
    const { LightXHairstyleProvider } = await import("../src/server/providers/lightx-provider.ts");
    expect(getProvider()).toBeInstanceOf(LightXHairstyleProvider);
  });

  it("selects FakeHairstyleProvider only when CHUKU_PROVIDER_MODE=fake", async () => {
    resetProviderEnv();
    process.env.CHUKU_PROVIDER_MODE = "fake";
    vi.resetModules();
    const { getProvider } = await import("../src/server/providers/provider-factory.ts");
    const { FakeHairstyleProvider } = await import("../src/server/providers/fake-provider.ts");
    const { LightXHairstyleProvider } = await import("../src/server/providers/lightx-provider.ts");
    const provider = getProvider();
    expect(provider).toBeInstanceOf(FakeHairstyleProvider);
    expect(provider).not.toBeInstanceOf(LightXHairstyleProvider);
  });
});
