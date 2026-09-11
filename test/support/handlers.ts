import { taskCtx, type TaskHandlers } from "./taskCtx.js";

/** The line llm.complete returns unless a test overrides it. */
export const SUMMARY_LINE = "Something shipped. Please amplify!";

/**
 * A TaskContext with a success default for every task the amplifier entry
 * points chain: nothing published, every Key Value call succeeding, Slack
 * accepting the note, and the model returning SUMMARY_LINE.
 *
 * Pass `overrides` to replace a task per test. An unlisted task name still
 * throws, so a test that chains something it did not stub fails loudly.
 */
export function runCtx(overrides: TaskHandlers = {}) {
  return taskCtx({
    "typefully.listPublished": () => ({ posts: [] }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "kv.get": () => ({ value: null }),
    "kv.set": () => ({ ok: true }),
    "kv.delete": () => ({ deleted: 1 }),
    // A ts, because announceGroups needs one to thread the replies under.
    "amplifier.postNote": () => ({ delivered: true, ts: "17580000.001" }),
    "llm.complete": () => ({ text: SUMMARY_LINE, model: "m", stopReason: "end" }),
    ...overrides,
  });
}
