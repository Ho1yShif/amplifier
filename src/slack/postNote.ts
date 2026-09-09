import { task, type TaskContext } from "@renderinc/sdk/workflows";
import {
  postMessageImpl,
  SLACK_RETRY,
  webApiPort,
  webhookPort,
  type PostMessageInput,
  type PostMessageResult,
  type SlackDeps,
} from "@render-lab/tasks-slack";

/**
 * Slack unfurls every link it finds, including links inside a section block's
 * mrkdwn, so emptying `text` of URLs is not enough to stop the preview cards.
 * Both `chat.postMessage` and incoming webhooks accept `unfurl_links` and
 * `unfurl_media`, but `@render-lab/tasks-slack` 0.3.0 sends neither and exposes
 * no option for them. Until it does, add them to the request body on the way out.
 */
const UNFURL_OFF = { unfurl_links: false, unfurl_media: false };

function withUnfurlOff(body: string): string {
  return JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), ...UNFURL_OFF });
}

/**
 * `WebFetchLike` and `FetchLike` take the same `init` shape and differ only in
 * the response shape (`WebFetchLike` also requires `json()`), so one function
 * satisfies both without a cast.
 */
const unfurlOffFetch = (url: string, init: { body: string }) =>
  fetch(url, { ...init, body: withUnfurlOff(init.body) });

/**
 * The vendor's default deps with unfurling off on both delivery paths. Built per
 * call, so SLACK_BOT_TOKEN is read at call time and never at import.
 */
function slackDeps(env: NodeJS.ProcessEnv): SlackDeps {
  return {
    slack: webhookPort({ fetchImpl: unfurlOffFetch, env }),
    ...(env.SLACK_BOT_TOKEN ? { web: webApiPort({ fetchImpl: unfurlOffFetch, env }) } : {}),
  };
}

/** Raw implementation of amplifier.postNote. */
export function postNoteImpl(
  ctx: TaskContext,
  input: PostMessageInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostMessageResult> {
  return postMessageImpl(ctx, input, slackDeps(env));
}

/** The vendor's slack.postMessage with the link-preview cards suppressed. */
export const postNote = task({ name: "amplifier.postNote", retry: SLACK_RETRY }, postNoteImpl);
