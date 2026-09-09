# LLM Post Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace amplifier's static Slack lead line with a one-line summary of the post, written by Claude Sonnet 5.

**Architecture:** A new `src/summary/` sibling holds the prompt file, the prompt loader, and a `summarizeGroup` wrapper around `llm.complete` from `@render-lab/tasks-llm`. It returns a line or a reason and never throws. `src/amplifier/` keeps working on `PostGroup`, and `template.ts` stays pure and synchronous: it takes the summary as an option. `checkPosts.ts` calls the summarizer before it claims the group.

**Tech Stack:** TypeScript, `@renderinc/sdk` Workflows 1.0, `@render-lab/tasks-llm` 0.8.1 (which wraps `@anthropic-ai/sdk`), vitest.

**Spec:** This document. The design was agreed in the session that wrote it; the Design section below is the spec the tasks argue from.

## Design

The note today opens with `AMPLIFIER_CALL_TO_ACTION` and quotes Typefully's 100-character `preview`. After this change, a successful summary is the entire lead line and the quote is gone, matching the shape of the real `#amplify` posts in `examples.md`:

```
Cursor Origin is now a supported Git provider on Render. Help spread the word!

• <https://linkedin.com/…|LinkedIn post>
• <https://x.com/…|X post>
```

When the call fails, the note still goes out. It carries the old lead line, the reason, and the preview it would have summarized:

```
New Render social post! Please like and share when you have a minute
_(Summarization LLM call failed: 401 invalid x-api-key)_

> We cut cold starts on Render by 40%.

• <https://linkedin.com/…|LinkedIn post>
• <https://x.com/…|X post>
```

Four decisions the tasks depend on:

**The summarizer runs before `claimGroup`.** `LLM_RETRY` in `tasks-llm` is 5 retries backing off 2s, 4s, 8s, 16s, 32s, so a bad provider day spends about 62 seconds of backoff plus six call durations. `INFLIGHT_TTL_SECONDS` is 300. Inside the claim, that lock can expire mid-flight and the next cron run re-posts the note. Running first costs one wasted Sonnet call when two runs race the same group, which is the cheaper failure.

**Truncation counts as a failure.** Sonnet 5's only on-mode is adaptive thinking, and `tasks-llm` sends no `thinking` parameter, so thinking tokens come out of `max_tokens`. The budget is 2048 for a one-line answer, and `stopReason === "length"` or empty text falls back rather than posting a half sentence.

**No bare URLs anywhere in the note.** Both bullets hyperlink the text `LinkedIn post` and `X post`. The `text` field, which is Slack's notification fallback, becomes the lead line alone. It carries the joined URLs today, and per the link-preview thread in the handoff that may be where the unfurl cards come from.

**`DEFAULT_SUMMARY_MODEL` lives in `src/summary/model.ts`, not in `summarize.ts`.** `config.ts` needs the constant, and `cron-trigger.ts` imports `config.ts`. Importing `summarize.ts` there would register `llm.complete` and pull `@anthropic-ai/sdk` into the cron service's process, which only dispatches runs.

## Global Constraints

- Default model is `anthropic/claude-sonnet-5`. The `anthropic/` prefix is required: `tasks-llm` routes on it and throws on a bare model id.
- `ANTHROPIC_API_KEY` is never read by `config.ts`. The Anthropic SDK reads it inside the call, which keeps the credentials-are-lazy invariant from the handoff.
- Dedupe stays per draft, not per note. Do not move the summarizer between the Slack call and the `markAnnounced` write.
- `AMPLIFIER_LIMIT` is still the concurrency ceiling. The summarizer adds one sequential `ctx.run` per group, not per draft.
- Slack labels are exactly `LinkedIn post` and `X post`, LinkedIn first.
- Pin the new dependency to an exact version, matching the other `@render-lab/*` entries.
- `pnpm test` and `pnpm typecheck` pass at the end of every task.

---

### Task 1: The prompt file and its loader

**Files:**
- Create: `prompts/post-summary.md`
- Create: `src/summary/prompt.ts`
- Create: `src/summary/model.ts`
- Modify: `package.json` (add the dependency)
- Modify: `.gitignore` (only if `examples.md` is ignored; check first)
- Test: `test/summaryPrompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadPrompt(): string`, `clearPromptCache(): void`, `DEFAULT_SUMMARY_MODEL: string`, `SUMMARY_MAX_TOKENS: number`.

- [x] **Step 1: Install the dependency**

```bash
pnpm add @render-lab/tasks-llm@0.8.1
```

Check `package.json` afterwards: the entry must read `"@render-lab/tasks-llm": "0.8.1"` with no caret, like the other `@render-lab/*` dependencies. Fix it by hand and re-run `pnpm install` if pnpm added one. This pulls in `@anthropic-ai/sdk`, `openai`, and `ioredis` as transitive dependencies.

- [x] **Step 2: Commit `examples.md`**

It is untracked today and the prompt is derived from it, so it belongs in the repo as the human-facing source.

```bash
git status --short examples.md
git add examples.md
```

If `git status` reports it as ignored, remove the pattern from `.gitignore` first.

- [x] **Step 3: Write the prompt file**

Create `prompts/post-summary.md`. The examples are copied in rather than read from `examples.md`, so the file is self-contained at runtime.

````markdown
# Post summary prompt

You write the one-line Slack message that tells Render's team a new social post
is live and asks them to amplify it.

You are given the text of one Render social post, and which platforms it went
live on.

Write exactly one line:

- Name what shipped, in the present tense.
- Then ask the team to amplify, in a short clause.
- Plain English. Short words. No emoji, no hashtags, no links, no markdown.
- Under 120 characters where the post allows it.
- Do not mention the platforms, the word "post", or that you are summarizing.
- Return the line and nothing else. No preamble, no quotes around it.

## Examples

These are real messages from the #amplify channel. Match their shape.

1. Cursor Origin is now a supported Git provider on Render. Help spread the word!
2. Please like/share our new customer story for OpenAI!
3. We've officially launched our partnership with TanStack!
4. Social posts are out for our much anticipated Deploys page. Please help amplify.
5. New plan IDs, what you see is what you get.
6. Social posts announcing our new compute plans are up!
7. Please amplify socials around Mac's monumental blog post!
8. We are hosting a hackathon with OpenAI. Please amplify!
9. Our newest customer story with Ferndesk (Railway migration) is up on socials.
10. We just launched our OSS integration with GitNexus! Please amplify.
````

- [x] **Step 4: Write the model constants**

Create `src/summary/model.ts`. It imports nothing, so `config.ts` can read these without registering a task.

```ts
// Model settings for the post summary. Kept apart from summarize.ts so that
// config.ts — and through it cron-trigger.ts — can read them without importing
// llm.complete and pulling @anthropic-ai/sdk into the cron service's process.

/**
 * Default summarizer. Sonnet 5 is the newest Sonnet, and the `anthropic/`
 * prefix is what tasks-llm routes on: a bare model id throws.
 */
export const DEFAULT_SUMMARY_MODEL = "anthropic/claude-sonnet-5";

/**
 * Output budget for a one-line answer.
 *
 * Sonnet 5's only on-mode is adaptive thinking and tasks-llm sends no thinking
 * parameter, so thinking tokens come out of this budget. One line needs a
 * fraction of 2048; the rest is headroom for the thinking.
 */
export const SUMMARY_MAX_TOKENS = 2048;
```

- [x] **Step 5: Write the failing test**

Create `test/summaryPrompt.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { clearPromptCache, loadPrompt } from "../src/summary/prompt.js";

describe("loadPrompt", () => {
  beforeEach(clearPromptCache);

  it("reads the prompt file", () => {
    expect(loadPrompt()).toContain("Write exactly one line");
  });

  it("carries the examples", () => {
    expect(loadPrompt()).toContain("Cursor Origin is now a supported Git provider on Render");
  });

  it("returns the same string on a second call", () => {
    expect(loadPrompt()).toBe(loadPrompt());
  });
});
```

- [x] **Step 6: Run the test to verify it fails**

Run: `pnpm vitest run test/summaryPrompt.test.ts`
Expected: FAIL, cannot resolve `../src/summary/prompt.js`.

- [x] **Step 7: Write the loader**

Create `src/summary/prompt.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The prompt file, relative to this module. `../../prompts/` resolves to the
 * repo root from both `src/summary/` and `dist/summary/`, so tsc needs no step
 * to copy the file into the build.
 */
const PROMPT_URL = new URL("../../prompts/post-summary.md", import.meta.url);

let cached: string | undefined;

/** The summary prompt, read once per process. */
export function loadPrompt(): string {
  return (cached ??= readFileSync(fileURLToPath(PROMPT_URL), "utf8"));
}

/** Drop the cached prompt. For tests. */
export function clearPromptCache(): void {
  cached = undefined;
}
```

- [x] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run test/summaryPrompt.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 9: Typecheck and commit**

```bash
pnpm typecheck
git add package.json pnpm-lock.yaml examples.md prompts/post-summary.md src/summary/ test/summaryPrompt.test.ts
git commit -m "feat(summary): add the post-summary prompt and its loader"
```

---

### Task 2: `summarizeGroup`

**Files:**
- Create: `src/summary/summarize.ts`
- Test: `test/summarize.test.ts`

**Interfaces:**
- Consumes: `loadPrompt()` from Task 1, `DEFAULT_SUMMARY_MODEL` and `SUMMARY_MAX_TOKENS` from Task 1, `PostGroup` from `src/amplifier/group.ts`.
- Produces:
  - `type SummaryOutcome = { line: string } | { error: string }`
  - `isSummary(outcome: SummaryOutcome): outcome is { line: string }`
  - `summarizeGroup(ctx: TaskContext, group: PostGroup, opts?: { model?: string }): Promise<SummaryOutcome>`

- [x] **Step 1: Write the failing test**

Create `test/summarize.test.ts`. The `taskCtx` helper dispatches `ctx.run` by task name and throws on a name it was not given, so a test that reaches an unstubbed task fails loudly.

```ts
import { describe, expect, it } from "vitest";
import type { PostGroup } from "../src/amplifier/group.js";
import { isSummary, summarizeGroup } from "../src/summary/summarize.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const group: PostGroup = {
  draftIds: ["1"],
  previews: ["We cut cold starts on Render by 40%."],
  publishedAt: "2026-09-04T15:00:00Z",
  links: [
    {
      platform: "linkedin",
      url: "https://linkedin.com/feed/update/2",
      publishedAt: "2026-09-04T15:00:00Z",
    },
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: "2026-09-04T15:02:00Z" },
  ],
};

function ctxFor(overrides: TaskHandlers = {}) {
  return taskCtx({
    "llm.complete": () => ({
      text: "Cold starts on Render are 40% faster. Please amplify!",
      model: "claude-sonnet-5",
      stopReason: "end",
    }),
    ...overrides,
  });
}

describe("summarizeGroup", () => {
  it("returns the model's line", async () => {
    const { ctx } = ctxFor();
    const outcome = await summarizeGroup(ctx, group);
    expect(outcome).toEqual({ line: "Cold starts on Render are 40% faster. Please amplify!" });
  });

  it("sends the prompt file as the system prompt and the previews as the user prompt", async () => {
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, group);
    const input = calls[0]?.input;
    expect(input.system).toContain("Write exactly one line");
    expect(input.prompt).toContain("We cut cold starts on Render by 40%.");
    expect(input.prompt).toContain("LinkedIn and X");
  });

  it("defaults to the newest Sonnet and gives thinking room", async () => {
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, group);
    expect(calls[0]?.input.model).toBe("anthropic/claude-sonnet-5");
    expect(calls[0]?.input.maxTokens).toBe(2048);
  });

  it("takes a model override", async () => {
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, group, { model: "anthropic/claude-haiku-4-5" });
    expect(calls[0]?.input.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("reports the error instead of throwing when the task fails", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => {
        throw new Error("401 invalid x-api-key");
      },
    });
    const outcome = await summarizeGroup(ctx, group);
    expect(outcome).toEqual({ error: "401 invalid x-api-key" });
  });

  it("treats a truncated answer as a failure", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => ({ text: "Cold starts on", model: "m", stopReason: "length" }),
    });
    const outcome = await summarizeGroup(ctx, group);
    expect(isSummary(outcome)).toBe(false);
    expect(outcome).toHaveProperty("error", expect.stringContaining("2048"));
  });

  it("treats empty text as a failure", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => ({ text: "   ", model: "m", stopReason: "end" }),
    });
    expect(await summarizeGroup(ctx, group)).toEqual({ error: "the model returned no text" });
  });

  it("keeps only the first line of a multi-line answer", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => ({
        text: "\nCold starts are faster. Please amplify!\n\nAlso: unrelated.",
        model: "m",
        stopReason: "end",
      }),
    });
    expect(await summarizeGroup(ctx, group)).toEqual({
      line: "Cold starts are faster. Please amplify!",
    });
  });

  it("names both platforms of a grouped note and lists every preview", async () => {
    const grouped: PostGroup = {
      ...group,
      draftIds: ["1", "2"],
      previews: ["First draft text.", "Second draft text."],
    };
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, grouped);
    expect(calls[0]?.input.prompt).toContain("First draft text.");
    expect(calls[0]?.input.prompt).toContain("Second draft text.");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/summarize.test.ts`
Expected: FAIL, cannot resolve `../src/summary/summarize.js`.

- [x] **Step 3: Write the summarizer**

Create `src/summary/summarize.ts`:

```ts
import { complete } from "@render-lab/tasks-llm";
import type { TaskContext } from "@renderinc/sdk/workflows";
import type { PostGroup } from "../amplifier/group.js";
import type { Platform } from "../typefully/types.js";
import { DEFAULT_SUMMARY_MODEL, SUMMARY_MAX_TOKENS } from "./model.js";
import { loadPrompt } from "./prompt.js";

/** How the platforms are named to the model, in the note's display order. */
const PLATFORM_NAMES: Record<Platform, string> = { linkedin: "LinkedIn", x: "X" };
const PLATFORM_ORDER: Platform[] = ["linkedin", "x"];

export interface SummarizeOptions {
  /** Provider-prefixed model id. Defaults to DEFAULT_SUMMARY_MODEL. */
  model?: string;
}

/** A summary line, or the reason there is none. */
export type SummaryOutcome = { line: string } | { error: string };

export function isSummary(outcome: SummaryOutcome): outcome is { line: string } {
  return "line" in outcome;
}

/** What the model is asked about: which platforms published, and the post text. */
function userPrompt(group: PostGroup): string {
  const present = new Set(group.links.map((l) => l.platform));
  const platforms = PLATFORM_ORDER.filter((p) => present.has(p))
    .map((p) => PLATFORM_NAMES[p])
    .join(" and ");
  const previews = group.previews
    .filter((p) => p !== "")
    .map((p) => `- ${p}`)
    .join("\n");
  return `Platforms: ${platforms}\n\nPost text:\n${previews}`;
}

/**
 * One line describing this announcement, or why there is none.
 *
 * Never throws. A dead provider must not cost an announcement, so every failure
 * comes back as `{ error }` and `renderNote` falls back to the template text.
 *
 * Call this before claiming the group. LLM_RETRY spends about 62 seconds of
 * backoff across 5 retries plus six call durations, and INFLIGHT_TTL_SECONDS is
 * 300 — inside the claim, that lock can expire mid-flight and the next run
 * re-posts the note.
 */
export async function summarizeGroup(
  ctx: TaskContext,
  group: PostGroup,
  opts: SummarizeOptions = {},
): Promise<SummaryOutcome> {
  const model = opts.model ?? DEFAULT_SUMMARY_MODEL;
  try {
    const { text, stopReason } = await ctx.run(complete, {
      prompt: userPrompt(group),
      system: loadPrompt(),
      model,
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    if (stopReason === "length") {
      return {
        error: `the model hit its ${SUMMARY_MAX_TOKENS}-token budget, so the line is truncated`,
      };
    }
    // The model is told to answer with one line. Take the first non-empty one
    // rather than post a stray second paragraph into the channel.
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "");
    if (!line) return { error: "the model returned no text" };
    return { line };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/summarize.test.ts`
Expected: PASS, 9 tests.

- [x] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/summary/summarize.ts test/summarize.test.ts
git commit -m "feat(summary): summarize a post group with llm.complete"
```

---

### Task 3: The summary in the Slack note

**Files:**
- Modify: `src/amplifier/template.ts:15-19` (`RenderNoteOptions`), `src/amplifier/template.ts:48-75` (`renderNote`)
- Test: `test/template.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1 and 2. `renderNote` takes the summary as a plain string, so it stays pure and synchronous.
- Produces: `RenderNoteOptions` gains `summary?: string` and `summaryError?: string`.

- [x] **Step 1: Write the failing tests**

Add to `test/template.test.ts`, inside the existing `describe("renderNote")`:

```ts
it("uses the summary as the whole lead line", () => {
  const md = renderNote(crossPost, { summary: "Cold starts are 40% faster. Please amplify!" })
    .markdown ?? "";
  expect(md.startsWith("Cold starts are 40% faster. Please amplify!")).toBe(true);
  expect(md).not.toContain("New Render social post!");
});

it("drops the preview quote when there is a summary", () => {
  const md = renderNote(crossPost, { summary: "Cold starts are 40% faster." }).markdown ?? "";
  expect(md).not.toContain("> We cut cold starts on Render by 40%.");
});

it("still links every platform under a summary", () => {
  const md = renderNote(crossPost, { summary: "Cold starts are 40% faster." }).markdown ?? "";
  expect(md).toContain("• <https://linkedin.com/feed/update/2|LinkedIn post>");
  expect(md).toContain("• <https://x.com/render/status/1|X post>");
});

it("names the failure and keeps the quote when there is no summary", () => {
  const md = renderNote(crossPost, { summaryError: "401 invalid x-api-key" }).markdown ?? "";
  expect(md).toContain("_(Summarization LLM call failed: 401 invalid x-api-key)_");
  expect(md).toContain("> We cut cold starts on Render by 40%.");
  expect(md.startsWith("New Render social post!")).toBe(true);
});

it("sets the notification fallback to the summary and no URL", () => {
  const note = renderNote(crossPost, { summary: "Cold starts are 40% faster." });
  expect(note.text).toBe("Cold starts are 40% faster.");
  expect(note.text).not.toContain("https://");
});

it("keeps no URL in the notification fallback when the summary failed", () => {
  const note = renderNote(crossPost, { summaryError: "boom" });
  expect(note.text).not.toContain("https://");
});
```

Then change the existing assertion that requires a URL in `text`. Replace this test:

```ts
it("sets no title and a plain-text fallback carrying the links", () => {
  const note = renderNote(crossPost);
  expect(note.title).toBeUndefined();
  expect(note.text).toContain("https://x.com/render/status/1");
});
```

with:

```ts
it("sets no title and a plain-text fallback with no bare URL", () => {
  const note = renderNote(crossPost);
  expect(note.title).toBeUndefined();
  expect(note.text).not.toContain("https://");
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/template.test.ts`
Expected: FAIL. The six new tests fail on the missing options, and the rewritten fallback test fails because `text` still appends the joined URLs.

- [x] **Step 3: Widen `RenderNoteOptions`**

In `src/amplifier/template.ts`, replace the interface:

```ts
export interface RenderNoteOptions {
  /** Slack channel to post to. Requires SLACK_BOT_TOKEN to be honored. */
  channel?: string;
  callToAction?: string;
  /** The model's one-line summary. When present it is the note's whole lead line. */
  summary?: string;
  /** Why there is no summary, shown under the fallback lead line. */
  summaryError?: string;
}
```

- [x] **Step 4: Rewrite `renderNote`**

Replace the body and its doc comment:

```ts
/**
 * Build the Slack message for one announcement.
 *
 * With a summary, the note is that one line and a bulleted link per platform.
 * Without one, it falls back to the call to action, the reason the summary is
 * missing, and the draft's preview as a quote — the preview is the only content
 * signal left, so it is worth the extra lines.
 *
 * `text` is the notification fallback Slack shows in the sidebar and in push
 * notifications. It carries the lead line and no URL: every link in the note is
 * hyperlinked on its label, and a bare URL here also renders an unfurl card.
 */
export function renderNote(group: PostGroup, opts: RenderNoteOptions = {}): PostMessageInput {
  const links = orderedLinks(group);
  // Slack mrkdwn has no list syntax, so the bullet is a literal character.
  const linkList = links.map((l) => `• ${linkMrkdwn(l, group.shareUrl)}`).join("\n");
  const summary = opts.summary?.trim();
  const lead = summary || (opts.callToAction ?? DEFAULT_CALL_TO_ACTION);

  const blocks: string[] = [];
  if (summary) {
    blocks.push(lead);
  } else {
    const failure = opts.summaryError
      ? `\n_(Summarization LLM call failed: ${opts.summaryError})_`
      : "";
    blocks.push(`${lead}${failure}`);
    const quotes = group.previews
      .filter((p) => p !== "")
      .map((p) => `> ${p}`)
      .join("\n>\n");
    blocks.push(quotes);
  }
  blocks.push(linkList);

  return {
    text: lead,
    markdown: blocks.filter((s) => s !== "").join("\n\n"),
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/template.test.ts`
Expected: PASS. Every earlier test in the file still passes, because with neither option set the note is what it was apart from `text`.

- [x] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add src/amplifier/template.ts test/template.test.ts
git commit -m "feat(template): lead the note with the summary and drop bare URLs"
```

---

### Task 4: `AMPLIFIER_SUMMARY_MODEL`

**Files:**
- Modify: `src/config.ts:1` (import), `src/config.ts:4-15` (`CheckPostsInput`), `src/config.ts:17-26` (`AmplifierConfig`), `src/config.ts:38-80` (`loadConfig`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SUMMARY_MODEL` from Task 1.
- Produces: `CheckPostsInput.summaryModel?: string`, `AmplifierConfig.summaryModel: string`.

- [x] **Step 1: Write the failing tests**

Add to `test/config.test.ts`:

```ts
it("defaults the summary model to the newest Sonnet", () => {
  expect(loadConfig({}, {}).summaryModel).toBe("anthropic/claude-sonnet-5");
});

it("reads the summary model from the environment", () => {
  expect(
    loadConfig({}, { AMPLIFIER_SUMMARY_MODEL: "anthropic/claude-haiku-4-5" }).summaryModel,
  ).toBe("anthropic/claude-haiku-4-5");
});

it("prefers the per-run summary model", () => {
  const config = loadConfig(
    { summaryModel: "openai/gpt-4o" },
    { AMPLIFIER_SUMMARY_MODEL: "anthropic/claude-haiku-4-5" },
  );
  expect(config.summaryModel).toBe("openai/gpt-4o");
});

it("treats a blank summary model as unset", () => {
  expect(loadConfig({}, { AMPLIFIER_SUMMARY_MODEL: "  " }).summaryModel).toBe(
    "anthropic/claude-sonnet-5",
  );
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL, `summaryModel` is undefined.

- [x] **Step 3: Add the setting**

In `src/config.ts`, add to the imports:

```ts
import { DEFAULT_SUMMARY_MODEL } from "./summary/model.js";
```

Add to `CheckPostsInput`, after `callToAction`:

```ts
  /** Provider-prefixed model id for the summary, e.g. "anthropic/claude-sonnet-5". */
  summaryModel?: string;
```

Add to `AmplifierConfig`, after `callToAction`:

```ts
  summaryModel: string;
```

Add this helper next to `whole`:

```ts
/**
 * Resolve one string setting. A blank environment variable means "use the
 * default", matching `whole`: a declared-but-empty variable is the normal state
 * of a Render env var nobody filled in.
 */
function text(
  override: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  return override?.trim() || envValue?.trim() || fallback;
}
```

Add to the object `loadConfig` returns, after `callToAction`:

```ts
    summaryModel: text(input.summaryModel, env.AMPLIFIER_SUMMARY_MODEL, DEFAULT_SUMMARY_MODEL),
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/config.test.ts`
Expected: PASS.

- [x] **Step 5: Confirm the cron service stays free of the vendor SDK**

Run: `pnpm build && grep -rl "@anthropic-ai" dist/cron-trigger.js dist/config.js`
Expected: no output. `model.ts` imports nothing, so neither file reaches the Anthropic SDK. If either matches, `config.ts` is importing `summarize.ts` instead of `model.ts`.

- [x] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add AMPLIFIER_SUMMARY_MODEL"
```

---

### Task 5: Wire the summarizer into the run

**Files:**
- Modify: `src/amplifier/checkPosts.ts:1-10` (imports), `src/amplifier/checkPosts.ts:12-18` (`NoteResult`), `src/amplifier/checkPosts.ts:80-99` (the group loop)
- Modify: `src/main.ts:1-9` (the registration comment)
- Test: `test/checkPosts.test.ts`

**Interfaces:**
- Consumes: `summarizeGroup` and `isSummary` from Task 2, `renderNote`'s `summary` and `summaryError` from Task 3, `config.summaryModel` from Task 4.
- Produces: `NoteResult.summarized: boolean`.

- [x] **Step 1: Write the failing tests**

In `test/checkPosts.test.ts`, add `llm.complete` to the defaults in `runCtx` so every existing test has it stubbed:

```ts
function runCtx(overrides: TaskHandlers = {}) {
  return taskCtx({
    "typefully.listPublished": () => ({ posts: [] }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "kv.get": () => ({ value: null }),
    "kv.set": () => ({ ok: true }),
    "slack.postMessage": () => ({ delivered: true }),
    "llm.complete": () => ({ text: "Something shipped. Please amplify!", model: "m", stopReason: "end" }),
    ...overrides,
  });
}
```

Then add these tests:

```ts
it("leads the note with the summary", async () => {
  const { ctx, calls } = runCtx({
    "typefully.listPublished": () => ({
      posts: [post("1", "2026-09-04T15:30:00Z", ["x", "linkedin"])],
    }),
  });

  const result = await check(ctx, BASE);

  const md = calls.find((c) => c.name === "slack.postMessage")?.input.markdown ?? "";
  expect(md.startsWith("Something shipped. Please amplify!")).toBe(true);
  expect(result.notes[0]?.summarized).toBe(true);
});

it("summarizes before it claims the group", async () => {
  const { ctx, calls } = runCtx({
    "typefully.listPublished": () => ({
      posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
    }),
  });

  await check(ctx, BASE);

  const names = calls.map((c) => c.name);
  expect(names.indexOf("llm.complete")).toBeLessThan(names.indexOf("kv.lock"));
});

it("passes the configured model through", async () => {
  const { ctx, calls } = runCtx({
    "typefully.listPublished": () => ({
      posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
    }),
  });

  await check(ctx, { ...BASE, summaryModel: "anthropic/claude-haiku-4-5" });

  expect(calls.find((c) => c.name === "llm.complete")?.input.model).toBe(
    "anthropic/claude-haiku-4-5",
  );
});

it("still posts, with the reason, when the summary fails", async () => {
  const { ctx, calls } = runCtx({
    "typefully.listPublished": () => ({
      posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
    }),
    "llm.complete": () => {
      throw new Error("401 invalid x-api-key");
    },
  });

  const result = await check(ctx, BASE);

  const md = calls.find((c) => c.name === "slack.postMessage")?.input.markdown ?? "";
  expect(md).toContain("_(Summarization LLM call failed: 401 invalid x-api-key)_");
  expect(md).toContain("> preview 1");
  expect(result.notified).toBe(1);
  expect(result.notes[0]?.summarized).toBe(false);
});

it("summarizes in a dry run so the logged note is the real one", async () => {
  const { ctx, calls } = runCtx({
    "typefully.listPublished": () => ({
      posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
    }),
  });

  await check(ctx, { ...BASE, dryRun: true });

  expect(calls.filter((c) => c.name === "llm.complete")).toHaveLength(1);
  expect(calls.filter((c) => c.name === "slack.postMessage")).toHaveLength(0);
});

it("summarizes once per note, not once per draft", async () => {
  const { ctx, calls } = runCtx({
    "typefully.listPublished": () => ({
      posts: [
        post("1", "2026-09-04T15:30:00Z", ["x"]),
        post("2", "2026-09-04T15:33:00Z", ["linkedin"]),
      ],
    }),
  });

  await check(ctx, { ...BASE, groupWindowMinutes: 10 });

  expect(calls.filter((c) => c.name === "llm.complete")).toHaveLength(1);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run test/checkPosts.test.ts`
Expected: FAIL. No `llm.complete` call is made, so the six new tests fail. Every earlier test still passes: the stub is a default no test has to use.

- [x] **Step 3: Wire it in**

In `src/amplifier/checkPosts.ts`, add the import after the `template.js` import:

```ts
import { isSummary, summarizeGroup } from "../summary/summarize.js";
```

Add to `NoteResult`, after `platforms`:

```ts
  /** Whether the model wrote this note's lead line. False means the fallback text. */
  summarized: boolean;
```

Then replace the top of the group loop, from `const outcome = await claimGroup(...)` through the `renderNote` call:

```ts
  for (const group of groups) {
    // Before the claim, not inside it. LLM_RETRY spends about 62 seconds of
    // backoff across 5 retries plus six call durations, and the in-flight lock
    // lives 300 seconds — inside the claim, the lock can expire mid-flight and
    // the next run re-posts the note. The cost is one wasted call when two runs
    // race the same group.
    const summary = await summarizeGroup(ctx, group, { model: config.summaryModel });
    if (!isSummary(summary)) {
      console.error(
        `[amplifier] No summary for ${group.draftIds.join(", ")}: ${summary.error}. ` +
          `Posting the fallback note.`,
      );
    }

    const outcome = await claimGroup(ctx, group, runToken);
    if (!isClaimed(outcome)) {
      skipped += group.draftIds.length;
      continue;
    }
    const { claims } = outcome;

    const message = renderNote(group, {
      ...(config.slackChannel ? { channel: config.slackChannel } : {}),
      callToAction: config.callToAction,
      ...(isSummary(summary) ? { summary: summary.line } : { summaryError: summary.error }),
    });
    const platforms = notePlatforms(group);
```

Then add `summarized: isSummary(summary)` to both `notes.push` calls in the loop, the dry-run one and the one at the end:

```ts
      notes.push({ draftIds: group.draftIds, platforms, delivered: false, summarized: isSummary(summary) });
```

and

```ts
    notes.push({ draftIds: group.draftIds, platforms, delivered, summarized: isSummary(summary) });
```

- [x] **Step 4: Update the registration comment in `src/main.ts`**

The task list in the comment is now wrong. Replace the first paragraph:

```ts
// Entry point for the amplifier Workflow service.
//
// Importing the task modules registers amplifier.checkPosts and, transitively,
// every task it composes — typefully.listPublished, llm.complete, slack.postMessage,
// kv.lock, kv.unlock, kv.get, kv.set — because each module calls task(...) at
// load. They all register into the one shared @renderinc/sdk TaskRegistry.
```

- [x] **Step 5: Run the full suite to verify it passes**

Run: `pnpm test`
Expected: PASS, 92 existing tests plus the ones added in Tasks 1 through 5.

- [x] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add src/amplifier/checkPosts.ts src/main.ts test/checkPosts.test.ts
git commit -m "feat(amplifier): summarize each note before claiming its group"
```

---

### Task 6: Configuration and docs

**Files:**
- Modify: `.env.example:12-28`
- Modify: `render.yaml:22-49`
- Modify: `README.md` (the configuration table)

**Interfaces:**
- Consumes: `AMPLIFIER_SUMMARY_MODEL` from Task 4, `DEFAULT_SUMMARY_MODEL` from Task 1.
- Produces: nothing in code.

- [x] **Step 1: Add the block to `.env.example`**

Insert after the `@render-lab/tasks-slack` block and before the `tasks-render-kv` block:

```
# --- @render-lab/tasks-llm (the one-line post summary) ---
# Read by the Anthropic SDK inside the call, never by src/config.ts. Without it
# the note still posts, carrying the fallback text and the reason.
ANTHROPIC_API_KEY=sk-ant-...
```

Then add to the amplifier config block, after `AMPLIFIER_CALL_TO_ACTION`:

```
# AMPLIFIER_SUMMARY_MODEL=anthropic/claude-sonnet-5   # provider prefix required; beats tasks-llm's own LLM_MODEL
```

Note that `AMPLIFIER_CALL_TO_ACTION` is now the fallback lead line only. Update its inline comment to say so.

- [x] **Step 2: Add the env var group to `render.yaml`**

Blueprints do not support Workflow services, so the Workflow service is created by hand and its `fromGroup` link is made in the dashboard. This group therefore has no consumer inside `render.yaml`, permanently. That validates: `envVarGroup` requires only `name` and `envVars`, and nothing in the schema ties a group to a consumer. Add it to `envVarGroups`, after `amplifier-triggers`:

```yaml
          # Vendor keys for the hand-created Workflow service. No service in this
          # Blueprint references this group: the cron service only starts runs.
          # Attach it to the Workflow service in the dashboard.
          - name: amplifier-workflow
            envVars:
              - key: ANTHROPIC_API_KEY
                sync: false
              - key: AMPLIFIER_SUMMARY_MODEL
                value: anthropic/claude-sonnet-5
```

- [x] **Step 3: Validate the Blueprint**

Run: `render blueprints validate`
Expected: `valid: true`, and a plan listing both `amplifier-triggers` and `amplifier-workflow` under `envGroups` with `totalActions: 5`. This was checked against CLI v2.26.0 while the plan was written.

- [x] **Step 4: Update the README configuration table**

Add a row for `AMPLIFIER_SUMMARY_MODEL`, default `anthropic/claude-sonnet-5`, described as the model that writes the lead line, with the note that the provider prefix is required. Add `ANTHROPIC_API_KEY` to whichever section lists `TYPEFULLY_API_KEY` and `SLACK_BOT_TOKEN`. Change the description of `AMPLIFIER_CALL_TO_ACTION` to say it is the lead line used when the summary fails.

Also update whatever part of the README shows the note's shape: the successful note is one summary line and the bulleted links, with no quote.

Follow `~/.claude/STYLE.md` for the prose.

- [x] **Step 5: Spell out the env group steps in the README Deployment section**

`render.yaml` now creates two env groups, and the second one has to be attached by hand because the Workflow service is not in the Blueprint. The numbered sequence under `## Deployment` does not say either thing today, so someone following it sets `ANTHROPIC_API_KEY` on the service directly and the group sits unused.

Replace step 2:

```markdown
2. Apply `render.yaml` to create the cron job, the Key Value instance, and two env groups: `amplifier-triggers` and `amplifier-workflow`. Set `RENDER_API_KEY`, and set `WORKFLOW_SLUG` to the slug from step 1.
```

Replace step 3:

```markdown
3. On the Workflow service, link the `amplifier-workflow` env group and set its `ANTHROPIC_API_KEY`. The group holds the vendor keys the Workflow service reads, and it is linked in the Dashboard because Blueprints do not support Workflow services, so `render.yaml` cannot reference it. Then set `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID`, a Slack credential (see below), `DRY_RUN=true`, and `REDIS_URL` (the `amplifier-kv` internal connection string) on the service itself.
```

Add a step after it, renumbering the two `DRY_RUN` steps that follow:

```markdown
4. Confirm the link took: the Workflow service's environment page lists `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5` from the group. If it does not, the group exists but is not linked, and every note will carry `(Summarization LLM call failed)`.
```

Say in the `## Configuration` section that `ANTHROPIC_API_KEY` and `AMPLIFIER_SUMMARY_MODEL` arrive through the `amplifier-workflow` group, and that `AMPLIFIER_SUMMARY_MODEL` has a literal value in `render.yaml` so a Blueprint apply resets a Dashboard override. `ANTHROPIC_API_KEY` is `sync: false`, so an apply leaves it alone.

- [x] **Step 6: Format and commit**

```bash
pnpm format
git add .env.example render.yaml README.md
git commit -m "docs: document the summary model, Anthropic key, and env groups"
```

---

### Task 7: Verify a real run

**Files:** none. This task changes nothing and produces a checked box.

**Interfaces:**
- Consumes: everything from Tasks 1 through 6.
- Produces: nothing.

The stub computes its draft timestamps at process start, so after about 35 minutes one draft falls outside the 90-minute lookback and only one note posts. Restart `pnpm stub` before each run. `set -a; . ./.env; set +a` is how the credentials load, because `tsx` does not read `.env` on its own. Do not print the file and do not ask for its contents in chat.

- [x] **Step 1: Verify the fallback with a bad key**

```bash
redis-server --daemonize yes
pnpm stub &
redis-cli --scan --pattern 'amplifier:*' | xargs -r redis-cli del
set -a; . ./.env; set +a
TYPEFULLY_API_KEY=stub-key TYPEFULLY_BASE_URL=http://localhost:8787 \
  ANTHROPIC_API_KEY=sk-ant-not-a-real-key \
  SLACK_WEBHOOK_URL= DRY_RUN=true pnpm local:run 1
```

Expected: the run logs `[amplifier] No summary for ...: 401 ...`, then a dry-run note whose first lines are the call to action, `_(Summarization LLM call failed: ...)_`, and the `> preview` quote. This takes about a minute: `LLM_RETRY` retries a 401 five times before giving up.

- [x] **Step 2: Verify the summary with the real key**

```bash
redis-cli --scan --pattern 'amplifier:*' | xargs -r redis-cli del
kill %1; pnpm stub &
set -a; . ./.env; set +a
TYPEFULLY_API_KEY=stub-key TYPEFULLY_BASE_URL=http://localhost:8787 \
  SLACK_WEBHOOK_URL= DRY_RUN=true pnpm local:run 1
```

Expected: a dry-run note that opens on one model-written line, then the two bullets, with no quote and no bare URL. This spends real Anthropic credit, a fraction of a cent per note.

- [x] **Step 3: Post to the test channel**

```bash
redis-cli --scan --pattern 'amplifier:*' | xargs -r redis-cli del
kill %1; pnpm stub &
set -a; . ./.env; set +a
TYPEFULLY_API_KEY=stub-key TYPEFULLY_BASE_URL=http://localhost:8787 \
  SLACK_WEBHOOK_URL= DRY_RUN=false pnpm local:run 1
```

`SLACK_WEBHOOK_URL=` must be empty: `scripts/local-run.ts` points it at the stub when it is unset, which sends the note nowhere real. With it empty, delivery goes through `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`.

Expected: a note in `#test-shif-amplify` reading as one summary line and two bullets labeled `LinkedIn post` and `X post`. Clear the `amplifier:*` keys before a repeat run, or the second one reports `skipped` and posts nothing, which is the dedupe working.

- [ ] **Step 4: Check whether the unfurl cards are gone**

`text` no longer carries the URLs. Compare this note against the two messages labeled UNFURL TEST A and UNFURL TEST B in `#test-shif-amplify`. If the preview cards are gone, the link-preview thread in the handoff is closed and no upstream change to `@render-lab/tasks-slack` is needed. Record the answer either way.

- [x] **Step 5: Clean up and commit**

```bash
kill %1
redis-cli shutdown nosave
rm -f dump.rdb
git status --short
```

`dump.rdb` is a stray local Redis snapshot. Delete it, do not commit it.
