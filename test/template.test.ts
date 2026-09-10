import { describe, expect, it } from "vitest";
import { notePlatforms, renderNote } from "../src/amplifier/template.js";
import type { PostGroup } from "../src/amplifier/group.js";
import { group } from "./support/fixtures.js";

const crossPost = group({
  previews: ["We cut cold starts on Render by 40%."],
  shareUrl: "https://typefully.com/t/abc",
  links: [
    {
      platform: "linkedin",
      url: "https://linkedin.com/feed/update/2",
      publishedAt: "2026-09-04T15:00:00Z",
    },
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: "2026-09-04T15:02:00Z" },
  ],
});

describe("renderNote", () => {
  it("links every platform in one message", () => {
    const note = renderNote(crossPost);
    expect(note.markdown).toContain("<https://x.com/render/status/1|X post>");
    expect(note.markdown).toContain("<https://linkedin.com/feed/update/2|LinkedIn post>");
  });

  it("puts LinkedIn before X", () => {
    const md = renderNote(crossPost).markdown ?? "";
    expect(md.indexOf("|LinkedIn post>")).toBeLessThan(md.indexOf("|X post>"));
  });

  it("quotes the preview", () => {
    expect(renderNote(crossPost).markdown).toContain("> We cut cold starts on Render by 40%.");
  });

  it("opens with the call to action", () => {
    expect(
      renderNote(crossPost).markdown?.startsWith(
        "New Render social post! Please like and share when you have a minute",
      ),
    ).toBe(true);
  });

  it("takes a custom call to action", () => {
    const note = renderNote(crossPost, { callToAction: "Boost it please." });
    expect(note.markdown).toContain("Boost it please.");
  });

  it("sets no title and a plain-text fallback with no bare URL", () => {
    const note = renderNote(crossPost);
    expect(note.title).toBeUndefined();
    expect(note.text).not.toContain("https://");
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
        {
          platform: "linkedin",
          url: "https://linkedin.com/b",
          publishedAt: "2026-09-04T15:04:00Z",
        },
      ],
    };
    expect(renderNote(merged).markdown).toContain("> first");
    expect(renderNote(merged).markdown).toContain("> second");
  });

  it("falls back to the Typefully draft when a permalink is missing", () => {
    const pending: PostGroup = {
      ...crossPost,
      links: [{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }],
    };
    expect(renderNote(pending).markdown).toContain(
      "<https://typefully.com/t/abc|X post (Typefully draft)>",
    );
  });

  it("says the link is pending with no permalink and no share URL", () => {
    const pending: PostGroup = {
      draftIds: ["1"],
      previews: ["p"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }],
    };
    expect(renderNote(pending).markdown).toContain("X post (link pending)");
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

  it("uses the summary as the whole lead line", () => {
    const md =
      renderNote(crossPost, { summary: "Cold starts are 40% faster. Please amplify!" }).markdown ??
      "";
    expect(md.startsWith("Cold starts are 40% faster. Please amplify!")).toBe(true);
    expect(md).not.toContain("New Render social post!");
  });

  it("drops the preview quote when there is a summary", () => {
    const md = renderNote(crossPost, { summary: "Cold starts are 40% faster." }).markdown ?? "";
    expect(md).not.toContain("> We cut cold starts on Render by 40%.");
  });

  it("still links every platform under a summary", () => {
    const md = renderNote(crossPost, { summary: "Cold starts are 40% faster." }).markdown ?? "";
    expect(md).toContain("• <https://linkedin.com/feed/update/2|LinkedIn post>");
    expect(md).toContain("• <https://x.com/render/status/1|X post>");
  });

  it("names the failure and keeps the quote when there is no summary", () => {
    const md = renderNote(crossPost, { summaryError: "401 invalid x-api-key" }).markdown ?? "";
    expect(md).toContain("_(Summarization LLM call failed: 401 invalid x-api-key)_");
    expect(md).toContain("> We cut cold starts on Render by 40%.");
    expect(md.startsWith("New Render social post!")).toBe(true);
  });

  it("drops the bullet when only one platform has a link", () => {
    const single: PostGroup = {
      ...crossPost,
      links: [
        { platform: "x", url: "https://x.com/render/status/1", publishedAt: crossPost.publishedAt },
      ],
    };
    const md = renderNote(single, { summary: "Cold starts are 40% faster." }).markdown ?? "";
    expect(md).toContain("<https://x.com/render/status/1|X post>");
    expect(md).not.toContain("•");
  });

  it("drops the bullet on a single pending link", () => {
    const pending: PostGroup = {
      ...crossPost,
      links: [{ platform: "linkedin", publishedAt: crossPost.publishedAt }],
    };
    expect(renderNote(pending).markdown).not.toContain("•");
  });

  it("keeps the bullets when both platforms have links", () => {
    const md = renderNote(crossPost, { summary: "Cold starts are 40% faster." }).markdown ?? "";
    expect(md).toContain("• <https://linkedin.com/feed/update/2|LinkedIn post>");
    expect(md).toContain("• <https://x.com/render/status/1|X post>");
  });

  it("sets the notification fallback to the summary and no URL", () => {
    const note = renderNote(crossPost, { summary: "Cold starts are 40% faster." });
    expect(note.text).toBe("Cold starts are 40% faster.");
    expect(note.text).not.toContain("https://");
  });

  it("keeps no URL in the notification fallback when the summary failed", () => {
    const note = renderNote(crossPost, { summaryError: "boom" });
    expect(note.text).not.toContain("https://");
  });
});
