# Handoff: clean-code pass

A review of the webhook trigger work refactored three things and raised four decisions, all four now
settled. Nothing is deployed. `pnpm check` passes: 189 tests across 16 files, typecheck and format
clean.

`docs/handoff-webhook-trigger.md` covers what the webhook trigger does and how to deploy it. This
doc covers what the review changed and what was decided.

## What the refactor changed

| File                                                  | Change                                                  |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `src/amplifier/settle.ts`                             | Now holds `StillPublishingError`.                       |
| `src/amplifier/StillPublishingError.ts`               | Deleted.                                                |
| `src/amplifier/checkPosts.ts`                         | Imports the error from `./settle.js`.                   |
| `test/checkPosts.test.ts`, `test/handleEvent.test.ts` | Import the error from `../src/amplifier/settle.js`.     |
| `src/typefully/webhook.ts`                            | `equals` renamed to `timingSafeEquals`.                 |
| `scripts/webhook-post.ts`                             | Rejects a draft id argument that is not a whole number. |
| `docs/handoff-webhook-trigger.md`                     | File table drops the deleted path.                      |

`StillPublishingError.ts` was the only PascalCase file in a repo of camelCase ones, and the class is
the settle rule's outcome, so it moved next to `settleDeadlineMs` and `pendingForDraft`.

Behavior is unchanged except in `scripts/webhook-post.ts`. `Number("abc")` produced `NaN`, which
serialized to `"id": null`, so the receiver read the event as a plain window rescan while the script
printed 202.

## The README and Blueprint edits

Committed alongside the refactor, and not part of the review:

- `README.md` gained the Deploy to Render button, a `### Creating the Workflow service` section with
  the CLI and Dashboard paths, and the note that the build command has to install pnpm first.
- `render.yaml` corrects the `amplifier-kv` comment. The Workflow service has to share the
  workspace and the region, not the project and the environment.

## Decisions made

### AMPLIFIER_SETTLE_MINUTES is capped at the retry budget

`loadConfig` now rejects a settle window wider than the retry budget on `amplifier.handleEvent`.
Set the variable to 30 and every event for an in-flight draft used to exhaust its retries, so the
post got no note and nothing reported it. `src/amplifier/retry.ts` holds
`HANDLE_EVENT_RETRY` and computes `MAX_SETTLE_MINUTES` from it, so changing the retry policy moves
the cap with it. A value that works today is now a startup error.

### The note names a dropped platform

`renderNote` takes `droppedPlatforms` and adds a line like `_X had not published yet, so there is no
link for it._` under the links. `checkPosts` passes the settle result to the group that holds the
event's draft, and only that group, because no other draft went through the settle check. Without
the line, nobody in `#amplify` learns the note is missing a link.

### The signature has a 15-minute replay window

`verify` rejects a timestamp more than 15 minutes from the receiver's clock, on either side. Stripe
and Slack both use 5 minutes; the wider window covers Typefully's hour-long delivery retries, since
whether it re-signs each attempt is unconfirmed. The check runs after the HMAC compare, so only a
delivery signed with the secret can write the rejection log, and the log carries the header value
and the measured skew. No delivery has been captured yet, so a timestamp unit that differs from the
OpenAPI document will show up there.

### Access control on the receiver is unchanged

The Typefully signature stays the single control on `POST /webhooks/typefully`, and `DISPATCH_TOKEN`
stays unset so `POST /tasks/:task` answers 401 to everything. Signature-only gating is the standard
shape for a webhook receiver. Confirm the header names against the first real delivery, which the
webhook handoff already calls for.

## Still not deployed

`docs/handoff-webhook-trigger.md` has the four Dashboard and Typefully steps, and README
`## Deployment` has the full sequence. No delivery has reached the receiver, so the header names and
the signed-payload construction in `verify` are still unconfirmed against real Typefully traffic.

The Deploy to Render button applies `render.yaml` and is deployment step 4:

```
https://render.com/deploy?repo=https://github.com/Ho1yShif/amplifier
```

It redirects to `dashboard.render.com/blueprint/new`. The repo is private, so the link works only
for a workspace that already has GitHub access to it, which is deployment step 1.

## Local environment

pnpm needs Node 22.13 or newer, and `node` resolves to 22.12.0 in this checkout by default.
`.node-version` pins 22.20.0, which is not installed on this machine. `fnm use 22.23.1` runs the
suite.
