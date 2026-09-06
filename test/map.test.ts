import { describe, expect, it } from "vitest";
import { mapDraft } from "../src/typefully/map.js";
import type { TypefullyDraft } from "../src/typefully/types.js";

const crossPosted: TypefullyDraft = {
  id: 4211,
  preview: "We cut cold starts on Render by 40%.",
  status: "published",
  share_url: "https://typefully.com/t/abc123",
  x_post_enabled: true,
  x_post_published_at: "2026-09-04T15:02:00Z",
  x_published_url: "https://x.com/render/status/1",
  linkedin_post_enabled: true,
  linkedin_post_published_at: "2026-09-04T15:00:00Z",
  linkedin_published_url: "https://linkedin.com/feed/update/2",
};

describe("mapDraft", () => {
  it("returns one post with a link per platform that published", () => {
    const post = mapDraft(crossPosted);
    expect(post).toEqual({
      draftId: "4211",
      preview: "We cut cold starts on Render by 40%.",
      publishedAt: "2026-09-04T15:00:00Z",
      shareUrl: "https://typefully.com/t/abc123",
      links: [
        {
          platform: "linkedin",
          url: "https://linkedin.com/feed/update/2",
          publishedAt: "2026-09-04T15:00:00Z",
        },
        {
          platform: "x",
          url: "https://x.com/render/status/1",
          publishedAt: "2026-09-04T15:02:00Z",
        },
      ],
    });
  });

  it("sets publishedAt to the earliest platform time", () => {
    expect(mapDraft(crossPosted)?.publishedAt).toBe("2026-09-04T15:00:00Z");
  });

  it("keeps a platform whose permalink has not arrived yet", () => {
    const post = mapDraft({
      id: 7,
      x_post_published_at: "2026-09-04T15:00:00Z",
      x_published_url: null,
    });
    expect(post?.links).toEqual([{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }]);
  });

  it("ignores a platform that is enabled but not published", () => {
    const post = mapDraft({
      id: 8,
      x_post_enabled: true,
      x_post_published_at: "2026-09-04T15:00:00Z",
      x_published_url: "https://x.com/render/status/8",
      linkedin_post_enabled: true,
      linkedin_post_published_at: null,
    });
    expect(post?.links.map((l) => l.platform)).toEqual(["x"]);
  });

  it("returns null when no platform published", () => {
    expect(mapDraft({ id: 9, status: "scheduled" })).toBeNull();
  });

  it("returns null without an id", () => {
    expect(mapDraft({ x_post_published_at: "2026-09-04T15:00:00Z" })).toBeNull();
  });

  it("falls back to an empty preview", () => {
    expect(mapDraft({ id: 10, x_post_published_at: "2026-09-04T15:00:00Z" })?.preview).toBe("");
  });
});
