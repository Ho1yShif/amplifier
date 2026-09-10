import { task, type TaskContext } from "@renderinc/sdk/workflows";
import type { CheckPostsInput } from "../config.js";
import { checkPostsImpl, type CheckPostsResult } from "./checkPosts.js";
import { HANDLE_EVENT_RETRY } from "./retry.js";

/**
 * Raw implementation of amplifier.handleEvent.
 *
 * Calls `checkPostsImpl` directly rather than through `ctx.run`, so it adds no
 * second dispatch and no second poll interval. It exists to carry the retry
 * policy and to give the webhook path its own name in the dashboard.
 *
 * A retry that follows a successful Slack post does not double-post:
 * `markAnnounced` writes the seen marker after delivery, so the retry's
 * `announcedDraftIds` read drops the draft.
 */
export async function handleEventImpl(
  ctx: TaskContext,
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckPostsResult> {
  return checkPostsImpl(ctx, input, env);
}

/**
 * Announce the draft a Typefully webhook reported, retrying while it publishes.
 *
 * HANDLE_EVENT_RETRY gives a 15-minute settle budget against the 10-minute
 * default deadline, so the deadline ends the wait and the retry count is only
 * the ceiling. loadConfig caps AMPLIFIER_SETTLE_MINUTES at that same budget.
 */
export const handleEvent = task(
  {
    name: "amplifier.handleEvent",
    retry: HANDLE_EVENT_RETRY,
  },
  handleEventImpl,
);
