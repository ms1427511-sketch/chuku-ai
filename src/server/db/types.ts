// Raw SQLite row shapes — server-internal only. Never returned directly
// from an API route; routes map these to the public DTOs in
// src/shared/types.ts (ChukuSession / ProductGeneration), which
// deliberately omit provider-specific fields (provider, provider_job_id,
// failure_message) — see docs/integration-contract.md.

export interface SessionRow {
  id: string;
  source_portrait_id: string | null;
  external_owner_id: string | null;
  favorite_generation_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface GenerationRow {
  id: string;
  session_id: string;
  operation_id: string;
  style_id: string;
  provider: string;
  provider_job_id: string | null;
  generation_index: number;
  status: string;
  source_portrait_id: string;
  result_path: string | null;
  retry_of: string | null;
  retry_count: number;
  safe_error_code: string | null;
  failure_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  latency_ms: number | null;
  expires_at: string | null;
}
