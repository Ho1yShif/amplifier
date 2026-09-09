import { describe, expect, it, vi } from "vitest";
import { postNoteImpl } from "../src/slack/postNote.js";
import { taskCtx } from "./support/taskCtx.js";

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

/** Stub global fetch, recording every request the Slack ports make. */
function captureFetch(json: unknown): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init: { body: string },
  ) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      text: async () => "ok",
      json: async () => json,
    };
  }) as unknown as typeof fetch);
  return { sent, restore: () => spy.mockRestore() };
}

describe("postNoteImpl", () => {
  const message = { text: "Origin is a supported Git provider.", markdown: "line\n\nlink" };

  it("turns off unfurling on chat.postMessage", async () => {
    const { sent, restore } = captureFetch({ ok: true, channel: "C1", ts: "1.1" });
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

  it("turns off unfurling on the incoming webhook", async () => {
    const { sent, restore } = captureFetch({});
    try {
      const { ctx } = taskCtx({});
      const result = await postNoteImpl(ctx, message, {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/X",
      });
      expect(result.delivered).toBe(true);
      expect(sent[0]?.url).toBe("https://hooks.slack.com/services/T/B/X");
      expect(sent[0]?.body).toMatchObject({ unfurl_links: false, unfurl_media: false });
    } finally {
      restore();
    }
  });

  it("keeps the blocks the template built", async () => {
    const { sent, restore } = captureFetch({ ok: true, channel: "C1", ts: "1.1" });
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

  it("falls back to the console with no token and no webhook", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { restore } = captureFetch({});
    try {
      const { ctx } = taskCtx({});
      expect(await postNoteImpl(ctx, message, {})).toEqual({ delivered: false });
    } finally {
      restore();
      log.mockRestore();
    }
  });
});
