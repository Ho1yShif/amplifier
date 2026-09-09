# Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to work through this task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code, collapse the repeated platform and fetch logic, fix one real config bug, and bring the README up to date with an ASCII architecture diagram.

**Baseline:** `pnpm test` passes 127 tests across 13 files and `pnpm typecheck` is clean as of the commit this plan was written against (`6271ebf`). Every task below must end with both still passing.

**Not in scope:** No change to the announce-once guarantee, the dedupe unit, the Key Value key names, the cron schedule, or the note's rendered output. The one exception is Task 7, which changes what a blank `AMPLIFIER_CALL_TO_ACTION` produces.

## What this plan replaces

`plan.md` used to hold the completed LLM-summary plan, all 43 steps checked. That file is now this one. Two places still point at the old content and are fixed in Task 1.

---

## Group A: dead code and stale references

### Task 1: Fix the two references to the old plan.md

**Files:**

- Modify: `.prettierignore`
- Modify: `scripts/local-run.ts`

`.prettierignore` line 3 reads "A record of a completed plan, kept as it was written." That is no longer what `plan.md` is. Keep `plan.md` ignored so the hand-wrapped prose survives, and replace the comment with one that describes the working cleanup plan.

`scripts/local-run.ts` line 10 says the two-run check "is plan.md Task 10 check 4". No such task exists now. Say what the check proves without pointing at a task number.

**Verify:**

```bash
pnpm format:check
grep -rn "plan.md" .prettierignore scripts/
```

- [ ] Task 1 complete

### Task 2: Say why the four unread Typefully fields are declared

**Files:**

- Modify: `src/typefully/types.ts`

`TypefullyDraft` is documented as "the subset of Typefully's draft response amplifier reads", but `mapDraft` reads only `id`, `preview`, `share_url`, and the four `*_post_published_at` / `*_published_url` fields. `status`, `published_at`, `x_post_enabled`, and `linkedin_post_enabled` are never read.

Keep all four. `test/map.test.ts` sets `x_post_enabled: true` with no publish timestamp to prove the mapper ignores it, and `test/listPublished.test.ts` uses `status: "scheduled"`. Both are the confusion this interface should prevent. Rewrite the doc comment so it says the interface covers the fields amplifier reads plus the ones it deliberately ignores, and put a one-line comment on the `*_enabled` pair pointing at `mapDraft`.

**Verify:** `pnpm typecheck && pnpm test`

- [ ] Task 2 complete

### Task 3: Decide the fate of the `ping` task

**Files:**

- Modify: `src/main.ts` or `README.md`

`src/main.ts` registers a zero-dependency `ping` task described as "handy for verifying the service is live", and `test/main.test.ts` covers it. Nothing in the README tells a deployer to use it.

Keep it and add one line to the deployment steps: after the Workflow service is up, `render workflows start ping --input='[{}]'` confirms the registry loaded before any secret is set. If that command is wrong for a Workflow service, check `render workflows tasks list` first and use whatever the real invocation is. Do not guess at the syntax in the README.

**Verify:** `pnpm test`, and the README instruction matches a command that exists in `render workflows --help`.

- [ ] Task 3 complete

---

## Group B: dedupe

### Task 4: One platform module

**Files:**

- Create: `src/typefully/platforms.ts`
- Modify: `src/amplifier/template.ts`
- Modify: `src/summary/summarize.ts`

`PLATFORM_ORDER` is declared twice with the same value, in `template.ts` and in `summarize.ts`. Two label maps sit beside them: `PLATFORM_LABELS` (`"X post"`, `"LinkedIn post"`) in the template and `PLATFORM_NAMES` (`"X"`, `"LinkedIn"`) in the summarizer. The labels are the names plus the word "post", so one map covers both.

The new module holds:

```ts
export const PLATFORM_ORDER: Platform[] = ["linkedin", "x"];
export const PLATFORM_NAMES: Record<Platform, string> = { linkedin: "LinkedIn", x: "X" };
export function platformLabel(platform: Platform): string;
```

`platformLabel` returns `${PLATFORM_NAMES[platform]} post`. The template imports `PLATFORM_ORDER` and `platformLabel`; the summarizer imports `PLATFORM_ORDER` and `PLATFORM_NAMES`.

It goes in `src/typefully/` because the display order is a property of the platform set, and `src/typefully/` is already the only directory that knows platform names. Do not put it in `src/amplifier/`, which `src/summary/` should not have to import from for a constant.

**Verify:** `pnpm test`. `test/template.test.ts` already asserts the exact strings `LinkedIn post` and `X post`, so it catches a label change.

- [ ] Task 4 complete

### Task 5: One fetch wrapper in postNote

**Files:**

- Modify: `src/slack/postNote.ts`

`webFetch` and `webhookFetch` have identical bodies. They differ only in their declared type, `WebFetchLike` against `FetchLike`, because the vendor's web API port and webhook port each declare their own. Write the body once and give it both types:

```ts
const unfurlOffFetch = (url: string, init: { body: string }) =>
  fetch(url, { ...init, body: withUnfurlOff(init.body) });
```

Then pass it as `unfurlOffFetch as WebFetchLike` and `unfurlOffFetch as FetchLike`, or narrow it properly if the two signatures are structurally compatible. Check whether they are before reaching for a cast: `exactOptionalPropertyTypes` and `strict` are on, so an unnecessary cast will hide a real difference. Keep the `UNFURL_OFF` comment, which explains why any of this exists.

**Verify:** `pnpm typecheck && pnpm test`. `test/postNote.test.ts` covers both paths.

- [ ] Task 5 complete

### Task 6: Collapse the two duplicated shapes in template and checkPosts

**Files:**

- Modify: `src/amplifier/template.ts`
- Modify: `src/amplifier/checkPosts.ts`

Two small repeats.

In `renderNote`, the `linkList` ternary maps and joins the links twice, once with a bullet prefix and once without:

```ts
const bullet = links.length > 1 ? "• " : "";
const linkList = links.map((l) => `${bullet}${linkMrkdwn(l, group.shareUrl)}`).join("\n");
```

The join changes from `""` to `"\n"` in the single-link branch, which is the same string, because a one-element array joins to itself.

In `checkPostsImpl`, the `notes.push({ draftIds, platforms, delivered, summarized })` object is built twice, once in the dry-run branch and once at the end. Build it once. Either set a `delivered` variable before the branch and push after, or extract a small local that takes `delivered`.

Do not restructure the surrounding control flow. The dry-run branch releases the claim and skips the Slack call, and that ordering is the announce-once guarantee.

**Verify:** `pnpm test`. `test/template.test.ts` asserts both the one-link and two-link output.

- [ ] Task 6 complete

### Task 7: Shared test fixtures

**Files:**

- Create: `test/support/fixtures.ts`
- Modify: `test/checkPosts.test.ts`, `test/group.test.ts`, `test/window.test.ts`
- Modify: `test/seen.test.ts`, `test/summarize.test.ts`, `test/template.test.ts`

Three test files declare a `post()` builder. They are near-identical: `checkPosts.test.ts` and `group.test.ts` differ only in `shareUrl` and the platform type annotation, and `window.test.ts` has a one-platform version. Three more files build `PostGroup` object literals by hand.

Add two builders:

```ts
export function post(
  draftId: string,
  at: string,
  platforms: Platform[] = ["x"],
  overrides?: Partial<PublishedPost>,
): PublishedPost;

export function group(overrides?: Partial<PostGroup>): PostGroup;
```

`post` keeps the `shareUrl` that `group.test.ts` relies on and lets `checkPosts.test.ts` override it away if any assertion depends on its absence. Check that before moving: `checkPosts.test.ts` currently builds posts with no `shareUrl`, and `linkMrkdwn` falls back to the share URL when a permalink is missing.

Leave `taskCtx.ts` and `kvStore` where they are. `kvStore` is used by one file.

Keep each test's assertions byte-identical. This task must change no expected value.

**Verify:** `pnpm test` reports 127 passing, the same count as the baseline.

- [ ] Task 7 complete

---

## Group C: the one behavior fix

### Task 8: A blank AMPLIFIER_CALL_TO_ACTION should use the default

**Files:**

- Modify: `src/config.ts`
- Modify: `src/amplifier/template.ts`
- Modify: `test/config.test.ts`, `test/template.test.ts`

`loadConfig` resolves `callToAction` with `input.callToAction ?? env.AMPLIFIER_CALL_TO_ACTION ?? DEFAULT_CALL_TO_ACTION`. `??` does not catch the empty string, so `AMPLIFIER_CALL_TO_ACTION=""` resolves to `""`. `renderNote` then computes `lead = summary || (opts.callToAction ?? DEFAULT_CALL_TO_ACTION)`, and `??` misses the empty string a second time, so a failed summary posts a note whose lead line is blank.

A declared-but-empty variable is the normal state of a Render env var nobody filled in. `config.ts` already says so in the doc comment on `whole`, and `summaryModel` already routes through the `text` helper for exactly this reason. `callToAction` is the one setting that does not.

Two edits:

1. In `loadConfig`, resolve `callToAction` through `text(input.callToAction, env.AMPLIFIER_CALL_TO_ACTION, DEFAULT_CALL_TO_ACTION)`.
2. In `renderNote`, change the fallback to `opts.callToAction?.trim() || DEFAULT_CALL_TO_ACTION` so a caller passing `""` directly gets the default too.

**Tests to add:**

- `config.test.ts`: `loadConfig({}, { AMPLIFIER_CALL_TO_ACTION: "" }).callToAction` equals `DEFAULT_CALL_TO_ACTION`. Add the whitespace-only case alongside it.
- `template.test.ts`: `renderNote(group, { callToAction: "" })` with no summary leads with `DEFAULT_CALL_TO_ACTION`, not an empty line.

Write both tests first and watch them fail before making the source edits.

**Verify:** `pnpm test`

- [ ] Task 8 complete

---

## Group D: polish

### Task 9: Constants above their use in config.ts

**Files:**

- Modify: `src/config.ts`

`MAX_LIMIT` is exported on line 92, after the `loadConfig` that uses it on line 63, with the `Bounds` interface below that. Hoisting means it works, but a reader hits the reference before the value. Move `MAX_LIMIT` and `Bounds` above `loadConfig`, keeping both doc comments exactly as written.

`text` and `whole` stay at the bottom. They are implementation detail below the exported entry point, which is the shape the rest of `src/` uses.

**Verify:** `pnpm typecheck && pnpm test`

- [ ] Task 9 complete

### Task 10: One command that runs every check

**Files:**

- Modify: `package.json`
- Modify: `README.md`

Contributors currently have to remember `pnpm format:check`, `pnpm typecheck`, and `pnpm test` separately. Add:

```json
"check": "pnpm format:check && pnpm typecheck && pnpm test"
```

Put it in the Local development section of the README as the command to run before committing.

**Verify:** `pnpm check` passes.

- [ ] Task 10 complete

### Task 11: Import order in checkPosts.ts

**Files:**

- Modify: `src/amplifier/checkPosts.ts`

The `../summary/summarize.js` import sits between `./template.js` and `./window.js`, so the parent-directory imports are no longer grouped. Move it up with the other `../` imports. Prettier does not sort imports, so this stays hand-maintained.

Do not add an import-sorting plugin as part of this task. That is a separate decision about tooling.

**Verify:** `pnpm check`

- [ ] Task 11 complete

---

## Group E: README

### Task 12: ASCII architecture diagram

**Files:**

- Modify: `README.md`

Add the diagram as the first thing under `## How it works`, before the numbered steps. Two boxes and the call-out arrows:

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

Steps 4 through 7 run once per group. Say that in one line under the diagram.

Then add a second, smaller diagram to the `## Adding Twitter or LinkedIn directly` section, showing the module boundary that section already describes in prose:

```
src/typefully/   knows Typefully's field names, emits PublishedPost
      │
      ▼
src/amplifier/   works only on PublishedPost and PostGroup
      │
      ├──▶ src/summary/   the lead line
      └──▶ src/slack/     the note, with unfurling off
```

Check the box-drawing characters render in a fixed-width font before committing. Do not use emoji or color.

**Verify:** Read the rendered README on GitHub or in a Markdown preview and confirm the diagram lines up.

- [ ] Task 12 complete

### Task 13: Correct the Slack task name

**Files:**

- Modify: `README.md`

The README names `slack.postMessage` in two places: step 6 of How it works, and the last line of the Slack credentials section. The task amplifier actually dispatches is `amplifier.postNote`, defined in `src/slack/postNote.ts`. It wraps the vendor's `postMessageImpl` and adds `unfurl_links: false` and `unfurl_media: false` to the request body, because `@render-lab/tasks-slack` 0.3.0 sends neither and exposes no option for them.

Fix both names and add two sentences on the wrapper. A reader looking for `slack.postMessage` in the logs will not find it, and a reader who upgrades `@render-lab/tasks-slack` needs to know the wrapper can go away once the vendor accepts an unfurl option.

**Verify:** `grep -n "slack.postMessage" README.md` returns nothing.

- [ ] Task 13 complete

### Task 14: Rewrite the Slack credentials opening

**Files:**

- Modify: `README.md`

The section opens with "Optionally, create a Slack channel for testing. If not, prepare a the Slack channel you will use in production and ensure it's ready to test below." That has a typo and buries the instruction. Replace it with a plain two-sentence version: pick the channel the notes will go to, and use a test channel first if the production one is busy.

While in this section, check the rest of it against `src/slack/postNote.ts` and `slack-app-manifest.yaml`. The manifest requests `chat:write` and `incoming-webhook`, and `slackDeps` builds the web API port only when `SLACK_BOT_TOKEN` is set. Both claims in the README match the code today. Confirm rather than assume.

**Verify:** `pnpm format:check`

- [ ] Task 14 complete

### Task 15: Complete the configuration table

**Files:**

- Modify: `README.md`

The table covers the Workflow service's variables. Three gaps:

1. The cron service's variables are missing entirely. `RENDER_API_KEY`, `WORKFLOW_SLUG`, `CRON_TASK`, and `CRON_INPUT` appear in `render.yaml` and `.env.example` but not in the table. Add them as a second table under a `### Cron service` heading, so a reader does not set them on the wrong service.
2. `STUB_PORT` is read by `scripts/typefully-stub.ts` and defaults to 8787. Add it to a short note in the local-development section rather than the main table. It is not a deployment setting.
3. `AMPLIFIER_SUMMARY_MODEL` takes precedence over `tasks-llm`'s own `LLM_MODEL`. `.env.example` says so and the README does not. Add it to the Notes column.

Check every default in the table against `src/config.ts` while editing. The current values are lookback 90, group window 10, seen TTL 30 days, limit 25, and dry run true. Correct any that have drifted.

**Verify:** Each row's default matches the `fallback` value in `loadConfig`, and each variable name appears in `src/`, `render.yaml`, or `scripts/`.

- [ ] Task 15 complete

### Task 16: Check the rest of the README against the code

**Files:**

- Modify: `README.md`

Walk the remaining claims and fix what has drifted.

- The note example shows two bulleted links. `renderNote` drops the bullet when there is one link. Add a one-line note or a second example.
- The local development block runs `pnpm install`, `pnpm test`, `cp .env.example .env`, `render workflows dev -- pnpm dev`, `render workflows tasks list --local`, and `render workflows start amplifier.checkPosts --local --input='[{}]'`. Run each one and fix any that fail or that the CLI has renamed.
- The end-to-end section says run 1 reports `notified: 2` and run 2 reports `notified: 0` and `skipped: 2`. Run it and confirm. It needs `redis-server` and `pnpm stub` and no credentials.
- The deployment steps reference build `pnpm install && pnpm build`, start `node dist/main.js`, project `amplifier`, environment `Production`, region Oregon. Confirm these still match `render.yaml`.
- Step 4 says the environment page should list `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5`. Confirm that against `render.yaml` and `src/summary/model.ts`.

Report anything that cannot be checked without deploying, rather than leaving it unverified and unmarked.

**Verify:** `pnpm check`, plus the local end-to-end run above.

- [ ] Task 16 complete

---

## Final check

```bash
pnpm check
git diff --stat
```

Test count must still be at least 127, with the four new cases from Task 8 on top. No task in this plan may change the note's rendered output except Task 8, and Task 8 only changes it when `AMPLIFIER_CALL_TO_ACTION` is blank.

- [ ] All tasks complete
