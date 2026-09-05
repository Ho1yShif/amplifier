import { describe, expect, it } from "vitest";
import { notePlatforms, renderNote } from "../src/amplifier/template.js";
import type { PostGroup } from "../src/amplifier/group.js";

const crossPost: PostGroup = {
  draftIds: ["1"],
  previews: ["We cut cold starts on Render by 40%."],
  publishedAt: "2026-09-04T15:00:00Z",
  shareUrl: "https://typefully.com/t/abc",
  links: [
    {
      platform: "linkedin",
      url: "https://linkedin.com/feed/update/2",
      publishedAt: "2026-09-04T15:00:00Z",
    },
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: "2026-09-04T15:02:00Z" },
  ],
};

describe("renderNote", () => {
  it("links every platform in one message", () => {
    const note = renderNote(crossPost);
    expect(note.markdown).toContain("<https://x.com/render/status/1|X>");
    expect(note.markdown).toContain("<https://linkedin.com/feed/update/2|LinkedIn>");
  });

  it("puts X before LinkedIn", () => {
    const md = renderNote(crossPost).markdown ?? "";
    expect(md.indexOf("|X>")).toBeLessThan(md.indexOf("|LinkedIn>"));
  });

  it("quotes the preview", () => {
    expect(renderNote(crossPost).markdown).toContain("> We cut cold starts on Render by 40%.");
  });

  it("ends with the call to action", () => {
    expect(renderNote(crossPost).markdown?.endsWith(
      "Give it a like and a repost when you get a minute.",
    )).toBe(true);
  });

  it("takes a custom call to action", () => {
    const note = renderNote(crossPost, { callToAction: "Boost it please." });
    expect(note.markdown).toContain("Boost it please.");
  });

  it("sets a title and a plain-text fallback", () => {
    const note = renderNote(crossPost);
    expect(note.title).toBe("New Render post to amplify");
    expect(note.text).toContain("https://x.com/render/status/1");
  });

  it("passes the channel through", () => {
    expect(renderNote(crossPost, { channel: "#social" }).channel).toBe("#social");
  });

  it("omits the channel when none is given", () => {
    expect(renderNote(crossPost).channel).toBeUndefined();
  });

  it("quotes one preview per draft when drafts merged", () => {
    const merged: PostGroup = {
      draftIds: ["1", "2"],
      previews: ["first", "second"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [
        { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
        { platform: "linkedin", url: "https://linkedin.com/b", publishedAt: "2026-09-04T15:04:00Z" },
      ],
    };
    expect(renderNote(merged).markdown).toContain("> first");
    expect(renderNote(merged).markdown).toContain("> second");
  });

  it("falls back to the Typefully draft when a permalink is missing", () => {
    const pending: PostGroup = { ...crossPost, links: [
      { platform: "x", publishedAt: "2026-09-04T15:00:00Z" },
    ] };
    expect(renderNote(pending).markdown).toContain(
      "<https://typefully.com/t/abc|X (Typefully draft)>",
    );
  });

  it("says the link is pending with no permalink and no share URL", () => {
    const pending: PostGroup = {
      draftIds: ["1"],
      previews: ["p"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }],
    };
    expect(renderNote(pending).markdown).toContain("X (link pending)");
  });

  it("keeps one link per platform when two drafts share a platform", () => {
    const dupe: PostGroup = {
      draftIds: ["1"],
      previews: ["p"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [
        { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
        { platform: "x", url: "https://x.com/b", publishedAt: "2026-09-04T15:01:00Z" },
      ],
    };
    expect(notePlatforms(dupe)).toEqual(["x"]);
    expect(renderNote(dupe).markdown).not.toContain("https://x.com/b");
  });
});
