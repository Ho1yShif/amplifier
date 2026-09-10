# Amplifier

Amplifier automates the process of sharing new LinkedIn and Twitter posts with the Render team. Whenever a post goes live on Twitter and/or LinkedIn, Amplifier sends a Slack note to the `#amplify` channel.

It reads published drafts from Typefully, which is where the Render Twitter and LinkedIn accounts are scheduled. A post sent to both platforms produces one note with both links.

## How it works

```
      every 30 min
           │
           ▼
┌────────────────────┐   dispatch    ┌──────────────────────────┐
│ amplifier-cron     │ ────────────▶ │ amplifier (Workflow)     │
│ cron service       │  @render-lab  │ amplifier.checkPosts     │
└────────────────────┘   /triggers   └────────────┬─────────────┘
                                                  │
  1  typefully.listPublished ─────────────────────┼──▶ Typefully API
  2  withinWindow, then announcedDraftIds ────────┼──▶ amplifier-kv
  3  groupPosts                                   │
  4  llm.complete ────────────────────────────────┼──▶ Anthropic
  5  claimGroup, one kv.lock per draft ───────────┼──▶ amplifier-kv
  6  amplifier.postNote ──────────────────────────┼──▶ Slack #amplify
  7  markAnnounced, then releaseGroup ────────────┴──▶ amplifier-kv
```

Steps 4 through 7 run once per group.

A Render cron job runs every 30 minutes and dispatches `amplifier.checkPosts` on the amplifier Workflow service. That task:

1. Calls `typefully.listPublished` for published drafts in the configured social set.
2. Keeps the drafts published in the last 90 minutes, then drops the ones Render Key Value already records as announced.
3. Groups the rest, when they were published close together on different platforms, into one note.
4. Asks Claude Sonnet 5, through `llm.complete`, for the one line that opens the note.
5. Takes a 5-minute lock per draft.
6. Posts the note through `amplifier.postNote`.
7. Records each draft as announced for 30 days.

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

1. Create a Workflow service in the Render Dashboard from this repo, with build `pnpm install && pnpm build` and start `node dist/main.js`. Put it in project `amplifier`, environment `Production`, region Oregon, the same as the services in `render.yaml`. The Key Value instance is reachable only over the private network within its own environment, so a Workflow service anywhere else fails to connect. Note the service's slug.
2. Run `render workflows start <slug-from-step-1>/ping --input='[]'` to confirm the task registry loaded, before any secret is set. `ping` takes no arguments, so the input array is empty.
3. Apply `render.yaml` to create the cron job, the Key Value instance, and two env groups: `amplifier-triggers` and `amplifier-workflow`. Set `RENDER_API_KEY`, and set `WORKFLOW_SLUG` to the slug from step 1.
4. On the Workflow service, link the `amplifier-workflow` env group and set its `ANTHROPIC_API_KEY`. The group holds the vendor keys the Workflow service reads, and it is linked in the Dashboard because Blueprints do not support Workflow services, so `render.yaml` cannot reference it. Then set `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID`, a Slack credential (see below), `DRY_RUN=true`, and `REDIS_URL` (the `amplifier-kv` internal connection string) on the service itself.
5. Confirm the link took: the Workflow service's environment page lists `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5` from the group. If it does not, the group exists but is not linked, and every note will carry `(Summarization LLM call failed)`.
6. Leave `DRY_RUN=true` for a couple of cron runs and read the Workflow logs.
7. Set `DRY_RUN=false`.

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

| Variable                         | Default                     | Range | Notes                                                                                                                      |
| -------------------------------- | --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `TYPEFULLY_API_KEY`              | —                           | —     | Required. Typefully Settings > Integrations.                                                                               |
| `TYPEFULLY_SOCIAL_SET_ID`        | —                           | —     | Required. `GET /v2/social-sets` lists them.                                                                                |
| `TYPEFULLY_BASE_URL`             | Typefully                   | —     | Local stub only. The API key goes to whatever host this names.                                                             |
| `SLACK_WEBHOOK_URL`              | —                           | —     | Incoming webhook. Locked to the channel you created it for.                                                                |
| `SLACK_BOT_TOKEN`                | —                           | —     | Bot token. Required for `SLACK_CHANNEL` to be honored.                                                                     |
| `SLACK_CHANNEL`                  | —                           | —     | Channel the note goes to. Needs `SLACK_BOT_TOKEN`.                                                                         |
| `ANTHROPIC_API_KEY`              | —                           | —     | Required for the summary. Without it the note carries the fallback lead line.                                              |
| `REDIS_URL`                      | —                           | —     | Required. The `amplifier-kv` internal connection string.                                                                   |
| `DRY_RUN`                        | `true`                      | —     | Set to `false` to post to Slack.                                                                                           |
| `AMPLIFIER_LOOKBACK_MINUTES`     | `90`                        | ≥ 1   | Wider than the 30-minute schedule, so a skipped run catches up.                                                            |
| `AMPLIFIER_GROUP_WINDOW_MINUTES` | `10`                        | ≥ 0   | How close two drafts must be to share a note. `0` turns grouping off.                                                      |
| `AMPLIFIER_SEEN_TTL_DAYS`        | `30`                        | ≥ 1   | How long a draft stays marked as announced.                                                                                |
| `AMPLIFIER_LIMIT`                | `25`                        | 1–100 | Drafts pulled per run, and the run's widest burst of concurrent Key Value calls.                                           |
| `AMPLIFIER_CALL_TO_ACTION`       | see below                   | —     | The lead line used when the summary fails.                                                                                 |
| `AMPLIFIER_SUMMARY_MODEL`        | `anthropic/claude-sonnet-5` | —     | The model that writes the lead line. The provider prefix is required. Takes precedence over `tasks-llm`'s own `LLM_MODEL`. |

A numeric variable set to a fraction, to something non-numeric, or to a value outside
its range fails the run with the variable's name in the error. `AMPLIFIER_LOOKBACK_MINUTES`,
`AMPLIFIER_GROUP_WINDOW_MINUTES`, `AMPLIFIER_SEEN_TTL_DAYS`, `AMPLIFIER_LIMIT`,
`AMPLIFIER_CALL_TO_ACTION`, and `AMPLIFIER_SUMMARY_MODEL` use their default when left
blank or unset. Every other variable in the table has no default.

Default call to action: "New Render social post! Please like and share when you have a minute"

`ANTHROPIC_API_KEY` and `AMPLIFIER_SUMMARY_MODEL` arrive through the `amplifier-workflow` env group. `AMPLIFIER_SUMMARY_MODEL` has a literal value in `render.yaml`, so a Blueprint apply resets a Dashboard override. `ANTHROPIC_API_KEY` is `sync: false`, so an apply leaves it alone.

### Cron service

The table above covers the Workflow service. These variables belong to the `amplifier-cron` service.

| Variable         | Default                | Range | Notes                                                                                         |
| ---------------- | ---------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `RENDER_API_KEY` | —                      | —     | Required. Authenticates the dispatch call to the Render API.                                  |
| `WORKFLOW_SLUG`  | —                      | —     | Required. Set by hand in the Dashboard to the Workflow service's slug from deployment step 1. |
| `CRON_TASK`      | `amplifier.checkPosts` | —     | The task the cron service dispatches.                                                         |
| `CRON_INPUT`     | `{}`                   | —     | The input passed to the dispatched task.                                                      |

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
