# Silent-Failure Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to work through this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining ways amplifier can look healthy and announce nothing, and make
announcing one post by hand a single command. A run that cannot post must fail, the per-run limit
must have one default instead of two, and recovering a dropped delivery must not require
reconstructing a time window.

**Baseline:** `pnpm check` passes at `7b5bd38` — 190 tests across 16 files, typecheck and format
clean. Every task below must end with all three still passing. pnpm 11.18.0 refuses to run on Node
22.12; use 22.13 or newer.

**Not in scope:** The announce-once guarantee, the dedupe unit (still one draft), the Key Value key
names, the grouping rule in `groupPosts`, the settle rule, and the note's rendered output all stay as
they are. The Workflow service is still created by hand, because Blueprints do not support Workflows.

## What this plan replaces

`plan.md` used to hold the webhook trigger plan, all 15 tasks checked and committed through
`def34fd`. `docs/handoff-webhook-trigger.md` records what shipped.

## Decisions this plan implements

**A missing Slack credential fails the run.** `webhookPort` in `@render-lab/tasks-slack` logs the
note to the console and returns `delivered: false` when `SLACK_WEBHOOK_URL` is unset, which is right
for a demo and wrong here: `checkPostsImpl` logs the miss and the run still ends `completed` with
`notified: 0`. The same thing happens with `SLACK_BOT_TOKEN` set and `SLACK_CHANNEL` unset, because
`postMessageImpl` only takes the Web API branch when a channel is given and otherwise falls through
to the unconfigured webhook. Both become a thrown error at the delivery boundary.

The check goes in `postNoteImpl`, not in `loadConfig`. `loadConfig` would catch it earlier, before
the Typefully read and the LLM call, but `test/checkPosts.test.ts` calls `checkPostsImpl` with an
empty environment and injected Slack deps on purpose, so an environment check there would fail
about thirty tests that are not testing the environment.

**A dropped delivery is recovered by a task, not by a cron sweep or a hand-built window.** The
webhook trigger plan deleted the 30-minute cron and accepted the cost in writing: if Typefully drops
a delivery, that post is never announced. Restoring a cron service is not worth another service for a
delivery failure that has not happened yet.

The recovery that exists today is `amplifier.checkPosts` over the whole lookback, which cannot target
one post. Doing that by hand means finding the draft id with `curl` and `jq`, pinning `now` and
`lookbackMinutes` around its publish time, turning grouping off, and knowing that `withinWindow`
keeps future timestamps so the window has no upper bound. Too many steps to run under pressure, and
every one of them is a step a task can take. `amplifier.announcePost` takes the post's URL and does
the rest.

It shares the delivery path with `amplifier.checkPosts` rather than copying it. The per-group
sequence — summarize, claim, post, mark, release — moves into one function both tasks call, so the
announce-once guarantee has one implementation.

**One default for the per-run limit.** `loadConfig` falls back to 25 and `listPublishedImpl` defaults
`input.limit` to 25 independently. They agree today by coincidence.

---

## Group A: a run that cannot post must fail

### Task 1: Make postNoteImpl fail closed

**Files:**

- Modify: `src/slack/postNote.ts`
- Modify: `test/postNote.test.ts`

`postNoteImpl` already builds the vendor's deps per call, so it is the one place that sees both the
environment and the message. Add the check there, before `postMessageImpl`:

```ts
const viaWebApi = Boolean(input.channel && env.SLACK_BOT_TOKEN);
if (!viaWebApi && !env.SLACK_WEBHOOK_URL) {
  throw new Error(
    "Slack is not configured, so the note was not posted. Set SLACK_WEBHOOK_URL, or set " +
      "SLACK_BOT_TOKEN together with SLACK_CHANNEL.",
  );
}
```

The condition mirrors the branch in `postMessageImpl`: a channel plus a bot token takes the Web API
route, and everything else needs the webhook URL. Say so in the comment, and name the vendor version
it was read against, because a change to that branch would make the two disagree.

`amplifier.postNote` carries `SLACK_RETRY`, so a configuration error costs five retries before the
run fails. Leave that alone. The run ending `failed` in the dashboard is the point, and the retries
cost seconds.

In `test/postNote.test.ts`, replace "falls back to the console with no token and no webhook" with a
case asserting the throw, and add one for a bot token with no channel. The three existing delivery
tests already pass an environment holding a credential, so they do not change.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 1 complete

### Task 2: Correct the not-delivered branch in checkPostsImpl

**Files:**

- Modify: `src/amplifier/checkPosts.ts`

With Task 1 in place, `delivered: false` no longer means "no credential is set" — the real Slack
ports either deliver or throw, so the branch is only reachable through injected deps. Keep it, and
rewrite the comment and the log line, which currently tell the reader to set `SLACK_BOT_TOKEN` or
`SLACK_WEBHOOK_URL`. Say instead that the Slack port reported the note undelivered without throwing,
that the drafts stay unannounced, and that a later run retries them.

Do not change the control flow. Leaving the drafts unmarked is still correct.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 2 complete

### Task 3: Say so in the README

**Files:**

- Modify: `README.md`

Two changes in the Slack credentials section and the Workflow service configuration table.

The section explains that with neither credential the note prints to the console. That is no longer
true. Say that a run with no credential fails, and that this is deliberate: a run that cannot post
must not report success.

The `SLACK_CHANNEL` row says it needs `SLACK_BOT_TOKEN`. Add the other half: a bot token with no
channel fails the run, so set both or use the webhook alone.

**Verify:** `pnpm format:check`

- [x] Task 3 complete

---

## Group B: announcing one post by hand

This group is independent of Group A.

### Task 4: Extract the announce loop

**Files:**

- Create: `src/amplifier/announce.ts`
- Modify: `src/amplifier/checkPosts.ts`

A pure refactor, no behavior change. Move the body of the `for (const group of groups)` loop in
`checkPostsImpl` into one exported function:

```ts
export interface AnnounceOptions {
  /** Platforms to name as dropped, and the draft whose note names them. */
  droppedFor?: { draftId: string; platforms: Platform[] };
}

export interface AnnounceResult {
  notes: NoteResult[];
  /** Drafts left unannounced because another run holds the claim or already announced them. */
  skipped: number;
}

export async function announceGroups(
  ctx: TaskContext,
  groups: PostGroup[],
  config: AmplifierConfig,
  runToken: string,
  opts: AnnounceOptions = {},
): Promise<AnnounceResult>;
```

Everything the loop does stays where it is relative to everything else: summarize before the claim,
the dry-run log instead of the post, `markAnnounced` only after `delivered`, `releaseGroup` on both
the throw path and the success path. Keep the comments explaining why the summary is outside the
claim and why an undelivered note leaves the drafts unmarked — they belong to the loop, not to
`checkPostsImpl`.

`NoteResult` moves to `announce.ts` with it; `checkPosts.ts` re-exports it so no other import
changes. `checkPostsImpl` keeps the `runToken`, builds the groups, calls `announceGroups`, and adds
`announced.size` to the returned `skipped`.

**Verify:** `pnpm typecheck && pnpm test`. Not one test may change, and the diff on
`checkPosts.ts` must be a deletion plus one call.

- [x] Task 4 complete

### Task 5: The amplifier.announcePost task

**Files:**

- Create: `src/amplifier/announcePost.ts`
- Create: `test/announcePost.test.ts`
- Modify: `src/main.ts`
- Modify: `test/main.test.ts`

One task that announces one post, given the URL a human has in front of them:

```ts
export interface AnnouncePostInput {
  /** Permalink to the live post, X or LinkedIn. Either this or draftId. */
  url?: string;
  /** Typefully draft id, when the URL is not to hand. */
  draftId?: string;
  /** Announce a draft the seen marker already records. Re-posts the note. */
  force?: boolean;
  dryRun?: boolean;
  slackChannel?: string;
}

export interface AnnouncePostResult {
  draftId: string;
  dryRun: boolean;
  /** Absent when the draft was already announced and force was not set. */
  note?: NoteResult;
  /** Set when nothing was posted, naming why. */
  skipped?: "announced" | "claimed";
}
```

The steps, in order, each one a `ctx.run` or a pure call that already exists:

1. Reject an input with neither `url` nor `draftId`, naming both fields.
2. `loadConfig` with `dryRun` and `slackChannel` passed through, so the channel, the call to action,
   the summary model, and the marker TTL come from the environment exactly as they do for a webhook
   run.
3. `ctx.run(listPublished, { socialSetId, limit: MAX_LIMIT })`. Fifty is the widest Typefully allows
   and this runs once, by hand.
4. Find the post: `draftId` when given, else the one whose `links` hold a `url` equal to the input
   URL. Compare the URL as given, and on no match throw an error saying how many published drafts
   were searched and that the post may be older than the newest 50, or that its permalink is not on
   X or LinkedIn.
5. `ctx.run(kvGet, { key: seenKey(draftId) })`. With a marker and no `force`, return
   `{ skipped: "announced" }` and log one line saying `force: true` re-posts it. With `force`,
   `ctx.run(deleteKeys, { keys: [seenKey(draftId)] })` and log that the marker was cleared.
6. `groupPosts([post], 0)` for the group, so a cross-posted draft still produces one note with both
   permalinks and no neighbouring draft can join it.
7. `announceGroups` from Task 4, with a fresh `runToken`. An in-flight claim held by another run
   comes back as `skipped: "claimed"`, not an error: the other run is about to post the same note.

No retry policy, matching `amplifier.checkPosts`. A human is watching this one, and a retry that
re-ran step 5 after a delivered note would read its own marker and do nothing useful.

Register it in `src/main.ts` next to the other two and add it to the assertions in
`test/main.test.ts`.

`test/announcePost.test.ts` reuses `taskCtx` and the `post` fixture from `test/support/`, and covers:
a match on an X URL, a match on a LinkedIn URL, a match on `draftId`, neither field given, no
matching draft, an already-marked draft skipping, the same draft with `force` deleting the marker and
posting, `dryRun: true` posting nothing and writing no marker, and a refused claim reporting
`skipped: "claimed"`.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 5 complete

### Task 6: Document both manual paths

**Files:**

- Modify: `README.md`

Replace `### Manual re-run` with `### Posting a note by hand`, holding two subsections.

**One post.** The common case, and now one command. Give the X URL example:

```bash
render workflows start <slug>/amplifier.announcePost \
  --input='[{"url":"https://x.com/render/status/2097716776390058019"}]'
```

Say that the Dashboard route is the same task from the Workflow service's Tasks tab, pasting the
same JSON array, and that the array is the task's positional arguments, so a single object in an
array is the shape. Then a four-row table for `url`, `draftId`, `force`, and `dryRun`, one line each:
the permalink to the live post, either platform; the Typefully draft id instead; re-post a draft
already announced; log the note instead of posting it. Add that `dryRun: true` prints the note after
`[dry run] would post:` in the run's logs and writes no marker, so the real run still has it to
announce.

Say what it cannot do: only the newest 50 published drafts are searched, so a post from weeks ago
needs its `draftId`.

**A whole window.** Keep the existing `amplifier.checkPosts` command with `[{}]` for the case where
several posts were missed at once, and keep the sentence about the 90-minute lookback and the markers
meaning it announces what was missed and nothing else. Do not document `now`, `lookbackMinutes`, or
`groupWindowMinutes` here; they are in the Configuration table and `amplifier.announcePost` is the
reason nobody needs them by hand.

**Verify:** `pnpm format:check`, and both commands run against the deployed service.

- [x] Task 6 complete

---

## Group C: one default for the per-run limit

This group is independent of Groups A and B.

### Task 7: Give the limit and the social set one source each

**Files:**

- Modify: `src/config.ts`
- Modify: `src/typefully/listPublished.ts`
- Modify: `src/typefully/types.ts`
- Modify: `test/listPublished.test.ts`

Export the fallback from `config.ts` next to `MAX_LIMIT`:

```ts
/** Drafts pulled per run when nothing overrides it. Also listPublished's own fallback. */
export const DEFAULT_LIMIT = 25;
```

Use it as the `fallback` in the `AMPLIFIER_LIMIT` call to `whole`, and as the `input.limit` fallback
in `listPublishedImpl`. Update the `limit` comment in `ListPublishedInput`, which hardcodes 25 in
prose.

While in `listPublishedImpl`, take the environment as a parameter instead of reading `process.env`
inside the function:

```ts
export async function listPublishedImpl(
  _ctx: TaskContext,
  input: ListPublishedInput,
  deps: TypefullyDeps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ListPublishedResult>;
```

Env last with a default, matching `checkPostsImpl` and `postNoteImpl`. The task registration and
every caller stay as they are; `checkPostsImpl` already passes `socialSetId` from `loadConfig`, so
the environment fallback only serves a manual dispatch of `typefully.listPublished`.

Add one test passing an env with `TYPEFULLY_SOCIAL_SET_ID` and asserting the port was called with it.
The existing "throws with no social set" case keeps working by passing an empty env.

**Verify:** `pnpm typecheck && pnpm test`

- [x] Task 7 complete

---

## Final check

```bash
pnpm check
grep -rn "SLACK_WEBHOOK_URL\|SLACK_BOT_TOKEN" src/
grep -rn "markAnnounced\|claimGroup" src/
grep -rn "25" src/config.ts src/typefully/listPublished.ts
git diff --stat
```

The only place that decides whether Slack is configured must be `src/slack/postNote.ts`. The claim
and the marker write must appear only in `src/amplifier/announce.ts`, which is what makes the two
entry points share one announce-once guarantee. 25 must appear once, in `DEFAULT_LIMIT`.

Then confirm the two properties this plan must not break, using `redis-server`, `pnpm stub`, and
`pnpm local:run 2`: the first run reports `notified: 2` and the second reports `notified: 0` with
`skipped: 2`.

- [x] All tasks complete
