import { task, type TaskContext } from "@renderinc/sdk/workflows";
import type { CheckPostsInput } from "../config.js";
import { checkPostsImpl, type CheckPostsResult } from "./checkPosts.js";

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
 * Four retries at 1m, 2m, 4m, and 8m give a 15-minute settle budget against the
 * 10-minute default deadline, so the deadline ends the wait and the retry count
 * is only the ceiling. Raising AMPLIFIER_SETTLE_MINUTES past 15 makes the
 * retries run out first, and the event is then lost with no note.
 */
export const handleEvent = task(
  {
    name: "amplifier.handleEvent",
    retry: { maxRetries: 4, waitDurationMs: 60_000, backoffScaling: 2 },
  },
  handleEventImpl,
);
