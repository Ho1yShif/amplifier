import { describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { checkPostsImpl } from "../src/amplifier/checkPosts.js";
import { StillPublishingError } from "../src/amplifier/StillPublishingError.js";
import type { CheckPostsInput } from "../src/config.js";
import type { PublishedPost } from "../src/typefully/types.js";
import { post } from "./support/fixtures.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const NOW = "2026-09-04T16:00:00Z";

/** ctx.run dispatched by task name, with sensible defaults per task. */
function runCtx(overrides: TaskHandlers = {}) {
  return taskCtx({
    "typefully.listPublished": () => ({ posts: [] }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "kv.get": () => ({ value: null }),
    "kv.set": () => ({ ok: true }),
    "amplifier.postNote": () => ({ delivered: true }),
    "llm.complete": () => ({
      text: "Something shipped. Please amplify!",
      model: "m",
      stopReason: "end",
    }),
    ...overrides,
  });
}

const BASE = { now: NOW, dryRun: false, socialSetId: "set_1", slackChannel: "#social" };

/**
 * Run checkPostsImpl with an empty environment, which every test wants.
 * checkPostsImpl takes its environment as an argument, so a developer's shell
 * cannot reach loadConfig and change a result.
 */
function check(ctx: TaskContext, input: CheckPostsInput) {
  return checkPostsImpl(ctx, input, {});
}

describe("checkPostsImpl", () => {
  it("posts one note for a cross-posted draft", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x", "linkedin"])],
      }),
    });

    const result = await check(ctx, BASE);

    const posts = calls.filter((c) => c.name === "amplifier.postNote");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.input.channel).toBe("#social");
    expect(posts[0]?.input.markdown).toContain("|X post>");
    expect(posts[0]?.input.markdown).toContain("|LinkedIn post>");
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

    const result = await check(ctx, { ...BASE, groupWindowMinutes: 10 });

    expect(calls.filter((c) => c.name === "amplifier.postNote")).toHaveLength(1);
    expect(result.notes[0]?.draftIds).toEqual(["1", "2"]);
  });

  it("drops posts older than the lookback window", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T10:00:00Z", ["x"])],
      }),
    });

    const result = await check(ctx, { ...BASE, lookbackMinutes: 90 });

    expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
    expect(result.inWindow).toBe(0);
  });

  it("skips a draft an earlier run already announced, without locking it", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "kv.get": () => ({ value: "announced" }),
    });

    const result = await check(ctx, BASE);

    expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
    expect(calls.filter((c) => c.name === "kv.lock")).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.groups).toBe(0);
  });

  it("skips a group another run is announcing right now", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "kv.lock": () => ({ acquired: false }),
    });

    const result = await check(ctx, BASE);

    expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("counts every draft in a group another run is announcing", async () => {
    const { ctx } = runCtx({
      "typefully.listPublished": () => ({
        posts: [
          post("1", "2026-09-04T15:30:00Z", ["x"]),
          post("2", "2026-09-04T15:33:00Z", ["linkedin"]),
        ],
      }),
      "kv.lock": () => ({ acquired: false }),
    });

    const result = await check(ctx, { ...BASE, groupWindowMinutes: 10 });

    // Both drafts went unannounced, so both are skipped. Counting the group as
    // 1 would report a different number for the same two drafts depending on
    // whether they were already announced or merely in flight.
    expect(result.groups).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("reports the Slack failure even when releasing the lock also fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "amplifier.postNote": () => {
        throw new Error("slack down");
      },
      "kv.unlock": () => {
        throw new Error("key value unreachable");
      },
    });

    await expect(check(ctx, BASE)).rejects.toThrow("slack down");
    expect(error.mock.calls[0]?.[0]).toContain("Could not release the in-flight lock");
    error.mockRestore();
  });

  it("marks the drafts announced only after Slack accepts the note", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await check(ctx, BASE);

    const names = calls.map((c) => c.name);
    expect(names.indexOf("amplifier.postNote")).toBeLessThan(names.indexOf("kv.set"));
    expect(calls.filter((c) => c.name === "kv.set").map((c) => c.input)).toEqual([
      { key: "amplifier:seen:1", value: "announced", ttlSeconds: 30 * 86_400 },
    ]);
  });

  it("leaves the drafts unannounced when Slack falls back to the console", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "amplifier.postNote": () => ({ delivered: false }),
    });

    const result = await check(ctx, BASE);

    expect(calls.filter((c) => c.name === "kv.set")).toEqual([]);
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:inflight:1",
    ]);
    expect(result.notified).toBe(0);
    expect(result.notes[0]?.delivered).toBe(false);
  });

  it("claims the drafts before posting", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await check(ctx, BASE);

    const names = calls.map((c) => c.name);
    expect(names.indexOf("kv.lock")).toBeLessThan(names.indexOf("amplifier.postNote"));
  });

  it("releases the claim when the Slack post fails", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "amplifier.postNote": () => {
        throw new Error("slack down");
      },
    });

    await expect(check(ctx, BASE)).rejects.toThrow("slack down");
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:inflight:1",
    ]);
  });

  it("posts nothing in dry run and leaves no claim behind", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    const result = await check(ctx, { ...BASE, dryRun: true });

    expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
    expect(calls.filter((c) => c.name === "kv.unlock")).toHaveLength(1);
    expect(result.dryRun).toBe(true);
    expect(result.notified).toBe(0);
    expect(result.notes[0]?.draftIds).toEqual(["1"]);
  });

  it("warns when the response fills the limit and nothing is in the window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-01T10:00:00Z", ["x"]), post("2", "2026-09-01T11:00:00Z", ["x"])],
      }),
    });

    await check(ctx, { ...BASE, limit: 2 });

    expect(warn.mock.calls[0]?.[0]).toContain("truncated");
    warn.mockRestore();
  });

  it("throws on a now that will not parse", async () => {
    const { ctx } = runCtx();
    await expect(check(ctx, { ...BASE, now: "last tuesday" })).rejects.toThrow(
      "not a parseable timestamp",
    );
  });

  it("passes the social set and limit to typefully.listPublished", async () => {
    const { ctx, calls } = runCtx();
    await check(ctx, { ...BASE, limit: 7 });
    expect(calls[0]).toEqual({
      name: "typefully.listPublished",
      input: { socialSetId: "set_1", limit: 7 },
    });
  });

  it("reports counts for an empty run", async () => {
    const { ctx } = runCtx();
    expect(await check(ctx, BASE)).toEqual({
      scanned: 0,
      inWindow: 0,
      groups: 0,
      notified: 0,
      skipped: 0,
      dryRun: false,
      droppedPlatforms: [],
      notes: [],
    });
  });

  describe("the settle check", () => {
    const EVENT_AT = "2026-09-04T15:55:00Z";
    const PENDING = { ...BASE, eventAt: EVENT_AT, draftId: "1" };

    /** A draft that published to LinkedIn with X still in flight. */
    function pendingPosts(): PublishedPost[] {
      return [post("1", "2026-09-04T15:54:00Z", ["linkedin"], { pending: ["x"] })];
    }

    it("throws and posts nothing while a platform is still publishing", async () => {
      const { ctx, calls } = runCtx({
        "typefully.listPublished": () => ({ posts: pendingPosts() }),
      });

      await expect(check(ctx, PENDING)).rejects.toThrow(StillPublishingError);
      expect(calls.filter((c) => c.name === "amplifier.postNote")).toHaveLength(0);
      expect(calls.filter((c) => c.name === "kv.lock")).toHaveLength(0);
    });

    it("announces without the pending platform once the deadline passes", async () => {
      const { ctx, calls } = runCtx({
        "typefully.listPublished": () => ({ posts: pendingPosts() }),
      });

      const result = await check(ctx, { ...PENDING, now: "2026-09-04T16:06:00Z" });

      expect(calls.filter((c) => c.name === "amplifier.postNote")).toHaveLength(1);
      expect(result.droppedPlatforms).toEqual(["x"]);
      expect(result.notified).toBe(1);
    });

    it("posts a complete draft on the first attempt", async () => {
      const { ctx } = runCtx({
        "typefully.listPublished": () => ({
          posts: [post("1", "2026-09-04T15:54:00Z", ["x", "linkedin"])],
        }),
      });

      const result = await check(ctx, PENDING);

      expect(result.notified).toBe(1);
      expect(result.droppedPlatforms).toEqual([]);
    });

    it("does not throw for a pending draft an earlier run already announced", async () => {
      const { ctx } = runCtx({
        "typefully.listPublished": () => ({ posts: pendingPosts() }),
        "kv.get": () => ({ value: "announced" }),
      });

      const result = await check(ctx, PENDING);

      expect(result.skipped).toBe(1);
      expect(result.notified).toBe(0);
    });

    it("does not throw for an event about a draft outside the window", async () => {
      const { ctx } = runCtx({
        "typefully.listPublished": () => ({
          posts: [post("2", "2026-09-04T15:54:00Z", ["x"])],
        }),
      });

      const result = await check(ctx, { ...PENDING, draftId: "404" });

      expect(result.notified).toBe(1);
      expect(result.droppedPlatforms).toEqual([]);
    });

    it("never throws when settleMinutes is 0", async () => {
      const { ctx } = runCtx({
        "typefully.listPublished": () => ({ posts: pendingPosts() }),
      });

      const result = await check(ctx, { ...PENDING, settleMinutes: 0 });

      expect(result.notified).toBe(1);
      expect(result.droppedPlatforms).toEqual([]);
    });
  });
});

/**
 * A Map-backed fake Key Value, shared across runs, with a virtual clock so TTLs
 * expire the way a real instance's do. This is what lets a test represent state
 * an earlier run left behind.
 */
function kvStore(startMs: number) {
  const store = new Map<string, { value: string; expiresAtMs: number }>();
  let nowMs = startMs;

  function live(key: string) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  const handlers: TaskHandlers = {
    "kv.lock": ({ key, token, ttlSeconds }) => {
      if (live(key)) return { acquired: false };
      store.set(key, { value: token, expiresAtMs: nowMs + ttlSeconds * 1000 });
      return { acquired: true };
    },
    "kv.unlock": ({ key, token }) => {
      const entry = live(key);
      if (!entry || entry.value !== token) return { released: false };
      store.delete(key);
      return { released: true };
    },
    "kv.get": ({ key }) => ({ value: live(key)?.value ?? null }),
    "kv.set": ({ key, value, ttlSeconds }) => {
      const expiresAtMs = ttlSeconds ? nowMs + ttlSeconds * 1000 : Number.POSITIVE_INFINITY;
      store.set(key, { value, expiresAtMs });
      return { ok: true };
    },
  };

  return {
    handlers,
    at(iso: string) {
      nowMs = Date.parse(iso);
    },
    keys() {
      return [...store.keys()].sort();
    },
  };
}

/** A run against a shared Key Value, recording the Slack posts it made. */
function runAt(kv: ReturnType<typeof kvStore>, posts: PublishedPost[], slackLog: string[][]) {
  kv.handlers["typefully.listPublished"] = () => ({ posts });
  kv.handlers["amplifier.postNote"] = (input) => {
    slackLog.push([String(input.markdown)]);
    return { delivered: true };
  };
  return runCtx(kv.handlers);
}

describe("checkPostsImpl across two runs with one Key Value", () => {
  it("announces a post once across two runs in the same window", async () => {
    const kv = kvStore(Date.parse("2026-09-04T15:45:00Z"));
    const slack: string[][] = [];
    const posts = [post("A", "2026-09-04T15:30:00Z", ["x"])];

    kv.at("2026-09-04T15:45:00Z");
    const run1 = await checkPostsImpl(runAt(kv, posts, slack).ctx, {
      ...BASE,
      now: "2026-09-04T15:45:00Z",
    });

    kv.at("2026-09-04T16:15:00Z");
    const run2 = await checkPostsImpl(runAt(kv, posts, slack).ctx, {
      ...BASE,
      now: "2026-09-04T16:15:00Z",
    });

    expect(run1.notified).toBe(1);
    expect(run2.notified).toBe(0);
    expect(run2.skipped).toBe(1);
    expect(slack).toHaveLength(1);
  });

  it("announces a draft that joins an already-announced group", async () => {
    const kv = kvStore(Date.parse("2026-09-04T15:45:00Z"));
    const slack: string[][] = [];
    const a = post("A", "2026-09-04T15:30:00Z", ["x"]);
    const b = post("B", "2026-09-04T15:35:00Z", ["linkedin"]);

    kv.at("2026-09-04T15:45:00Z");
    const run1 = await checkPostsImpl(runAt(kv, [a], slack).ctx, {
      ...BASE,
      now: "2026-09-04T15:45:00Z",
    });

    kv.at("2026-09-04T15:50:00Z");
    const run2 = await checkPostsImpl(runAt(kv, [a, b], slack).ctx, {
      ...BASE,
      now: "2026-09-04T15:50:00Z",
    });

    expect(run1.notes.map((n) => n.draftIds)).toEqual([["A"]]);
    expect(run2.notes.map((n) => n.draftIds)).toEqual([["B"]]);
    expect(slack).toHaveLength(2);
  });

  it("posts once when a second run's marker read precedes the first run's announce cycle", async () => {
    const kv = kvStore(Date.parse("2026-09-04T15:45:00Z"));
    const slack: string[][] = [];
    const posts = [post("A", "2026-09-04T15:30:00Z", ["x"])];

    // Run B reads the announced markers, finds none, and only then reaches its
    // first kv.lock. Run A does its whole announce cycle in that gap.
    let interleaved = false;
    const lockHandler = kv.handlers["kv.lock"];
    const handlers: TaskHandlers = {
      ...kv.handlers,
      "kv.lock": async (input: any) => {
        if (!interleaved) {
          interleaved = true;
          await checkPostsImpl(runAt(kv, posts, slack).ctx, {
            ...BASE,
            now: "2026-09-04T15:45:00Z",
          });
        }
        return lockHandler?.(input);
      },
    };
    handlers["typefully.listPublished"] = () => ({ posts });
    handlers["amplifier.postNote"] = (input: any) => {
      slack.push([String(input.markdown)]);
      return { delivered: true };
    };

    const runB = await checkPostsImpl(runCtx(handlers).ctx, {
      ...BASE,
      now: "2026-09-04T15:45:00Z",
    });

    expect(slack).toHaveLength(1);
    expect(runB.notified).toBe(0);
    expect(runB.skipped).toBe(1);
  });

  it("retries after a run crashes between the lock and the Slack post", async () => {
    const kv = kvStore(Date.parse("2026-09-04T15:45:00Z"));
    const slack: string[][] = [];
    const posts = [post("A", "2026-09-04T15:30:00Z", ["x"])];

    kv.at("2026-09-04T15:45:00Z");
    const crashing = runCtx({
      ...kv.handlers,
      "typefully.listPublished": () => ({ posts }),
      "amplifier.postNote": () => {
        throw new Error("instance died");
      },
      // A crash leaves the in-flight lock behind, so no unlock runs.
      "kv.unlock": () => ({ released: false }),
    });
    await expect(check(crashing.ctx, { ...BASE, now: "2026-09-04T15:45:00Z" })).rejects.toThrow(
      "instance died",
    );

    kv.at("2026-09-04T16:15:00Z");
    const run2 = await checkPostsImpl(runAt(kv, posts, slack).ctx, {
      ...BASE,
      now: "2026-09-04T16:15:00Z",
    });

    expect(run2.notified).toBe(1);
    expect(slack).toHaveLength(1);
  });
  it("leads the note with the summary", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x", "linkedin"])],
      }),
    });

    const result = await check(ctx, BASE);

    const md = calls.find((c) => c.name === "amplifier.postNote")?.input.markdown ?? "";
    expect(md.startsWith("Something shipped. Please amplify!")).toBe(true);
    expect(result.notes[0]?.summarized).toBe(true);
  });

  it("summarizes before it claims the group", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await check(ctx, BASE);

    const names = calls.map((c) => c.name);
    expect(names.indexOf("llm.complete")).toBeLessThan(names.indexOf("kv.lock"));
  });

  it("passes the configured model through", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await check(ctx, { ...BASE, summaryModel: "anthropic/claude-haiku-4-5" });

    expect(calls.find((c) => c.name === "llm.complete")?.input.model).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("still posts, with the reason, when the summary fails", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "llm.complete": () => {
        throw new Error("401 invalid x-api-key");
      },
    });

    const result = await check(ctx, BASE);

    const md = calls.find((c) => c.name === "amplifier.postNote")?.input.markdown ?? "";
    expect(md).toContain("_(Summarization LLM call failed: 401 invalid x-api-key)_");
    expect(md).toContain("> preview 1");
    expect(result.notified).toBe(1);
    expect(result.notes[0]?.summarized).toBe(false);
  });

  it("summarizes in a dry run so the logged note is the real one", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await check(ctx, { ...BASE, dryRun: true });

    expect(calls.filter((c) => c.name === "llm.complete")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "amplifier.postNote")).toHaveLength(0);
  });

  it("summarizes once per note, not once per draft", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [
          post("1", "2026-09-04T15:30:00Z", ["x"]),
          post("2", "2026-09-04T15:33:00Z", ["linkedin"]),
        ],
      }),
    });

    await check(ctx, { ...BASE, groupWindowMinutes: 10 });

    expect(calls.filter((c) => c.name === "llm.complete")).toHaveLength(1);
  });
});
