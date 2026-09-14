// Idempotent product-persistence schema — safe to run on every startup.
// Separate from the Lab/benchmark JSON history (storage.ts,
// benchmark/results/generations.json), which this schema never touches.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source_portrait_id TEXT,
  external_owner_id TEXT,
  favorite_generation_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  operation_id TEXT NOT NULL,
  style_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'lightx',
  provider_job_id TEXT,
  generation_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  source_portrait_id TEXT NOT NULL,
  result_path TEXT,
  retry_of TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  safe_error_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  latency_ms INTEGER,
  expires_at TEXT,
  UNIQUE (session_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_generations_session ON generations(session_id);
CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions(status, expires_at);
`;
