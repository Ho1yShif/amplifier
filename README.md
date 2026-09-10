# Amplifier

Amplifier automates the process of sharing new LinkedIn and Twitter posts with the Render team. Whenever a post goes live on Twitter and/or LinkedIn, Amplifier sends a Slack note to the `#amplify` channel.

It reads published drafts from Typefully, which is where the Render Twitter and LinkedIn accounts are scheduled. A post sent to both platforms produces one note with both links.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Ho1yShif/amplifier)

The button applies `render.yaml`, which covers the webhook receiver, the Key Value instance,
and the env groups. It does not create the Workflow service, because Blueprints do not support
Workflows yet. Read [Deployment](#deployment) first; the button is step 4.

## How it works

```
   post goes live
        │
        ▼
┌────────────────────┐   POST        ┌──────────────────────────┐
│ Typefully          │ ────────────▶ │ amplifier-webhook        │
│ Settings > API     │  /webhooks/   │ web service              │
└────────────────────┘   typefully   └────────────┬─────────────┘
                                      verify, map │ dispatch
                                                  ▼
                                     ┌──────────────────────────┐
                                     │ amplifier (Workflow)     │
                                     │ amplifier.handleEvent    │
                                     └────────────┬─────────────┘
  1  typefully.listPublished ─────────────────────┼──▶ Typefully API
  2  withinWindow, then announcedDraftIds ────────┼──▶ amplifier-kv
  3  settle check for pending platforms           │
  4  groupPosts                                   │
  5  llm.complete ────────────────────────────────┼──▶ Anthropic
  6  claimGroup, one kv.lock per draft ───────────┼──▶ amplifier-kv
  7  amplifier.postNote ──────────────────────────┼──▶ Slack #amplify
  8  markAnnounced, then releaseGroup ────────────┴──▶ amplifier-kv
```

Steps 5 through 8 run once per group.

Typefully posts to the `amplifier-webhook` service when a draft publishes. The receiver verifies the delivery and starts `amplifier.handleEvent` on the amplifier Workflow service, which retries at 1m, 2m, 4m, and 8m while a platform is still publishing. That task:

1. Calls `typefully.listPublished` for published drafts in the configured social set.
2. Keeps the drafts published in the last 90 minutes, then drops the ones Render Key Value already records as announced.
3. Throws while the event's draft is enabled for a platform that has not reported a permalink, so a retry re-reads Typefully a minute later. Past the 10-minute settle deadline it announces the draft with whatever links exist.
4. Groups the rest, when they were published close together on different platforms, into one note.
5. Asks Claude Sonnet 5, through `llm.complete`, for the one line that opens the note.
6. Takes a 5-minute lock per draft.
7. Posts the note through `amplifier.postNote`.
8. Records each draft as announced for 30 days.

`amplifier.postNote` wraps the vendor's `postMessageImpl` and adds `unfurl_links: false` and `unfurl_media: false` to the request body, because `@render-lab/tasks-slack` 0.3.0 sends neither and exposes no option for them. The wrapper can go away once the vendor adds an unfurl option.

A note is that one summary line and a link per platform. Two links get bullets; one does not.

```
Cursor Origin is now a supported Git provider on Render. Help spread the word

• <https://linkedin.com/…|LinkedIn post>
• <https://x.com/…|X post>
```

A post that only went out on one platform gets no bullet:

```
Please like/share our new customer story for OpenAI

<https://x.com/…|X post>
```

When the summary call fails, the note still goes out. It opens with `AMPLIFIER_CALL_TO_ACTION`, names the reason, and quotes the draft preview.

Dedupe is per draft, not per note, so a LinkedIn post that arrives after its Twitter twin was announced still gets its own note.

Delivery is at least once. The announced marker is written after Slack accepts the note, so a run that dies in the gap between the two loses its lock within 5 minutes and the next run posts the same note again. The design accepts a duplicate note so that no note is lost.

## Local development

```bash
pnpm install
pnpm test          # unit tests, no secrets needed
cp .env.example .env
render workflows dev -- pnpm dev
# in another terminal:
render workflows tasks list --local
render workflows start amplifier.checkPosts --local --input='[{}]'
```

`DRY_RUN=true` is the default, so a local run logs the note it would post and writes nothing to Slack.

Run this before committing:

```bash
pnpm check
```

### End-to-end run with no credentials

`scripts/typefully-stub.ts` stands in for both Typefully and a Slack incoming webhook, so the whole announce-once path runs against a local Key Value with no keys:

```bash
redis-server &
pnpm stub &
pnpm local:run 2
```

The argument is how many runs to do in a row. Run 1 reports `notified: 2`. Run 2 reports `notified: 0` and `skipped: 2`, which is the announce-once guarantee holding across runs. `redis-cli --scan --pattern 'amplifier:*'` should then show two `amplifier:seen:` markers and no `amplifier:inflight:` locks.

Edit the drafts in the stub to cover other cases. Reversing them puts the oldest first, which is the failure the deployment checks below are looking for: `limit` truncates the response to the oldest drafts, every run reports `inWindow: 0`, and nothing posts without erroring.

This runs every task in one process with no retries and no timeouts, so it checks the wiring and the Key Value state, not durability. It also cannot tell you the real Typefully response shape, which is what the first deployment check is for.

The stub listens on port 8787. Set `STUB_PORT` to use a different one.

## Deployment

Applying a Blueprint, creating a Workflow service, and giving a workspace access to a private repo have no API or CLI path, so every step below except the `ping` check happens in the Render Dashboard.

1. Give the workspace that will own the project access to this repo, under Settings > GitHub. The repo is private, so Render cannot clone it until then. For the Render team, that workspace is Render-DX.
2. Create a Workflow service from this repo on branch `main`, language Node, with build `pnpm install && pnpm build` and start `node dist/main.js`. Put it in project `amplifier`, environment `Production`, region Oregon, the same as the services in `render.yaml`. The Key Value instance is reachable only over the private network within its own environment, so a Workflow service anywhere else fails to connect. Note the service's slug.
3. Run `render workflows start <slug-from-step-2>/ping --input='[]'` to confirm the task registry loaded, before any secret is set. `ping` takes no arguments, so the input array is empty, and it returns `pong`. If the task list is empty, the build shipped but `dist/main.js` registered nothing, and the deploy logs say why.
4. Apply `render.yaml`, with the Deploy to Render button above or from the Dashboard, to create the `amplifier-webhook` service, the Key Value instance, and two env groups: `amplifier-triggers` and `amplifier-workflow`. Set `RENDER_API_KEY` to a key for the workspace that owns the Workflow service, and set `WORKFLOW_SLUG` to the slug from step 2.
5. Confirm the apply landed in the project from step 2. `render.yaml` names project `amplifier` and environment `Production`, so it should. If it created a second project, move the receiver and the Key Value instance into the Workflow service's environment before going on, because the internal connection string does not resolve across environments.
6. On the Workflow service, link the `amplifier-workflow` env group and set its `ANTHROPIC_API_KEY`. The group holds the vendor keys the Workflow service reads, and it is linked in the Dashboard because Blueprints do not support Workflow services, so `render.yaml` cannot reference it. Then set `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID`, a Slack credential (see below), `DRY_RUN=true`, and `REDIS_URL` (the `amplifier-kv` internal connection string) on the service itself.
7. Confirm the link took: the Workflow service's environment page lists `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5` from the group. If it does not, the group exists but is not linked, and every note will carry `(Summarization LLM call failed)`.
8. Register the receiver in Typefully. Copy the `amplifier-webhook` service's `onrender.com` URL, append `/webhooks/typefully`, and add that URL under Settings > API, subscribed to `draft.published`. Typefully then shows a signing secret; copy it into `TYPEFULLY_WEBHOOK_SECRET` in the `amplifier-triggers` env group. The secret does not exist until the webhook is registered, so this order matters.
9. Leave `DRY_RUN=true` for a couple of published posts and read the Workflow logs.
10. Set `DRY_RUN=false`.

### Manual re-run

The webhook is the only trigger, so a dropped delivery means a post nobody announces. Start a run by hand:

```bash
render workflows start <slug-from-step-2>/amplifier.checkPosts --input='[{}]'
```

`amplifier.checkPosts` takes no event, so it scans the whole 90-minute lookback. The announced markers mean it posts what was missed and nothing else.

### Security

The receiver's URL is public, and `verify` is the only thing gating it. A delivery whose HMAC-SHA256 signature does not match `TYPEFULLY_WEBHOOK_SECRET` gets a 401 and starts no run. `POST /tasks/:task` stays shut because `DISPATCH_TOKEN` is unset, which makes that route answer 401 to everything. Do not set it.

## Slack credentials

Pick the Slack channel the notes will go to. If the production channel is busy, use a test channel first.

`slack-app-manifest.yaml` defines the app. At <https://api.slack.com/apps>, choose
**Create New App > From a manifest > Continue**, pick the workspace, and paste the file as YAML. Click **Next > Create and Install**.

The manifest requests both `chat:write` and `incoming-webhook`, so either credential
below works. To change the app later, edit the file and paste it into **App Manifest**
on the app's settings page.

Slack should install the app to the workspace for you. Slack asks which channel the webhook posts to,
and both credentials show up on the app's pages afterwards. Set one of these two:

- **`SLACK_WEBHOOK_URL`** is the URL on the app's **Incoming Webhooks** page. It is
  locked to the channel you picked during install, so `SLACK_CHANNEL` is ignored and
  switching channels means a new webhook.
- **`SLACK_BOT_TOKEN`** is the `xoxb-` token on **OAuth & Permissions**. It makes
  `SLACK_CHANNEL` pick the channel, and you `/invite` the bot there first.

If neither is set, `amplifier.postNote` logs to the console and
reports `delivered: false`.

Both credentials are minted during install, so neither can be committed alongside the
manifest.

## Configuration

| Variable                         | Default                     | Range | Notes                                                                                                                                                                |
| -------------------------------- | --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPEFULLY_API_KEY`              | —                           | —     | Required. Typefully Settings > Integrations.                                                                                                                         |
| `TYPEFULLY_SOCIAL_SET_ID`        | —                           | —     | Required. `GET /v2/social-sets` lists them.                                                                                                                          |
| `TYPEFULLY_BASE_URL`             | Typefully                   | —     | Local stub only. The API key goes to whatever host this names.                                                                                                       |
| `SLACK_WEBHOOK_URL`              | —                           | —     | Incoming webhook. Locked to the channel you created it for.                                                                                                          |
| `SLACK_BOT_TOKEN`                | —                           | —     | Bot token. Required for `SLACK_CHANNEL` to be honored.                                                                                                               |
| `SLACK_CHANNEL`                  | —                           | —     | Channel the note goes to. Needs `SLACK_BOT_TOKEN`.                                                                                                                   |
| `ANTHROPIC_API_KEY`              | —                           | —     | Required for the summary. Without it the note carries the fallback lead line.                                                                                        |
| `REDIS_URL`                      | —                           | —     | Required. The `amplifier-kv` internal connection string.                                                                                                             |
| `DRY_RUN`                        | `true`                      | —     | Set to `false` to post to Slack.                                                                                                                                     |
| `AMPLIFIER_LOOKBACK_MINUTES`     | `90`                        | ≥ 1   | Covers the gap between the event and the run, plus any retry backoff.                                                                                                |
| `AMPLIFIER_GROUP_WINDOW_MINUTES` | `10`                        | ≥ 0   | How close two drafts must be to share a note. `0` turns grouping off.                                                                                                |
| `AMPLIFIER_SETTLE_MINUTES`       | `10`                        | ≥ 0   | How long a run waits for a platform's permalink before announcing without it. `0` turns settling off. Keep it under 15, the retry budget on `amplifier.handleEvent`. |
| `AMPLIFIER_SEEN_TTL_DAYS`        | `30`                        | ≥ 1   | How long a draft stays marked as announced.                                                                                                                          |
| `AMPLIFIER_LIMIT`                | `25`                        | 1–50  | Drafts pulled per run, and the run's widest burst of concurrent Key Value calls.                                                                                     |
| `AMPLIFIER_CALL_TO_ACTION`       | see below                   | —     | The lead line used when the summary fails.                                                                                                                           |
| `AMPLIFIER_SUMMARY_MODEL`        | `anthropic/claude-sonnet-5` | —     | The model that writes the lead line. The provider prefix is required. Takes precedence over `tasks-llm`'s own `LLM_MODEL`.                                           |

A numeric variable set to a fraction, to something non-numeric, or to a value outside
its range fails the run with the variable's name in the error. Every variable with a
value in the Default column uses that default when unset. The `AMPLIFIER_*` settings and
`DRY_RUN` also use their default when set to a blank value. The rows showing `—` have
no default.

Default call to action: "New Render social post! Please like and share when you have a minute"

`ANTHROPIC_API_KEY` and `AMPLIFIER_SUMMARY_MODEL` arrive through the `amplifier-workflow` env group. `AMPLIFIER_SUMMARY_MODEL` has a literal value in `render.yaml`, so a Blueprint apply resets a Dashboard override. `ANTHROPIC_API_KEY` is `sync: false`, so an apply leaves it alone.

### Webhook receiver

The table above covers the Workflow service. These variables belong to the `amplifier-webhook` service.

| Variable                   | Default | Range | Notes                                                                                               |
| -------------------------- | ------- | ----- | --------------------------------------------------------------------------------------------------- |
| `RENDER_API_KEY`           | —       | —     | Required. Authenticates the dispatch call to the Render API.                                        |
| `WORKFLOW_SLUG`            | —       | —     | Required. Set by hand in the Dashboard to the Workflow service's slug from deployment step 2.       |
| `TYPEFULLY_WEBHOOK_SECRET` | —       | —     | Required. The signing secret from Typefully, Settings > API. Unset means every delivery gets a 401. |
| `PORT`                     | `3000`  | —     | Render sets this. Only needed to run the receiver locally.                                          |

## Adding Twitter or LinkedIn directly

```
src/typefully/   knows Typefully's field names, emits PublishedPost
      │
      ▼
src/amplifier/   works only on PublishedPost and PostGroup
      │
      ├──▶ src/summary/   the lead line
      └──▶ src/slack/     the note, with unfurling off
```

Everything that knows Typefully's field names lives in `src/typefully/`. `src/amplifier/` works only on the `PublishedPost` DTO, so a direct Twitter or LinkedIn source means adding a sibling directory with a second task shaped like `typefully.listPublished` and merging its posts in `checkPosts.ts`.
