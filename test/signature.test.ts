import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isFresh, timingSafeEquals } from "../src/http/signature.js";
import { parseRepostClick, verifySlackSignature } from "../src/slack/interactivity.js";
import { REPOST_ACTION_ID } from "../src/amplifier/template.js";

const SECRET = "slack-signing-secret";
const NOW_MS = Date.parse("2026-09-11T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const RAW_BODY = "payload=%7B%22ok%22%3Atrue%7D";

/** Headers Slack would send for `rawBody`, signed with `secret`. */
function signed(rawBody: string, secret: string, timestamp = TIMESTAMP) {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${digest}` };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("timingSafeEquals", () => {
  it("matches equal strings", () => {
    expect(timingSafeEquals("abc", "abc")).toBe(true);
  });

  it("rejects different strings of the same length", () => {
    expect(timingSafeEquals("abc", "abd")).toBe(false);
  });

  it("rejects strings of different lengths without throwing", () => {
    expect(timingSafeEquals("abc", "abcd")).toBe(false);
  });
});

describe("isFresh", () => {
  it("accepts a timestamp inside the window", () => {
    expect(isFresh("Slack", TIMESTAMP, NOW_MS + 60_000, 5 * 60_000)).toBe(true);
  });

  it("rejects a timestamp past the window", () => {
    expect(isFresh("Slack", TIMESTAMP, NOW_MS + 6 * 60_000, 5 * 60_000)).toBe(false);
  });

  it("rejects a clock ahead by more than the window, the same as one behind", () => {
    expect(isFresh("Slack", TIMESTAMP, NOW_MS - 6 * 60_000, 5 * 60_000)).toBe(false);
  });

  it("rejects a timestamp that is not Unix seconds", () => {
    expect(isFresh("Slack", "2026-09-11T12:00:00Z", NOW_MS, 5 * 60_000)).toBe(false);
  });

  it("uses the window the caller passes, so Typefully gets 15 minutes", () => {
    expect(isFresh("Typefully", TIMESTAMP, NOW_MS + 10 * 60_000, 15 * 60_000)).toBe(true);
    expect(isFresh("Typefully", TIMESTAMP, NOW_MS + 10 * 60_000, 5 * 60_000)).toBe(false);
  });
});

describe("verifySlackSignature", () => {
  it("accepts a request Slack signed", () => {
    expect(verifySlackSignature(signed(RAW_BODY, SECRET), RAW_BODY, SECRET, NOW_MS)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifySlackSignature(signed(RAW_BODY, "wrong"), RAW_BODY, SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a body that changed after signing", () => {
    const headers = signed(RAW_BODY, SECRET);
    expect(verifySlackSignature(headers, `${RAW_BODY}&extra=1`, SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    const headers = signed(RAW_BODY, SECRET);
    expect(verifySlackSignature(headers, RAW_BODY, SECRET, NOW_MS + 6 * 60_000)).toBe(false);
  });

  it("rejects a replay whose timestamp was re-signed outside the window", () => {
    const old = String(Math.floor(NOW_MS / 1000) - 600);
    const headers = signed(RAW_BODY, SECRET, old);
    expect(verifySlackSignature(headers, RAW_BODY, SECRET, NOW_MS)).toBe(false);
  });

  it("rejects everything when the secret is unset", () => {
    expect(verifySlackSignature(signed(RAW_BODY, SECRET), RAW_BODY, undefined, NOW_MS)).toBe(false);
  });

  it("rejects a request with no signature headers", () => {
    expect(verifySlackSignature({}, RAW_BODY, SECRET, NOW_MS)).toBe(false);
  });
});

describe("parseRepostClick", () => {
  const payload = {
    actions: [{ action_id: REPOST_ACTION_ID, value: "amplifier:note:1" }],
    channel: { id: "C1" },
    message: { ts: "17580000.001" },
    user: { id: "U9" },
    response_url: "https://hooks.slack.com/actions/T/1/2",
  };

  it("reads the click the repost task needs", () => {
    expect(parseRepostClick(payload)).toEqual({
      channel: "C1",
      messageTs: "17580000.001",
      userId: "U9",
      noteKey: "amplifier:note:1",
      responseUrl: "https://hooks.slack.com/actions/T/1/2",
    });
  });

  it("ignores another action added to the app later", () => {
    const other = { ...payload, actions: [{ action_id: "something_else", value: "x" }] };
    expect(parseRepostClick(other)).toBeNull();
  });

  it("ignores a payload with no actions", () => {
    expect(parseRepostClick({ ...payload, actions: [] })).toBeNull();
  });

  it("ignores a click missing the note key", () => {
    const noValue = { ...payload, actions: [{ action_id: REPOST_ACTION_ID }] };
    expect(parseRepostClick(noValue)).toBeNull();
  });

  it("ignores a click missing the response_url", () => {
    const { response_url: _dropped, ...rest } = payload;
    expect(parseRepostClick(rest)).toBeNull();
  });

  it("ignores a non-object payload", () => {
    expect(parseRepostClick("nope")).toBeNull();
    expect(parseRepostClick(null)).toBeNull();
  });
});
