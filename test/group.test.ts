import { describe, expect, it } from "vitest";
import { groupPosts } from "../src/amplifier/group.js";
import type { Platform, PublishedPost } from "../src/typefully/types.js";

function post(draftId: string, at: string, platforms: Platform[]): PublishedPost {
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
  };
}

describe("groupPosts", () => {
  it("keeps a cross-posted draft as one group with both links", () => {
    const groups = groupPosts([post("1", "2026-09-04T15:00:00Z", ["x", "linkedin"])], 10);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.links.map((l) => l.platform).sort()).toEqual(["linkedin", "x"]);
    expect(groups[0]?.draftIds).toEqual(["1"]);
  });

  it("merges two drafts on different platforms inside the window", () => {
    const groups = groupPosts(
      [post("1", "2026-09-04T15:00:00Z", ["x"]), post("2", "2026-09-04T15:04:00Z", ["linkedin"])],
      10,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.draftIds).toEqual(["1", "2"]);
    expect(groups[0]?.previews).toEqual(["preview 1", "preview 2"]);
    expect(groups[0]?.publishedAt).toBe("2026-09-04T15:00:00Z");
  });

  it("does not merge two drafts on the same platform", () => {
    const groups = groupPosts(
      [post("1", "2026-09-04T15:00:00Z", ["x"]), post("2", "2026-09-04T15:04:00Z", ["x"])],
      10,
    );
    expect(groups.map((g) => g.draftIds)).toEqual([["1"], ["2"]]);
  });

  it("does not merge drafts outside the window", () => {
    const groups = groupPosts(
      [post("1", "2026-09-04T15:00:00Z", ["x"]), post("2", "2026-09-04T15:20:00Z", ["linkedin"])],
      10,
    );
    expect(groups.map((g) => g.draftIds)).toEqual([["1"], ["2"]]);
  });

  it("measures the window from the group's first post, not the previous one", () => {
    const groups = groupPosts(
      [post("1", "2026-09-04T15:00:00Z", ["x"]), post("2", "2026-09-04T15:08:00Z", ["linkedin"])],
      10,
    );
    expect(groups[0]?.draftIds).toEqual(["1", "2"]);
  });

  it("orders groups oldest first regardless of input order", () => {
    const groups = groupPosts(
      [post("2", "2026-09-04T16:00:00Z", ["x"]), post("1", "2026-09-04T15:00:00Z", ["x"])],
      10,
    );
    expect(groups.map((g) => g.draftIds)).toEqual([["1"], ["2"]]);
  });

  it("carries the first share URL in the group", () => {
    const groups = groupPosts(
      [post("1", "2026-09-04T15:00:00Z", ["x"]), post("2", "2026-09-04T15:04:00Z", ["linkedin"])],
      10,
    );
    expect(groups[0]?.shareUrl).toBe("https://typefully.com/t/1");
  });

  it("returns nothing for no posts", () => {
    expect(groupPosts([], 10)).toEqual([]);
  });
});
