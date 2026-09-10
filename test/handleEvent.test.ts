import { describe, expect, it } from "vitest";
import { handleEventImpl } from "../src/amplifier/handleEvent.js";
import { StillPublishingError } from "../src/amplifier/settle.js";
import type { CheckPostsInput } from "../src/config.js";
import type { PublishedPost } from "../src/typefully/types.js";
import { post } from "./support/fixtures.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const EVENT_AT = "2026-09-04T15:30:00Z";
const BASE = { dryRun: false, slackChannel: "#social", eventAt: EVENT_AT, draftId: "1" };

/** The draft as Typefully reports it before and after X reports its permalink. */
const stillPublishing: PublishedPost[] = [post("1", EVENT_AT, ["linkedin"], { pending: ["x"] })];
const complete: PublishedPost[] = [post("1", EVENT_AT, ["linkedin", "x"])];

/**
 * A Map-backed Key Value plus a Slack log, both shared across attempts, so a
 * retry sees the markers its predecessor wrote.
 */
function attempts() {
  const store = new Map<string, string>();
  const slack: string[] = [];

  function ctxFor(posts: PublishedPost[]) {
    const handlers: TaskHandlers = {
      "typefully.listPublished": () => ({ posts }),
      "kv.lock": ({ key, token }) => {
        if (store.has(key)) return { acquired: false };
        store.set(key, token);
        return { acquired: true };
      },
      "kv.unlock": ({ key }) => {
        store.delete(key);
        return { released: true };
      },
      "kv.get": ({ key }) => ({ value: store.get(key) ?? null }),
      "kv.set": ({ key, value }) => {
        store.set(key, value);
        return { ok: true };
      },
      "amplifier.postNote": (input) => {
        slack.push(String(input.markdown));
        return { delivered: true };
      },
      "llm.complete": () => ({ text: "Something shipped.", model: "m", stopReason: "end" }),
    };
    return taskCtx(handlers).ctx;
  }

  return {
    slack,
    keys: () => [...store.keys()].sort(),
    run: (posts: PublishedPost[], input: CheckPostsInput) =>
      handleEventImpl(ctxFor(posts), { ...BASE, ...input }, {}),
  };
}

describe("handleEventImpl", () => {
  it("throws on the first attempt, then announces once X reports its permalink", async () => {
    const a = attempts();

    await expect(a.run(stillPublishing, { now: "2026-09-04T15:30:05Z" })).rejects.toThrow(
      StillPublishingError,
    );
    expect(a.slack).toHaveLength(0);

    const second = await a.run(complete, { now: "2026-09-04T15:31:05Z" });

    expect(second.notified).toBe(1);
    expect(a.slack).toHaveLength(1);
    expect(a.slack[0]).toContain("|X post>");
  });

  it("announces nothing on a retry that follows a delivered post", async () => {
    const a = attempts();

    const first = await a.run(complete, { now: "2026-09-04T15:31:05Z" });
    const second = await a.run(complete, { now: "2026-09-04T15:32:05Z" });

    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(second.skipped).toBe(1);
    expect(a.slack).toHaveLength(1);
  });

  it("leaves no in-flight lock behind when it throws", async () => {
    const a = attempts();

    await expect(a.run(stillPublishing, { now: "2026-09-04T15:30:05Z" })).rejects.toThrow(
      StillPublishingError,
    );

    expect(a.keys()).toEqual([]);
  });
});
