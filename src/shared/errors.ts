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
