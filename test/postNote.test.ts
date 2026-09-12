import { describe, expect, it, vi } from "vitest";
import { postNoteImpl } from "../src/slack/postNote.js";
import { taskCtx } from "./support/taskCtx.js";

interface Sent {
  url: string;
  authorization?: string;
  body: Record<string, unknown>;
}

/** Stub global fetch, recording every request the Slack port makes. */
function captureFetch(json: unknown): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init: { body: string; headers: Record<string, string> },
  ) => {
    sent.push({
      url: String(url),
      ...(init.headers.authorization ? { authorization: init.headers.authorization } : {}),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return { ok: true, status: 200, text: async () => "ok", json: async () => json };
  }) as unknown as typeof fetch);
  return { sent, restore: () => spy.mockRestore() };
}

const OK = { ok: true, channel: "C1", ts: "1.1" };

describe("postNoteImpl", () => {
  const message = { text: "Origin is a supported Git provider.", markdown: "line\n\nlink" };

  it("turns off unfurling on chat.postMessage", async () => {
    const { sent, restore } = captureFetch(OK);
    try {
      const { ctx } = taskCtx({});
      const result = await postNoteImpl(
        ctx,
        { ...message, channel: "#social" },
        { SLACK_BOT_TOKEN: "xoxb-test" },
      );
      expect(result).toEqual({ delivered: true, channel: "C1", ts: "1.1" });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe("https://slack.com/api/chat.postMessage");
      expect(sent[0]?.body).toMatchObject({
        channel: "#social",
        unfurl_links: false,
        unfurl_media: false,
      });
    } finally {
      restore();
    }
  });

  it("keeps the blocks the template built", async () => {
    const { sent, restore } = captureFetch(OK);
    try {
      const { ctx } = taskCtx({});
      await postNoteImpl(ctx, { ...message, channel: "#social" }, { SLACK_BOT_TOKEN: "xoxb-test" });
      expect(sent[0]?.body["blocks"]).toEqual([
        { type: "section", text: { type: "mrkdwn", text: "line\n\nlink" } },
      ]);
    } finally {
      restore();
    }
  });

  it("adds thread_ts alongside the unfurl fields", async () => {
    const { sent, restore } = captureFetch(OK);
    try {
      const { ctx } = taskCtx({});
      await postNoteImpl(
        ctx,
        { ...message, channel: "#social", threadTs: "1758000000.000100" },
        { SLACK_BOT_TOKEN: "xoxb-test" },
      );
      expect(sent[0]?.body).toMatchObject({
        thread_ts: "1758000000.000100",
        unfurl_links: false,
        unfurl_media: false,
      });
    } finally {
      restore();
    }
  });

  it("sends no thread_ts when the message is not a reply", async () => {
    const { sent, restore } = captureFetch(OK);
    try {
      const { ctx } = taskCtx({});
      await postNoteImpl(ctx, { ...message, channel: "#social" }, { SLACK_BOT_TOKEN: "xoxb-test" });
      expect(sent[0]?.body).not.toHaveProperty("thread_ts");
    } finally {
      restore();
    }
  });

  it("authorizes with the user token when one is given", async () => {
    const { sent, restore } = captureFetch(OK);
    try {
      const { ctx } = taskCtx({});
      await postNoteImpl(
        ctx,
        { ...message, channel: "#social", userToken: "xoxp-person" },
        { SLACK_BOT_TOKEN: "xoxb-test" },
      );
      expect(sent[0]?.authorization).toBe("Bearer xoxp-person");
    } finally {
      restore();
    }
  });

  it("authorizes with the bot token when no user token is given", async () => {
    const { sent, restore } = captureFetch(OK);
    try {
      const { ctx } = taskCtx({});
      await postNoteImpl(ctx, { ...message, channel: "#social" }, { SLACK_BOT_TOKEN: "xoxb-test" });
      expect(sent[0]?.authorization).toBe("Bearer xoxb-test");
    } finally {
      restore();
    }
  });

  it("throws with no bot token", async () => {
    const { sent, restore } = captureFetch({});
    try {
      const { ctx } = taskCtx({});
      await expect(postNoteImpl(ctx, { ...message, channel: "#social" }, {})).rejects.toThrow(
        /Slack is not configured/,
      );
      expect(sent).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("throws with a bot token and no channel", async () => {
    const { sent, restore } = captureFetch({});
    try {
      const { ctx } = taskCtx({});
      await expect(postNoteImpl(ctx, message, { SLACK_BOT_TOKEN: "xoxb-test" })).rejects.toThrow(
        /Slack is not configured/,
      );
      expect(sent).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("throws when only an incoming webhook is configured", async () => {
    const { sent, restore } = captureFetch({});
    try {
      const { ctx } = taskCtx({});
      await expect(
        postNoteImpl(
          ctx,
          { ...message, channel: "#social" },
          {
            SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
          },
        ),
      ).rejects.toThrow(/Slack is not configured/);
      expect(sent).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
