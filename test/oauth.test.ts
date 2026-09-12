import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskRegistry } from "@renderinc/sdk/workflows";
import {
  authorizeUrl,
  isVerified,
  publicBaseUrl,
  signState,
  userTokenKey,
  verifyState,
} from "../src/slack/oauth.js";
import { saveUserTokenImpl } from "../src/amplifier/saveUserToken.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const SECRET = "signing-secret";
const NOW_MS = Date.parse("2026-09-11T12:00:00Z");
const REDIRECT = "https://amplifier-webhook.onrender.com/slack/oauth/callback";

const env = { SLACK_CLIENT_ID: "1234.5678", SLACK_CLIENT_SECRET: "client-secret" };

/** A fetch that answers `oauth.v2.access` with `body`, recording what it was sent. */
function stubExchange(body: unknown, status = 200) {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    return {
      ok: status < 400,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  }) as never;
  return { sent, fetchImpl };
}

function handlers(overrides: TaskHandlers = {}): TaskHandlers {
  return { "kv.set": () => ({ ok: true }), ...overrides };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("signState and verifyState", () => {
  it("round-trips the user id", () => {
    const state = signState("U9", SECRET, NOW_MS);
    const outcome = verifyState(state, SECRET, NOW_MS);
    expect(isVerified(outcome) && outcome.userId).toBe("U9");
  });

  it("rejects a state signed with a different secret", () => {
    const state = signState("U9", "other-secret", NOW_MS);
    expect(verifyState(state, SECRET, NOW_MS)).toEqual({ failure: "bad-signature" });
  });

  it("rejects a state whose user id was swapped", () => {
    const state = signState("U9", SECRET, NOW_MS);
    const tampered = state.replace("U9", "U8");
    expect(verifyState(tampered, SECRET, NOW_MS)).toEqual({ failure: "bad-signature" });
  });

  it("rejects a state whose expiry was pushed out", () => {
    const [userId, expiresAt, mac] = signState("U9", SECRET, NOW_MS).split(":");
    const pushed = `${userId}:${Number(expiresAt) + 86_400_000}:${mac}`;
    expect(verifyState(pushed, SECRET, NOW_MS)).toEqual({ failure: "bad-signature" });
  });

  it("rejects an expired state", () => {
    const state = signState("U9", SECRET, NOW_MS);
    expect(verifyState(state, SECRET, NOW_MS + 11 * 60_000)).toEqual({ failure: "expired" });
  });

  it("accepts a state inside its window", () => {
    const state = signState("U9", SECRET, NOW_MS);
    expect(isVerified(verifyState(state, SECRET, NOW_MS + 9 * 60_000))).toBe(true);
  });

  it("rejects a state that is not three parts", () => {
    expect(verifyState("U9:nonsense", SECRET, NOW_MS)).toEqual({ failure: "malformed" });
    expect(verifyState("U9:notanumber:abc", SECRET, NOW_MS)).toEqual({ failure: "malformed" });
    expect(verifyState(":123:abc", SECRET, NOW_MS)).toEqual({ failure: "malformed" });
  });
});

describe("authorizeUrl", () => {
  it("asks for the user scope only, and carries the state", () => {
    const url = new URL(authorizeUrl({ clientId: "1234.5678", redirectUri: REDIRECT, state: "s" }));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("user_scope")).toBe("chat:write");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("s");
  });
});

describe("publicBaseUrl", () => {
  it("prefers AMPLIFIER_PUBLIC_URL, so the callback can run locally", () => {
    expect(
      publicBaseUrl({
        AMPLIFIER_PUBLIC_URL: "http://localhost:3000",
        RENDER_EXTERNAL_URL: "https://a.onrender.com",
      }),
    ).toBe("http://localhost:3000");
  });

  it("falls back to what Render sets", () => {
    expect(publicBaseUrl({ RENDER_EXTERNAL_URL: "https://a.onrender.com/" })).toBe(
      "https://a.onrender.com",
    );
  });

  it("is undefined when neither is set", () => {
    expect(publicBaseUrl({})).toBeUndefined();
  });
});

describe("saveUserTokenImpl", () => {
  const input = { code: "code-1", userId: "U9", redirectUri: REDIRECT };
  const ok = { ok: true, authed_user: { id: "U9", access_token: "xoxp-person" } };

  it("stores the user token with no TTL", async () => {
    const { sent, fetchImpl } = stubExchange(ok);
    const { ctx, calls } = taskCtx(handlers());
    const result = await saveUserTokenImpl(ctx, input, env, { fetchImpl });

    expect(result).toEqual({ saved: true });
    expect(calls[0]).toEqual({
      name: "kv.set",
      input: { key: userTokenKey("U9"), value: "xoxp-person" },
    });
    expect(sent[0]).toContain("code=code-1");
    expect(sent[0]).toContain("client_secret=client-secret");
  });

  it("rejects a token Slack authorized for someone else", async () => {
    const { fetchImpl } = stubExchange({
      ok: true,
      authed_user: { id: "U8", access_token: "xoxp-other" },
    });
    const { ctx, calls } = taskCtx(handlers());
    const result = await saveUserTokenImpl(ctx, input, env, { fetchImpl });

    expect(result.saved).toBe(false);
    expect(result.error).toContain("authorized U8");
    expect(calls).toHaveLength(0);
  });

  it("reports the error Slack named", async () => {
    const { fetchImpl } = stubExchange({ ok: false, error: "invalid_code" });
    const { ctx, calls } = taskCtx(handlers());
    const result = await saveUserTokenImpl(ctx, input, env, { fetchImpl });

    expect(result.error).toContain("invalid_code");
    expect(calls).toHaveLength(0);
  });

  it("reports a response with no user token", async () => {
    const { fetchImpl } = stubExchange({ ok: true, authed_user: { id: "U9" } });
    const { ctx } = taskCtx(handlers());
    const result = await saveUserTokenImpl(ctx, input, env, { fetchImpl });
    expect(result.error).toContain("no user token");
  });

  it("reports a body that is not JSON", async () => {
    const { fetchImpl } = stubExchange("<html>502</html>", 502);
    const { ctx } = taskCtx(handlers());
    const result = await saveUserTokenImpl(ctx, input, env, { fetchImpl });
    expect(result.error).toContain("not JSON");
  });

  it("reports missing client credentials instead of calling Slack", async () => {
    const { sent, fetchImpl } = stubExchange(ok);
    const { ctx } = taskCtx(handlers());
    const result = await saveUserTokenImpl(ctx, input, {}, { fetchImpl });

    expect(result.error).toContain("SLACK_CLIENT_ID");
    expect(sent).toHaveLength(0);
  });

  it("registers amplifier.saveUserToken with no retry policy", async () => {
    // An OAuth code is single-use, so a retry after a successful exchange
    // fails with invalid_code and reports a working authorization as failed.
    await import("../src/amplifier/saveUserToken.js");
    await import("../src/amplifier/repost.js");
    const registry = TaskRegistry.getInstance();
    expect(registry.get("amplifier.saveUserToken")?.options?.retry).toBeUndefined();
    // amplifier.repost does carry one, so this is not just an absent task.
    expect(registry.get("amplifier.repost")?.options?.retry).toBeDefined();
  });
});
