# Plan: remind the channel when a note has not been reposted

Thirty minutes after amplifier posts a note in `SLACK_CHANNEL`, check whether the thread was
reposted. If it was not, reply in the thread with `reply_broadcast` so the reminder also shows in
the channel.

## Shape

`announceGroups` starts a separate workflow run for the check and returns. Only that run holds a
task for 30 minutes, and cancelling or redeploying during the announce path cannot take the
reminder with it.

`renderDispatcher` from `@render-lab/triggers` does the starting, the same call the receiver
makes. `start` returns a run id immediately, and the Workflow service starts the run on itself by
slug. That needs `RENDER_API_KEY` and `WORKFLOW_SLUG` on the Workflow service, which today carries
neither — a Render API key is workspace-wide, so this is a real credential added to a second
service.

The 30 minutes are spent inside `amplifier.remindRepost`, which sleeps. `RunSubtaskRequest` in
`@renderinc/sdk` 1.0.0 has no delay field and a started run begins at once, so nothing schedules
the check for later. A task may run that long: `timeoutSeconds` accepts 30 to 86400 seconds.

## How "reposted" is checked

A Key Value marker written by `amplifier.repost`. Reading reactions would need a `reactions:read`
scope and a raw Slack call, because `@render-lab/tasks-slack` 0.3.0 wraps neither `reactions.get`
nor `conversations.replies`.

Limitation: a repost done by hand, without the button, still gets a reminder. Anyone can delete
the reminder. Accept this for the first version.

## Steps

### 1. `src/amplifier/remindRepost.ts` (new)

```ts
export interface RemindRepostInput {
  channel: string;
  messageTs: string;
  /** Epoch milliseconds the check is due at. */
  dueAtMs: number;
}

export const remindRepost = task(
  { name: "amplifier.remindRepost", timeoutSeconds: 2400, plan: "starter", retry: REMIND_RETRY },
  remindRepostImpl,
);
```

- `repostedKey(channel, messageTs)` → `amplifier:reposted:<channel>:<ts>`, and
  `remindedKey(channel, messageTs)` → `amplifier:reminded:<channel>:<ts>`.
- `remindRepostImpl` takes `now` and `sleep` deps so a test can drive both. It sleeps
  `Math.max(0, dueAtMs - now())` milliseconds, reads both markers, and returns early when either
  is set. Otherwise it `kvSet`s the reminded marker, then calls
  `ctx.run(postNote, { channel, text, markdown, threadTs: messageTs, broadcast: true })`.
- Return `{ reminded: boolean, reason?: "reposted" | "already-reminded" }`.

`dueAtMs` on the input rather than a duration, so a retry after a crash waits out what is left
instead of starting the 30 minutes over. The reminded marker is written before the post, so two
runs for one note produce one reminder.

`REMIND_RETRY` in `src/amplifier/retry.ts` is `{ maxRetries: 2, waitDurationMs: 10_000 }`, for
crash recovery only. A deploy during the sleep kills the task and the resumed attempt finishes the
remaining wait.

### 2. `src/amplifier/dispatchRun.ts` (new)

One function, `startRun(task, args, env)`, wrapping `renderDispatcher({ slug: env.WORKFLOW_SLUG })`
and `start`. Built per call through a getter, the way `typefullyPort` is, so `RENDER_API_KEY` is
read at call time and not at import.

When `RENDER_API_KEY` or `WORKFLOW_SLUG` is unset, log and return null instead of throwing. That
keeps `pnpm local:run` and `localCtx` off the Render API.

### 3. `src/amplifier/announce.ts`

At the end of the posted branch, after `pingLaunchOwners`, when `config.reminderMinutes > 0` and
`threadTs` is set:

```ts
try {
  await startRun("amplifier.remindRepost", [
    {
      channel: noteChannel ?? parent.channel,
      messageTs: threadTs,
      dueAtMs: Date.now() + config.reminderMinutes * 60_000,
    },
  ]);
} catch (err) {
  console.error("[amplifier] The repost reminder run did not start.", err);
}
```

Caught, because the note is already posted and a failed dispatch must not fail the announce run or
re-post the note. Skipped under `DRY_RUN`, along with the rest of the posted branch.

### 4. `src/amplifier/repost.ts`

In `markSource`, `kvSet` `repostedKey(input.channel, input.messageTs)` to `"reposted"` with the
seen TTL, in its own try/catch like the reaction. The repost already happened, so a failed write
must not retry the task.

### 5. `src/slack/postNote.ts`

Add `broadcast?: boolean` to `PostNoteInput` and `reply_broadcast: true` to `rewriteBody`, next to
`thread_ts`. Pass it through `outgoingFetch` the way `threadTs` is passed.

### 6. `src/main.ts`

Import `remindRepost` for the side effect. It is an entry point now — a run starts it by name, so
an unimported task does not exist on the deploy.

### 7. `src/config.ts`

- `reminderMinutes` from `AMPLIFIER_REMINDER_MINUTES`, default 30, `0` turns reminders off.
- `reminderText` from `AMPLIFIER_REMINDER_TEXT`, default:

  > This post still needs to be shared in #amplify. The first hour matters most — can the owner or
  > anyone on the team share it?

Build the channel name in the text from `config.repostChannel`, and only run reminders when it is
set, so the ask and the button name the same channel.

### 8. `render.yaml` and the Workflow service

Add `RENDER_API_KEY` and `WORKFLOW_SLUG` to the `amplifier-workflow` env group. Both are secrets or
deploy-specific, and `sync: false` is ignored inside an env group, so add them by hand in the
Dashboard and list them in the README's Deployment step 4 rather than putting values in the
Blueprint.

### 9. Tests

- `test/remindRepost.test.ts` — with a fake `sleep`, it waits until `dueAtMs`, a past `dueAtMs`
  waits zero, a missing marker posts one broadcast reply, a reposted marker posts nothing, and a
  reminded marker posts nothing. Use `test/support/kvStore.ts` with its virtual clock and `runCtx`
  from `test/support/handlers.ts`.
- `test/postNote.test.ts` — `broadcast: true` puts `reply_broadcast` in the request body.
- `test/announce.test.ts` — the announce result is unchanged when the dispatch throws, and no
  dispatch happens under `DRY_RUN` or with `reminderMinutes` at 0. Inject a fake `startRun`.
- `test/main.test.ts` — `amplifier.remindRepost` is in the registry.

### 10. Docs

Add the two new environment variables to `.env.example`, and a "Repost reminders" section to the
README covering the separate run, the API key it needs, and the by-hand-repost limitation. Add
`amplifier.remindRepost` to the entry-point table in `tasks.md` and say the delay is a sleep, with
`REMIND_RETRY` there for crash recovery.

## Check

`pnpm check`, then `render workflows start <slug>/amplifier.remindRepost` with a `dueAtMs` already
in the past and confirm one reply lands in the thread and in the channel. Run it again and confirm
the reminded marker stops a second one.
