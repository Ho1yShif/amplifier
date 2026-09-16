import { taskCtx, type TaskHandlers } from "./taskCtx.js";

/** The line llm.complete returns unless a test overrides it. */
export const SUMMARY_LINE = "Something shipped. Please amplify!";

/**
 * A TaskContext with a success default for every task the amplifier entry
 * points chain: nothing published, every Key Value call succeeding, Slack
 * accepting the note and resolving every owner, and the model returning
 * SUMMARY_LINE.
 *
 * Pass `overrides` to replace a task per test. An unlisted task name still
 * throws, so a test that chains something it did not stub fails loudly.
 */
export function runCtx(overrides: TaskHandlers = {}) {
  return taskCtx({
    "typefully.listPublished": () => ({ posts: [] }),
    // A page with an id and no properties, which reads as a launch page whose
    // Typefully URL is still empty. Tests that want a launch pass their own.
    "notion.getPage": ({ pageId }) => ({ page: { id: pageId } }),
    "notion.findLaunches": () => ({ pages: [], truncated: false }),
    "amplifier.lookupUser": () => ({ userId: "U_OWNER" }),
    "amplifier.openDm": () => ({ channelId: "D_OWNER" }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "kv.get": () => ({ value: null }),
    "kv.set": () => ({ ok: true }),
    "kv.delete": () => ({ deleted: 1 }),
    // A channel and a ts, because announceGroups threads the replies under the
    // ts and hands both to the owner DMs.
    "amplifier.postNote": () => ({ delivered: true, channel: "C_NOTE", ts: "17580000.001" }),
    "amplifier.messageLink": () => ({ url: "https://renderinc.slack.com/archives/C_NOTE/p1" }),
    "llm.complete": () => ({ text: SUMMARY_LINE, model: "m", stopReason: "end" }),
    ...overrides,
  });
}
