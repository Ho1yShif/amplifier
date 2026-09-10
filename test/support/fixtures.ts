import type { PostGroup } from "../../src/amplifier/group.js";
import type { Platform, PublishedPost } from "../../src/typefully/types.js";

/**
 * A published post on the given platforms, each with a permalink and a share
 * URL derived from `draftId`. Pass `overrides` to change any field, including
 * dropping `shareUrl` or a link's `url`.
 */
export function post(
  draftId: string,
  at: string,
  platforms: Platform[] = ["x"],
  overrides?: Partial<PublishedPost>,
): PublishedPost {
  return {
    draftId,
    preview: `preview ${draftId}`,
    publishedAt: at,
    shareUrl: `https://typefully.com/t/${draftId}`,
    links: platforms.map((platform) => ({
      platform,
      url: `https://example.com/${platform}/${draftId}`,
      publishedAt: at,
    })),
    pending: [],
    ...overrides,
  };
}

/** A one-draft, one-link post group. Pass `overrides` to change any field. */
export function group(overrides?: Partial<PostGroup>): PostGroup {
  return {
    draftIds: ["1"],
    previews: ["preview 1"],
    publishedAt: "2026-09-04T15:00:00Z",
    links: [{ platform: "x", url: "https://example.com/x/1", publishedAt: "2026-09-04T15:00:00Z" }],
    ...overrides,
  };
}
