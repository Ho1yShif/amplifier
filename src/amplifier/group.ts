import { compareTime } from "../time.js";
import type { Platform, PlatformLink, PublishedPost } from "../typefully/types.js";

/** One Slack note's worth of published posts. */
export interface PostGroup {
  /** Every draft announced by this note. Drives the Key Value claim. */
  draftIds: string[];
  /** One preview per draft, in the same order as `draftIds`. */
  previews: string[];
  /** Every platform link across the group's drafts. */
  links: PlatformLink[];
  /** Earliest publish time in the group. */
  publishedAt: string;
  /** First Typefully share URL in the group, used when a permalink is missing. */
  shareUrl?: string;
}

/**
 * Collapse posts into one group per announcement.
 *
 * A draft cross-posted to X and LinkedIn arrives as a single post holding both
 * links, so it is already one group. Two separate drafts join the same group
 * only when the later one lands within `groupWindowMinutes` of the group's
 * first post AND adds a platform the group does not have yet — two X posts
 * minutes apart are two announcements, not one cross-post.
 *
 * Every `publishedAt` must parse; `withinWindow` drops the ones that do not.
 */
export function groupPosts(posts: PublishedPost[], groupWindowMinutes: number): PostGroup[] {
  const windowMs = groupWindowMinutes * 60_000;
  const ordered = [...posts].sort((a, b) => compareTime(a.publishedAt, b.publishedAt));

  const groups: PostGroup[] = [];
  let current: PostGroup | undefined;
  let currentStartMs = 0;
  let currentPlatforms = new Set<Platform>();

  for (const post of ordered) {
    const startMs = Date.parse(post.publishedAt);
    const platforms = post.links.map((l) => l.platform);
    const overlaps = platforms.some((p) => currentPlatforms.has(p));
    const inWindow = current !== undefined && startMs - currentStartMs <= windowMs;

    if (current && inWindow && !overlaps) {
      current.draftIds.push(post.draftId);
      current.previews.push(post.preview);
      current.links.push(...post.links);
      if (!current.shareUrl && post.shareUrl) current.shareUrl = post.shareUrl;
      for (const p of platforms) currentPlatforms.add(p);
      continue;
    }

    current = {
      draftIds: [post.draftId],
      previews: [post.preview],
      links: [...post.links],
      publishedAt: post.publishedAt,
      ...(post.shareUrl ? { shareUrl: post.shareUrl } : {}),
    };
    currentStartMs = startMs;
    currentPlatforms = new Set<Platform>(platforms);
    groups.push(current);
  }

  return groups;
}
