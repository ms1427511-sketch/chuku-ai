import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const SECRET = "a".repeat(40);

function fakeReqRes(headerValue: string | undefined) {
  const req = { header: (name: string) => (name.toLowerCase() === "x-internal-auth" ? headerValue : undefined) } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status, json } as unknown as Response;
  const next = vi.fn();
  return { req, res, next, status, json };
}

describe("internalAuthMiddleware — fails closed with no configured secret", () => {
  it("rejects every request, even with a header present, when CHUKU_INTERNAL_AUTH_SECRET is unset", async () => {
    delete process.env.CHUKU_INTERNAL_AUTH_SECRET;
    vi.resetModules();
    const { internalAuthMiddleware } = await import("../src/server/security/internal-auth.ts");

    const { req, res, next, status, json } = fakeReqRes(SECRET);
    internalAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: "INTERNAL_AUTH_FAILED" }));
  });

  it("rejects when the configured secret is below the minimum reasonable length", async () => {
    process.env.CHUKU_INTERNAL_AUTH_SECRET = "too-short";
    vi.resetModules();
    const { internalAuthMiddleware } = await import("../src/server/security/internal-auth.ts");

    const { req, res, next, status } = fakeReqRes("too-short");
    internalAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    delete process.env.CHUKU_INTERNAL_AUTH_SECRET;
  });
});

describe("internalAuthMiddleware — with a configured secret", () => {
  it("rejects a missing header", async () => {
    process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
    vi.resetModules();
    const { internalAuthMiddleware } = await import("../src/server/security/internal-auth.ts");

    const { req, res, next, status } = fakeReqRes(undefined);
    internalAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("rejects a wrong header value", async () => {
    process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
    vi.resetModules();
    const { internalAuthMiddleware } = await import("../src/server/security/internal-auth.ts");

    const { req, res, next, status } = fakeReqRes("b".repeat(40));
    internalAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it("accepts the correct header value", async () => {
    process.env.CHUKU_INTERNAL_AUTH_SECRET = SECRET;
    vi.resetModules();
    const { internalAuthMiddleware } = await import("../src/server/security/internal-auth.ts");

    const { req, res, next, status } = fakeReqRes(SECRET);
    internalAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
});
