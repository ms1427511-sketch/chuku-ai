# LightX API — Verified Findings (Hairstyle Endpoint)

Researched 2026-09-13 directly from LightX's own documentation and marketing
pages. Everything below is either a direct quote/transcription of what those
pages state, or explicitly marked as unconfirmed. Nothing here is guessed.

Primary sources:
- https://docs.lightxeditor.com/ (API docs portal)
- https://docs.lightxeditor.com/api/ai-hairstyle (hairstyle endpoint docs)
- https://docs.lightxeditor.com/authentication
- https://docs.lightxeditor.com/error-codes
- https://www.lightxeditor.com/api/ai-hairstyle/ (marketing/overview page)
- https://www.lightxeditor.com/pricing/ (pricing page)

## Two documented endpoint versions

The marketing overview page (`lightxeditor.com/api/ai-hairstyle/`) shows a
simpler, older-looking sample hitting `v1/hairstyle` directly with an
`imageUrl` + `textPrompt` body and no mention of upload/polling steps. The
structured API docs portal (`docs.lightxeditor.com`) documents a newer,
more complete `v2` flow with an explicit upload step and an async
order/status pattern. **This project targets v2** as canonical, since it is
the fuller, more recently structured documentation and matches the
async/job-based behavior we need to design around regardless. If v2 ever
errors as unrecognized, v1 is the documented fallback shape (same auth
header, same `imageUrl`/`textPrompt` body, synchronous-looking response) —
see `LightXHairstyleProvider`'s fallback note in code.

## Step 1 — Get a pre-signed upload URL

```
POST https://api.lightxeditor.com/external/api/v2/uploadImageUrl
Headers:
  Content-Type: application/json
  x-api-key: <your API key>

Body:
{
  "uploadType": "imageUrl",
  "size": 791436,           // image size in bytes, documented max 5,242,880 (5MB)
  "contentType": "image/jpeg" // "image/jpeg" or "image/png"
}
```

Response:
```json
{
  "statusCode": 2000,
  "message": "SUCCESS",
  "body": {
    "uploadImage": "<pre-signed S3 PUT URL>",
    "imageUrl": "https://d3aa3s3yhl0emm.cloudfront.net/apikey/....jpeg",
    "size": 791436
  }
}
```

## Step 1.1 — Upload the image bytes

```
PUT <uploadImage URL from step 1>
Headers:
  Content-Type: image/jpeg (or image/png, matching the declared contentType)
Body: raw binary image bytes, same size as declared in step 1
```

No `x-api-key` header on this call — auth is embedded in the pre-signed S3
URL's query parameters (`X-Amz-*`). `body.imageUrl` from step 1 is what you
pass to step 2 as the source image, once step 1.1 has completed.

## Step 2 — Create the hairstyle generation job

```
POST https://api.lightxeditor.com/external/api/v2/hairstyle
Headers:
  Content-Type: application/json
  x-api-key: <your API key>

Body:
{
  "imageUrl": "https://example.com/your-image.jpg",
  "textPrompt": "YourInputPrompt"
}
```

Response (job created, not the result yet):
```json
{
  "statusCode": 2000,
  "message": "SUCCESS",
  "body": {
    "orderId": "7906da5353b504162db5199d6",
    "maxRetriesAllowed": 5,
    "avgResponseTimeInSec": 15,
    "status": "init"
  }
}
```

This is asynchronous / job-based: creating the job does not return the
result. You must poll.

## Step 2.1 — Poll job status

```
POST https://api.lightxeditor.com/external/api/v2/order-status
Headers:
  Content-Type: application/json
  x-api-key: <your API key>

Body:
{
  "orderId": "<orderId from step 2>"
}
```

Response:
```json
{
  "statusCode": 2000,
  "message": "SUCCESS",
  "body": {
    "orderId": "7906da5353b504162db5199d6",
    "status": "active",
    "output": "https://example.com/your-outputimage.jpg"
  }
}
```

Documented polling behavior: poll roughly every 3 seconds, up to
`maxRetriesAllowed` (5) retries, until `status` becomes `"active"` (success,
`output` populated) or `"failed"` (error). Documented average response time
is ~15 seconds (`avgResponseTimeInSec`). This project's provider adapter
polls with a bounded loop and a hard timeout, never indefinitely.

## Result URL / expiration

The `output` URL is a hosted result image URL. **No documented expiration
window was found** for either the CloudFront-hosted uploaded source image
or the generated result URL. Because of this, and per this project's own
"no permanent cloud persistence" rule, the provider adapter downloads the
result to local disk (`test-images/results/...`) immediately rather than
treating the LightX-hosted URL as durable storage.

## Authentication

- Header: `x-api-key: <your API key>` — this exact header name appears in
  every concrete request example across both the `docs.lightxeditor.com`
  and `lightxeditor.com` pages, for all three calls above.
- The general authentication page (`docs.lightxeditor.com/authentication`)
  does not itself name the header, but explicitly instructs: "incorporate
  your API key into the authorization header of every API request", "never
  share your API key publicly or embed it in any client-side code", and
  "ensure that all production requests are routed through your backend
  server" — directly matching this project's server-only key rule.
- Obtained via the LightX API Dashboard ("Generate Your API Key" button).
  Resettable from the dashboard if compromised.

## Error codes (from `docs.lightxeditor.com/error-codes`)

| Code | Name | Meaning | Credits |
|---|---|---|---|
| 5040 | API_CREDITS_CONSUMED | Credit limit reached | Purchase/allocate more |
| 5041 | INVALID_PROMPTS_DETECTED | Restricted/unsafe words in prompt | No credits deducted |
| 5044 | (unnamed) | "Unable to process" | No credit deducted |
| 5046 | ERROR_IN_GETTING_RESPONSE | Generic processing issue | Not stated |
| 5047 | INVALID_HUMAN_PORTRAIT | No human face detected in image | Not stated |
| 404 | (HTTP) | Resource not found | Not stated |
| 403 | Forbidden | x-api-key missing or incorrect | Not stated |
| 400 | Bad Request | Invalid request body/format | Not stated |

`5047 INVALID_HUMAN_PORTRAIT` is directly relevant: it means LightX itself
performs face-presence validation, which is why this project does not build
custom face-detection computer vision (per spec item 15) — provider-side
validation covers it, and the adapter maps 5047 to a clear local failure
category (`invalid_portrait`) instead of a generic error.

## Rate limits

**Not publicly documented.** Neither the error-codes page nor the
authentication page states any requests-per-second/minute figure. The only
throttling-shaped fact found is the hairstyle job's own
`maxRetriesAllowed: 5` polling ceiling for a single job, which is unrelated
to account-wide rate limiting. This project's own server-side cost guard
(hard cap of 15 generations for Stage A, max 1 automatic retry) is the
actual limiting factor in practice, independent of whatever LightX-side
limit may or may not exist.

## Credits and pricing

Confirmed from `lightxeditor.com/pricing/`:
- New API accounts get **25 free credits** on signup, no card required.
- API subscription plans: from ₹579/mo for 100 credits (₹5.79/credit) up to
  ₹303,648/mo for 100,000 credits (₹3.04/credit); custom volumes available.
- API one-time ("Flexi") credit purchase: from ₹864 for 100 credits
  (₹8.64/credit) up to ₹455,472 for 100,000 credits (₹4.55/credit).
- Custom/enterprise "brand AI" plans start at $3,000 USD/month (contact
  sales) — not relevant to a benchmark-stage integration.
- A per-module credit-cost table on the pricing page explicitly lists
  Remove Background (0.5 credits), Cleanup Picture (0.5 credits), AI Avatar
  (1.0 credit), and AI Cartoon Generator (1.0 credit) — **the Hairstyle
  endpoint's specific credit cost is not listed in that table**, and no
  page found during this research states it explicitly.

**DOLLAR COST UNKNOWN** for hairstyle generations specifically: LightX
publishes credit pricing in INR, not USD, and does not publish a
hairstyle-specific credit-per-call figure anywhere found during this
research. `docs/benchmark.md`'s cost model therefore reports cost per
generation as "unknown — credit count not published for this endpoint"
rather than inventing a number. If the live benchmark runs and LightX's
dashboard shows actual credits consumed per call, that observed figure
(not a published one) will be recorded and clearly labeled as
"observed, not published."

## Supported input

- `contentType`: `image/jpeg` or `image/png` (from the upload-URL request
  schema).
- Max declared size: 5,242,880 bytes (5MB), per the `uploadImageUrl`
  request schema's `size` field.
- No documented minimum/maximum pixel dimensions were found.

## What this means for the provider adapter

`LightXHairstyleProvider` implements exactly this three/four-call sequence
(get upload URL → upload bytes → create job → poll status), maps the
documented error codes to local `GenerationFailureCategory` values, enforces
a bounded poll loop (not an unbounded one, even though LightX's own
`maxRetriesAllowed` already bounds it), and downloads the result image to
local disk immediately rather than treating the returned URL as permanent
storage.
