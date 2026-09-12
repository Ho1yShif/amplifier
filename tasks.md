# Render Tasks in Amplifier

[Render Tasks](https://github.com/render-lab/render-tasks) is a set of packages that wrap vendor APIs
as [Render Workflows](https://render.com/docs/workflows) tasks. In amplifier, every network call out
of the process runs as one of those tasks: Typefully, Anthropic, Render Key Value, and Slack. Each
task carries its own retry policy, and a run that dies part way through resumes from the last
completed task.

The packages are a proof of concept and break their APIs between releases, so `package.json` pins
every version exactly. `@renderinc/sdk` is pinned to `1.0.0` because each package declares it as an
exact peer dependency: one physical copy means every task registers into the same `TaskRegistry`.

## What amplifier takes from each package

| Package                       | Version        | What amplifier uses it for                                                                                                                                        |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@render-lab/tasks-render-kv` | 0.3.0          | `get`, `set`, `deleteKeys`, `lock`, `unlock`. `src/amplifier/seen.ts` builds the announced markers and the in-flight locks from them.                             |
| `@render-lab/tasks-slack`     | 0.3.0          | `postMessageImpl`, `webApiPort`, `addReaction`, and `SLACK_RETRY`. `src/slack/postNote.ts` wraps the first three.                                                 |
| `@render-lab/tasks-llm`       | 0.8.1          | `complete`, called in `src/summary/summarize.ts` for the note's lead line.                                                                                        |
| `@render-lab/tasks-core`      | 0.3.0          | `createHttpClient`, which backs the Typefully REST port in `src/typefully/client.ts`. Defines no tasks.                                                           |
| `@render-lab/triggers`        | 0.2.0          | `createDispatchServer`, `renderDispatcher`, and the `WebhookAdapter` contract, which are the whole `amplifier-webhook` service.                                   |
| `hono` + `@hono/node-server`  | 4.13.5 / 2.1.1 | The Slack routes mount on the Hono app `createDispatchServer` returns, and the receiver serves it itself. Pinned to the versions `@render-lab/triggers` resolves. |
| `@render-lab/test-utils`      | 0.1.0          | `fakeCtx` for the tests and `localCtx` for `pnpm local:run`.                                                                                                      |

## Amplifier's own tasks

Five tasks are entry points, started from outside the workflow. The rest are composed from them.

| Task                      | Started by                             | Retry                |
| ------------------------- | -------------------------------------- | -------------------- |
| `amplifier.checkPosts`    | By hand, to rescan the lookback window | none                 |
| `amplifier.handleEvent`   | A Typefully `draft.published` delivery | `HANDLE_EVENT_RETRY` |
| `amplifier.announcePost`  | By hand, with a permalink or draft id  | none                 |
| `amplifier.repost`        | A Repost button click in Slack         | `REPOST_RETRY`       |
| `amplifier.saveUserToken` | The Slack OAuth callback               | none                 |
| `amplifier.postNote`      | The four tasks above that post         | `SLACK_RETRY`        |
| `typefully.listPublished` | `checkPosts` and `announcePost`        | `TYPEFULLY_RETRY`    |
| `ping`                    | By hand, to check the registry loaded  | none                 |

`src/main.ts` imports the five entry modules for the side effect. Each one calls `task()` at load, so
the import registers that task and, through its own imports, every vendor task it calls. A new entry
task that is not imported there does not exist on the deploy. To confirm the registry loaded, run
`render workflows start <slug>/ping --input='[]'` and expect `pong`.

`amplifier.checkPosts` is the one to read first. It composes the whole announce path as `ctx.run`
calls: `typefully.listPublished`, then `kv.get` per draft, then `llm.complete`, `kv.lock`,
`amplifier.postNote`, `kv.set`, `kv.unlock` inside `announceGroups`.

`amplifier.handleEvent` registers `checkPostsImpl` directly rather than calling `ctx.run(checkPosts)`.
No second dispatch, no second poll interval. It exists to carry its own retry policy and its own name
in the Dashboard.

Amplifier's tasks compose vendor tasks instead of calling vendor clients, with one exception:
`saveUserTokenImpl` posts to `oauth.v2.access` through an injected `fetchImpl`, because no packaged
task covers the OAuth exchange.

## Where the retry policies matter

`HANDLE_EVENT_RETRY` is not only resilience. A Typefully delivery arrives when the first platform
publishes, so `checkPostsImpl` throws `StillPublishingError` and the retry backoff — 1m, 2m, 4m, 8m —
is how amplifier waits for the second platform. Two things depend on that budget:

- `MAX_SETTLE_MINUTES` in `src/amplifier/retry.ts` computes the total backoff and `loadConfig` caps
  `AMPLIFIER_SETTLE_MINUTES` at it. A settle deadline past the retry budget means the retries run out
  before the deadline and the post gets no note.
- `announceGroups` calls `summarizeGroup` before taking the in-flight lock, because the `complete`
  task spends about 62 seconds of backoff and `INFLIGHT_TTL_SECONDS` is 300. Inside the lock, the lock
  could expire mid-call and a second run would re-post the note.

`REPOST_RETRY` is short — 1s, 2s, 4s, 8s — because a person clicked the button and is waiting for the
ephemeral answer. A long backoff reads as a dead button. It can only fire before the parent message is
posted; everything after that either swallows its own failure or answers the clicker and returns.

`amplifier.announcePost` and `amplifier.saveUserToken` have no retry policy on purpose. A human is
watching the first one, and an OAuth code is single-use, so a retry after a successful exchange fails
with `invalid_code` and turns a working authorization into a reported failure.

Typefully rate limits are absorbed in-process instead of by a retry policy. `typefullyPort` passes
`retry` to `createHttpClient`, because a durable re-dispatch re-fires the same request and sustains the
limit.

## Dispatching in parallel

Each `ctx.run` polls its own subtask every 500ms, so sequential calls pay that interval each time.
`announcedDraftIds` and `markAnnounced` in `src/amplifier/seen.ts` dispatch their Key Value calls with
`Promise.all` for that reason — 25 sequential reads would wait through 25 poll intervals.

Two places stay sequential deliberately. `claimGroup` takes the locks one at a time so it can release
what it already holds and give up on the first refusal. `postReplies` posts the thread's replies in
order, because the order the links appear is part of the note's format.

## Where amplifier reaches past a packaged task

`amplifier.postNote` wraps `postMessageImpl` under its own name because the packaged behavior is wrong
for amplifier in three ways:

- Slack unfurls every link it finds, including links inside a section block. `chat.postMessage` accepts
  `unfurl_links` and `unfurl_media`, but `@render-lab/tasks-slack` 0.3.0 sends neither and exposes no
  option, so `outgoingFetch` adds them to the request body on the way out.
- `thread_ts` rides the same rewrite. `PostMessageInput` has no field for it in 0.3.0, and amplifier's
  notes are threads.
- It throws when Slack is unconfigured, instead of letting the packaged webhook port log the note and
  return `delivered: false`. A run that cannot post must not report success.

`SLACK_API_BASE_URL` is the same kind of hole. `webApiPort` builds `https://slack.com/api` into the URL
itself, so `outgoingFetch` rewrites the host when that variable is set. `pnpm local:run` uses it to
point the announce path at the local stub, the way `TYPEFULLY_BASE_URL` already does for Typefully.

The wrapper builds its `SlackDeps` per call, so `SLACK_BOT_TOKEN` is read at call time and not at
import. That also gives `amplifier.repost` posting-as-a-person for free: it hands `webApiPort` a copy
of the environment with `SLACK_BOT_TOKEN` replaced by the clicker's user token, which keeps the second
identity inside the vendor's client instead of adding a second HTTP path.

`src/amplifier/storedNote.ts` exists for a missing task. `amplifier.repost` needs the thread's content,
and 0.3.0 wraps no `conversations.replies` task, so reading the thread back from Slack would mean a raw
API call and a `channels:history` scope. `announceGroups` writes the rendered messages to Key Value
when it posts them instead.

## The Typefully port

`listPublishedImpl` takes a `TypefullyDeps` object with a default, and the default port is built on
first use through a getter, never at import. `TYPEFULLY_API_KEY` and `TYPEFULLY_BASE_URL` come from the
environment the run has rather than the one the module loaded in. Tests pass a fake port.
`typefullyWebhook` reads `TYPEFULLY_WEBHOOK_SECRET` the same way, so an unconfigured receiver rejects
deliveries instead of answering 500 to every one of them.

## The receiver

Workflows have no HTTP entry point, so `amplifier-webhook` is a separate Render web service. It verifies
an inbound request and starts a run through the Render API with `RENDER_API_KEY` and `WORKFLOW_SLUG`.

`src/receiver.ts` calls `createDispatchServer` rather than `serveDispatchServer`, because the two Slack
routes mount on the Hono app it returns. They cannot be `WebhookAdapter`s: Slack sends interactivity as
form-encoded with the JSON in a `payload` field, and the adapter path `JSON.parse`s the body before
`map` ever sees it. The three routes that start runs are:

- `POST /webhooks/typefully` — the adapter in `src/typefully/webhook.ts`. `verify` checks the
  HMAC-SHA256 signature and the timestamp, and `map` returns `{ task: "amplifier.handleEvent", args }`
  or `null` to ignore the event. `verify` is the only thing between a public URL and a workflow run,
  because `POST /webhooks/:name` does not check `DISPATCH_TOKEN`.
- `POST /slack/interactivity` — answers 200 before dispatching `amplifier.repost`, because Slack's
  interactivity budget is three seconds and starting a run is slower than that.
- `GET /slack/oauth/callback` — waits on `amplifier.saveUserToken` with `dispatcher.run` and a
  20-second timeout, so the browser gets a real answer instead of a page that says "probably".

`GET /healthz` is the Render health check path. `DISPATCH_TOKEN` stays unset, which makes
`POST /tasks/:task` answer 401 to everything. Nothing in amplifier uses that route.

## Testing

`fakeCtx()` returns a context whose `run` throws. `test/listPublished.test.ts` uses it bare for a leaf
task, so a call that unexpectedly chains a subtask fails loudly instead of receiving `undefined`. For a
task that does chain, `test/support/taskCtx.ts` wraps `fakeCtx` with a `run` that dispatches by task
name to stub handlers and records every call in order. An unstubbed name still throws.

`localCtx()` runs chained tasks in-process by invoking each target's undecorated function.
`scripts/local-run.ts` uses it to drive the whole announce path against a local Key Value with no
credentials. It checks the wiring and the Key Value state, not durability: no retries and no timeouts.

## Upgrading a package

Change the exact version, then check the places amplifier reaches past the packaged task:

1. `src/slack/postNote.ts` requires a channel and a bot token, mirroring the condition `postMessageImpl`
   uses to take the Web API route. A change to that condition makes the two disagree about when Slack is
   configured, and only that route returns the `ts` a thread reply needs.
2. The same file patches the request body as JSON. A body the vendor no longer serializes as JSON
   throws in `rewriteBody`.
3. `@render-lab/test-utils` calls each task's undecorated `func`, so a change to how `task()` stores it
   breaks `localCtx` and `test/main.test.ts`.
4. `@renderinc/sdk` must stay one physical copy at the version every package pins. Two copies mean two
   registries and an empty task list on deploy.

Run `pnpm check` and `render workflows start <slug>/ping --input='[]'` after any upgrade.
