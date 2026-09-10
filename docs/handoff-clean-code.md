# Handoff: clean-code pass

A review of the webhook trigger work refactored three things and left four decisions open. Nothing
is deployed. `pnpm check` passes: 180 tests across 16 files, typecheck and format clean.

`docs/handoff-webhook-trigger.md` covers what the webhook trigger does and how to deploy it. This
doc covers what the review changed and what still needs a decision.

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

## Decisions to make

### AMPLIFIER_SETTLE_MINUTES has no upper bound

`loadConfig` validates `min: 0` and no maximum, while the retry policy on `amplifier.handleEvent`
gives a 15-minute budget across four retries at 1m, 2m, 4m, and 8m. Set the variable to 30 and every
event for an in-flight draft exhausts its retries, so the post gets no note and nothing reports it.
`whole()` already takes a `max`, so the fix is `max: 15` at `src/config.ts:104`. I left it out
because it turns a value that works today into a startup error.

### A dropped platform only reaches the logs

When the settle deadline passes, `checkPosts.ts:97` warns, `droppedPlatforms` goes into the result,
and the note reaches Slack without the X or LinkedIn link. `markAnnounced` then covers the draft, so
the missing link is never announced later. Nobody in `#amplify` learns the note is incomplete.
Naming the dropped platform in the note text would tell them, and that changes the note.

### The signature has no replay window

`verify` folds the timestamp into the HMAC but never checks its age, so a captured delivery stays
valid forever. `docs/typefully-webhook.md` records this as deliberate, and the reasoning holds: a
replay re-scans the same window, the seen markers make it announce nothing, and rejecting on clock
skew would drop a real delivery. Stripe and Slack both reject a timestamp older than a few minutes.
A tolerance of 15 minutes would cover skew and still bound the replay.

### Access control on the receiver

The receiver holds a `RENDER_API_KEY` that can start workflow runs, and `POST /webhooks/typefully`
is gated only by the Typefully signature. `DISPATCH_TOKEN` is unset on purpose, which shuts
`POST /tasks/:task`. That is the right shape, and it makes the signing secret the single control, so
confirming the header names against the first real delivery matters as much as the webhook handoff
says.

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
