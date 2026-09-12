# Amplifier

Amplifier automates the process of sharing new LinkedIn and Twitter posts with the Render team. Whenever a post goes live on Twitter and/or LinkedIn, Amplifier sends a Slack note to the `#amplify` channel.

It reads published drafts from Typefully, which is where the Render Twitter and LinkedIn accounts are scheduled. A post sent to both platforms produces one Slack thread, with a link per platform as a reply. Anyone in the channel can click Repost on that thread to post it again in a second channel, as themselves.

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
  7  amplifier.postNote, parent then replies ─────┼──▶ Slack #amplify
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
7. Posts the note through `amplifier.postNote`: a parent message, then one threaded reply per platform link.
8. Records each draft as announced for 30 days.

`amplifier.postNote` wraps the vendor's `postMessageImpl` and adds `unfurl_links: false`, `unfurl_media: false` and, on a reply, `thread_ts` to the request body. `@render-lab/tasks-slack` 0.3.0 sends none of them and exposes no option for them. The wrapper can go away once the vendor does.

A cross-post is a thread. The parent carries the summary line, a 🧵, and a Repost button; each platform link is a reply.

```
Cursor Origin is now a supported Git provider on Render. Help spread the word 🧵
[ Repost to #amplify-wider ]
  └ <https://linkedin.com/…|LinkedIn post>
  └ <https://x.com/…|X post>
```

A post that only went out on one platform is one flat message, with no thread and no 🧵:

```
Please like/share our new customer story for OpenAI

<https://x.com/…|X post>
```

When the summary call fails, the note still goes out. The parent opens with `AMPLIFIER_CALL_TO_ACTION`, names the reason, and quotes the draft preview.

The announced marker is written as soon as the parent is delivered, not after the last reply. A failed reply leaves the thread missing a link, which is logged. The alternative is a later run posting a second parent.

Dedupe is per draft, not per note, so a LinkedIn post that arrives after its Twitter twin was announced still gets its own note.

Delivery is at least once. The announced marker is written after Slack accepts the parent, so a run that dies in the gap between the two loses its lock within 5 minutes and the next run posts the same note again. The design accepts a duplicate note so that no note is lost.

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

`scripts/typefully-stub.ts` stands in for both Typefully and the Slack Web API, so the whole announce-once path runs against a local Key Value with no keys:

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
   | `amplifier-workflow` | `SLACK_BOT_TOKEN`         | See below                                              |
   | `amplifier-workflow` | `SLACK_CHANNEL`           | The channel the notes go to                            |

   For Slack, add `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`. Both are required. To turn the Repost button on, also add `AMPLIFIER_REPOST_CHANNEL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` to `amplifier-workflow`, and `SLACK_CLIENT_ID` and `SLACK_SIGNING_SECRET` to `amplifier-triggers`. All four Slack values are on the app's Basic Information page. `AMPLIFIER_PUBLIC_URL` comes later, in step 6, because it is the receiver's own URL. See [Reposting](#reposting).

   `TYPEFULLY_WEBHOOK_SECRET` belongs in `amplifier-triggers` too, but Typefully does not show it until step 11, so leave it out for now. Leave `AMPLIFIER_SUMMARY_MODEL` out as well; `render.yaml` gives it a literal value and the apply adds it to `amplifier-workflow`. `REDIS_URL` comes later, in step 9, because `amplifier-kv` does not exist yet. Nothing here can use `generateValue`; every value is one you paste in.

5. Apply `render.yaml`, with the Deploy to Render button above or from the Dashboard, to create the `amplifier-webhook` service and the Key Value instance, and to link `amplifier-triggers` to the receiver. The apply asks for no values, because step 4 set them all.
6. Point the Slack app at the receiver, now that it has a hostname. On the app's pages set **Interactivity & Shortcuts > Request URL** to `<receiver>/slack/interactivity` and **OAuth & Permissions > Redirect URLs** to `<receiver>/slack/oauth/callback`, then add `AMPLIFIER_PUBLIC_URL` to `amplifier-workflow`, set to the receiver's base URL. The Workflow service builds the authorize link and has no external URL of its own. Skip this step if you are not using the Repost button.
7. Confirm `amplifier-kv` landed in region Oregon. `render.yaml` names Oregon, so it should. The Workflow service reaches it over the private network as long as both are in Oregon in the same workspace; the project and the environment do not have to match.
8. On the Workflow service, link the `amplifier-workflow` env group. The group holds every variable the Workflow service reads, and it is linked in the Dashboard because Blueprints do not support Workflow services, so `render.yaml` cannot reference it.
9. Add `REDIS_URL` to `amplifier-workflow`, set to the `amplifier-kv` internal connection string from its Dashboard page. Do not copy the value from `.env` or `.env.example`; those hold `redis://localhost:6379` for local dev, and on Render nothing listens there. A run using it fails every Key Value task with repeated `[ioredis] Unhandled error event: AggregateError [ECONNREFUSED]` and `Reached the max retries per request limit (which is 20)`.
10. Confirm the link took: the Workflow service's environment page lists `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5` from the group. If it does not, the group exists but is not linked, and every note will carry `(Summarization LLM call failed)`.
11. Register the receiver in Typefully, following [Registering the Typefully webhook](#registering-the-typefully-webhook) below.
12. Add `DRY_RUN=true` to `amplifier-workflow`, publish a couple of posts, and read the Workflow logs. The parent is logged after `[dry run] would post:` and each threaded link after `[dry run] would reply:`, in the order a real run would send them. Check the thread shape here before the first real note.
13. Remove `DRY_RUN` from `amplifier-workflow` so runs post to Slack.

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

### Manual trigger

The webhook is the only trigger, so a dropped delivery means a post nobody announces.

#### One post

`amplifier.announcePost` takes the permalink you have in front of you:

```bash
render workflows start <slug>/amplifier.announcePost \
  --input='[{"url":"https://x.com/render/status/2097716776390058019"}]'
```

The Dashboard route is the same task from the Workflow service's **Tasks** tab, pasting the same JSON array. The array is the task's positional arguments, so a single object in an array is the shape.

| Field     | What it does                                     |
| --------- | ------------------------------------------------ |
| `url`     | Permalink to the live post, X or LinkedIn.       |
| `draftId` | Typefully draft id, when the URL is not to hand. |
| `force`   | Re-post a draft that was already announced.      |
| `dryRun`  | Log the note instead of posting it.              |

`dryRun: true` prints the note after `[dry run] would post:` in the run's logs and writes no marker, so the real run still has the post to announce.

Only the newest 50 published drafts are searched, so a post from weeks ago needs its `draftId`.

#### A whole window

When several posts were missed at once, run the scan instead:

```bash
render workflows start <slug>/amplifier.checkPosts --input='[{}]'
```

`amplifier.checkPosts` takes no event, so it scans the whole 90-minute lookback. The announced markers mean it posts what was missed and nothing else.

### Security

The receiver's URL is public, and a signature check is the only thing gating each route.

A Typefully delivery whose HMAC-SHA256 signature does not match `TYPEFULLY_WEBHOOK_SECRET` gets a 401 and starts no run, and so does one whose timestamp is more than 15 minutes from the receiver's clock.

`POST /slack/interactivity` recomputes Slack's own HMAC-SHA256 over `v0:{timestamp}:{body}` with `SLACK_SIGNING_SECRET` and rejects a timestamp more than five minutes from the clock. `GET /slack/oauth/callback` takes no signature, so the `state` on the authorize link carries the clicker's user id plus an expiry, HMAC-signed with the same secret. Without that signature anyone could complete the callback and have their own token stored under someone else's id.

`POST /tasks/:task` stays shut because `DISPATCH_TOKEN` is unset, which makes that route answer 401 to everything. Do not set it.

## Slack credentials

Pick the Slack channel the notes will go to. If the production channel is busy, use a test channel first.

`slack-app-manifest.yaml` defines the app. At <https://api.slack.com/apps>, choose
**Create New App > From a manifest > Continue**, pick the workspace, and paste the file as YAML. Click **Next > Create and Install**.

The manifest requests `chat:write` and `reactions:write` for the bot, and `chat:write` for
a user. To change the app later, edit the file and paste it into **App Manifest** on the
app's settings page. A scope change requires a reinstall, which mints a new bot token, so
update `SLACK_BOT_TOKEN` afterwards.

The two URLs in the manifest point at the `amplifier-webhook` receiver, which does not
exist until the Blueprint is applied. Deployment step 6 fills them in.

Copy these into the env groups in deployment step 4:

- **`SLACK_BOT_TOKEN`** is the `xoxb-` token on **OAuth & Permissions**. Goes in
  `amplifier-workflow`. `/invite` the bot to the channel first.
- **`SLACK_CHANNEL`** is the channel the notes go to. Goes in `amplifier-workflow`. The
  leading `#` is optional. If the production channel is busy, use a test channel first.
- **`SLACK_SIGNING_SECRET`** is on **Basic Information**. Goes in both groups, with the same
  value. The receiver verifies Repost clicks with it, and `amplifier.repost` signs the
  authorize link's `state` with it.
- **`SLACK_CLIENT_ID`** and **`SLACK_CLIENT_SECRET`** are on **Basic Information** too.
  The id goes in both groups; the secret goes in `amplifier-workflow` only, because
  `amplifier.saveUserToken` is the only thing that reads it.

Both `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` are required. Without either,
`amplifier.postNote` throws and the run ends `failed`. That is deliberate: a run that
cannot post must not report success. Threading needs the parent message's `ts`, and only
the Web API route returns one.

The token is minted during install, so it cannot be committed alongside the manifest.

### Migrating an existing deployment

The incoming-webhook path is gone, so a deployment that used `SLACK_WEBHOOK_URL` needs four changes:

1. Paste the updated `slack-app-manifest.yaml` into the Slack app and reinstall it. The scope change mints a new bot token, so update `SLACK_BOT_TOKEN`.
2. Remove `SLACK_WEBHOOK_URL` from `amplifier-workflow`, and confirm `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` are both set and the bot is in the source channel.
3. Set the Slack app's Interactivity Request URL and OAuth Redirect URL, as in deployment step 6, if you want the Repost button.
4. Redeploy both services.

## Reposting

When `AMPLIFIER_REPOST_CHANNEL` is set, the parent of every cross-post thread carries a
**Repost to #<channel>** button. Anyone in the source channel can click it. The thread is
posted again in the repost channel, as the clicker rather than as the bot, and the source
parent gets an `AMPLIFIER_REPOST_EMOJI` reaction and a "Reposted by" reply.

The first click asks for a one-time authorization. Amplifier has no token for that person
yet, so it answers privately with an authorize link. Approving it grants `chat:write` for
that one person, and clicking Repost again does the repost. The token is stored in
`amplifier-kv` with no expiry, so nobody has to authorize twice.

Every person who clicks has to be a member of the repost channel. Slack answers
`not_in_channel` when they are not, and amplifier answers privately asking them to join
it. The bot never posts in the repost channel and does not need to be a member.

The button stays live after a click, so a second click reposts again. Reposted threads
carry no button, so a repost cannot itself be reposted.

`amplifier.repost` reads the thread's text from `amplifier-kv`, not from Slack. The record
carries the same 30-day TTL as the announced marker, so an older note answers that it is
too old to repost.

Unset `AMPLIFIER_REPOST_CHANNEL` to turn all of this off: no button, no stored note.

## Configuration

| Variable                         | Default                     | Range | Notes                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPEFULLY_API_KEY`              | —                           | —     | Required. Typefully Settings > Integrations.                                                                                                                                                                                                         |
| `TYPEFULLY_SOCIAL_SET_ID`        | —                           | —     | Required. `GET /v2/social-sets` lists them.                                                                                                                                                                                                          |
| `TYPEFULLY_BASE_URL`             | Typefully                   | —     | Local stub only. The API key goes to whatever host this names.                                                                                                                                                                                       |
| `SLACK_BOT_TOKEN`                | —                           | —     | Required. The `xoxb-` bot token.                                                                                                                                                                                                                     |
| `SLACK_CHANNEL`                  | —                           | —     | Required. Channel the note goes to, with or without a leading `#`. Missing either this or the bot token fails the run.                                                                                                                               |
| `SLACK_API_BASE_URL`             | Slack                       | —     | Local stub only. The bot token goes to whatever host this names.                                                                                                                                                                                     |
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
| `AMPLIFIER_REPOST_CHANNEL`       | —                           | —     | Channel the Repost button posts to. Unset means no button and no stored note. See [Reposting](#reposting).                                                                                                                                           |
| `AMPLIFIER_REPOST_EMOJI`         | `white_check_mark`          | —     | Reaction added to a note that has been reposted. Must be an emoji the workspace has, or `reactions.add` answers `invalid_name`.                                                                                                                      |
| `SLACK_CLIENT_ID`                | —                           | —     | Needed for the user-token exchange. Slack app, Basic Information.                                                                                                                                                                                    |
| `SLACK_CLIENT_SECRET`            | —                           | —     | Needed for the user-token exchange. Read only by `amplifier.saveUserToken`, so it never reaches the receiver.                                                                                                                                        |
| `SLACK_SIGNING_SECRET`           | —                           | —     | Signs the authorize link's `state`. Must be the same value the receiver has, or the receiver rejects the link.                                                                                                                                       |
| `AMPLIFIER_PUBLIC_URL`           | —                           | —     | The receiver's base URL, such as `https://amplifier-webhook.onrender.com`. Required for the Repost button, because the Workflow service has no `RENDER_EXTERNAL_URL` of its own.                                                                     |

A numeric variable set to a fraction, to something non-numeric, or to a value outside
its range fails the run with the variable's name in the error. Every variable with a
value in the Default column uses that default when unset. The `AMPLIFIER_*` settings and
`DRY_RUN` also use their default when set to a blank value. The rows showing `—` have
no default.

Default call to action: "New Render social post! Please like and share when you have a minute"

Every variable above reaches the Workflow service through the `amplifier-workflow` env group, so set them there rather than on the service. All of them are added to the group by hand, in step 4, except `AMPLIFIER_SUMMARY_MODEL`: it has a literal value in `render.yaml`, so a Blueprint apply resets a Dashboard override.

### Webhook receiver

The table above covers the Workflow service. These variables belong to the `amplifier-webhook` service. They reach it through the `amplifier-triggers` env group, so set them there rather than on the service. `render.yaml` gives the service only `fromGroup: amplifier-triggers`, and a variable added straight to the service is removed on the next Blueprint sync.

| Variable                   | Default               | Range | Notes                                                                                                   |
| -------------------------- | --------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `RENDER_API_KEY`           | —                     | —     | Required. Authenticates the dispatch call to the Render API.                                            |
| `WORKFLOW_SLUG`            | —                     | —     | Required. Set by hand in the Dashboard to the Workflow service's slug, `amplifier` for the Render team. |
| `TYPEFULLY_WEBHOOK_SECRET` | —                     | —     | Required. The signing secret from Typefully, Settings > API. Unset means every delivery gets a 401.     |
| `SLACK_SIGNING_SECRET`     | —                     | —     | Verifies Repost clicks and signs the OAuth `state`. Unset means every Slack request gets a 401.         |
| `SLACK_CLIENT_ID`          | —                     | —     | Builds the authorize link. The client secret does not belong here.                                      |
| `AMPLIFIER_PUBLIC_URL`     | `RENDER_EXTERNAL_URL` | —     | The receiver's own base URL, used to build the OAuth redirect. Only needed locally.                     |
| `PORT`                     | `3000`                | —     | Render sets this. Only needed to run the receiver locally.                                              |

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
