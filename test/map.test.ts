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

  it("keeps X when Typefully reports a permalink but no X timestamp", () => {
    const post = mapDraft({
      id: 10628613,
      published_at: "2026-09-09T19:59:02.160Z",
      x_post_published_at: null,
      x_published_url: "https://x.com/render/status/2097776813036765567",
      linkedin_post_published_at: "2026-09-09T19:59:04.795Z",
      linkedin_published_url:
        "https://www.linkedin.com/feed/update/urn:li:share:7503542514444865536",
    });
    expect(post?.links).toEqual([
      {
        platform: "x",
        url: "https://x.com/render/status/2097776813036765567",
        publishedAt: "2026-09-09T19:59:02.160Z",
      },
      {
        platform: "linkedin",
        url: "https://www.linkedin.com/feed/update/urn:li:share:7503542514444865536",
        publishedAt: "2026-09-09T19:59:04.795Z",
      },
    ]);
    expect(post?.publishedAt).toBe("2026-09-09T19:59:02.160Z");
  });

  it("announces an X-only draft that has no X timestamp", () => {
    const post = mapDraft({
      id: 10586221,
      published_at: "2026-09-10T17:00:09.241Z",
      x_published_url: "https://x.com/render/status/2098094182632165398",
    });
    expect(post?.links).toEqual([
      {
        platform: "x",
        url: "https://x.com/render/status/2098094182632165398",
        publishedAt: "2026-09-10T17:00:09.241Z",
      },
    ]);
  });

  it("skips a platform whose permalink has no timestamp anywhere", () => {
    expect(mapDraft({ id: 11, x_published_url: "https://x.com/render/status/11" })).toBeNull();
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
