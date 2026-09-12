import { describe, expect, it, vi } from "vitest";
import { announceGroups } from "../src/amplifier/announce.js";
import { loadConfig } from "../src/config.js";
import { noteKey, type StoredNote } from "../src/amplifier/storedNote.js";
import { groupPosts } from "../src/amplifier/group.js";
import { post } from "./support/fixtures.js";
import { taskCtx, type TaskCall, type TaskHandlers } from "./support/taskCtx.js";

const AT = "2026-09-04T15:00:00Z";

/** The announce path with every task stubbed: a summary, locks, and a delivered post. */
function handlers(overrides: TaskHandlers = {}): TaskHandlers {
  let ts = 0;
  return {
    "llm.complete": () => ({ text: "Cold starts are 40% faster.", stopReason: "end_turn" }),
    "kv.get": () => ({ value: null }),
    "kv.set": () => ({ ok: true }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "amplifier.postNote": () => ({
      delivered: true,
      channel: "C1",
      ts: `17580000.00${(ts += 1)}`,
    }),
    ...overrides,
  };
}

/** Every `amplifier.postNote` input, in the order announce dispatched it. */
function posted(calls: TaskCall[]) {
  return calls.filter((c) => c.name === "amplifier.postNote").map((c) => c.input);
}

const env = { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "#amplify" };
const crossPost = groupPosts([post("1", AT, ["linkedin", "x"])], 0);
const singlePost = groupPosts([post("2", AT, ["x"])], 0);

describe("announceGroups, cross-posted", () => {
  it("posts a parent and one reply per platform, in display order", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    const sent = posted(calls);
    expect(sent).toHaveLength(3);
    expect(sent[0]?.blocks).toBeDefined();
    expect(sent[1]?.markdown).toContain("|LinkedIn post>");
    expect(sent[2]?.markdown).toContain("|X post>");
  });

  it("replies in the parent's thread", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    const sent = posted(calls);
    const parentTs = "17580000.001";
    expect(sent[0]).not.toHaveProperty("threadTs");
    expect(sent[1]?.threadTs).toBe(parentTs);
    expect(sent[2]?.threadTs).toBe(parentTs);
  });

  it("reports the parent's ts as the note's threadTs", async () => {
    const { ctx } = taskCtx(handlers());
    const { notes } = await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");
    expect(notes[0]).toMatchObject({ delivered: true, threadTs: "17580000.001" });
  });

  it("marks the drafts announced as soon as the parent is delivered", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    const names = calls.map((c) => c.name);
    const marked = calls.findIndex(
      (c) => c.name === "kv.set" && c.input.key === "amplifier:seen:1",
    );
    const firstReply = names.indexOf("amplifier.postNote", names.indexOf("amplifier.postNote") + 1);
    expect(marked).toBeGreaterThan(-1);
    expect(marked).toBeLessThan(firstReply);
  });

  it("keeps the drafts announced when a reply fails", async () => {
    let n = 0;
    const { ctx, calls } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          n += 1;
          if (n === 1) return { delivered: true, channel: "C1", ts: "17580000.001" };
          throw new Error("Slack API chat.postMessage error: ratelimited");
        },
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { notes } = await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");
      expect(notes[0]?.delivered).toBe(true);
      expect(calls.some((c) => c.name === "kv.set" && c.input.key === "amplifier:seen:1")).toBe(
        true,
      );
    } finally {
      error.mockRestore();
    }
  });
});

describe("announceGroups, the stored note", () => {
  const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };

  it("stores the parent and the replies under the group's key", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, withRepost), "run-1");

    const stored = calls.find((c) => c.name === "kv.set" && c.input.key === noteKey(["1"]));
    expect(stored).toBeDefined();
    const note = JSON.parse(stored?.input.value as string) as StoredNote;
    expect(note.replies.map((r) => r.markdown)).toEqual([
      "<https://example.com/linkedin/1|LinkedIn post>",
      "<https://example.com/x/1|X post>",
    ]);
    expect(note.parent.blocks?.some((b) => b["type"] === "actions")).toBe(true);
  });

  it("carries the seen TTL, so the record and the marker expire together", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const config = loadConfig({}, withRepost);
    await announceGroups(ctx, crossPost, config, "run-1");

    const stored = calls.find((c) => c.name === "kv.set" && c.input.key === noteKey(["1"]));
    expect(stored?.input.ttlSeconds).toBe(config.seenTtlSeconds);
  });

  it("puts the button on the parent, holding the note's key", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, withRepost), "run-1");

    const actions = posted(calls)[0]?.blocks?.find(
      (b: Record<string, unknown>) => b["type"] === "actions",
    );
    expect(actions.elements[0].value).toBe(noteKey(["1"]));
    expect(actions.elements[0].text.text).toBe("Repost to #amplify-wider");
  });

  it("stores nothing and adds no button without a repost channel", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    expect(calls.some((c) => c.name === "kv.set" && c.input.key === noteKey(["1"]))).toBe(false);
    expect(
      posted(calls)[0]?.blocks?.some((b: Record<string, unknown>) => b["type"] === "actions"),
    ).toBe(false);
  });
});

describe("announceGroups, one link", () => {
  it("posts one flat message and no reply", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, singlePost, loadConfig({}, env), "run-1");

    const sent = posted(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.markdown).toContain("|X post>");
    expect(sent[0]?.markdown).not.toContain("🧵");
  });

  it("stores no note, because a flat message has nothing to repost as a thread", async () => {
    const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, singlePost, loadConfig({}, withRepost), "run-1");
    expect(calls.some((c) => c.name === "kv.set" && c.input.key === noteKey(["2"]))).toBe(false);
  });
});

describe("announceGroups, dry run", () => {
  it("logs the parent and every reply in order and posts nothing", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await announceGroups(ctx, crossPost, loadConfig({ dryRun: true }, env), "run-1");
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toContain("would post:");
      expect(lines[0]).toContain("🧵");
      expect(lines[1]).toContain("|LinkedIn post>");
      expect(lines[2]).toContain("|X post>");
      expect(posted(calls)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("writes nothing to Key Value", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };
      await announceGroups(ctx, crossPost, loadConfig({ dryRun: true }, withRepost), "run-1");
      expect(calls.some((c) => c.name === "kv.set")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
