import { task } from "@renderinc/sdk/workflows";
import { checkPostsImpl } from "./checkPosts.js";
import { HANDLE_EVENT_RETRY } from "./retry.js";

/**
 * Announce the draft a Typefully webhook reported, retrying while it publishes.
 *
 * Registers `checkPostsImpl` directly, so the webhook path adds no second
 * dispatch and no second poll interval. This task exists to carry the retry
 * policy and to give the webhook path its own name in the dashboard.
 *
 * HANDLE_EVENT_RETRY gives a 15-minute settle budget against the 10-minute
 * default deadline, so the deadline ends the wait and the retry count is only
 * the ceiling. loadConfig caps AMPLIFIER_SETTLE_MINUTES at that same budget.
 *
 * A retry that follows a successful Slack post does not double-post:
 * `markAnnounced` writes the seen marker after delivery, so the retry's
 * `announcedDraftIds` read drops the draft.
 */
export const handleEvent = task(
  {
    name: "amplifier.handleEvent",
    retry: HANDLE_EVENT_RETRY,
  },
  checkPostsImpl,
);
