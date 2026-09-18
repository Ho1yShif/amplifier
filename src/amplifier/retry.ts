import type { Retry } from "@renderinc/sdk/workflows";

/**
 * Retry policy for amplifier.handleEvent — the wait while a draft finishes
 * publishing. Backoff over 1m, 2m, 4m, 8m.
 */
export const HANDLE_EVENT_RETRY: Retry = {
  maxRetries: 4,
  waitDurationMs: 60_000,
  backoffScaling: 2,
};

/**
 * Retry policy for amplifier.repost. Backoff over 1s, 2s, 4s, 8s.
 *
 * Sized like SLACK_RETRY rather than wider: a person clicked the button and is
 * waiting for the ephemeral answer, so a long backoff reads as a dead button.
 */
export const REPOST_RETRY: Retry = {
  maxRetries: 4,
  waitDurationMs: 1_000,
  backoffScaling: 2,
};

/**
 * Retry policy for amplifier.remindRepost. Backoff over 10s, 20s.
 *
 * For crash recovery only. A deploy during the sleep kills the task, and the
 * resumed attempt waits out what is left of `dueAtMs` rather than the whole
 * delay again.
 */
export const REMIND_RETRY: Retry = {
  maxRetries: 2,
  waitDurationMs: 10_000,
  backoffScaling: 2,
};

/** Wall clock one amplifier.remindRepost run may spend, its sleep included. */
export const REMIND_TIMEOUT_SECONDS = 2_400;

/** Minutes of the remind timeout kept for the Key Value reads and the Slack post. */
const REMIND_POST_MARGIN_MINUTES = 5;

/**
 * Widest AMPLIFIER_REMINDER_MINUTES that can still produce a reminder.
 *
 * The delay is a sleep inside the task, so a delay past the task's timeout
 * kills the run before it reads either marker.
 */
export const MAX_REMINDER_MINUTES = REMIND_TIMEOUT_SECONDS / 60 - REMIND_POST_MARGIN_MINUTES;

/** Total backoff a retry policy spends, in minutes. */
function budgetMinutes({ maxRetries, waitDurationMs, backoffScaling }: Retry): number {
  let waitMs = 0;
  for (let attempt = 0; attempt < (maxRetries ?? 0); attempt++) {
    waitMs += (waitDurationMs ?? 0) * (backoffScaling ?? 1) ** attempt;
  }
  return waitMs / 60_000;
}

/**
 * Widest AMPLIFIER_SETTLE_MINUTES that can still announce a draft.
 *
 * The settle deadline is only reached on a retry, so a deadline past the
 * retries' 15-minute budget means every event for an in-flight draft exhausts
 * its retries and the post gets no note. loadConfig rejects a larger value at
 * startup instead.
 */
export const MAX_SETTLE_MINUTES = budgetMinutes(HANDLE_EVENT_RETRY);

/**
 * Retry policy for amplifier.editNote. Backoff over 1s, 2s, 4s, 8s.
 *
 * Sized like REPOST_RETRY, for the same reason: a person submitted a modal and
 * is waiting to see the note change. Both of the task's writes are idempotent,
 * so a retry re-runs the whole task safely.
 */
export const EDIT_RETRY: Retry = {
  maxRetries: 4,
  waitDurationMs: 1_000,
  backoffScaling: 2,
};
