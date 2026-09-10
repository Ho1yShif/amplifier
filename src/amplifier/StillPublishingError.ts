import type { Platform } from "../typefully/types.js";

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
