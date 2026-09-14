import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDbForTests } from "../src/server/db/connection.ts";
import { createSession, getSession, setSessionFavorite, setSessionSource } from "../src/server/services/session-service.ts";
import { InvalidSourceError, SessionNotFoundError } from "../src/shared/errors.ts";

beforeEach(() => {
  useInMemoryDbForTests();
});

describe("createSession", () => {
  it("creates an active session with no source, zero generations, and the configured limits", () => {
    const session = createSession();
    expect(session.status).toBe("active");
    expect(session.sourcePortraitId).toBeNull();
    expect(session.generationCount).toBe(0);
    expect(session.includedGenerations).toBeGreaterThan(0);
    expect(session.maxGenerations).toBeGreaterThanOrEqual(session.includedGenerations);
  });

  it("never exposes internal-only fields (provider, db-row shape) in the public DTO", () => {
    const session = createSession();
    expect(session).not.toHaveProperty("provider");
    expect(session).not.toHaveProperty("source_portrait_id");
  });
});

describe("getSession", () => {
  it("throws SessionNotFoundError for an unknown id", () => {
    expect(() => getSession("does-not-exist")).toThrow(SessionNotFoundError);
  });

  it("round-trips a created session by id", () => {
    const created = createSession();
    expect(getSession(created.id)).toMatchObject({ id: created.id, status: "active" });
  });
});

describe("setSessionSource", () => {
  it("sets a valid portrait id", () => {
    const created = createSession();
    const updated = setSessionSource(created.id, "portrait-b");
    expect(updated.sourcePortraitId).toBe("portrait-b");
  });

  it("rejects an invalid portrait id", () => {
    const created = createSession();
    expect(() => setSessionSource(created.id, "not-a-real-portrait")).toThrow(InvalidSourceError);
  });

  it("throws SessionNotFoundError for an unknown session", () => {
    expect(() => setSessionSource("does-not-exist", "portrait-a")).toThrow(SessionNotFoundError);
  });
});

describe("setSessionFavorite", () => {
  it("sets and clears the favorite generation id", () => {
    const created = createSession();
    const favorited = setSessionFavorite(created.id, "gen-1");
    expect(favorited.favoriteGenerationId).toBe("gen-1");
    const cleared = setSessionFavorite(created.id, null);
    expect(cleared.favoriteGenerationId).toBeNull();
  });
});
