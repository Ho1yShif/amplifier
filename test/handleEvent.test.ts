import { describe, expect, it } from "vitest";
import { handleEvent } from "../src/amplifier/handleEvent.js";
import { StillPublishingError } from "../src/amplifier/settle.js";
import type { CheckPostsInput } from "../src/config.js";
import type { PublishedPost } from "../src/typefully/types.js";
import { post } from "./support/fixtures.js";
import { runCtx } from "./support/handlers.js";
import { kvStore } from "./support/kvStore.js";

const EVENT_AT = "2026-09-04T15:30:00Z";
const BASE = { dryRun: false, slackChannel: "social", eventAt: EVENT_AT, draftId: "1" };

/** The draft as Typefully reports it before and after X reports its permalink. */
const stillPublishing: PublishedPost[] = [post("1", EVENT_AT, ["linkedin"], { pending: ["x"] })];
const complete: PublishedPost[] = [post("1", EVENT_AT, ["linkedin", "x"])];

/**
 * A Key Value plus a Slack log, both shared across attempts, so a retry sees
 * the markers its predecessor wrote. The clock never moves, so nothing an
 * attempt wrote expires before the next one reads it.
 *
 * Parents and replies are logged separately, because a cross-post is one note
 * made of three messages and "how many notes went out" is what the tests check.
 */
function attempts() {
  const kv = kvStore(EVENT_AT);
  const slack: string[] = [];
  const replies: string[] = [];
  let ts = 0;

  function ctxFor(posts: PublishedPost[]) {
    return runCtx({
      ...kv.handlers,
      "typefully.listPublished": () => ({ posts }),
      "amplifier.postNote": (input) => {
        if (input.threadTs) {
          replies.push(String(input.markdown));
          return { delivered: true, ts: `17580000.00${(ts += 1)}` };
        }
        slack.push(String(input.markdown ?? input.blocks?.[0]?.text?.text));
        return { delivered: true, ts: `17580000.00${(ts += 1)}` };
      },
    }).ctx;
  }

  return {
    slack,
    replies,
    keys: kv.keys,
    run: (posts: PublishedPost[], input: CheckPostsInput) =>
      handleEvent.func(ctxFor(posts), { ...BASE, ...input }, {}),
  };
}

describe("amplifier.handleEvent", () => {
  it("throws on the first attempt, then announces once X reports its permalink", async () => {
    const a = attempts();

    await expect(a.run(stillPublishing, { now: "2026-09-04T15:30:05Z" })).rejects.toThrow(
      StillPublishingError,
    );
    expect(a.slack).toHaveLength(0);

    const second = await a.run(complete, { now: "2026-09-04T15:31:05Z" });

    expect(second.notified).toBe(1);
    expect(a.slack).toHaveLength(1);
    expect(a.slack[0]).toContain("🧵");
    expect(a.replies).toEqual([
      "<https://example.com/linkedin/1|LinkedIn post>",
      "<https://example.com/x/1|X post>",
    ]);
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
