import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GenerationFailureCategory } from "../../shared/types.ts";
import { MissingProviderCredentialError } from "../../shared/errors.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { CreateGenerationInput, GenerationJob, GenerationStatus, HairstyleProvider } from "./hairstyle-provider.ts";

const BASE_URL = "https://api.lightxeditor.com/external/api/v2";
const MAX_UPLOAD_BYTES = 5_242_880; // documented 5MB cap, docs/lightx.md

// LightX's own documented job ceiling is 5 retries at ~3s apart
// (docs/lightx.md). This adapter still enforces its own independent
// bound rather than trusting that number alone.
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 20; // ~60s hard ceiling, comfortably above the documented ~15s average

interface LightXEnvelope<T> {
  statusCode: number;
  message: string;
  body: T;
}

function mimeFor(filePath: string): "image/jpeg" | "image/png" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  throw new Error(`unsupported extension for LightX upload: ${ext}`);
}

function categorizeHttpError(status: number, code: number | undefined): GenerationFailureCategory {
  if (status === 403) return "provider_auth";
  if (status === 400) return "provider_bad_request";
  switch (code) {
    case 5040:
      return "provider_credits_exhausted";
    case 5041:
      return "unsafe_prompt";
    case 5047:
      return "invalid_portrait";
    case 5044:
    case 5046:
      return "provider_error";
    default:
      return "provider_error";
  }
}

export class LightXHairstyleProvider implements HairstyleProvider {
  private readonly apiKey: string | null;

  constructor(apiKey: string | null) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new MissingProviderCredentialError();
    return { "content-type": "application/json", "x-api-key": this.apiKey };
  }

  private async request<T>(url: string, body: unknown): Promise<LightXEnvelope<T>> {
    // Resolved outside the try block so a missing-credential failure
    // (MissingProviderCredentialError) propagates as itself — fails
    // closed with a distinct, identifiable error — rather than being
    // miscategorized as a generic network_error below.
    const headers = this.headers();
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new ProviderCallError("network_error", sanitizeErrorMessage(message, this.apiKey));
    }
    const json = (await response.json().catch(() => null)) as LightXEnvelope<T> | { statusCode?: number } | null;
    if (!response.ok || !json || (json as LightXEnvelope<T>).statusCode >= 4000) {
      const code = (json as { statusCode?: number } | null)?.statusCode;
      const category = categorizeHttpError(response.status, code);
      const rawMessage = (json as { message?: string } | null)?.message ?? `HTTP ${response.status}`;
      throw new ProviderCallError(category, sanitizeErrorMessage(rawMessage, this.apiKey));
    }
    return json as LightXEnvelope<T>;
  }

  async createGeneration(input: CreateGenerationInput): Promise<GenerationJob> {
    const bytes = await readFile(input.sourceImagePath);
    const size = (await stat(input.sourceImagePath)).size;
    if (size > MAX_UPLOAD_BYTES) {
      throw new ProviderCallError("provider_bad_request", `source image exceeds LightX's documented 5MB limit (${size} bytes)`);
    }
    const contentType = mimeFor(input.sourceImagePath);

    const uploadEnvelope = await this.request<{ uploadImage: string; imageUrl: string; size: number }>(
      `${BASE_URL}/uploadImageUrl`,
      { uploadType: "imageUrl", size, contentType },
    );

    let putResponse: Response;
    try {
      putResponse = await fetch(uploadEnvelope.body.uploadImage, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: new Uint8Array(bytes),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new ProviderCallError("network_error", sanitizeErrorMessage(message, this.apiKey));
    }
    if (!putResponse.ok) {
      throw new ProviderCallError("provider_error", `LightX S3 upload failed with HTTP ${putResponse.status}`);
    }

    const jobEnvelope = await this.request<{ orderId: string; status: string }>(`${BASE_URL}/hairstyle`, {
      imageUrl: uploadEnvelope.body.imageUrl,
      textPrompt: input.prompt,
    });

    return {
      provider: "lightx",
      externalJobId: jobEnvelope.body.orderId,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
  }

  async getGeneration(jobId: string): Promise<GenerationStatus> {
    const envelope = await this.request<{ orderId: string; status: string; output?: string }>(`${BASE_URL}/order-status`, {
      orderId: jobId,
    });
    const status = envelope.body.status;
    if (status === "active") {
      return {
        provider: "lightx",
        externalJobId: jobId,
        status: "completed",
        resultUrl: envelope.body.output ?? null,
        failureCategory: null,
        failureMessage: null,
      };
    }
    if (status === "failed") {
      return {
        provider: "lightx",
        externalJobId: jobId,
        status: "failed",
        resultUrl: null,
        failureCategory: "provider_error",
        failureMessage: "LightX reported status=failed for this order",
      };
    }
    return { provider: "lightx", externalJobId: jobId, status: "processing", resultUrl: null, failureCategory: null, failureMessage: null };
  }

  /** Bounded poll loop used by the generation service — never indefinite. */
  async pollUntilTerminal(jobId: string): Promise<GenerationStatus> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const current = await this.getGeneration(jobId);
      if (current.status !== "processing") return current;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return {
      provider: "lightx",
      externalJobId: jobId,
      status: "failed",
      resultUrl: null,
      failureCategory: "provider_timeout",
      failureMessage: `polling exceeded ${POLL_MAX_ATTEMPTS} attempts at ${POLL_INTERVAL_MS}ms`,
    };
  }
}

export class ProviderCallError extends Error {
  readonly category: GenerationFailureCategory;

  constructor(category: GenerationFailureCategory, message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.category = category;
  }
}
