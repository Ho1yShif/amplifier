import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { notionWebhook } from "../src/notion/webhook.js";

const SECRET = "secret_test";
const NOW = new Date("2026-09-10T18:00:00.000Z");

/** A page.properties_updated body, shaped from Notion's documented envelope. */
const EVENT_BODY = readFileSync(new URL("./support/notion-event.json", import.meta.url), "utf8");
const PAGE_ID = JSON.parse(EVENT_BODY).entity.id;

/** The handshake Notion posts once, unsigned, when the subscription is created. */
const HANDSHAKE_BODY = JSON.stringify({ verification_token: "secret_handshake_token" });

/** The same envelope carrying a different event type. */
function bodyFor(type: string): string {
  return JSON.stringify({ ...JSON.parse(EVENT_BODY), type });
}

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function request(rawBody: string, signature = sign(rawBody)) {
  return {
    rawBody,
    headers: { "content-type": "application/json", "x-notion-signature": signature },
  };
}

function adapter(env: NodeJS.ProcessEnv = { NOTION_WEBHOOK_SECRET: SECRET }) {
  return notionWebhook({ env, now: () => NOW });
}

describe("notionWebhook.verify", () => {
  it("accepts a delivery signed with the configured secret", () => {
    expect(adapter().verify(request(EVENT_BODY))).toBe(true);
  });

  it("rejects a signature computed with another secret", () => {
    expect(adapter().verify(request(EVENT_BODY, sign(EVENT_BODY, "secret_other")))).toBe(false);
  });

  it("rejects a body that was changed after signing", () => {
    const req = request(EVENT_BODY);
    expect(adapter().verify({ ...req, rawBody: `${EVENT_BODY} ` })).toBe(false);
  });

  it("rejects a signature of the wrong length", () => {
    expect(adapter().verify(request(EVENT_BODY, "sha256=deadbeef"))).toBe(false);
  });

  it("rejects a delivery with no signature header", () => {
    expect(adapter().verify({ rawBody: EVENT_BODY, headers: {} })).toBe(false);
  });

  it("rejects every delivery when the secret is unset", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(adapter({}).verify(request(EVENT_BODY))).toBe(false);
      expect(errors.mock.calls[0]?.[0]).toMatch(/NOTION_WEBHOOK_SECRET is unset/);
    } finally {
      errors.mockRestore();
    }
  });

  it("accepts the handshake and logs the token while the secret is unset", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(adapter({}).verify({ rawBody: HANDSHAKE_BODY, headers: {} })).toBe(true);
      expect(logs.mock.calls[0]?.[0]).toContain("secret_handshake_token");
    } finally {
      logs.mockRestore();
    }
  });

  it("rejects an unsigned handshake once the secret is set", () => {
    expect(adapter().verify({ rawBody: HANDSHAKE_BODY, headers: {} })).toBe(false);
  });

  it("rejects a body carrying a verification token next to event fields", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = JSON.stringify({ ...JSON.parse(EVENT_BODY), verification_token: "t" });
      expect(adapter({}).verify({ rawBody: body, headers: {} })).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("notionWebhook.map", () => {
  it("starts amplifier.pingOwners with the edited page id", () => {
    const dispatch = adapter().map({ body: JSON.parse(EVENT_BODY), headers: {} });
    expect(dispatch).toEqual({ task: "amplifier.pingOwners", args: [{ pageId: PAGE_ID }] });
  });

  it("ignores every event type but page.properties_updated", () => {
    const dispatch = adapter().map({ body: JSON.parse(bodyFor("page.created")), headers: {} });
    expect(dispatch).toBeNull();
  });

  it("ignores the handshake body", () => {
    const dispatch = adapter().map({ body: JSON.parse(HANDSHAKE_BODY), headers: {} });
    expect(dispatch).toBeNull();
  });

  it("ignores an event that names no entity", () => {
    const body = { ...JSON.parse(EVENT_BODY), entity: {} };
    expect(adapter().map({ body, headers: {} })).toBeNull();
  });
});
