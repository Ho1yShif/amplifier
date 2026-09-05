import type { PublishedPost } from "../typefully/types.js";

/**
 * Keep the posts published within `lookbackMinutes` of `nowMs`.
 *
 * Future timestamps are kept: a small clock difference between Typefully and
 * the workflow instance must not swallow a post that just went live. A
 * timestamp that will not parse is dropped, because it cannot be windowed.
 */
export function withinWindow(
  posts: PublishedPost[],
  nowMs: number,
  lookbackMinutes: number,
): PublishedPost[] {
  const cutoff = nowMs - lookbackMinutes * 60_000;
  return posts.filter((p) => {
    const at = Date.parse(p.publishedAt);
    return Number.isFinite(at) && at >= cutoff;
  });
}
