import { describe, expect, it, vi } from "vitest";
import {
  remindedKey,
  remindRepostImpl,
  repostedKey,
  type RemindRepostInput,
} from "../src/amplifier/remindRepost.js";
import { CHANNEL_PLACEHOLDER } from "../src/amplifier/remindTemplate.js";
import { REPOST_ACTION_ID } from "../src/amplifier/template.js";
import { kvStore } from "./support/kvStore.js";
import { runCtx } from "./support/handlers.js";
import type { TaskCall, TaskHandlers } from "./support/taskCtx.js";

const AT = "2026-09-04T15:00:00Z";
const NOW_MS = Date.parse(AT);

const env = {
  SLACK_BOT_TOKEN: "xoxb",
  SLACK_CHANNEL: "amplify",
  AMPLIFIER_REPOST_CHANNEL: "amplify-wider",
};

const input: RemindRepostInput = {
  channel: "C_NOTE",
  messageTs: "17580000.001",
  dueAtMs: NOW_MS + 30 * 60_000,
  noteKey: "amplifier:note:1",
};

/** A context over a shared fake Key Value, plus the sleeps the run asked for. */
function remindCtx(overrides: TaskHandlers = {}) {
  const kv = kvStore(AT);
  const { ctx, calls } = runCtx({ ...kv.handlers, ...overrides });
  const slept: number[] = [];
  return {
    ctx,
    calls,
    kv,
    slept,
    deps: {
      now: () => NOW_MS,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
}

/** Every `amplifier.postNote` input, in the order the run dispatched it. */
function posted(calls: TaskCall[]) {
  return calls.filter((c) => c.name === "amplifier.postNote").map((c) => c.input);
}

describe("keys", () => {
  it("namespaces both markers by channel and ts", () => {
    expect(repostedKey("C1", "1.1")).toBe("amplifier:reposted:C1:1.1");
    expect(remindedKey("C1", "1.1")).toBe("amplifier:reminded:C1:1.1");
  });
});

describe("remindRepostImpl, the delay", () => {
  it("sleeps until dueAtMs", async () => {
    const { ctx, slept, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);
    expect(slept).toEqual([30 * 60_000]);
  });

  it("sleeps zero when dueAtMs has passed, so a resumed attempt posts at once", async () => {
    const { ctx, calls, slept, deps } = remindCtx();
    await remindRepostImpl(ctx, { ...input, dueAtMs: NOW_MS - 60_000 }, env, deps);
    expect(slept).toEqual([0]);
    expect(posted(calls)).toHaveLength(1);
  });
});

describe("remindRepostImpl, an un-reposted note", () => {
  it("posts one broadcast reply in the note's thread", async () => {
    const { ctx, calls, deps } = remindCtx();
    const result = await remindRepostImpl(ctx, input, env, deps);

    expect(result).toEqual({ reminded: true });
    const sent = posted(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: "C_NOTE",
      threadTs: "17580000.001",
      broadcast: true,
    });
  });

  it("names the repost channel in place of the placeholder", async () => {
    const { ctx, calls, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);

    const section = posted(calls)[0]?.blocks?.[0];
    expect(section.text.text).toContain("#amplify-wider");
    expect(section.text.text).not.toContain(CHANNEL_PLACEHOLDER);
  });

  it("carries its own Repost button, holding the note's key", async () => {
    const { ctx, calls, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);

    const actions = posted(calls)[0]?.blocks?.find(
      (b: Record<string, unknown>) => b["type"] === "actions",
    );
    expect(actions.elements[0].action_id).toBe(REPOST_ACTION_ID);
    expect(actions.elements[0].value).toBe("amplifier:note:1");
    expect(actions.elements[0].text.text).toBe("Repost to #amplify-wider");
  });

  it("writes the reminded marker before it posts, so a second run posts nothing", async () => {
    const { ctx, calls, kv, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);

    const names = calls.map((c) => c.name);
    const marked = calls.findIndex(
      (c) => c.name === "kv.set" && c.input.key === remindedKey("C_NOTE", "17580000.001"),
    );
    expect(marked).toBeGreaterThan(-1);
    expect(marked).toBeLessThan(names.indexOf("amplifier.postNote"));
    expect(kv.keys()).toContain(remindedKey("C_NOTE", "17580000.001"));
  });
});

describe("remindRepostImpl, a note that needs no reminder", () => {
  it("posts nothing when the reposted marker is set", async () => {
    const { ctx, calls, deps } = remindCtx({
      "kv.get": ({ key }) => ({
        value: key === repostedKey("C_NOTE", "17580000.001") ? "reposted" : null,
      }),
    });
    const result = await remindRepostImpl(ctx, input, env, deps);

    expect(result).toEqual({ reminded: false, reason: "reposted" });
    expect(posted(calls)).toHaveLength(0);
  });

  it("posts nothing when the reminded marker is set", async () => {
    const { ctx, calls, deps } = remindCtx({
      "kv.get": ({ key }) => ({
        value: key === remindedKey("C_NOTE", "17580000.001") ? "reminded" : null,
      }),
    });
    const result = await remindRepostImpl(ctx, input, env, deps);

    expect(result).toEqual({ reminded: false, reason: "already-reminded" });
    expect(posted(calls)).toHaveLength(0);
  });

  it("posts nothing without a repost channel, and does not even sleep", async () => {
    const { ctx, calls, slept, deps } = remindCtx();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await remindRepostImpl(
        ctx,
        input,
        { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "amplify" },
        deps,
      );
      expect(result).toEqual({ reminded: false, reason: "no-repost-channel" });
      expect(slept).toEqual([]);
      expect(posted(calls)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });
});

describe("remindRepostImpl, dry run", () => {
  it("logs the reminder and writes nothing", async () => {
    const { ctx, calls, deps } = remindCtx();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await remindRepostImpl(ctx, input, { ...env, DRY_RUN: "true" }, deps);
      expect(result).toEqual({ reminded: false });
      expect(String(log.mock.calls[0]?.[0])).toContain("would remind:");
      expect(posted(calls)).toHaveLength(0);
      expect(calls.some((c) => c.name === "kv.set")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
