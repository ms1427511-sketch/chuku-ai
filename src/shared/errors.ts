// Local, sanitized error shapes. Never wraps or forwards raw provider
// error bodies/headers — see server/security/sanitize.ts.

export class ChukuError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ChukuError";
    this.code = code;
  }
}

export class GenerationLimitReachedError extends ChukuError {
  constructor(limit: number) {
    super(`Generation hard cap reached (${limit}).`, "GENERATION_LIMIT_REACHED");
  }
}

export class UnknownHairstyleError extends ChukuError {
  constructor(hairstyleId: string) {
    super(`Unknown hairstyle id: ${hairstyleId}`, "UNKNOWN_HAIRSTYLE");
  }
}

export class UnknownPortraitError extends ChukuError {
  constructor(source: string) {
    super(`Unknown portrait id: ${source}`, "UNKNOWN_PORTRAIT");
  }
}

export class InvalidImagePathError extends ChukuError {
  constructor(reason: string) {
    super(`Invalid image path: ${reason}`, "INVALID_IMAGE_PATH");
  }
}

export class UnsupportedImageTypeError extends ChukuError {
  constructor(mime: string) {
    super(`Unsupported image type: ${mime}`, "UNSUPPORTED_IMAGE_TYPE");
  }
}

export class MissingProviderCredentialError extends ChukuError {
  constructor() {
    super("LIGHTX_API_KEY is not configured.", "MISSING_PROVIDER_CREDENTIAL");
  }
}

// ---------------------------------------------------------------------------
// Product session/generation errors (Core Productization phase) — see
// docs/error-model.md for the full code list and route error-status mapping.

export class SessionNotFoundError extends ChukuError {
  constructor(id: string) {
    super(`No session with id ${id}`, "SESSION_NOT_FOUND");
  }
}

export class SourceRequiredError extends ChukuError {
  constructor() {
    super("This session has no source portrait set yet.", "SOURCE_REQUIRED");
  }
}

export class InvalidSourceError extends ChukuError {
  constructor(sourcePortraitId: string) {
    super(`Invalid source portrait id: ${sourcePortraitId}`, "INVALID_SOURCE");
  }
}

export class UnknownStyleError extends ChukuError {
  constructor(styleId: string) {
    super(`Unknown style id: ${styleId}`, "UNKNOWN_STYLE");
  }
}

export class GenerationNotFoundError extends ChukuError {
  constructor(id: string) {
    super(`No generation with id ${id}`, "GENERATION_NOT_FOUND");
  }
}

export class GenerationInProgressError extends ChukuError {
  constructor(id: string) {
    super(`Generation ${id} has not completed yet.`, "GENERATION_IN_PROGRESS");
  }
}

export class ResultExpiredError extends ChukuError {
  constructor(id: string) {
    super(`The result for generation ${id} has expired and was removed.`, "RESULT_EXPIRED");
  }
}

export class InvalidOperationError extends ChukuError {
  constructor(reason: string) {
    super(reason, "INVALID_OPERATION");
  }
}

// ---------------------------------------------------------------------------
// Internal (MEKKY <-> Chuku) integration errors — Phase 4.1B. See
// docs/architecture.md and server/routes/internal.ts. Never expose provider
// details through these; see safe-error-code mapping in
// services/internal-safe-error-mapping.ts.

export class InternalAuthError extends ChukuError {
  constructor(reason: string) {
    super(`internal auth failed: ${reason}`, "INTERNAL_AUTH_FAILED");
  }
}

/** Same externalGenerationId reused for a materially different request — see docs on request_fingerprint. */
export class ExternalGenerationConflictError extends ChukuError {
  constructor(externalGenerationId: string) {
    super(
      `externalGenerationId ${externalGenerationId} was already used for a different request`,
      "EXTERNAL_GENERATION_CONFLICT",
    );
  }
}

export class SourceFetchError extends ChukuError {
  constructor(reason: string) {
    super(`source fetch failed: ${reason}`, "SOURCE_FETCH_FAILED");
  }
}
