import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { callSlack } from "../src/slack/api.js";
import { lookupUserImpl, openDmImpl } from "../src/slack/lookupUser.js";
import { fakeFetch, withFetch } from "./support/slackFetch.js";

const ENV = { SLACK_BOT_TOKEN: "xoxb-test" };

describe("lookupUserImpl", () => {
  it("returns the Slack user id for an address", async () => {
    const body = { ok: true, user: { id: "U123", name: "dana" } };
    const result = await withFetch(fakeFetch(body), () =>
      lookupUserImpl(fakeCtx(), { email: "dana@render.com" }, ENV),
    );
    expect(result).toEqual({ userId: "U123" });
  });

  it("returns users_not_found rather than throwing, so the other owners still get DMs", async () => {
    const result = await withFetch(fakeFetch({ ok: false, error: "users_not_found" }), () =>
      lookupUserImpl(fakeCtx(), { email: "nobody@render.com" }, ENV),
    );
    expect(result).toEqual({ error: "users_not_found" });
  });

  it("returns missing_scope the same way", async () => {
    const result = await withFetch(fakeFetch({ ok: false, error: "missing_scope" }), () =>
      lookupUserImpl(fakeCtx(), { email: "dana@render.com" }, ENV),
    );
    expect(result).toEqual({ error: "missing_scope" });
  });

  it("names an empty address instead of calling Slack", async () => {
    const fetchImpl = fakeFetch({ ok: true });
    const result = await withFetch(fetchImpl, () => lookupUserImpl(fakeCtx(), { email: " " }, ENV));
    expect(result).toEqual({ error: "no_email" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a transport failure, so the durable retry fires", async () => {
    await expect(
      withFetch(fakeFetch({ error: "gateway" }, false, 502), () =>
        lookupUserImpl(fakeCtx(), { email: "dana@render.com" }, ENV),
      ),
    ).rejects.toThrow(/answered 502/);
  });
});

describe("openDmImpl", () => {
  it("returns the DM channel id", async () => {
    const body = { ok: true, channel: { id: "D123" } };
    const result = await withFetch(fakeFetch(body), () =>
      openDmImpl(fakeCtx(), { userId: "U123" }, ENV),
    );
    expect(result).toEqual({ channelId: "D123" });
  });

  it("returns the Slack error when the DM cannot be opened", async () => {
    const result = await withFetch(fakeFetch({ ok: false, error: "cannot_dm_bot" }), () =>
      openDmImpl(fakeCtx(), { userId: "U123" }, ENV),
    );
    expect(result).toEqual({ error: "cannot_dm_bot" });
  });
});

describe("callSlack", () => {
  it("sends the bot token and a form-encoded body, which is all users.lookupByEmail reads", async () => {
    const fetchImpl = fakeFetch({ ok: true });

    await callSlack("users.lookupByEmail", { email: "dana@render.com" }, { env: ENV, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("https://slack.com/api/users.lookupByEmail", {
      method: "POST",
      headers: {
        authorization: "Bearer xoxb-test",
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: "email=dana%40render.com",
    });
  });

  it("refuses a base URL that would send the bot token to another host", async () => {
    await expect(
      callSlack(
        "users.lookupByEmail",
        {},
        { env: { ...ENV, SLACK_API_BASE_URL: "https://evil.example" } },
      ),
    ).rejects.toThrow(/SLACK_BOT_TOKEN would be sent to evil.example/);
  });

  it("refuses to call Slack with no bot token", async () => {
    await expect(callSlack("users.lookupByEmail", {}, { env: {} })).rejects.toThrow(
      /SLACK_BOT_TOKEN is unset/,
    );
  });
});
