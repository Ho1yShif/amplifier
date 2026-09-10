// Model settings for the post summary. Kept apart from summarize.ts so that
// config.ts can read them without importing llm.complete and pulling
// @anthropic-ai/sdk into the webhook receiver's process.

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
