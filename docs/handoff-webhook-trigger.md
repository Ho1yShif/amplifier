# Handoff: webhook trigger

The webhook trigger in `plan.md` is implemented and committed on `main`, from `1a32dcd` through
`def34fd`. Nothing is deployed. The receiver has never received a delivery from Typefully.

## What shipped

The 30-minute cron trigger is gone. Typefully now posts to a Render web service, which verifies the
delivery and starts `amplifier.handleEvent` on the Workflow service.

| Area           | Files                                                                 |
| -------------- | --------------------------------------------------------------------- |
| Receiver       | `src/webhook-server.ts`, `src/typefully/webhook.ts`                   |
| Retried task   | `src/amplifier/handleEvent.ts`                                        |
| Settle rule    | `src/amplifier/settle.ts`, the check in `src/amplifier/checkPosts.ts` |
| Infrastructure | `render.yaml`, `.env.example`                                         |
| Findings       | `docs/typefully-webhook.md`                                           |

`amplifier.checkPosts` still exists with no retry policy, so a manual dispatch and
`scripts/local-run.ts` behave as they did before.

`pnpm check` passes: 180 tests across 16 files, typecheck and format clean.

## What is left to do

Everything below happens in the Render Dashboard or the Typefully UI. README `## Deployment` has
the full sequence; these are the steps that did not exist before this change.

1. Apply `render.yaml`. It creates `amplifier-webhook` in place of `amplifier-cron`. Delete the old
   cron service if the apply leaves it behind.
2. Copy the `amplifier-webhook` service's `onrender.com` URL, append `/webhooks/typefully`, and
   register it in Typefully under Settings > API, subscribed to `draft.published`.
3. Copy the signing secret Typefully shows into `TYPEFULLY_WEBHOOK_SECRET` in the
   `amplifier-triggers` env group. The secret does not exist until step 2, so the order matters.
4. Publish a test draft with `DRY_RUN=true` and read the Workflow logs before setting it to `false`.

## Confirm the signature against a real delivery

`verify` is built from Typefully's live OpenAPI document at
`https://api.typefully.com/v2/openapi.json`, not from a captured delivery. The document specifies
`X-Typefully-Signature` as `sha256=<hex>` over `` `${timestamp}.${rawBody}` ``. See
`docs/typefully-webhook.md`.

Check the first real delivery in the receiver's logs. A wrong header name or a wrong signed-payload
construction fails closed: every delivery gets a 401, no run starts, and no note goes to `#amplify`.
Nothing else reports the problem, because the webhook is the only trigger.

Typefully disables a webhook after 100 consecutive failures and sends an email.

## Open questions

Whether a draft cross-posted to X and LinkedIn fires one `draft.published` event or two is
unconfirmed. The settle rule handles both. One event that sees a single permalink throws and the
retry re-reads Typefully a minute later; a second event for the same draft finds the seen marker and
announces nothing.

`GET /v2/webhooks` returns the registered webhooks but is absent from the OpenAPI paths. There is no
documented way to create one over the API, so registration stays a manual step.

## Local verification

The receiver, with no Render credentials:

```bash
pnpm build
PORT=3000 WORKFLOW_SLUG=x RENDER_API_KEY=rnd_fake TYPEFULLY_WEBHOOK_SECRET=whsec_local \
  pnpm trigger:serve &
TYPEFULLY_WEBHOOK_SECRET=whsec_local pnpm webhook:post 101
```

A correct secret returns 202 against a real dispatcher and 502 against a fake `RENDER_API_KEY`,
because the signature and the mapping both passed and only the dispatch failed. A wrong secret
returns 401. `RENDER_API_KEY` has to be set to something or the process exits at startup.

The announce-once path, unchanged by this work:

```bash
redis-server &
pnpm stub &
pnpm local:run 2
```

Run 1 reports `notified: 2`, run 2 reports `notified: 0` and `skipped: 2`.

## Design decisions

A dropped delivery means a post nobody announces. The retry policy on `amplifier.handleEvent` covers
failures after an event arrives, not an event that never arrives. README `### Manual re-run` has the
command for that case.

`AMPLIFIER_SETTLE_MINUTES` defaults to 10 and must stay under 15. The four retries at 1m, 2m, 4m,
and 8m give a 15-minute budget, so a longer settle window makes the retries run out first and the
event is lost with no note.

`DISPATCH_TOKEN` is unset on purpose, which makes `POST /tasks/:task` answer 401 to everything.
Amplifier does not use that route.

## Local environment

pnpm refuses to run on Node 22.12, which is what `node` resolves to in this checkout by default.
`.node-version` pins 22.20.0. Use `fnm use` or put a 22.20+ install first on `PATH`.
