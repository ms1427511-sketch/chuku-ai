// Internal-auth choke point for every /internal/* route (Phase 4.1B — MEKKY
// backend <-> Chuku AI service). This is a *service* credential, not a
// customer credential: it authenticates "this caller is MEKKY's dispatcher",
// nothing more. It must never be treated as proof of who owns a particular
// externalOwnerId/externalSessionId/externalGenerationId — those remain
// opaque, MEKKY-supplied identifiers that carry no authorization weight
// here. Chuku makes zero customer-authorization decisions; MEKKY remains
// solely responsible for ownership. See docs/architecture.md and
// Phase 4.1B mission sections 4 and 9.
import { timingSafeEqual, createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, hasInternalAuthSecret, MIN_INTERNAL_AUTH_SECRET_LENGTH } from "../config/env.ts";
import { InternalAuthError } from "../../shared/errors.ts";
import { handleError } from "../routes/http-errors.ts";

export const INTERNAL_AUTH_HEADER = "x-internal-auth";

/**
 * Fixed-length digest comparison: avoids both a length-based timing leak
 * (timingSafeEqual throws/short-circuits on mismatched buffer lengths) and
 * ever needing to branch on `.length` before the constant-time compare.
 */
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Fails closed: with no configured secret (or one below the minimum
 * reasonable length) in a non-test runtime, every /internal/* request is
 * rejected — there is no "auth disabled" mode. Tests inject a secret via
 * process.env.CHUKU_INTERNAL_AUTH_SECRET before importing config, exactly
 * like other env-driven config in this codebase (config/env.ts).
 */
export function internalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Uses handleError() directly (rather than next(err)) so the
  // ChukuError -> HTTP status mapping in http-errors.ts is honored here;
  // the app-level fallback error handler in index.ts always answers 500.
  if (!hasInternalAuthSecret()) {
    handleError(res, new InternalAuthError("CHUKU_INTERNAL_AUTH_SECRET is not configured"));
    return;
  }
  const provided = req.header(INTERNAL_AUTH_HEADER);
  if (!provided) {
    handleError(res, new InternalAuthError("missing internal auth header"));
    return;
  }
  // config.internalAuthSecret is non-null here: hasInternalAuthSecret()
  // already confirmed it is set and meets MIN_INTERNAL_AUTH_SECRET_LENGTH.
  const secret = config.internalAuthSecret as string;
  if (provided.length < MIN_INTERNAL_AUTH_SECRET_LENGTH || !safeEqual(provided, secret)) {
    // Never log `provided` — even a rejected value could be a mistyped
    // real secret pasted into the wrong field.
    handleError(res, new InternalAuthError("invalid internal auth header"));
    return;
  }
  next();
}
