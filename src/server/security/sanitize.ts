// Central choke point for anything derived from a provider error/response
// before it can reach a log line, an API response, or local metadata JSON.
// Nothing that passes through here may contain the API key, an
// Authorization/x-api-key header value, or a raw provider response body.

const SECRET_KEY_PATTERN = /x-api-key|authorization/i;

export function sanitizeErrorMessage(message: string, apiKey: string | null): string {
  let out = message;
  if (apiKey) {
    out = out.split(apiKey).join("[redacted]");
  }
  return out;
}

export function assertNoSecretHeaders(headers: Record<string, unknown>): void {
  for (const key of Object.keys(headers)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`refusing to log/persist a header that may carry a secret: ${key}`);
    }
  }
}

/** Strips any accidental provider-secret-shaped fields before persisting local JSON metadata. */
export function sanitizeForLocalStorage<T extends Record<string, unknown>>(obj: T): T {
  const clone = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    if (SECRET_KEY_PATTERN.test(key) || key === "apiKey" || key === "headers") {
      delete clone[key];
    }
  }
  return clone as T;
}
