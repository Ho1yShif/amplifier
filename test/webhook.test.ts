import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { typefullyWebhook } from "../src/typefully/webhook.js";

const SECRET = "whsec_test";
const NOW = new Date("2026-09-10T18:00:00.000Z");
/** Unix seconds for NOW, so a delivery signed with it is inside the replay window. */
const TIMESTAMP = String(NOW.getTime() / 1000);

/** Unix seconds `minutes` before NOW. */
function minutesAgo(minutes: number): string {
  return String(NOW.getTime() / 1000 - minutes * 60);
}

/** A real draft.published body, captured from a Typefully delivery. */
const PUBLISHED_BODY = readFileSync(
  new URL("./support/typefully-event.json", import.meta.url),
  "utf8",
);
const PUBLISHED_DRAFT_ID = String(JSON.parse(PUBLISHED_BODY).data.id);

/** The same envelope carrying a different event type. */
function bodyFor(event: string): string {
  return JSON.stringify({ ...JSON.parse(PUBLISHED_BODY), event });
}

function sign(rawBody: string, secret = SECRET, timestamp = TIMESTAMP): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

function request(rawBody: string, signature = sign(rawBody), timestamp = TIMESTAMP) {
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-typefully-event": JSON.parse(rawBody).event,
      "x-typefully-timestamp": timestamp,
      "x-typefully-signature": signature,
    },
  };
}

function adapter(env: NodeJS.ProcessEnv = { TYPEFULLY_WEBHOOK_SECRET: SECRET }) {
  return typefullyWebhook({ env, now: () => NOW });
}

describe("typefullyWebhook.verify", () => {
  it("accepts a delivery signed with the configured secret", () => {
    expect(adapter().verify(request(PUBLISHED_BODY))).toBe(true);
  });

  it("rejects a signature computed with another secret", () => {
    const req = request(PUBLISHED_BODY, sign(PUBLISHED_BODY, "whsec_other"));
    expect(adapter().verify(req)).toBe(false);
  });

  it("rejects a body that was changed after signing", () => {
    const req = request(PUBLISHED_BODY);
    expect(adapter().verify({ ...req, rawBody: `${PUBLISHED_BODY} ` })).toBe(false);
  });

  it("rejects a signature bound to another timestamp", () => {
    const req = request(PUBLISHED_BODY, sign(PUBLISHED_BODY, SECRET, minutesAgo(1)));
    expect(adapter().verify(req)).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    expect(adapter().verify(request(PUBLISHED_BODY, "sha256=deadbeef"))).toBe(false);
  });

  it("rejects a delivery with no signature header", () => {
    const { headers, rawBody } = request(PUBLISHED_BODY);
    delete (headers as Record<string, string>)["x-typefully-signature"];
    expect(adapter().verify({ headers, rawBody })).toBe(false);
  });

  it("rejects a delivery with no timestamp header", () => {
    const { headers, rawBody } = request(PUBLISHED_BODY);
    delete (headers as Record<string, string>)["x-typefully-timestamp"];
    expect(adapter().verify({ headers, rawBody })).toBe(false);
  });

  it("rejects every delivery when the secret is unset", () => {
    expect(adapter({}).verify(request(PUBLISHED_BODY))).toBe(false);
  });

  it("accepts a signed delivery inside the replay window", () => {
    const stamp = minutesAgo(14);
    const req = request(PUBLISHED_BODY, sign(PUBLISHED_BODY, SECRET, stamp), stamp);
    expect(adapter().verify(req)).toBe(true);
  });

  it("rejects a signed delivery older than the replay window", () => {
    const stamp = minutesAgo(16);
    const req = request(PUBLISHED_BODY, sign(PUBLISHED_BODY, SECRET, stamp), stamp);
    expect(adapter().verify(req)).toBe(false);
  });

  it("rejects a signed delivery dated past the replay window", () => {
    const stamp = minutesAgo(-16);
    const req = request(PUBLISHED_BODY, sign(PUBLISHED_BODY, SECRET, stamp), stamp);
    expect(adapter().verify(req)).toBe(false);
  });

  it("rejects a timestamp that is not Unix seconds", () => {
    const stamp = "2026-09-10T18:00:00.000Z";
    const req = request(PUBLISHED_BODY, sign(PUBLISHED_BODY, SECRET, stamp), stamp);
    expect(adapter().verify(req)).toBe(false);
  });
});

describe("typefullyWebhook.map", () => {
  it("dispatches amplifier.handleEvent for a published draft", () => {
    expect(adapter().map({ headers: {}, body: JSON.parse(PUBLISHED_BODY) })).toEqual({
      task: "amplifier.handleEvent",
      args: [{ draftId: PUBLISHED_DRAFT_ID, eventAt: "2026-09-10T18:00:00.000Z" }],
    });
  });

  const ignored = [
    "draft.created",
    "draft.planned",
    "draft.scheduled",
    "draft.status_changed",
    "draft.tags_changed",
    "draft.deleted",
    "draft.unheard_of",
  ];

  it.each(ignored)("ignores %s", (event) => {
    expect(adapter().map({ headers: {}, body: JSON.parse(bodyFor(event)) })).toBeNull();
  });

  it("omits draftId when the payload carries no id", () => {
    const body = JSON.parse(PUBLISHED_BODY);
    delete body.data.id;
    expect(adapter().map({ headers: {}, body })).toEqual({
      task: "amplifier.handleEvent",
      args: [{ eventAt: "2026-09-10T18:00:00.000Z" }],
    });
  });

  it("ignores a body that is not the expected shape", () => {
    expect(adapter().map({ headers: {}, body: "draft.published" })).toBeNull();
    expect(adapter().map({ headers: {}, body: null })).toBeNull();
    expect(adapter().map({ headers: {}, body: { event: 7 } })).toBeNull();
  });

  it("rescans the window for a published event whose data is missing", () => {
    expect(adapter().map({ headers: {}, body: { event: "draft.published" } })).toEqual({
      task: "amplifier.handleEvent",
      args: [{ eventAt: "2026-09-10T18:00:00.000Z" }],
    });
  });
});
