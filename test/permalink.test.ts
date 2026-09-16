import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { callSlack } from "../src/slack/api.js";
import { messageLinkImpl } from "../src/slack/permalink.js";
import { fakeFetch, withFetch } from "./support/slackFetch.js";

const ENV = { SLACK_BOT_TOKEN: "xoxb-test" };
const NOTE = { channel: "C_NOTE", messageTs: "17580000.001" };
const PERMALINK = "https://renderinc.slack.com/archives/C_NOTE/p17580000001";

describe("messageLinkImpl", () => {
  it("returns the permalink to a message", async () => {
    const result = await withFetch(fakeFetch({ ok: true, permalink: PERMALINK }), () =>
      messageLinkImpl(fakeCtx(), NOTE, ENV),
    );
    expect(result).toEqual({ url: PERMALINK });
  });

  it("returns message_not_found rather than throwing, so the run sends no DM", async () => {
    const result = await withFetch(fakeFetch({ ok: false, error: "message_not_found" }), () =>
      messageLinkImpl(fakeCtx(), NOTE, ENV),
    );
    expect(result).toEqual({ error: "message_not_found" });
  });

  it("names an empty channel or ts instead of calling Slack", async () => {
    const fetchImpl = fakeFetch({ ok: true });
    await withFetch(fetchImpl, async () => {
      expect(await messageLinkImpl(fakeCtx(), { ...NOTE, channel: " " }, ENV)).toEqual({
        error: "no_channel",
      });
      expect(await messageLinkImpl(fakeCtx(), { ...NOTE, messageTs: "" }, ENV)).toEqual({
        error: "no_message_ts",
      });
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a transport failure, so the durable retry fires", async () => {
    await expect(
      withFetch(fakeFetch({ error: "gateway" }, false, 502), () =>
        messageLinkImpl(fakeCtx(), NOTE, ENV),
      ),
    ).rejects.toThrow(/answered 502/);
  });

  it("form-encodes the call, the way callSlack sends every Web API body", async () => {
    const fetchImpl = fakeFetch({ ok: true, permalink: PERMALINK });

    await callSlack(
      "chat.getPermalink",
      { channel: NOTE.channel, message_ts: NOTE.messageTs },
      { env: ENV, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://slack.com/api/chat.getPermalink", {
      method: "POST",
      headers: {
        authorization: "Bearer xoxb-test",
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: "channel=C_NOTE&message_ts=17580000.001",
    });
  });
});
