import type { Platform, PublishedPost } from "../typefully/types.js";

/**
 * Milliseconds after which an incomplete draft gets announced anyway.
 *
 * Derived from the event time in the run's args rather than from the clock, so
 * every retry of a run computes the same deadline and the last attempt behaves
 * differently from the earlier ones.
 *
 * Throws on an `eventAt` that will not parse, matching how `checkPostsImpl`
 * treats `input.now`. A deadline computed from garbage would either fire
 * forever or never.
 */
export function settleDeadlineMs(eventAt: string, settleMinutes: number): number {
  const eventMs = Date.parse(eventAt);
  if (!Number.isFinite(eventMs)) {
    throw new Error(`eventAt is not a parseable timestamp: ${eventAt}`);
  }
  return eventMs + settleMinutes * 60_000;
}

/**
 * The still-publishing platforms of the event's draft, or [] when it is
 * complete or absent.
 *
 * A draft id that is not in `posts` returns []. Absent from the window is not
 * the same as incomplete, and it must not hold up a run. That happens when the
 * event is for a draft outside the lookback, or for one that never published to
 * X or LinkedIn.
 */
export function pendingForDraft(posts: PublishedPost[], draftId: string): Platform[] {
  return posts.find((p) => p.draftId === draftId)?.pending ?? [];
}

/**
 * Thrown while a draft's publish is still in flight, so the task's retry
 * re-reads Typefully a minute later.
 *
 * Its own class so `handleEventImpl` and a reader of the run logs can tell an
 * expected wait from a real failure.
 */
export class StillPublishingError extends Error {
  constructor(
    readonly draftId: string,
    readonly pending: Platform[],
    readonly deadlineMs: number,
  ) {
    super(
      `Draft ${draftId} is still publishing to ${pending.join(", ")}; retrying until ` +
        `${new Date(deadlineMs).toISOString()}`,
    );
    this.name = "StillPublishingError";
  }
}
