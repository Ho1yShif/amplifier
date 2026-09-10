# Typefully webhook deliveries

How Typefully signs a delivery and what it sends, so `src/typefully/webhook.ts` can verify one.

## Where this came from

Typefully's live OpenAPI document, `https://api.typefully.com/v2/openapi.json`, fetched on
2026-09-10. The `Webhooks` tag description in that document specifies the headers, the signature
algorithm, and the payload envelope. No delivery has been captured against a real endpoint yet.
Confirm the header names and the signed-payload construction against one real delivery before
trusting the receiver in production.

The webhook list endpoint, `GET /v2/webhooks`, exists but is not in the OpenAPI paths. It returned
an empty list for the Render account, so no webhook is registered yet. There is no documented
endpoint for creating one. Register it in the Typefully UI under Settings > API, which is also where
the signing secret comes from.

## Headers

Every delivery carries three headers:

| Header                  | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| `X-Typefully-Event`     | The event type, for example `draft.published`.          |
| `X-Typefully-Timestamp` | Unix timestamp of when the event was generated.         |
| `X-Typefully-Signature` | `sha256=<hex>`, an HMAC-SHA256 over the signed payload. |

## Verification

Typefully signs with an HMAC over the timestamp and the raw body, so `verify` recomputes it and
compares with `timingSafeEqual`. This is the preferred strategy of the three the plan listed.

The signed payload is the timestamp, a literal `.`, and the request body:

```
signature_payload = `${timestamp}.${rawBody}`
expected = "sha256=" + hmacSha256Hex(secret, signature_payload)
```

The secret is the signing secret Typefully shows when the webhook is added. It reaches the receiver
as `TYPEFULLY_WEBHOOK_SECRET`.

Sign the bytes as received. Typefully's docs note that it serializes the JSON with compact
separators and sorted keys, which matters only to a receiver that re-serializes the parsed body.
`createDispatchServer` hands `verify` the raw body, so the receiver never re-serializes.

Typefully also recommends rejecting an old timestamp to prevent replay. `verify` does not, because a
replayed delivery re-scans the same window and the announced markers in Key Value make it announce
nothing. A clock difference between Typefully and the receiver would otherwise reject real
deliveries, and a rejected delivery is a post that never gets announced.

## Payload

Two fields:

```json
{ "event": "draft.published", "data": { "...": "the full draft" } }
```

`data` is a `DraftDetailResponse`, the same shape `GET /v2/social-sets/{id}/drafts/{id}` returns and
the same one `mapDraft` already reads. It carries the draft id as `id`, the platform permalinks as
`x_published_url` and `linkedin_published_url`, the per-platform timestamps, and `published_at`.

`test/support/typefully-event.json` holds a real `draft.published` body, taken from draft 10628613
on the Render social set with the social set id and the private URL replaced.

## Event types

Seven, not the six the plan assumed. `draft.planned` is the extra one.

| Event                  | Triggered when                                        |
| ---------------------- | ----------------------------------------------------- |
| `draft.created`        | A draft is created.                                   |
| `draft.planned`        | A draft is planned: dated, but inert until confirmed. |
| `draft.scheduled`      | A draft is scheduled for publishing.                  |
| `draft.published`      | A draft is successfully published.                    |
| `draft.status_changed` | Any status transition.                                |
| `draft.tags_changed`   | Draft tags are modified.                              |
| `draft.deleted`        | A draft is deleted.                                   |

`map` returns a dispatch for `draft.published` and null for the other six, and null for a type it
does not recognize.

## Cross-posts

Whether a draft cross-posted to X and LinkedIn produces one `draft.published` event or two is not
answered by the OpenAPI document. The payload is the draft rather than the platform, so one event
per draft is the likely reading, but it is unconfirmed.

The settle rule in `src/amplifier/settle.ts` covers both readings. A first event that sees only one
permalink throws `StillPublishingError` and the retry re-reads Typefully a minute later, and a
second event for the same draft finds the seen marker and announces nothing.

## Delivery retries

Typefully retries a failed delivery with exponential backoff, four times over an hour, five attempts
in all. Any 2xx acknowledges receipt. A webhook is disabled automatically after 100 consecutive
failures, with an email, and has to be re-enabled from the API settings.
