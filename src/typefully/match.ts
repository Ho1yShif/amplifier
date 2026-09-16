import type { PublishedPost } from "./types.js";

/** The two ways a human names one published post. */
export interface PostQuery {
  /** Permalink to the live post, or its Typefully share URL. */
  url?: string;
  /** Typefully draft id, when the URL is not to hand. */
  draftId?: string;
}

/**
 * The draft a query names, by draft id when given and otherwise by URL.
 *
 * The URL is matched against both the platform permalinks and Typefully's own
 * share URL, because the link on a Notion launch page is the share URL — the
 * post is scheduled there before any permalink exists.
 */
export function matchPost(posts: PublishedPost[], query: PostQuery): PublishedPost | undefined {
  if (query.draftId !== undefined) {
    return posts.find((p) => p.draftId === query.draftId);
  }
  return posts.find((p) => p.links.some((l) => l.url === query.url) || p.shareUrl === query.url);
}

/** Why nothing matched, for the throw that ends a manual run. */
export function noMatchMessage(posts: PublishedPost[], query: PostQuery): string {
  const target = query.draftId !== undefined ? `draft ${query.draftId}` : `${query.url}`;
  return (
    `No published draft matches ${target} among the newest ${posts.length} Typefully ` +
    `returned. The post may be older than those, or its permalink may not be on X or ` +
    `LinkedIn.`
  );
}
