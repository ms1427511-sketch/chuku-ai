import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage, assertNoSecretHeaders, sanitizeForLocalStorage } from "../src/server/security/sanitize.ts";

describe("sanitizeErrorMessage", () => {
  it("redacts a literal API key value out of a message", () => {
    const message = "request failed, key=sk-super-secret-value was rejected";
    const out = sanitizeErrorMessage(message, "sk-super-secret-value");
    expect(out).not.toContain("sk-super-secret-value");
    expect(out).toContain("[redacted]");
  });

  it("is a no-op when apiKey is null", () => {
    expect(sanitizeErrorMessage("plain message", null)).toBe("plain message");
  });
});

describe("assertNoSecretHeaders", () => {
  it("throws when a header key looks like an auth header", () => {
    expect(() => assertNoSecretHeaders({ "x-api-key": "abc" })).toThrow();
    expect(() => assertNoSecretHeaders({ Authorization: "Bearer abc" })).toThrow();
  });

  it("does not throw for ordinary headers", () => {
    expect(() => assertNoSecretHeaders({ "content-type": "application/json" })).not.toThrow();
  });
});

describe("sanitizeForLocalStorage", () => {
  it("strips secret-shaped fields before persisting", () => {
    const input = { id: "abc", "x-api-key": "secret", apiKey: "secret", headers: { a: 1 }, status: "completed" };
    const out = sanitizeForLocalStorage(input);
    expect(out).not.toHaveProperty("x-api-key");
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("headers");
    expect(out.id).toBe("abc");
    expect(out.status).toBe("completed");
  });
});
