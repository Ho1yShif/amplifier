import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import type { TaskDefinition } from "@renderinc/sdk/workflows";
import { checkPostsImpl } from "../src/amplifier/checkPosts.js";
import type { PublishedPost } from "../src/typefully/types.js";

const NOW = "2026-09-04T16:00:00Z";

function post(draftId: string, at: string, platforms: Array<"x" | "linkedin">): PublishedPost {
  return {
    draftId,
    preview: `preview ${draftId}`,
    publishedAt: at,
    links: platforms.map((platform) => ({
      platform,
      url: `https://example.com/${platform}/${draftId}`,
      publishedAt: at,
    })),
  };
}

/** ctx.run dispatched by task name, with sensible defaults per task. */
function runCtx(overrides: Record<string, (input: any) => unknown> = {}) {
  const calls: Array<{ name: string; input: any }> = [];
  const handlers: Record<string, (input: any) => unknown> = {
    "typefully.listPublished": () => ({ posts: [] }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "kv.get": () => ({ value: null }),
    "slack.postMessage": () => ({ delivered: true }),
    ...overrides,
  };
  const ctx = fakeCtx({
    run: (async (t: TaskDefinition<any, any>, input: any) => {
      calls.push({ name: t.name, input });
      const handler = handlers[t.name];
      if (!handler) throw new Error(`unexpected task ${t.name}`);
      return handler(input);
    }) as any,
  });
  return { ctx, calls };
}

const BASE = { now: NOW, dryRun: false, socialSetId: "set_1", slackChannel: "#social" };

describe("checkPostsImpl", () => {
  beforeEach(() => {
    // checkPostsImpl calls loadConfig(input) with no env argument, so
    // process.env is the fallback for anything the input omits. Delete every
    // AMPLIFIER_* var (and DRY_RUN) so a developer's shell (e.g.
    // AMPLIFIER_GROUP_WINDOW_MINUTES) can't change these results — loadConfig
    // then falls back to its own defaults. Every test that asserts on one of
    // these values passes it explicitly in the input instead.
    vi.unstubAllEnvs();
    vi.stubEnv("AMPLIFIER_LIMIT", undefined);
    vi.stubEnv("AMPLIFIER_LOOKBACK_MINUTES", undefined);
    vi.stubEnv("AMPLIFIER_GROUP_WINDOW_MINUTES", undefined);
    vi.stubEnv("AMPLIFIER_SEEN_TTL_DAYS", undefined);
    vi.stubEnv("AMPLIFIER_CALL_TO_ACTION", undefined);
    vi.stubEnv("DRY_RUN", undefined);
    vi.stubEnv("TYPEFULLY_SOCIAL_SET_ID", undefined);
    vi.stubEnv("SLACK_CHANNEL", undefined);
  });

  it("posts one note for a cross-posted draft", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x", "linkedin"])],
      }),
    });

    const result = await checkPostsImpl(ctx, BASE);

    const posts = calls.filter((c) => c.name === "slack.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.input.channel).toBe("#social");
    expect(posts[0]?.input.markdown).toContain("|X>");
    expect(posts[0]?.input.markdown).toContain("|LinkedIn>");
    expect(result.notified).toBe(1);
  });

  it("posts one note when an X post and a LinkedIn post land together", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [
          post("1", "2026-09-04T15:30:00Z", ["x"]),
          post("2", "2026-09-04T15:33:00Z", ["linkedin"]),
        ],
      }),
    });

    const result = await checkPostsImpl(ctx, { ...BASE, groupWindowMinutes: 10 });

    expect(calls.filter((c) => c.name === "slack.postMessage")).toHaveLength(1);
    expect(result.notes[0]?.draftIds).toEqual(["1", "2"]);
  });

  it("drops posts older than the lookback window", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T10:00:00Z", ["x"])],
      }),
    });

    const result = await checkPostsImpl(ctx, { ...BASE, lookbackMinutes: 90 });

    expect(calls.filter((c) => c.name === "slack.postMessage")).toEqual([]);
    expect(result.inWindow).toBe(0);
  });

  it("skips a group another run already announced", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "kv.lock": () => ({ acquired: false }),
      "kv.get": () => ({ value: "amplifier:someone-else" }),
    });

    const result = await checkPostsImpl(ctx, BASE);

    expect(calls.filter((c) => c.name === "slack.postMessage")).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("claims the drafts before posting", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await checkPostsImpl(ctx, BASE);

    const names = calls.map((c) => c.name);
    expect(names.indexOf("kv.lock")).toBeLessThan(names.indexOf("slack.postMessage"));
  });

  it("releases the claim when the Slack post fails", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "slack.postMessage": () => {
        throw new Error("slack down");
      },
    });

    await expect(checkPostsImpl(ctx, BASE)).rejects.toThrow("slack down");
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:seen:1",
    ]);
  });

  it("posts nothing in dry run and leaves no claim behind", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    const result = await checkPostsImpl(ctx, { ...BASE, dryRun: true });

    expect(calls.filter((c) => c.name === "slack.postMessage")).toEqual([]);
    expect(calls.filter((c) => c.name === "kv.unlock")).toHaveLength(1);
    expect(result.dryRun).toBe(true);
    expect(result.notified).toBe(0);
    expect(result.notes[0]?.draftIds).toEqual(["1"]);
  });

  it("passes the social set and limit to typefully.listPublished", async () => {
    const { ctx, calls } = runCtx();
    await checkPostsImpl(ctx, { ...BASE, limit: 7 });
    expect(calls[0]).toEqual({
      name: "typefully.listPublished",
      input: { socialSetId: "set_1", limit: 7 },
    });
  });

  it("reports counts for an empty run", async () => {
    const { ctx } = runCtx();
    expect(await checkPostsImpl(ctx, BASE)).toEqual({
      scanned: 0,
      inWindow: 0,
      groups: 0,
      notified: 0,
      skipped: 0,
      dryRun: false,
      notes: [],
    });
  });
});
