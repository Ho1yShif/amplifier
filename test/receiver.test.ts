import { describe, expect, it } from "vitest";
import type { WorkflowDispatcher } from "@render-lab/triggers";
import { buildReceiver } from "../src/receiver.js";
import { CALLBACK_PATH, signState } from "../src/slack/oauth.js";

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
