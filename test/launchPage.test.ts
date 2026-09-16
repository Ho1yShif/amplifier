import { describe, expect, it, vi } from "vitest";
import { launchNeedles, resolveLaunchPageId } from "../src/amplifier/launchPage.js";
import { loadConfig } from "../src/config.js";
import { post } from "./support/fixtures.js";
import { runCtx } from "./support/handlers.js";
import { launchPage } from "./support/notionPort.js";
import type { TaskHandlers } from "./support/taskCtx.js";

const POST = post("77", "2026-09-04T15:30:00Z", ["x"]);
const PAGE = launchPage("page_1", "https://typefully.com/t/77");

const CONFIG = loadConfig({}, { NOTION_DATABASE_ID: "db_1" });

/** A context with the post published and one launch page carrying its link. */
function ctxFor(overrides: TaskHandlers = {}) {
  return runCtx({
    "typefully.listPublished": () => ({ posts: [POST] }),
    "notion.findLaunches": () => ({ pages: [PAGE], truncated: false }),
    ...overrides,
  });
}

describe("launchNeedles", () => {
  it("puts the share URL first, then its token, then the draft id", () => {
    expect(launchNeedles(POST)).toEqual(["https://typefully.com/t/77", "77"]);
  });

  it("falls back to the draft id alone when the post has no share URL", () => {
    const { shareUrl: _shareUrl, ...noShareUrl } = post("9", "2026-09-04T15:30:00Z", ["x"]);
    expect(launchNeedles(noShareUrl)).toEqual(["9"]);
  });

  it("drops a query string from the token", () => {
    const needles = launchNeedles(
      post("9", "2026-09-04T15:30:00Z", ["x"], { shareUrl: "https://typefully.com/t/xyz?utm=1" }),
    );
    expect(needles).toEqual(["https://typefully.com/t/xyz?utm=1", "xyz", "9"]);
  });
});

describe("resolveLaunchPageId", () => {
  it("finds the page whose Typefully link matches a permalink", async () => {
    const { ctx, calls } = ctxFor();

    const pageId = await resolveLaunchPageId(ctx, { url: "https://example.com/x/77" }, CONFIG);

    expect(pageId).toBe("page_1");
    expect(calls.find((c) => c.name === "notion.findLaunches")?.input).toEqual({
      databaseId: "db_1",
      typefullyProperty: "Typefully",
      needles: ["https://typefully.com/t/77", "77"],
    });
  });

  it("finds the page from a draft id", async () => {
    const { ctx } = ctxFor();

    expect(await resolveLaunchPageId(ctx, { draftId: "77" }, CONFIG)).toBe("page_1");
  });

  it("prefers the page matched by the share URL over one matched by the draft id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = ctxFor({
        "notion.findLaunches": () => ({
          pages: [launchPage("page_other", "https://typefully.com/t/ab77cd"), PAGE],
          truncated: false,
        }),
      });

      expect(await resolveLaunchPageId(ctx, { draftId: "77" }, CONFIG)).toBe("page_1");
    } finally {
      log.mockRestore();
    }
  });

  it("prefers the exact share URL over a page whose link only starts with it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = ctxFor({
        "notion.findLaunches": () => ({
          pages: [launchPage("page_other", "https://typefully.com/t/77abc"), PAGE],
          truncated: false,
        }),
      });

      expect(await resolveLaunchPageId(ctx, { draftId: "77" }, CONFIG)).toBe("page_1");
    } finally {
      log.mockRestore();
    }
  });

  it("says which page it chose when several carry the link", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = ctxFor({
        "notion.findLaunches": () => ({
          pages: [PAGE, launchPage("page_other", "https://typefully.com/t/ab77cd")],
          truncated: false,
        }),
      });

      await resolveLaunchPageId(ctx, { draftId: "77" }, CONFIG);

      expect(log.mock.calls.at(-1)?.[0]).toMatch(/2 launch pages/);
    } finally {
      log.mockRestore();
    }
  });

  it("throws without a launch database to search", async () => {
    const { ctx } = ctxFor();

    await expect(resolveLaunchPageId(ctx, { draftId: "77" }, loadConfig({}, {}))).rejects.toThrow(
      /NOTION_DATABASE_ID/,
    );
  });

  it("throws when Typefully has no such published draft", async () => {
    const { ctx } = ctxFor({ "typefully.listPublished": () => ({ posts: [] }) });

    await expect(resolveLaunchPageId(ctx, { draftId: "77" }, CONFIG)).rejects.toThrow(
      /No published draft matches/,
    );
  });

  it("throws when no launch page carries the link", async () => {
    const { ctx } = ctxFor({ "notion.findLaunches": () => ({ pages: [], truncated: false }) });

    await expect(resolveLaunchPageId(ctx, { draftId: "77" }, CONFIG)).rejects.toThrow(
      /No page in the launch database/,
    );
  });
});
