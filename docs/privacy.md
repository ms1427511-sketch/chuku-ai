# Chuku AI Lab — Privacy Notes (Provisional)

**This document is a provisional engineering recommendation, not final
legal or privacy advice.** Every retention figure and policy point below is
marked `REQUIRES PRODUCT/PRIVACY APPROVAL` and must be reviewed by whoever
owns MEKKY's privacy/legal decisions before any of this informs a real
product feature.

This document describes privacy considerations for a **future** MEKKY
product integration of AI hairstyle generation. Nothing in this Phase 4.0
Lab processes real customer photos — see `docs/benchmark.md` for the
synthetic-portraits-only rule that applies to this Lab itself.

## What would be processed, in a real integration

- A customer's source portrait photo (a photo of their own face/hair).
- One or more AI-generated result images derived from that source photo
  and a selected hairstyle.
- Metadata: which hairstyle was requested, when, generation status,
  latency — no biometric analysis beyond what LightX itself performs to
  generate the image.

## Consent

`REQUIRES PRODUCT/PRIVACY APPROVAL`. Recommended baseline: explicit,
specific consent captured before the first photo upload, clearly stating
that the photo will be sent to a third-party AI provider (LightX, or
whichever provider is live at the time) for processing, separate from any
general app-usage consent.

## AI processing disclosure

`REQUIRES PRODUCT/PRIVACY APPROVAL`. Recommended baseline: the UI must
disclose, before upload, that (a) the photo is sent to a third-party AI
service, (b) the result is AI-generated and may not be perfectly accurate,
and (c) the customer controls whether any AI-generated image is ever shown
to salon staff (see "Customer-controlled sharing" below).

## Storage and access

- Source photos and generated results should be treated as **private to
  the customer** by default — not visible to staff, not visible to other
  customers, not part of any public profile.
- Any stored copy (source or result) should be served only via
  short-lived, signed access (e.g. a signed URL or an authenticated
  endpoint scoped to that customer), never a permanently public URL.
- `REQUIRES PRODUCT/PRIVACY APPROVAL`: exact storage backend, access
  control mechanism, and signing scheme are product/infra decisions for
  Phase 4.1+, not decided by this Lab.

## Retention (provisional recommendation only)

- Source photo: retain approximately **24 hours**, then delete, unless the
  customer takes an explicit action to keep it (e.g. saving it for a future
  visit).
- Generated results: retain approximately **24–72 hours**, then delete,
  unless the customer explicitly saves/favorites a specific result.
- These figures are a starting engineering recommendation only —
  `REQUIRES PRODUCT/PRIVACY APPROVAL` before being treated as policy.

## Deletion

- Customers should be able to request deletion of their source photo and
  any generated results at any time, with deletion actually removing the
  files (not just hiding them in a UI), within a reasonable, disclosed
  timeframe.
- `REQUIRES PRODUCT/PRIVACY APPROVAL`: exact deletion SLA and whether
  deletion also needs to be requested from the AI provider's side (LightX's
  own data retention on their infrastructure is outside this project's
  control — see `docs/lightx.md`, no documented retention window was
  found for LightX-hosted result URLs).

## Customer-controlled sharing (future product flow, not built here)

Per the intended future MEKKY UX (documented, not implemented, in this
phase): an AI-generated hairstyle result must **never** be exposed to
salon staff automatically. Sharing requires an explicit customer action —
e.g. "Share with Barber" or "Attach to Appointment" — after the customer
has already seen and chosen the result themselves.

## Provider data handling

LightX is a third-party processor. This project's own code does not
persist the API key or raw provider response bodies (see
`docs/architecture.md` → "Secret handling"), but LightX's own handling of
uploaded photos on their infrastructure is governed by LightX's terms, not
by this project — `REQUIRES PRODUCT/PRIVACY APPROVAL` to confirm LightX's
own data processing terms are acceptable for real customer photos before
any production integration.
