import { createDispatchServer, type WorkflowDispatcher } from "@render-lab/triggers";
import type { Hono } from "hono";
import { CALLBACK_PATH, isVerified, publicBaseUrl, verifyState } from "./slack/oauth.js";
import { parseRepostClick, verifySlackSignature } from "./slack/interactivity.js";
import { typefullyWebhook } from "./typefully/webhook.js";

export interface ReceiverOptions {
  dispatcher: WorkflowDispatcher;
  workflowSlug: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** How long the OAuth callback waits for the token exchange before giving up. */
const EXCHANGE_TIMEOUT_MS = 20_000;

/**
 * The receiver's HTTP app: the dispatch server plus the two Slack routes.
 *
 * `createDispatchServer` rather than `serveDispatchServer`, because the Slack
 * routes mount on the Hono app it returns. They cannot be `WebhookAdapter`s:
 * Slack sends interactivity as form-encoded with the JSON in a `payload` field,
 * and the adapter path `JSON.parse`s the body before `map` ever sees it.
 */
export function buildReceiver(opts: ReceiverOptions): Hono {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const app = createDispatchServer({
    workflowSlug: opts.workflowSlug,
    dispatcher: opts.dispatcher,
    webhooks: { typefully: typefullyWebhook({ env, now }) },
  });

  /**
   * Start a repost for a verified Repost click.
   *
   * Answers 200 before the dispatch, because Slack's interactivity budget is
   * three seconds and starting a workflow run is slower than that. Everything
   * the clicker needs to hear afterwards arrives through `response_url`.
   */
  app.post("/slack/interactivity", async (c) => {
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    if (!verifySlackSignature(headers, rawBody, env.SLACK_SIGNING_SECRET, now().getTime())) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const payloadField = new URLSearchParams(rawBody).get("payload");
    if (payloadField === null) return c.json({ error: "no payload" }, 400);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadField);
    } catch {
      return c.json({ error: "invalid payload JSON" }, 400);
    }

    const click = parseRepostClick(payload);
    if (!click) return c.body(null, 200);

    void opts.dispatcher.start("amplifier.repost", [click]).catch((err: unknown) => {
      console.error("[amplifier] Could not start amplifier.repost for a Repost click.", err);
    });
    return c.body(null, 200);
  });

  /**
   * Finish one person's authorization.
   *
   * Waits for `amplifier.saveUserToken` rather than starting it, so the browser
   * gets a real answer instead of a page that says "probably".
   */
  app.get(CALLBACK_PATH, async (c) => {
    const secret = env.SLACK_SIGNING_SECRET;
    if (!secret) return page("Not configured", "SLACK_SIGNING_SECRET is unset.", 500);

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      const denied = c.req.query("error");
      return page(
        "Not authorized",
        denied ? `Slack said: ${denied}.` : "The link was incomplete.",
        400,
      );
    }

    const outcome = verifyState(state, secret, now().getTime());
    if (!isVerified(outcome)) {
      return page("Not authorized", stateMessage(outcome.failure), 400);
    }

    const base = publicBaseUrl(env);
    if (!base) return page("Not configured", "The receiver has no public URL.", 500);

    let result: unknown;
    try {
      const run = await opts.dispatcher.run(
        "amplifier.saveUserToken",
        [{ code, userId: outcome.userId, redirectUri: `${base}${CALLBACK_PATH}` }],
        EXCHANGE_TIMEOUT_MS,
      );
      if (run.timedOut) {
        return page("Still working", "Slack is slow. Click Repost again in a minute.", 504);
      }
      result = run.results;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return page("Not authorized", `The token exchange failed: ${detail}`, 502);
    }

    const error = exchangeError(result);
    if (error) return page("Not authorized", error, 400);
    return page("Authorized", "Go back to Slack and click Repost again.", 200);
  });

  return app;
}

/** Why a `state` was rejected, in words a person can act on. */
function stateMessage(failure: "malformed" | "bad-signature" | "expired"): string {
  if (failure === "expired") return "The authorize link has expired. Click Repost again.";
  return "This authorize link was not issued by amplifier.";
}

/**
 * The error `amplifier.saveUserToken` reported, or undefined on success.
 *
 * The Render API reports a run's results as an array, one entry per argument,
 * and this callback starts the task with one. `results` is typed `unknown`, so
 * the shape is checked rather than asserted.
 */
function exchangeError(results: unknown): string | undefined {
  const result = Array.isArray(results) ? results[0] : results;
  if (typeof result !== "object" || result === null) {
    return "The token exchange returned nothing readable.";
  }
  const r = result as { saved?: unknown; error?: unknown };
  if (r.saved === true) return undefined;
  return typeof r.error === "string" ? r.error : "The token was not saved.";
}

/** A plain HTML page, which is all a browser gets from this receiver. */
function page(title: string, detail: string, status: number): Response {
  const body =
    `<!doctype html><meta charset="utf-8"><title>Amplifier</title>` +
    `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
}
