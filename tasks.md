# Render Tasks in Amplifier

[Render Tasks](https://github.com/render-lab/render-tasks) is a set of packages that wrap vendor APIs
as [Render Workflows](https://render.com/docs/workflows) tasks. In amplifier, every network
call out of the process runs as one of those tasks: Typefully, Anthropic, Render Key Value, and Slack.
Each task carries its own retry policy, and a run that dies part way through resumes from the last
completed task.

The packages are a proof of concept and break their APIs between releases, so `package.json` pins
every version exactly. `@renderinc/sdk` is pinned to `1.0.0` because each package declares it as an
exact peer dependency: one physical copy means every task registers into the same `TaskRegistry`.

## Packages

| Package                       | Version | What amplifier gets from it                                                                                                                    |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@render-lab/tasks-render-kv` | 0.3.0   | `kv.get`, `kv.set`, `kv.delete`, `kv.lock`, `kv.unlock`. `src/amplifier/seen.ts` builds the announced markers and the in-flight locks on them. |
| `@render-lab/tasks-slack`     | 0.3.0   | `postMessageImpl`, the `SlackDeps` ports, and `SLACK_RETRY`. `src/slack/postNote.ts` wraps them.                                               |
| `@render-lab/tasks-llm`       | 0.8.1   | `llm.complete`, called in `src/summary/summarize.ts` for the note's lead line.                                                                 |
| `@render-lab/tasks-core`      | 0.3.0   | `createHttpClient`, which backs the Typefully REST port in `src/typefully/client.ts`. Defines no tasks.                                        |
| `@render-lab/triggers`        | 0.2.0   | `serveDispatchServer` and the `WebhookAdapter` contract, which are the whole `amplifier-webhook` service.                                      |
| `@render-lab/test-utils`      | 0.1.0   | `fakeCtx` and `localCtx`, the `TaskContext` fakes the tests and `pnpm local:run` use.                                                          |

## Defining a task

Write the implementation as a plain exported function taking `TaskContext` first, then wrap it with
`task()`. The pair is the convention throughout `src/`: tests and `scripts/local-run.ts` call the
`Impl` function with a fake context, and production calls the registered task.

```ts
export async function listPublishedImpl(ctx, input, deps = defaultDeps, env = process.env) { ... }

export const listPublished = task(
  { name: "typefully.listPublished", retry: TYPEFULLY_RETRY },
  listPublishedImpl,
);
```

`src/main.ts` imports `announcePost.js`, `checkPosts.js`, and `handleEvent.js` for the side effect.
Each module calls `task()` at load, so the import registers amplifier's three entry tasks and, through
their imports, every vendor task they call. To confirm the registry loaded on a deploy, run
`render workflows start <slug>/ping --input='[]'` and expect `pong`.

## Calling a task

`ctx.run(task, input)` dispatches a subtask and waits for it. Amplifier's tasks compose rather than
call vendor clients directly, so `amplifier.checkPosts` reads as a list of `ctx.run` calls against
`typefully.listPublished`, `kv.*`, `llm.complete`, and `amplifier.postNote`.

Each `ctx.run` polls its own subtask every 500ms. Dispatch independent calls together with
`Promise.all`, the way `announcedDraftIds` and `markAnnounced` do, or 25 sequential Key Value reads
wait through 25 poll intervals.

Two tasks can share one implementation. `amplifier.handleEvent` registers `checkPostsImpl` directly,
which gives the webhook path its own name in the Dashboard and its own retry policy without a second
dispatch.

## Retry policies

A retry policy is per task, declared in the `task()` options, and each one lives in a `retry.ts` next
to the tasks it covers. Vendor packages export their own tuning (`SLACK_RETRY`, `LLM_RETRY`), and
amplifier's policies are `TYPEFULLY_RETRY` in `src/typefully/retry.ts` and `HANDLE_EVENT_RETRY` in
`src/amplifier/retry.ts`.

Changing a policy means checking two dependents:

- `MAX_SETTLE_MINUTES` computes the total backoff of `HANDLE_EVENT_RETRY` and caps
  `AMPLIFIER_SETTLE_MINUTES` at it. A settle deadline past the retry budget means the retries run out
  before the deadline and the post gets no note.
- `announceGroups` calls `summarizeGroup` before taking the in-flight lock, because `LLM_RETRY` spends
  about 62 seconds of backoff and `INFLIGHT_TTL_SECONDS` is 300. Inside the lock, the lock could expire
  mid-call and a second run would re-post the note.

Rate limits are handled in-process instead. The Typefully port passes `retry` to `createHttpClient`,
because a durable re-dispatch re-fires the same request and sustains the limit.

## Wrapping a vendor task

Wrap the vendor's `Impl` function under your own task name when the packaged behavior is wrong for
amplifier. `amplifier.postNote` does both things this is for:

- It adds `unfurl_links: false` and `unfurl_media: false` to the outgoing request body through a
  custom `fetchImpl`, because `@render-lab/tasks-slack` 0.3.0 sends neither and exposes no option.
- It throws when Slack is unconfigured, instead of letting the packaged webhook port log the note and
  return `delivered: false`. A run that cannot post must not report success.

The wrapper builds its `SlackDeps` per call, so `SLACK_BOT_TOKEN` is read at call time and not at
import. Both changes can be dropped once the vendor package covers them.

## Ports and deps

A leaf task that talks to a vendor takes a deps object with a default, as `listPublishedImpl` does with
`TypefullyDeps`. The default port is built on first use through a getter, never at import, so
`TYPEFULLY_API_KEY` and `TYPEFULLY_BASE_URL` come from the environment the run has rather than the one
the module loaded in. Tests pass a fake port instead.

## Triggers

Workflows have no HTTP entry point, so `amplifier-webhook` is a separate Render web service running
`serveDispatchServer`. It serves `GET /healthz` for the Render health check and
`POST /webhooks/typefully`, and it starts runs through the Render API with `RENDER_API_KEY` and
`WORKFLOW_SLUG`.

`src/typefully/webhook.ts` supplies the `WebhookAdapter`: `verify` checks the HMAC-SHA256 signature and
the timestamp, and `map` returns `{ task: "amplifier.handleEvent", args: [...] }` or `null` to ignore
the event. `verify` is the only thing between a public URL and a workflow run, because
`POST /webhooks/:name` does not check `DISPATCH_TOKEN`.

`DISPATCH_TOKEN` stays unset, which makes `POST /tasks/:task` answer 401 to everything. Nothing in
amplifier uses that route.

## Testing

`fakeCtx()` returns a context whose `run` throws. Use it for a leaf task, so a call that unexpectedly
chains a subtask fails loudly instead of receiving `undefined`. Stub `run` when the task under test
does chain.

`localCtx()` runs chained tasks in-process by invoking each target's undecorated function. Use it for
composition tests and for `scripts/local-run.ts`, which drives the whole announce path against a local
Key Value with no credentials. It checks the wiring and the Key Value state, not durability: there are
no retries and no timeouts.

## Upgrading a package

Change the exact version, then check the places amplifier reaches past the packaged task:

1. `src/slack/postNote.ts` mirrors the Web-API-versus-webhook branch inside `postMessageImpl`. A change
   to that branch makes the two disagree about when Slack is configured.
2. The same file patches the request body as JSON. A body the vendor no longer serializes as JSON
   throws in `withUnfurlOff`.
3. `@render-lab/test-utils` calls each task's undecorated `func`, so a change to how `task()` stores it
   breaks `localCtx`.
4. `@renderinc/sdk` must stay one physical copy at the version every package pins. Two copies mean two
   registries and an empty task list on deploy.

Run `pnpm check` and `render workflows start <slug>/ping --input='[]'` after any upgrade.
