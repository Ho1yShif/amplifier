# Webhook Trigger Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to work through this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 30-minute cron trigger with a Typefully webhook receiver, so a note reaches
`#amplify` seconds after a post goes live instead of up to half an hour later. The receiver only
verifies the delivery and starts a run; every step after the HTTP boundary is a registered workflow
task with a retry policy.

**Baseline:** `pnpm test` passes 134 tests across 13 files and `pnpm typecheck` is clean at
`bbf7288`. Every task below must end with both still passing. Node 22.20.0 or newer is required;
pnpm refuses to run on 22.12.

**Not in scope:** The announce-once guarantee, the dedupe unit (still one draft), the Key Value key
names, the grouping rule in `groupPosts`, and the note's rendered output all stay as they are. The
Workflow service is still created by hand, because Blueprints do not support Workflows.

## What this plan replaces

`plan.md` used to hold the cleanup plan, all 16 tasks checked. That work is committed. Task 15 of
this plan updates the one file that describes what `plan.md` contains.

## Decisions this plan implements

Two questions were settled before the plan was written.

The cron job is deleted rather than kept as a slower backstop. The webhook becomes the only trigger.
The cost is real and worth stating once: if Typefully drops a delivery, that post is never announced
and nothing comes back for it. The retry policies below cover failures after an event arrives, not
an event that never arrives. Task 14 adds a manual re-run command to the README for that case.

A draft cross-posted to X and LinkedIn does not publish to both at the same instant, and `mapDraft`
counts a platform as published only once its permalink exists. The cron hid this by arriving late.
A webhook arrives immediately, so the first event can see a draft with only one permalink filled in.
The fix is a settle rule: while a platform is enabled but has no permalink, the publish is still in
flight, so the task throws and the retry re-reads Typefully a minute later. Once the settle deadline
passes, the note goes out with whatever links exist. A note with one link beats no note.

## What the vendor already provides

Read this before writing any receiver code. `@render-lab/triggers` 0.2.0 ships the whole HTTP layer,
so the only new code on the receiver side is one adapter and one entry point.

`createDispatchServer({ webhooks })` returns a Hono app with:

- `GET /healthz`, returning `ok`. This is the Render health check path.
- `POST /webhooks/:name` for each key in `webhooks`. It reads the body under a 1 MiB cap before
  verifying anything, calls `adapter.verify({ headers, rawBody })` and answers 401 when it fails,
  parses the JSON, calls `adapter.map({ headers, body })`, and answers 204 when `map` returns null.
  On a mapped event it calls `dispatcher.start(task, args)` and answers 202, or 502 when the
  dispatch throws.
- `POST /tasks/:task`, a bearer-authed generic dispatcher gated on `DISPATCH_TOKEN`.

`serveDispatchServer` is the same app bound to `$PORT` on all interfaces.

The 502 on a failed dispatch makes Typefully retry the delivery. That hop is the one place
a workflow task cannot wrap, because dispatch creates the run.

`WebhookAdapter` is `{ verify(req: WebhookRequest): boolean; map(ctx: WebhookContext): WebhookDispatch | null }`.
Note that `/webhooks/:name` does not check `DISPATCH_TOKEN`. `verify` is the only thing standing
between the public URL and a workflow run, so Task 1 has to finish before Task 9 can be written.

---

## Group A: the unknown

### Task 1: Find out how Typefully signs a delivery

**Files:**

- Create: `docs/typefully-webhook.md`
- Create: `test/support/typefully-event.json`

The Typefully docs describe six events (draft created, published, scheduled, status changed, tags
changed, deleted) and say webhooks are added under Settings > API. They do not say whether a
delivery is signed, which header carries the signature, or what the payload holds. `verify` and
`map` cannot be written until that is known.

Register a webhook against a request-capture URL, publish a test draft, and record what arrives:

1. Every request header, with the signature header's name and format.
2. Whether Typefully offers a signing secret in the UI when the webhook is added.
3. The full body for a `draft.published` event, including whether it carries the draft id, the
   platform permalinks, and a timestamp.
4. Whether a cross-post to X and LinkedIn produces one event or two.

Write the findings to `docs/typefully-webhook.md` and save one real body, with any account
identifiers replaced, as `test/support/typefully-event.json`. Tasks 9 and 10 read both.

Then pick the verification strategy and record which one, with the reason:

- Typefully signs with an HMAC over the raw body. `verify` recomputes it and compares with
  `timingSafeEqual`. Preferred.
- Typefully sends a static secret header. `verify` compares it with `timingSafeEqual`.
- Typefully sends nothing verifiable. The webhook is registered at
  `/webhooks/typefully-<random>` and `verify` returns true, with the path segment as the secret.
  Record this as a deficiency in `docs/typefully-webhook.md`.

Do not guess. If the capture cannot be run, stop and say so rather than implementing a `verify`
against an invented header name.

**Verify:** `docs/typefully-webhook.md` names the real header, and
`test/support/typefully-event.json` parses as JSON.

- [x] Task 1 complete

---

## Group B: the settle rule

This group is independent of Task 1 and can be worked in parallel with it.

### Task 2: Report which platforms are still publishing

**Files:**

- Modify: `src/typefully/types.ts`
- Modify: `src/typefully/map.ts`
- Modify: `test/map.test.ts`

`mapDraft` reads the raw draft and is the only place that sees `x_post_enabled` and
`linkedin_post_enabled`. Task 2 of the previous plan kept those two fields purely as documentation
of what the mapper ignores. They now do a job: enabled with no permalink means the publish is in
flight.

Add to `PublishedPost`:

```ts
/** Platforms this draft was queued for that have not reported a permalink yet. */
pending: Platform[];
```

Always present, empty when nothing is outstanding, so no caller has to test for undefined. Populate
it in `mapDraft`: a platform is pending when its `*_post_enabled` is true and its `*_published_url`
is absent. Extend `PLATFORM_FIELDS` with the `enabled` field name so the loop still reads both
platforms one way.

A platform can be both published and pending under this rule if Typefully sets the timestamp before
the URL. Prefer that over the alternative: a link with no URL renders as bare text, so the note
should wait.

Update the doc comment on `mapDraft` and drop the two "Not read" comments in `types.ts`, which are
now false.

Add cases to `test/map.test.ts`: enabled with no URL is pending, enabled with a URL is not, not
enabled is not, and a draft with neither platform enabled maps to an empty `pending`.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 2 complete

### Task 3: The settle decision, as a pure function

**Files:**

- Create: `src/amplifier/settle.ts`
- Create: `test/settle.test.ts`

One module, two exported functions, no I/O:

```ts
/** Milliseconds after which an incomplete draft gets announced anyway. */
export function settleDeadlineMs(eventAt: string, settleMinutes: number): number;

/** The still-publishing platforms of the event's draft, or [] when it is complete or absent. */
export function pendingForDraft(posts: PublishedPost[], draftId: string): Platform[];
```

`settleDeadlineMs` throws on an `eventAt` that will not parse, matching how `checkPostsImpl` already
treats `input.now`. A deadline computed from garbage would either fire forever or never.

`pendingForDraft` returns `[]` for a draft id that is not in `posts`. Absent from the window is not
the same as incomplete, and it must not hold up a run. That happens when the event is for a draft
outside the lookback, or for one that never published to X or LinkedIn.

`test/settle.test.ts` covers: a deadline in the future, a deadline in the past, a zero
`settleMinutes` making the deadline the event time, an unparseable `eventAt` throwing, a draft with
one pending platform, a complete draft, and an unknown draft id.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 3 complete

### Task 4: Config for the settle window

**Files:**

- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

Add `AMPLIFIER_SETTLE_MINUTES` through the existing `whole` helper, fallback 10, min 0, no max. Zero
turns settling off, matching how `AMPLIFIER_GROUP_WINDOW_MINUTES` treats zero. Add `settleMinutes`
to `AmplifierConfig` and `CheckPostsInput`.

Add two fields to `CheckPostsInput`, both optional so a manual dispatch with `{}` still works:

```ts
/** ISO 8601 time the webhook event was received. Absent means do not settle. */
eventAt?: string;
/** Typefully draft the event was about. Absent means do not settle. */
draftId?: string;
```

The deadline is derived from `eventAt` in the args plus `settleMinutes` from the environment, so
every retry of a run computes the same deadline. `TaskContext` exposes no attempt number and no
sleep, so a deadline fixed at dispatch time is the only way to make the last attempt behave
differently from the earlier ones.

Update the `loadConfig` doc comment. It currently explains the 90-minute lookback as covering a
skipped 30-minute cron run. With the cron gone, the lookback covers the gap between the event and
the run, plus any retry backoff, and it is wide enough that a manual re-run catches a missed post.

Add config cases: the default, an override, a blank variable falling back, and a negative value
throwing.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 4 complete

### Task 5: The settle check inside checkPostsImpl

**Files:**

- Modify: `src/amplifier/checkPosts.ts`
- Create: `src/amplifier/StillPublishingError.ts`
- Modify: `test/checkPosts.test.ts`

Insert one step into the existing sequence, after the `announcedDraftIds` read and before
`groupPosts`. Placement matters: the check must sit after the marker read, so a draft that was
already announced never blocks, and before `claimGroup`, so no in-flight lock is held across the
retry backoff.

```
list -> window -> announced markers -> SETTLE CHECK -> group -> summarize -> claim -> post -> mark
```

The check runs only when `config.settleMinutes > 0` and both `input.eventAt` and `input.draftId` are
present. When `pendingForDraft(recent, input.draftId)` is non-empty and `nowMs` is before
`settleDeadlineMs(input.eventAt, config.settleMinutes)`, throw `StillPublishingError` carrying the
draft id, the pending platforms, and the deadline. Past the deadline, log one line naming the
platforms being dropped and carry on.

`StillPublishingError` is its own class so `handleEvent` in Task 6 and a reader of the run logs can
tell an expected wait from a real failure. Give it a message that reads as a wait:
`Draft 123 is still publishing to x; retrying until 12:40:00Z`.

Add to `CheckPostsResult`:

```ts
/** Platforms announced without a link because the settle deadline passed. */
droppedPlatforms: Platform[];
```

Add cases to `test/checkPosts.test.ts`: a pending draft before the deadline throws
`StillPublishingError` and posts nothing; a pending draft past the deadline posts and reports
`droppedPlatforms`; a complete draft posts on the first attempt; a pending draft that is already
announced does not throw; an event for a draft outside the window does not throw; and
`settleMinutes: 0` never throws. Pass `now` to pin the clock, as the existing tests do.

**Verify:** `pnpm typecheck && pnpm test`. No existing test may change, because every one of them
calls `checkPostsImpl` without `eventAt`, which leaves the new branch inert.

- [x] Task 5 complete

### Task 6: The retried task the webhook dispatches

**Files:**

- Create: `src/amplifier/handleEvent.ts`
- Modify: `src/main.ts`
- Create: `test/handleEvent.test.ts`
- Modify: `test/main.test.ts`

`amplifier.checkPosts` stays registered with no retry, so a manual dispatch and
`scripts/local-run.ts` keep behaving as they do now. The retry policy lives on a separate task for the
webhook path:

```ts
export const handleEvent = task(
  {
    name: "amplifier.handleEvent",
    retry: { maxRetries: 4, waitDurationMs: 60_000, backoffScaling: 2 },
  },
  handleEventImpl,
);
```

Four retries at 1m, 2m, 4m, and 8m give a 15-minute settle budget against a 10-minute deadline, so
the deadline ends the wait and the retry count is only the ceiling. Keep that relationship
in a comment: raising `AMPLIFIER_SETTLE_MINUTES` past 15 makes the retries run out first, and the
event is then lost with no note.

`handleEventImpl` calls `checkPostsImpl` directly rather than through `ctx.run`, so it adds no
second dispatch and no second poll interval. It exists to carry the retry policy and to give the
webhook path its own name in the dashboard.

One retry-safety property to keep intact, and to assert in the tests: a retry that follows a
successful Slack post does not double-post, because `markAnnounced` writes the seen marker after
delivery and the retry's `announcedDraftIds` read drops the draft. The existing `catch` around the
post already calls `releaseGroup` before rethrowing, so a retry does not collide with its own
predecessor's lock.

Import the module in `src/main.ts` so the task registers, and add it to the registration assertions
in `test/main.test.ts`.

`test/handleEvent.test.ts` covers: a throw on the first attempt followed by a successful second
attempt against a Typefully fake whose second response carries the missing permalink, and a second
call after a delivered post announcing nothing.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 6 complete

---

## Group C: the receiver

Every task in this group needs the answer from Task 1.

### Task 7: The Typefully webhook adapter

**Files:**

- Create: `src/typefully/webhook.ts`
- Create: `test/webhook.test.ts`

Export one factory:

```ts
export function typefullyWebhook(opts?: { env?: NodeJS.ProcessEnv; now?: () => Date }): WebhookAdapter;
```

`verify` implements whatever Task 1 established, reading `TYPEFULLY_WEBHOOK_SECRET` from the env on
each call rather than at import, matching how `typefullyPort` reads its API key. A missing secret
returns false, so an unconfigured receiver rejects deliveries instead of answering 500 to every
one of them. Compare with `timingSafeEqual`.

`map` returns null for every event except the published one. No other event can produce a note. A draft created, scheduled, deleted, or re-tagged changes nothing amplify cares
about, and the server answers those 204. Read the event type from wherever Task 1 found it, and
return null on an unrecognized type rather than treating it as published, so a new Typefully event
does not start a run.

For a published event, return:

```ts
{ task: "amplifier.handleEvent", args: [{ draftId, eventAt: now().toISOString() }] }
```

`eventAt` is stamped at receipt rather than read from the payload. The receiver controls it, it is
stable across every retry of the run because it lives in the args, and it does not depend on
Typefully reporting a timestamp. `now` is injectable so the test can pin it.

Omit `draftId` when the payload has no id. The settle check in Task 5 needs both fields, so a
payload without an id becomes a plain window rescan.

`test/webhook.test.ts` is table-driven over the six event types plus one unrecognized type, and
covers a valid signature, an invalid signature, a missing secret, a body that is not the expected
shape, and a published event with no draft id. Build the requests from
`test/support/typefully-event.json` so the fixture and the adapter cannot drift.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 7 complete

### Task 8: The receiver entry point

**Files:**

- Create: `src/webhook-server.ts`
- Delete: `src/cron-trigger.ts`
- Modify: `package.json`

`src/webhook-server.ts` replaces `src/cron-trigger.ts` as the trigger entry point:

```ts
serveDispatchServer({ webhooks: { typefully: typefullyWebhook() } });
```

`workflowSlug` and the dispatcher default to `WORKFLOW_SLUG` and the Render SDK, and the port
defaults to `$PORT`, so nothing else needs passing. Open the file with a comment saying what the
service is, the same way `cron-trigger.ts` does: a separate Render web service, not the Workflow,
whose only job is to verify a delivery and start a run.

If Task 1 concluded that Typefully sends nothing verifiable, mount the adapter under the
random-suffixed name instead of `typefully`, read from `TYPEFULLY_WEBHOOK_PATH`, and say in the
comment that the path is the secret.

Replace the `trigger:cron` script with `trigger:serve`, running `node dist/webhook-server.js`.

**Verify:** `pnpm build`, then `PORT=3000 WORKFLOW_SLUG=x TYPEFULLY_WEBHOOK_SECRET=y node dist/webhook-server.js`
answers `ok` on `GET /healthz` and 401 on an unsigned `POST /webhooks/typefully`.

- [x] Task 8 complete

### Task 9: A local way to fire an event

**Files:**

- Create: `scripts/webhook-post.ts`
- Modify: `package.json`

`scripts/local-run.ts` proves the announce-once guarantee without deploying. Nothing yet proves the
receiver, so add the equivalent: a script that signs `test/support/typefully-event.json` with
`TYPEFULLY_WEBHOOK_SECRET` and POSTs it to a locally running `webhook-server`.

Take the draft id as an optional argument so the event can be pointed at whatever the stub in
`scripts/typefully-stub.ts` serves. Print the response status and body, and say in the header
comment that a 202 proves the signature and the mapping, while the run itself is the Workflow
service's business.

Add a `webhook:post` script.

**Verify:** With `redis-server`, `pnpm stub`, and the built receiver running, `pnpm webhook:post`
answers 202, and the same command with a wrong secret answers 401.

- [x] Task 9 complete

---

## Group D: infrastructure

### Task 10: Swap the cron service for a web service in the Blueprint

**Files:**

- Modify: `render.yaml`

Replace the `amplifier-cron` cron service with:

```yaml
- type: web
  name: amplifier-webhook
  runtime: node
  plan: starter
  region: oregon
  buildCommand: pnpm install && pnpm build
  startCommand: node dist/webhook-server.js
  healthCheckPath: /healthz
  autoDeployTrigger: commit
  envVars:
    - fromGroup: amplifier-triggers
```

Keep the plan at starter and the region at oregon, matching the Key Value instance and the
hand-created Workflow service.

In the `amplifier-triggers` group, keep `RENDER_API_KEY` and `WORKFLOW_SLUG`, both still
`sync: false`. Drop `CRON_TASK` and `CRON_INPUT`, which only the cron helper read. Add
`TYPEFULLY_WEBHOOK_SECRET` with `sync: false`, because it comes from the Typefully dashboard.

Do not add `DISPATCH_TOKEN`. It gates `POST /tasks/:task`, which nothing in amplifier uses. Leaving
it unset makes that route answer 401 to everything. Say so in a
comment, so the next reader does not add the variable to make a route work that should stay shut.

Rewrite the file's opening comment. It currently describes a cron service that starts runs; it now
describes a web service that receives Typefully deliveries. Keep the ordering note about creating
the Workflow service first and copying the Key Value connection string into `REDIS_URL`, and add
the new last step: register the receiver's public URL in Typefully under Settings > API.

**Verify:** `render blueprints validate` if the CLI is available. Otherwise confirm by reading that
every referenced env group exists, no service references a deleted variable, and
`grep -n "cron" render.yaml` returns nothing.

- [x] Task 10 complete

### Task 11: Remove the cron from the environment example

**Files:**

- Modify: `.env.example`

Rename the last section from "trigger layer (@render-lab/triggers): the cron service only" to name
the receiver. Drop `CRON_TASK` and `CRON_INPUT`. Add `TYPEFULLY_WEBHOOK_SECRET` and `PORT`, with
`PORT` noted as set by Render in production and only needed locally.

Add `AMPLIFIER_SETTLE_MINUTES=10` to the amplifier config block, commented out like its neighbours,
with a one-line note that it must stay under the retry budget from Task 6.

Fix the comment on `AMPLIFIER_LOOKBACK_MINUTES`, which says "wider than the 30-minute schedule, so a
skipped run still catches up". There is no schedule now.

`AMPLIFIER_LIMIT` says "max 100". `MAX_LIMIT` is 50, and `bbf7288` capped it there because Typefully
rejects more with a 422. Correct the number while in the file.

**Verify:** Every variable in `.env.example` appears in `src/`, `scripts/`, or `render.yaml`, and
every variable those read appears in `.env.example`.

- [x] Task 11 complete

### Task 12: Point local-run at the right explanation

**Files:**

- Modify: `scripts/local-run.ts`

The header says two runs prove the announce-once guarantee "across runs". That is still true and
still worth running. Add one sentence: the same guarantee makes the Task 6 retry safe,
because a retry after a delivered note reads the seen marker and announces nothing.

Do not change what the script does. It calls `checkPostsImpl` with no `eventAt`, so the settle
branch stays inert, so it checks the announce-once behavior on its own.

**Verify:** `redis-server &`, `pnpm stub &`, `pnpm local:run 2` still reports `notified: 2` then
`notified: 0` with `skipped: 2`.

- [x] Task 12 complete

---

## Group E: documentation

### Task 13: Redraw the architecture diagram

**Files:**

- Modify: `README.md`

The diagram opens with "every 30 min" feeding `amplifier-cron`. Replace the trigger with the
receiver and add the settle step:

```
   post goes live
         │
         ▼
┌────────────────────┐   POST         ┌──────────────────────────┐
│ Typefully          │ ─────────────▶ │ amplifier-webhook        │
│ Settings > API     │  /webhooks/    │ web service              │
└────────────────────┘   typefully    └────────────┬─────────────┘
                                       verify, map │ dispatch
                                                   ▼
                                      ┌──────────────────────────┐
                                      │ amplifier (Workflow)     │
                                      │ amplifier.handleEvent    │
                                      └────────────┬─────────────┘
  1  typefully.listPublished ─────────────────────┼──▶ Typefully API
  2  withinWindow, then announcedDraftIds ────────┼──▶ amplifier-kv
  3  settle check: throw while a platform is pending
  4  groupPosts                                   │
  5  llm.complete ────────────────────────────────┼──▶ Anthropic
  6  claimGroup, one kv.lock per draft ───────────┼──▶ amplifier-kv
  7  amplifier.postNote ──────────────────────────┼──▶ Slack #amplify
  8  markAnnounced, then releaseGroup ────────────┴──▶ amplifier-kv
```

Renumber the prose list under it to match, and rewrite its opening sentence, which currently says a
cron job runs every 30 minutes. Say instead that Typefully posts to the receiver when a draft
publishes, the receiver verifies the delivery and starts `amplifier.handleEvent`, and that task
retries at 1m, 2m, 4m, and 8m while a platform is still publishing.

Check the box-drawing characters render in a fixed-width font before committing. No emoji, no color.

**Verify:** Read the rendered README and confirm the diagram lines up. Every task name in it exists
in `src/`.

- [x] Task 13 complete

### Task 14: Rewrite deployment for the receiver

**Files:**

- Modify: `README.md`

Four changes.

The intro says the button's `render.yaml` covers "the cron job, the Key Value instance, and the env
groups". It now covers the web service instead of the cron job.

The deployment steps need the new last step: copy the receiver's `onrender.com` URL, add
`/webhooks/typefully` to it, and register that in Typefully under Settings > API, then copy the
signing secret back into `TYPEFULLY_WEBHOOK_SECRET` on the receiver. Give the order explicitly,
because the secret does not exist until the webhook is registered.

Add a short "Manual re-run" section. The webhook is the only trigger, so a dropped delivery needs a
human. Give the command that starts `amplifier.checkPosts` with an empty input, and say that the
90-minute lookback plus the seen markers mean a re-run announces what was missed and nothing else.
Check the invocation against `render workflows --help` before writing it.

Add a "Security" section, three sentences: the receiver's URL is public, `verify` is the only thing
gating it, and `POST /tasks/:task` stays shut because `DISPATCH_TOKEN` is unset. If Task 1 concluded
that Typefully sends nothing verifiable, say that the path segment is the secret and that the URL
must not be shared.

**Verify:** `pnpm format:check`. Every command in the section runs.

- [x] Task 14 complete

### Task 15: Update the configuration table and the plan reference

**Files:**

- Modify: `README.md`
- Modify: `.prettierignore`

In the README, add `AMPLIFIER_SETTLE_MINUTES` to the Workflow service table, default 10. Rename the
`### Cron service` table to name the receiver, drop `CRON_TASK` and `CRON_INPUT`, and add
`TYPEFULLY_WEBHOOK_SECRET`. Check every remaining default against `loadConfig` while in the table.

`.prettierignore` line 3 reads "The working cleanup plan, kept as it was written." Say instead that
`plan.md` is the working plan, hand-wrapped, and leave it ignored.

**Verify:** `pnpm format:check`, and each row's default matches the `fallback` value in `loadConfig`.

- [x] Task 15 complete

---

## Final check

```bash
pnpm check
grep -rn "cron\|CRON" src/ render.yaml .env.example package.json
git diff --stat
```

The grep must return nothing outside a comment explaining what the cron used to do. Test count must
be at least 134 plus the cases added in Tasks 2, 3, 4, 5, 6, and 7.

Then confirm the two properties this plan must not break, using `pnpm local:run 2`: the first run
reports `notified: 2` and the second reports `notified: 0` with `skipped: 2`.

- [x] All tasks complete
