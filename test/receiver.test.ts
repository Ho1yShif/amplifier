import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDispatcher } from "@render-lab/triggers";
import { buildReceiver } from "../src/receiver.js";
import { CALLBACK_PATH, signState } from "../src/slack/oauth.js";
import { REPOST_ACTION_ID } from "../src/amplifier/template.js";

const SECRET = "signing-secret";
const USER = "U123";
const NOW_MS = Date.parse("2026-09-11T12:00:00Z");
const BASE = "https://amplifier-webhook.onrender.com";

const env: NodeJS.ProcessEnv = {
  SLACK_SIGNING_SECRET: SECRET,
  AMPLIFIER_PUBLIC_URL: BASE,
};

/**
 * A dispatcher whose `run` answers with `results`, in the shape the Render API
 * uses: an array holding one entry per argument the task was started with.
 */
function dispatcherReturning(results: unknown, timedOut = false): WorkflowDispatcher {
  return {
    start: async () => ({ runId: "run-1" }),
    run: async () => ({ runId: "run-1", status: "succeeded", results, timedOut }),
  } as unknown as WorkflowDispatcher;
}

function callback(dispatcher: WorkflowDispatcher, state: string) {
  const app = buildReceiver({
    dispatcher,
    workflowSlug: "amplifier",
    env,
    now: () => new Date(NOW_MS),
  });
  return app.request(`${CALLBACK_PATH}?code=abc&state=${encodeURIComponent(state)}`);
}

describe("GET /slack/oauth/callback", () => {
  const state = signState(USER, SECRET, NOW_MS);

  it("reports success when the run saved the token", async () => {
    const res = await callback(dispatcherReturning([{ saved: true }]), state);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Authorized");
  });

  it("reports the error the run returned", async () => {
    const results = [{ saved: false, error: "Slack rejected the exchange: invalid_code." }];

    const res = await callback(dispatcherReturning(results), state);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_code");
  });

  it("rejects a state it did not sign", async () => {
    const res = await callback(dispatcherReturning([{ saved: true }]), `${USER}:0:deadbeef`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not issued by amplifier");
  });

  it("asks the clicker to try again when the exchange outlasts the wait", async () => {
    const res = await callback(dispatcherReturning(undefined, true), state);

    expect(res.status).toBe(504);
  });
});

/** A dispatcher that records every `start` call instead of dispatching. */
function recordingDispatcher() {
  const started: { task: string; args: unknown[] }[] = [];
  const dispatcher = {
    start: async (task: string, args: unknown[]) => {
      started.push({ task, args });
      return { runId: "run-1" };
    },
    run: async () => ({ runId: "run-1", status: "succeeded", results: [], timedOut: false }),
  } as unknown as WorkflowDispatcher;
  return { dispatcher, started };
}

/** Headers Slack would send for `rawBody`, signed the way Slack signs them. */
function slackHeaders(rawBody: string, secret = SECRET) {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${digest}`,
  };
}

/** A form-encoded interactivity body, the way Slack posts a button click. */
function clickBody(payload: unknown) {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function interactivity(
  dispatcher: WorkflowDispatcher,
  body: string,
  headers: Record<string, string>,
) {
  const app = buildReceiver({
    dispatcher,
    workflowSlug: "amplifier",
    env,
    now: () => new Date(NOW_MS),
  });
  return app.request("/slack/interactivity", { method: "POST", body, headers });
}

describe("POST /slack/interactivity", () => {
  const click = {
    actions: [{ action_id: REPOST_ACTION_ID, value: "amplifier:note:1" }],
    channel: { id: "C1" },
    message: { ts: "17580000.001" },
    user: { id: USER },
    response_url: "https://hooks.slack.com/actions/T/1/2",
  };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("starts a repost for a signed click", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody(click);

    const res = await interactivity(dispatcher, body, slackHeaders(body));

    expect(res.status).toBe(200);
    expect(started).toEqual([
      {
        task: "amplifier.repost",
        args: [
          {
            channel: "C1",
            messageTs: "17580000.001",
            userId: USER,
            noteKey: "amplifier:note:1",
            responseUrl: "https://hooks.slack.com/actions/T/1/2",
          },
        ],
      },
    ]);
  });

  it("rejects a body over the cap before it checks the signature", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody({ ...click, padding: "A".repeat(2 * 1024 * 1024) });

    const res = await interactivity(dispatcher, body, {
      "content-type": "application/x-www-form-urlencoded",
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    expect(started).toEqual([]);
  });

  it("rejects a body under the cap with a forged signature", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody(click);

    const res = await interactivity(dispatcher, body, slackHeaders(body, "wrong-secret"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(started).toEqual([]);
  });
});
