import type { PublishedPost } from "../typefully/types.js";

/**
 * How far past `nowMs` a post may be published and still count as inside the
 * window.
 *
 * A small clock difference between Typefully and the workflow instance must not
 * swallow a post that just went live. The allowance stops there, so a run given
 * a past `nowMs` replays that window instead of scanning everything published
 * since.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Keep the posts published within `lookbackMinutes` of `nowMs`, plus the clock
 * skew allowance past `nowMs`.
 *
 * A timestamp that will not parse is dropped, because it cannot be windowed.
 */
export function withinWindow(
  posts: PublishedPost[],
  nowMs: number,
  lookbackMinutes: number,
): PublishedPost[] {
  const cutoff = nowMs - lookbackMinutes * 60_000;
  const ceiling = nowMs + MAX_CLOCK_SKEW_MS;
  return posts.filter((p) => {
    const at = Date.parse(p.publishedAt);
    return Number.isFinite(at) && at >= cutoff && at <= ceiling;
  });
}
