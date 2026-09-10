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
