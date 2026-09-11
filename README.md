# Amplifier

Amplifier automates the process of sharing new LinkedIn and Twitter posts with the Render team. Whenever a post goes live on Twitter and/or LinkedIn, Amplifier sends a Slack note to the `#amplify` channel.

It reads published drafts from Typefully, which is where the Render Twitter and LinkedIn accounts are scheduled. A post sent to both platforms produces one note with both links.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Ho1yShif/amplifier)

The button applies `render.yaml`, which covers the webhook receiver, the Key Value instance,
and the env groups. It does not create the Workflow service, because Blueprints do not support
Workflows yet. Read [Deployment](#deployment) first; the button is step 5.

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
3. Throws while the event's draft is enabled for a platform that has not reported a permalink, so a retry re-reads Typefully a minute later. Past the 10-minute settle deadline it announces the draft with whatever links exist, and the note names the platform it has no link for.
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

`.env.example` sets `DRY_RUN=true`, so a local run logs the note it would post and writes nothing to Slack.

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

`render.yaml` covers the webhook receiver, the Key Value instance, and the env groups. The Workflow
service is created separately, because Blueprints do not support Workflow services yet. Applying a
Blueprint and giving a workspace access to a private repo both happen in the Render Dashboard;
neither has an API or CLI path. Give the workspace that will own the project access to this repo
first, under Settings > GitHub, because Render cannot clone a private repo until then.

For the Render team, the workspace is Render-DX and steps 2 and 3 are done: workflow `amplifier`,
region Oregon, built from `main`.

1. Create the Slack app and copy a credential, following [Slack credentials](#slack-credentials) below. Nothing in Render has to exist first, and step 4 needs the credential.
2. Create the Workflow service, following [Creating the Workflow service](#creating-the-workflow-service) below. Note the slug it prints.
3. Run `render workflows start <slug>/ping --input='[]'` to confirm the task registry loaded, before any secret is set. `ping` takes no arguments, so the input array is empty, and it returns `pong`. If the task list is empty, the build shipped but `dist/main.js` registered nothing, and the deploy logs say why.
4. Create the two env groups in the Dashboard, under Env Groups, and add the keys below. Do this before applying the Blueprint. `sync: false` is ignored inside an env var group, so the apply never prompts for these, and a receiver whose `RENDER_API_KEY` is empty exits at startup with `RenderError: API token is required`.

   | Group                | Key                       | Value                                                  |
   | -------------------- | ------------------------- | ------------------------------------------------------ |
   | `amplifier-triggers` | `RENDER_API_KEY`          | A key for the workspace that owns the Workflow service |
   | `amplifier-triggers` | `WORKFLOW_SLUG`           | The slug from step 2                                   |
   | `amplifier-workflow` | `ANTHROPIC_API_KEY`       | An Anthropic API key                                   |
   | `amplifier-workflow` | `TYPEFULLY_API_KEY`       | Typefully Settings > Integrations                      |
   | `amplifier-workflow` | `TYPEFULLY_SOCIAL_SET_ID` | `GET /v2/social-sets` lists them                       |
   | `amplifier-workflow` | The Slack credential      | See below                                              |

   For Slack, with a bot token add `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`. With an incoming webhook add `SLACK_WEBHOOK_URL` alone, because the webhook is locked to one channel and `SLACK_CHANNEL` is ignored.

   `TYPEFULLY_WEBHOOK_SECRET` belongs in `amplifier-triggers` too, but Typefully does not show it until step 10, so leave it out for now. Leave `AMPLIFIER_SUMMARY_MODEL` out as well; `render.yaml` gives it a literal value and the apply adds it to `amplifier-workflow`. `REDIS_URL` comes later, in step 8, because `amplifier-kv` does not exist yet. Nothing here can use `generateValue`; every value is one you paste in.

5. Apply `render.yaml`, with the Deploy to Render button above or from the Dashboard, to create the `amplifier-webhook` service and the Key Value instance, and to link `amplifier-triggers` to the receiver. The apply asks for no values, because step 4 set them all.
6. Confirm `amplifier-kv` landed in region Oregon. `render.yaml` names Oregon, so it should. The Workflow service reaches it over the private network as long as both are in Oregon in the same workspace; the project and the environment do not have to match.
7. On the Workflow service, link the `amplifier-workflow` env group. The group holds every variable the Workflow service reads, and it is linked in the Dashboard because Blueprints do not support Workflow services, so `render.yaml` cannot reference it.
8. Add `REDIS_URL` to `amplifier-workflow`, set to the `amplifier-kv` internal connection string from its Dashboard page. Do not copy the value from `.env` or `.env.example`; those hold `redis://localhost:6379` for local dev, and on Render nothing listens there. A run using it fails every Key Value task with repeated `[ioredis] Unhandled error event: AggregateError [ECONNREFUSED]` and `Reached the max retries per request limit (which is 20)`.
9. Confirm the link took: the Workflow service's environment page lists `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5` from the group. If it does not, the group exists but is not linked, and every note will carry `(Summarization LLM call failed)`.
10. Register the receiver in Typefully, following [Registering the Typefully webhook](#registering-the-typefully-webhook) below.
11. Add `DRY_RUN=true` to `amplifier-workflow`, publish a couple of posts, and read the Workflow logs. Each note the run would have sent is logged after `[dry run] would post:`.
12. Remove `DRY_RUN` from `amplifier-workflow` so runs post to Slack.

### Creating the Workflow service

Use the Render CLI, version 2.26.0 or newer, from a checkout of this repo. First pick the workspace
that owns the project:

```bash
render workspace set
```

Then create the service:

```bash
render workflows create \
  --name amplifier \
  --repo . \
  --branch main \
  --runtime node \
  --region oregon \
  --build-command 'npm install -g pnpm@11.18.0 && pnpm install && pnpm build' \
  --run-command 'node dist/main.js'
```

Or in the Dashboard, choose **New > Workflow**, pick this repo, and fill in the form:

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Name           | `amplifier`                                                 |
| Branch         | `main`                                                      |
| Region         | Oregon                                                      |
| Language       | Node                                                        |
| Root Directory | leave blank                                                 |
| Build Command  | `npm install -g pnpm@11.18.0 && pnpm install && pnpm build` |
| Start Command  | `node dist/main.js`                                         |

Then click **Deploy Workflow**.

The build command installs pnpm first. Render's Node runtime ships npm, and `package.json` pins
`pnpm@11.18.0`, so `pnpm install` fails without that line.

Region Oregon matches `amplifier-kv` in `render.yaml`. The private network covers one region within
one workspace, so a Workflow service in any other region cannot reach the Key Value instance. Keep
the service out of a network-isolated environment as well, because a Workflow service in one cannot
reach anything over that environment's private network.

The Workflow service reads its variables from the `amplifier-workflow` env group, linked in step 7,
so `render workflows create` needs no `--env-var` or `--env-file` flags.

### Registering the Typefully webhook

1. In the Render Dashboard, copy the `amplifier-webhook` service's `onrender.com` URL and append `/webhooks/typefully`.
2. Open <https://typefully.com/?settings=api> and click **Add webhook**.
3. Paste the URL, select the `draft.published` event, and save.
4. Typefully now shows a signing secret. Add a new key to the `amplifier-triggers` env group, named `TYPEFULLY_WEBHOOK_SECRET`, and paste the secret as its value. The key does not exist yet, because Typefully creates the secret only when you save the webhook, so deployment step 4 could not add it.
5. Redeploy `amplifier-webhook`. It reads `TYPEFULLY_WEBHOOK_SECRET` at startup, so it rejects every delivery until it restarts with the new value.

### Manual re-run

The webhook is the only trigger, so a dropped delivery means a post nobody announces. Start a run by hand:

```bash
render workflows start <slug>/amplifier.checkPosts --input='[{}]'
```

`amplifier.checkPosts` takes no event, so it scans the whole 90-minute lookback. The announced markers mean it posts what was missed and nothing else.

### Security

The receiver's URL is public, and `verify` is the only thing gating it. A delivery whose HMAC-SHA256 signature does not match `TYPEFULLY_WEBHOOK_SECRET` gets a 401 and starts no run, and so does one whose timestamp is more than 15 minutes from the receiver's clock. `POST /tasks/:task` stays shut because `DISPATCH_TOKEN` is unset, which makes that route answer 401 to everything. Do not set it.

## Slack credentials

Pick the Slack channel the notes will go to. If the production channel is busy, use a test channel first.

`slack-app-manifest.yaml` defines the app. At <https://api.slack.com/apps>, choose
**Create New App > From a manifest > Continue**, pick the workspace, and paste the file as YAML. Click **Next > Create and Install**.

The manifest requests both `chat:write` and `incoming-webhook`, so either credential
below works. To change the app later, edit the file and paste it into **App Manifest**
on the app's settings page.

Slack should install the app to the workspace for you. Slack asks which channel the webhook posts to,
and both credentials show up on the app's pages afterwards. Copy one of these two, and add it to the
`amplifier-workflow` env group in deployment step 4:

- **`SLACK_WEBHOOK_URL`** is the URL on the app's **Incoming Webhooks** page. It is
  locked to the channel you picked during install, so `SLACK_CHANNEL` is ignored and
  switching channels means a new webhook.
- **`SLACK_BOT_TOKEN`** is the `xoxb-` token on **OAuth & Permissions**. It makes
  `SLACK_CHANNEL` pick the channel, and you `/invite` the bot there first. The
  leading `#` is optional.

Set one of them. If neither is set, `amplifier.postNote` throws and the run ends
`failed`. That is deliberate: a run that cannot post must not report success.

Both credentials are minted during install, so neither can be committed alongside the
manifest.

## Configuration

| Variable                         | Default                     | Range | Notes                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPEFULLY_API_KEY`              | —                           | —     | Required. Typefully Settings > Integrations.                                                                                                                                                                                                         |
| `TYPEFULLY_SOCIAL_SET_ID`        | —                           | —     | Required. `GET /v2/social-sets` lists them.                                                                                                                                                                                                          |
| `TYPEFULLY_BASE_URL`             | Typefully                   | —     | Local stub only. The API key goes to whatever host this names.                                                                                                                                                                                       |
| `SLACK_WEBHOOK_URL`              | —                           | —     | Incoming webhook. Locked to the channel you created it for.                                                                                                                                                                                          |
| `SLACK_BOT_TOKEN`                | —                           | —     | Bot token. Required for `SLACK_CHANNEL` to be honored.                                                                                                                                                                                               |
| `SLACK_CHANNEL`                  | —                           | —     | Channel the note goes to, with or without a leading `#`. Needs `SLACK_BOT_TOKEN`, and a bot token with no channel fails the run, so set both or use the webhook alone.                                                                               |
| `ANTHROPIC_API_KEY`              | —                           | —     | Required for the summary. Without it the note carries the fallback lead line.                                                                                                                                                                        |
| `REDIS_URL`                      | —                           | —     | Required. The `amplifier-kv` internal connection string.                                                                                                                                                                                             |
| `DRY_RUN`                        | `false`                     | —     | Set to exactly `true` to log the note instead of posting to Slack.                                                                                                                                                                                   |
| `AMPLIFIER_LOOKBACK_MINUTES`     | `90`                        | ≥ 1   | Covers the gap between the event and the run, plus any retry backoff.                                                                                                                                                                                |
| `AMPLIFIER_GROUP_WINDOW_MINUTES` | `10`                        | ≥ 0   | How close two drafts must be to share a note. `0` turns grouping off.                                                                                                                                                                                |
| `AMPLIFIER_SETTLE_MINUTES`       | `10`                        | 0–15  | How long a run waits for a platform's permalink before announcing without it. `0` turns settling off. The maximum is the retry budget on `amplifier.handleEvent`, past which the retries run out before the deadline and the event produces no note. |
| `AMPLIFIER_SEEN_TTL_DAYS`        | `30`                        | ≥ 1   | How long a draft stays marked as announced.                                                                                                                                                                                                          |
| `AMPLIFIER_LIMIT`                | `25`                        | 1–50  | Drafts pulled per run, and the run's widest burst of concurrent Key Value calls.                                                                                                                                                                     |
| `AMPLIFIER_CALL_TO_ACTION`       | see below                   | —     | The lead line used when the summary fails.                                                                                                                                                                                                           |
| `AMPLIFIER_SUMMARY_MODEL`        | `anthropic/claude-sonnet-5` | —     | The model that writes the lead line. The provider prefix is required. Takes precedence over `tasks-llm`'s own `LLM_MODEL`.                                                                                                                           |

A numeric variable set to a fraction, to something non-numeric, or to a value outside
its range fails the run with the variable's name in the error. Every variable with a
value in the Default column uses that default when unset. The `AMPLIFIER_*` settings and
`DRY_RUN` also use their default when set to a blank value. The rows showing `—` have
no default.

Default call to action: "New Render social post! Please like and share when you have a minute"

Every variable above reaches the Workflow service through the `amplifier-workflow` env group, so set them there rather than on the service. All of them are added to the group by hand, in step 4, except `AMPLIFIER_SUMMARY_MODEL`: it has a literal value in `render.yaml`, so a Blueprint apply resets a Dashboard override.

### Webhook receiver

The table above covers the Workflow service. These variables belong to the `amplifier-webhook` service. They reach it through the `amplifier-triggers` env group, so set them there rather than on the service. `render.yaml` gives the service only `fromGroup: amplifier-triggers`, and a variable added straight to the service is removed on the next Blueprint sync.

| Variable                   | Default | Range | Notes                                                                                                   |
| -------------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `RENDER_API_KEY`           | —       | —     | Required. Authenticates the dispatch call to the Render API.                                            |
| `WORKFLOW_SLUG`            | —       | —     | Required. Set by hand in the Dashboard to the Workflow service's slug, `amplifier` for the Render team. |
| `TYPEFULLY_WEBHOOK_SECRET` | —       | —     | Required. The signing secret from Typefully, Settings > API. Unset means every delivery gets a 401.     |
| `PORT`                     | `3000`  | —     | Render sets this. Only needed to run the receiver locally.                                              |

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
