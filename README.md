# Amplifier

Amplifier posts one note to Slack when a Render post goes live on X or LinkedIn. The note asks the team to amplify it.

It reads published drafts from Typefully, which is where the Render X and LinkedIn accounts are scheduled. A post sent to both platforms produces one note with both links.

## How it works

A Render cron job runs every 30 minutes and dispatches `amplifier.checkPosts` on the amplifier Workflow service. That task:

1. Calls `typefully.listPublished` for published drafts in the configured social set.
2. Keeps the drafts published in the last 90 minutes.
3. Drops the drafts Render Key Value already records as announced.
4. Groups the rest, when they were published close together on different platforms, into one note.
5. Takes a 5-minute lock per draft, posts the note through `slack.postMessage`, then records each draft as announced for 30 days.

Dedupe is per draft, not per note, so a LinkedIn post that arrives after its X twin was announced still gets its own note.

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

## Deployment

1. Create a Workflow service in the Render Dashboard from this repo, with build `pnpm install && pnpm build` and start `node dist/main.js`. Put it in project `amplifier`, environment `Production`, region Oregon, the same as the services in `render.yaml`. The Key Value instance is reachable only over the private network within its own environment, so a Workflow service anywhere else fails to connect. Note the service's slug.
2. Apply `render.yaml` to create the cron job and the Key Value instance. Set `RENDER_API_KEY`, and set `WORKFLOW_SLUG` to the slug from step 1.
3. On the Workflow service, set `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `DRY_RUN=true`, and `REDIS_URL` (the `amplifier-kv` internal connection string).
4. Leave `DRY_RUN=true` for a couple of cron runs and read the Workflow logs.
5. Set `DRY_RUN=false`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `TYPEFULLY_API_KEY` | — | Required. Typefully Settings > Integrations. |
| `TYPEFULLY_SOCIAL_SET_ID` | — | Required. `GET /v2/social-sets` lists them. |
| `SLACK_BOT_TOKEN` | — | Required for `SLACK_CHANNEL` to be honored. |
| `SLACK_CHANNEL` | — | Channel the note goes to. |
| `REDIS_URL` | — | Required. The `amplifier-kv` internal connection string. |
| `DRY_RUN` | `true` | Set to `false` to post to Slack. |
| `AMPLIFIER_LOOKBACK_MINUTES` | `90` | Wider than the 30-minute schedule, so a skipped run catches up. |
| `AMPLIFIER_GROUP_WINDOW_MINUTES` | `10` | How close two drafts must be to share a note. |
| `AMPLIFIER_SEEN_TTL_DAYS` | `30` | How long a draft stays marked as announced. |
| `AMPLIFIER_LIMIT` | `25` | Drafts pulled per run. |
| `AMPLIFIER_CALL_TO_ACTION` | see below | The ask at the end of the note. |

Default call to action: "Give it a like and a repost when you get a minute."

## Adding X or LinkedIn directly

Everything that knows Typefully's field names lives in `src/typefully/`. `src/amplifier/` works only on the `PublishedPost` DTO, so a direct X or LinkedIn source means adding a sibling directory with a second task shaped like `typefully.listPublished` and merging its posts in `checkPosts.ts`.
