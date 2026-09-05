import { describe, expect, it } from "vitest";
import { withinWindow } from "../src/amplifier/window.js";
import type { PublishedPost } from "../src/typefully/types.js";

const NOW = Date.parse("2026-09-04T16:00:00Z");

function post(draftId: string, publishedAt: string): PublishedPost {
  return {
    draftId,
    preview: "p",
    publishedAt,
    links: [{ platform: "x", url: "https://x.com/render/status/1", publishedAt }],
  };
}

describe("withinWindow", () => {
  it("keeps a post inside the window", () => {
    const posts = [post("1", "2026-09-04T15:30:00Z")];
    expect(withinWindow(posts, NOW, 90).map((p) => p.draftId)).toEqual(["1"]);
  });

  it("drops a post older than the window", () => {
    const posts = [post("1", "2026-09-04T14:00:00Z")];
    expect(withinWindow(posts, NOW, 90)).toEqual([]);
  });

  it("keeps a post exactly on the boundary", () => {
    const posts = [post("1", "2026-09-04T14:30:00Z")];
    expect(withinWindow(posts, NOW, 90).map((p) => p.draftId)).toEqual(["1"]);
  });

  it("keeps a post dated slightly in the future", () => {
    const posts = [post("1", "2026-09-04T16:00:30Z")];
    expect(withinWindow(posts, NOW, 90).map((p) => p.draftId)).toEqual(["1"]);
  });

  it("drops a post with an unparseable timestamp", () => {
    const posts = [post("1", "not-a-date")];
    expect(withinWindow(posts, NOW, 90)).toEqual([]);
  });
});
