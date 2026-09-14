import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { PRODUCT_DATA_DIR, PRODUCT_DB_PATH, PRODUCT_RESULTS_DIR } from "../security/paths.ts";
import { SCHEMA_SQL } from "./schema.ts";

// node:sqlite is loaded via process.getBuiltinModule (Node 22.3+) rather
// than a static `import ... from "node:sqlite"`. vite-node's module
// normalizer strips the "node:" prefix from any specifier not in its own
// hardcoded builtins allow-list, and (being experimental) "sqlite" isn't in
// that list — a static import resolves to the bare, nonexistent "sqlite"
// package under vitest. getBuiltinModule reads directly from the running
// Node process, bypassing that resolution path entirely.
const { DatabaseSync: DatabaseSyncCtor } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

// node:sqlite's DatabaseSync is fully synchronous — there is no await
// boundary between statements, so read-check-then-write sequences in the
// repos (see generations-repo.ts's per-session limit check) cannot be
// interleaved by another request the way async JSON read/modify/write
// (as used by the Lab's storage.ts) can. This is why product persistence
// uses SQLite rather than another hand-rolled JSON file.
let db: DatabaseSync | null = null;

function migrate(instance: DatabaseSync): void {
  instance.exec("PRAGMA foreign_keys = ON");
  instance.exec(SCHEMA_SQL);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(PRODUCT_DATA_DIR, { recursive: true });
  mkdirSync(PRODUCT_RESULTS_DIR, { recursive: true });
  db = new DatabaseSyncCtor(PRODUCT_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/** Test-only: point subsequent getDb() calls at a fresh, isolated in-memory database. */
export function useInMemoryDbForTests(): DatabaseSync {
  db?.close();
  db = new DatabaseSyncCtor(":memory:");
  migrate(db);
  return db;
}
