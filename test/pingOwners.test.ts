import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { pingOwnersImpl, type PingOwnersInput } from "../src/amplifier/pingOwners.js";
import { pingedKey, pingInflightKey } from "../src/amplifier/pinged.js";
import type { NotionPage } from "../src/notion/types.js";
import { post } from "./support/fixtures.js";
import { runCtx } from "./support/handlers.js";
import type { TaskCall, TaskHandlers } from "./support/taskCtx.js";

const PAGE: NotionPage = JSON.parse(
  readFileSync(new URL("./support/notion-page.json", import.meta.url), "utf8"),
);
const PAGE_ID = PAGE.id as string;
const LAUNCH_DATABASE_ID = PAGE.parent?.database_id as string;

/** Only what pingOwners reads, so a developer's shell cannot change a result. */
const ENV = { SLACK_CHANNEL: "social", SLACK_BOT_TOKEN: "xoxb-test" };

/** A context with the fixture page published, which most tests here want. */
function ctxFor(overrides: TaskHandlers = {}) {
  return runCtx({
    "notion.getPage": () => ({ page: PAGE }),
    "amplifier.lookupUser": ({ email }) => ({ userId: `U_${email.split("@")[0]}` }),
    "amplifier.openDm": ({ userId }) => ({ channelId: `D_${userId}` }),
    ...overrides,
  });
}

function ping(ctx: TaskContext, input: PingOwnersInput, env: NodeJS.ProcessEnv = ENV) {
  return pingOwnersImpl(ctx, input, env);
}

/** Every message the run posted, in order. */
function posts(calls: TaskCall[]) {
  return calls.filter((c) => c.name === "amplifier.postNote").map((c) => c.input);
}

/** The page's title and its URL come from the fixture, so assert against them. */
const LAUNCH_NAME = "Origin is a supported Git provider";
const TYPEFULLY_URL = "https://typefully.com/?d=10628613&a=1";

describe("pingOwnersImpl", () => {
  it("DMs every owner and marks the page pinged", async () => {
    const { ctx, calls } = ctxFor();

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.pinged?.map((p) => p.email)).toEqual(["dana@render.com", "sam@render.com"]);
    expect(result.pinged?.every((p) => p.delivered)).toBe(true);
    expect(result.unreachable).toBeUndefined();
    expect(posts(calls).map((p) => p.channel)).toEqual(["D_U_dana", "D_U_sam"]);
    expect(calls.find((c) => c.name === "kv.set")?.input).toMatchObject({
      key: pingedKey(PAGE_ID),
      value: "pinged",
    });
  });

  it("writes the Typefully link and the launch name into the DM", async () => {
    const { ctx, calls } = ctxFor();

    await ping(ctx, { pageId: PAGE_ID });

    const dm = posts(calls)[0];
    expect(dm.markdown).toContain(`*${LAUNCH_NAME}*`);
    expect(dm.markdown).toContain(`<${TYPEFULLY_URL}|Open it in Typefully>`);
    expect(dm.text).not.toContain("http");
  });

  it("takes the in-flight lock before the page and releases it after", async () => {
    const { ctx, calls } = ctxFor();

    await ping(ctx, { pageId: PAGE_ID });

    const order = calls.map((c) => c.name);
    expect(order.indexOf("kv.lock")).toBeLessThan(order.indexOf("notion.getPage"));
    expect(calls.find((c) => c.name === "kv.lock")?.input.key).toBe(pingInflightKey(PAGE_ID));
    expect(calls.at(-1)?.name).toBe("kv.unlock");
  });

  it("sends nothing for a page whose Typefully URL is empty", async () => {
    const { ctx, calls } = ctxFor({ "notion.getPage": ({ pageId }) => ({ page: { id: pageId } }) });

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.skipped).toBe("no-url");
    expect(posts(calls)).toHaveLength(0);
    expect(calls.some((c) => c.name === "kv.set")).toBe(false);
  });

  it("sends nothing for a page whose owner property is empty", async () => {
    const page = {
      ...PAGE,
      properties: { ...PAGE.properties, Owner: { type: "people", people: [] } },
    };
    const { ctx, calls } = ctxFor({ "notion.getPage": () => ({ page }) });

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.skipped).toBe("no-owners");
    expect(posts(calls)).toHaveLength(0);
  });

  it("sends nothing for a page the marker already records", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx, calls } = ctxFor({ "kv.get": () => ({ value: "pinged" }) });

      const result = await ping(ctx, { pageId: PAGE_ID });

      expect(result.skipped).toBe("pinged");
      expect(posts(calls)).toHaveLength(0);
      expect(calls.some((c) => c.name === "notion.getPage")).toBe(false);
    } finally {
      logs.mockRestore();
    }
  });

  it("re-sends the DMs when force clears the marker", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx, calls } = ctxFor({ "kv.get": () => ({ value: "pinged" }) });

      const result = await ping(ctx, { pageId: PAGE_ID, force: true });

      expect(result.skipped).toBeUndefined();
      expect(calls.find((c) => c.name === "kv.delete")?.input).toEqual({
        keys: [pingedKey(PAGE_ID)],
      });
      expect(posts(calls)).toHaveLength(2);
    } finally {
      logs.mockRestore();
    }
  });

  it("sends nothing when another run holds the lock", async () => {
    const { ctx, calls } = ctxFor({ "kv.lock": () => ({ acquired: false }) });

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.skipped).toBe("claimed");
    expect(calls.some((c) => c.name === "notion.getPage")).toBe(false);
    expect(posts(calls)).toHaveLength(0);
  });

  it("DMs the owner it can resolve and names the other one in the channel", async () => {
    const { ctx, calls } = ctxFor({
      "amplifier.lookupUser": ({ email }) =>
        email === "sam@render.com" ? { error: "users_not_found" } : { userId: "U_dana" },
    });

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.pinged?.map((p) => p.email)).toEqual(["dana@render.com"]);
    expect(result.unreachable?.[0]?.owner.name).toBe("Sam Okafor");
    const [dm, note] = posts(calls);
    expect(dm.channel).toBe("D_U_dana");
    expect(note.channel).toBe("social");
    expect(note.markdown).toContain("Sam Okafor");
    expect(note.markdown).toContain("users_not_found");
    expect(note.markdown).not.toContain("<@");
  });

  it("names an owner Notion reports with no email without calling Slack about them", async () => {
    const page = {
      ...PAGE,
      properties: {
        ...PAGE.properties,
        Owner: {
          type: "people",
          people: [{ object: "user", id: "u1", name: "Dana Reed", type: "person", person: {} }],
        },
      },
    };
    const { ctx, calls } = ctxFor({ "notion.getPage": () => ({ page }) });

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.pinged).toEqual([]);
    expect(result.unreachable?.[0]?.reason).toMatch(/user-email capability/);
    expect(calls.some((c) => c.name === "amplifier.lookupUser")).toBe(false);
    expect(posts(calls)).toHaveLength(1);
  });

  it("marks the page pinged when only the channel note reached Slack", async () => {
    const { ctx, calls } = ctxFor({
      "amplifier.lookupUser": () => ({ error: "users_not_found" }),
    });

    await ping(ctx, { pageId: PAGE_ID });

    expect(calls.some((c) => c.name === "kv.set")).toBe(true);
  });

  it("leaves the page unmarked when nothing reached Slack", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ctx, calls } = ctxFor({
        "amplifier.lookupUser": () => ({ error: "users_not_found" }),
      });

      await ping(ctx, { pageId: PAGE_ID }, { SLACK_BOT_TOKEN: "xoxb-test" });

      expect(posts(calls)).toHaveLength(0);
      expect(calls.some((c) => c.name === "kv.set")).toBe(false);
      expect(errors.mock.calls[0]?.[0]).toMatch(/No SLACK_CHANNEL/);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the DMs that went out when one owner's DM fails for good", async () => {
    const { ctx, calls } = ctxFor({
      "amplifier.postNote": ({ channel }) => {
        if (channel === "D_U_sam") throw new Error("channel_not_found");
        return { delivered: true, ts: "17580000.001" };
      },
    });

    const result = await ping(ctx, { pageId: PAGE_ID });

    expect(result.pinged?.map((p) => p.email)).toEqual(["dana@render.com"]);
    expect(result.unreachable?.[0]?.reason).toMatch(/channel_not_found/);
    expect(calls.some((c) => c.name === "kv.set")).toBe(true);
    expect(calls.at(-1)?.name).toBe("kv.unlock");
  });

  it("releases the lock when the page fetch throws", async () => {
    const { ctx, calls } = ctxFor({
      "notion.getPage": () => {
        throw new Error("notion down");
      },
    });

    await expect(ping(ctx, { pageId: PAGE_ID })).rejects.toThrow(/notion down/);
    expect(calls.at(-1)?.name).toBe("kv.unlock");
  });

  it("posts nothing in a dry run", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx, calls } = ctxFor();

      const result = await ping(ctx, { pageId: PAGE_ID, dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.pinged?.every((p) => p.delivered)).toBe(false);
      expect(posts(calls)).toHaveLength(0);
      expect(calls.some((c) => c.name === "kv.set")).toBe(false);
      expect(logs.mock.calls[0]?.[0]).toContain("[dry run] would DM Dana Reed");
    } finally {
      logs.mockRestore();
    }
  });

  it("refuses a run naming no page, URL or draft", async () => {
    const { ctx } = ctxFor();
    await expect(ping(ctx, {})).rejects.toThrow(/pageId.*url.*draftId/s);
  });

  it("finds the page from a live post's permalink and DMs its owners", async () => {
    const { ctx, calls } = ctxFor({
      "typefully.listPublished": () => ({
        posts: [post("10628613", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "notion.findLaunches": () => ({ pages: [PAGE], truncated: false }),
    });

    const result = await ping(
      ctx,
      { url: "https://example.com/x/10628613" },
      { ...ENV, NOTION_DATABASE_ID: LAUNCH_DATABASE_ID },
    );

    expect(result.pageId).toBe(PAGE_ID);
    expect(result.pinged).toHaveLength(2);
    expect(calls.find((c) => c.name === "notion.findLaunches")?.input.databaseId).toBe(
      LAUNCH_DATABASE_ID,
    );
  });

  it("skips a page from another database when one is configured", async () => {
    const { ctx, calls } = ctxFor();

    const result = await ping(ctx, { pageId: PAGE_ID }, { ...ENV, NOTION_DATABASE_ID: "other" });

    expect(result.skipped).toBe("other-database");
    expect(posts(calls)).toHaveLength(0);
  });
});
