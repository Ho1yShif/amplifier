import { task, type TaskContext } from "@renderinc/sdk/workflows";
import {
  postMessageImpl,
  SLACK_RETRY,
  webApiPort,
  type PostMessageInput,
  type PostMessageResult,
  type SlackDeps,
  type SlackPort,
} from "@render-lab/tasks-slack";

export interface PostNoteInput extends PostMessageInput {
  /** Parent message `ts`, to post this message as a reply in that thread. */
  threadTs?: string;
  /** A Slack user token, to post as that person instead of as the bot. */
  userToken?: string;
}

/**
 * Slack unfurls every link it finds, including links inside a section block's
 * mrkdwn, so emptying `text` of URLs is not enough to stop the preview cards.
 * `chat.postMessage` accepts `unfurl_links` and `unfurl_media`, but
 * `@render-lab/tasks-slack` 0.3.0 sends neither and exposes no option for them.
 * Until it does, add them to the request body on the way out.
 *
 * `thread_ts` rides the same rewrite. `PostMessageInput` has no field for it in
 * 0.3.0 and `postMessageImpl` builds the Web API body from `channel`, `text` and
 * `blocks` alone, so the body is the only place to add it.
 */
const UNFURL_OFF = { unfurl_links: false, unfurl_media: false };

function rewriteBody(body: string, threadTs: string | undefined): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    ...UNFURL_OFF,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

/** Where `webApiPort` sends every call, and what SLACK_API_BASE_URL replaces. */
const SLACK_API_BASE_URL = "https://slack.com/api";

/**
 * `WebFetchLike` and `FetchLike` take the same `init` shape and differ only in
 * the response shape (`WebFetchLike` also requires `json()`), so one function
 * satisfies both without a cast.
 *
 * `SLACK_API_BASE_URL` redirects the call to a local stub, the way
 * `TYPEFULLY_BASE_URL` does for Typefully. `webApiPort` builds the Slack host
 * into the URL itself, so rewriting the URL here is the only route. Leave it
 * unset everywhere but `pnpm local:run`: the bot token travels to whatever host
 * it names.
 */
function outgoingFetch(threadTs: string | undefined, env: NodeJS.ProcessEnv) {
  const base = env.SLACK_API_BASE_URL?.trim().replace(/\/+$/, "");
  return (url: string, init: { body: string }) =>
    fetch(base ? url.replace(SLACK_API_BASE_URL, base) : url, {
      ...init,
      body: rewriteBody(init.body, threadTs),
    });
}

/**
 * The incoming-webhook port, which amplifier no longer uses.
 *
 * `SlackDeps.slack` is required, and `postMessageImpl` reaches for it only when
 * a channel or a bot token is missing. `postNoteImpl` throws before that, so
 * this port is unreachable — it throws rather than logging to the console,
 * because a silent `delivered: false` is how the webhook path used to report
 * that nothing was posted.
 */
const noWebhookPort: SlackPort = {
  post() {
    throw new Error(
      "amplifier posts through the Slack Web API only. Set SLACK_BOT_TOKEN and SLACK_CHANNEL.",
    );
  },
};

/**
 * The vendor's Web API port with unfurling off and `thread_ts` added.
 *
 * Built per call, so SLACK_BOT_TOKEN is read at call time and never at import.
 * A user token is applied by handing `webApiPort` a copy of the environment
 * with SLACK_BOT_TOKEN replaced, which keeps posting-as-a-person inside the
 * vendor's own client instead of adding a second HTTP path.
 */
function slackDeps(env: NodeJS.ProcessEnv, input: PostNoteInput): SlackDeps {
  const tokenEnv = input.userToken ? { ...env, SLACK_BOT_TOKEN: input.userToken } : env;
  return {
    slack: noWebhookPort,
    web: webApiPort({ fetchImpl: outgoingFetch(input.threadTs, env), env: tokenEnv }),
  };
}

/**
 * Raw implementation of amplifier.postNote.
 *
 * Throws when Slack is not configured, instead of letting the port log the note
 * to the console and return `delivered: false`. A run that cannot post must not
 * report success.
 *
 * Both a channel and a bot token are required, because `postMessageImpl` takes
 * the Web API route only when it has both, and only that route returns the `ts`
 * a thread reply needs.
 */
export async function postNoteImpl(
  ctx: TaskContext,
  input: PostNoteInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostMessageResult> {
  if (!input.channel || !env.SLACK_BOT_TOKEN) {
    throw new Error(
      "Slack is not configured, so the note was not posted. Set SLACK_BOT_TOKEN together " +
        "with SLACK_CHANNEL.",
    );
  }
  return postMessageImpl(ctx, input, slackDeps(env, input));
}

/** Post one note, threaded when `threadTs` is set and as a person when `userToken` is. */
export const postNote = task({ name: "amplifier.postNote", retry: SLACK_RETRY }, postNoteImpl);
