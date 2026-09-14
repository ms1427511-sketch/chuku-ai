import type { Response } from "express";
import { ChukuError } from "../../shared/errors.ts";

// Central choke point: every route maps a ChukuError to a stable HTTP
// status + { error: code, message } body. Anything else (unexpected throw)
// becomes a generic 500 — a raw stack trace or provider payload must never
// reach the response body. See docs/error-model.md.
function errorStatus(code: string): number {
  switch (code) {
    case "SESSION_NOT_FOUND":
    case "GENERATION_NOT_FOUND":
    case "UNKNOWN_HAIRSTYLE":
    case "UNKNOWN_PORTRAIT":
    case "UNKNOWN_STYLE":
      return 404;
    case "GENERATION_LIMIT_REACHED":
      return 429;
    case "SOURCE_REQUIRED":
    case "INVALID_SOURCE":
    case "INVALID_IMAGE_PATH":
    case "UNSUPPORTED_IMAGE_TYPE":
    case "INVALID_OPERATION":
    case "GENERATION_IN_PROGRESS":
      return 400;
    case "RESULT_EXPIRED":
      return 410;
    case "MISSING_PROVIDER_CREDENTIAL":
    case "PROVIDER_TEMPORARY_FAILURE":
      return 503;
    default:
      return 500;
  }
}

export function handleError(res: Response, error: unknown): void {
  if (error instanceof ChukuError) {
    res.status(errorStatus(error.code)).json({ error: error.code, message: error.message });
    return;
  }
  // Never forward a raw provider error/stack trace to the client.
  res.status(500).json({ error: "INTERNAL_ERROR", message: "unexpected server error" });
}
