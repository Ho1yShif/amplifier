import { complete } from "@render-lab/tasks-llm";
import type { TaskContext } from "@renderinc/sdk/workflows";
import type { PostGroup } from "../amplifier/group.js";
import { PLATFORM_NAMES, PLATFORM_ORDER } from "../typefully/platforms.js";
import { DEFAULT_SUMMARY_MODEL, SUMMARY_MAX_TOKENS } from "./model.js";
import { loadPrompt } from "./prompt.js";

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
