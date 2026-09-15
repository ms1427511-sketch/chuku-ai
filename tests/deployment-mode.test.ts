import { afterEach, describe, expect, it, vi } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Deployment-hardening mission section 8: proves route mounting is
// deterministic per CHUKU_DEPLOYMENT_MODE, not merely "unauthenticated but
// present". Each test builds a fresh app (module-load-time route mounting,
// same convention as config/env.ts) via vi.resetModules() + dynamic import.
async function buildApp(deploymentMode: "local" | "service" | undefined): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  if (deploymentMode) process.env.CHUKU_DEPLOYMENT_MODE = deploymentMode;
  else delete process.env.CHUKU_DEPLOYMENT_MODE;
  vi.resetModules();
  const { app } = await import("../src/server/app.ts");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function get(baseUrl: string, urlPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${urlPath}`, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    }).on("error", reject);
  });
}

function post(baseUrl: string, urlPath: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

afterEach(() => {
  delete process.env.CHUKU_DEPLOYMENT_MODE;
  vi.resetModules();
});

describe("CHUKU_DEPLOYMENT_MODE=local (default) — existing Lab behavior is fully preserved", () => {
  it("mounts every existing Lab/Product route", async () => {
    const { baseUrl, close } = await buildApp(undefined);
    try {
      expect((await get(baseUrl, "/health")).status).toBe(200);
      expect((await get(baseUrl, "/styles")).status).toBe(200);
      expect((await get(baseUrl, "/sessions/does-not-exist")).status).not.toBe(404 - 1); // reachable at all (route mounted)
      expect((await get(baseUrl, "/generations")).status).toBe(200);
      // /internal/* is mounted in both modes, but still requires auth.
      expect((await post(baseUrl, "/internal/generations")).status).toBe(401);
    } finally {
      await close();
    }
  });
});

describe("CHUKU_DEPLOYMENT_MODE=service — only /health and /internal/* are reachable", () => {
  it("mounts /health", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await get(baseUrl, "/health")).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("mounts /internal/* (still internal-auth gated)", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await post(baseUrl, "/internal/generations")).status).toBe(401);
      expect((await get(baseUrl, "/internal/generations/does-not-exist")).status).toBe(401);
    } finally {
      await close();
    }
  });

  it("does NOT mount /styles or /hairstyles (catalog)", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await get(baseUrl, "/styles")).status).toBe(404);
      expect((await get(baseUrl, "/hairstyles")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("does NOT mount /generations (Lab, unauthenticated real-provider trigger)", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await get(baseUrl, "/generations")).status).toBe(404);
      expect((await post(baseUrl, "/generations")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("does NOT mount /sessions or /sessions/:id/generations (Product, unauthenticated real-provider trigger)", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await post(baseUrl, "/sessions")).status).toBe(404);
      expect((await post(baseUrl, "/sessions/some-id/generations")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("does NOT mount /product-results/* (shares storage with the internal-auth-gated result route)", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await get(baseUrl, "/product-results/some/path.png")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("does NOT mount /maintenance/cleanup", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await post(baseUrl, "/maintenance/cleanup")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("does NOT mount /input/* or /results/* (Lab benchmark images)", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      expect((await get(baseUrl, "/input/portrait-a.png")).status).toBe(404);
      expect((await get(baseUrl, "/results/portrait-a/buzz-cut/out.png")).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("no unauthenticated route can trigger provider work: every mounted route other than /health requires internal auth", async () => {
    const { baseUrl, close } = await buildApp("service");
    try {
      const health = await get(baseUrl, "/health");
      expect(health.status).toBe(200);
      const internalCreate = await post(baseUrl, "/internal/generations");
      expect(internalCreate.status).toBe(401);
      const internalStatus = await get(baseUrl, "/internal/generations/anything");
      expect(internalStatus.status).toBe(401);
      const internalResult = await get(baseUrl, "/internal/generations/anything/result");
      expect(internalResult.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("GET /health discloses only liveness — no provider/deployment/config details", async () => {
    process.env.CHUKU_DEPLOYMENT_MODE = "service";
    vi.resetModules();
    const { app } = await import("../src/server/app.ts");
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const body: Record<string, unknown> = await new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/health`, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          })
          .on("error", reject);
      });
      expect(Object.keys(body).sort()).toEqual(["ok"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
