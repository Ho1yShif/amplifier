import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { SLACK_RETRY } from "@render-lab/tasks-slack";
import { callSlack, type SlackApiResponse } from "./api.js";

export interface MessageLinkInput {
  /** Channel the message is in, as an id or a bare name. */
  channel: string;
  /** The message's `ts`, as `chat.postMessage` returned it. */
  messageTs: string;
}

/** A permalink, or the Slack error code that says why there is none. */
export type MessageLinkResult = { url: string } | { error: string };

/** The `permalink` in a `chat.getPermalink` reply, or undefined. */
function permalink(body: SlackApiResponse): string | undefined {
  const url = body["permalink"];
  return typeof url === "string" && url !== "" ? url : undefined;
}

/**
 * Raw implementation of amplifier.messageLink.
 *
 * A `message_not_found` is returned rather than thrown, matching
 * `amplifier.lookupUser`: it is an answer about one message, and the caller
 * sends no DM instead of failing the run that already posted the note.
 *
 * No new bot scope. `chat.getPermalink` reads the bot's own channels.
 *
 * Not `@render-lab/tasks-slack`'s own `slack.getPermalink`, which throws on an
 * `ok: false` body and sends JSON to a hard-coded `https://slack.com/api`. This
 * one returns the error code and goes through `callSlack`, so SLACK_API_BASE_URL
 * still redirects it to the local stub.
 */
export async function messageLinkImpl(
  _ctx: TaskContext,
  input: MessageLinkInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MessageLinkResult> {
  const channel = input.channel?.trim();
  const messageTs = input.messageTs?.trim();
  if (!channel) return { error: "no_channel" };
  if (!messageTs) return { error: "no_message_ts" };

  const body = await callSlack("chat.getPermalink", { channel, message_ts: messageTs }, { env });
  const url = permalink(body);
  if (!url) return { error: body.error ?? "no_permalink_in_response" };
  return { url };
}

/** The permalink to one Slack message. */
export const messageLink = task(
  { name: "amplifier.messageLink", retry: SLACK_RETRY },
  messageLinkImpl,
);
