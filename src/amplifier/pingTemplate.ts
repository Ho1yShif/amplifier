import type { PostMessageInput } from "@render-lab/tasks-slack";
import type { Launch, Owner } from "../notion/types.js";
import { body } from "../slack/mrkdwn.js";

/** The ask on the first line of an owner's DM. Override with AMPLIFIER_PING_ASK. */
export const DEFAULT_PING_ASK = "Please click the Repost button in this thread";

/** Shown in place of a launch name when the Notion page has an empty title. */
const UNTITLED_LAUNCH = "A Render social post";

export interface PingDmOptions {
  /** The DM channel from `conversations.open`. */
  channel: string;
  /** The ask in the DM. Defaults to DEFAULT_PING_ASK. */
  ask?: string;
  /** Permalink to the announcement thread the Repost button is in. */
  noteUrl: string;
}

/** The launch's title, or a stand-in when the page has none. */
function launchName(launch: Launch): string {
  return launch.name.trim() || UNTITLED_LAUNCH;
}

/** An owner as a log line should name them: their name, else their address. */
export function ownerLabel(owner: Owner): string {
  return owner.name?.trim() || owner.email?.trim() || "an unnamed owner";
}

/**
 * The DM one owner gets.
 *
 * The thread link is the only link, because the Repost button is in the thread
 * and nothing else needs clicking. It leads the second line as a labelled link
 * rather than a bare URL — `amplifier.postNote` sends `unfurl_links: false`,
 * and a bare URL with no preview card reads as a stray string.
 *
 * `text` is the sidebar and push-notification fallback, so it carries no URL.
 */
export function renderPingDm(launch: Launch, opts: PingDmOptions): PostMessageInput {
  const name = launchName(launch);
  const ask = (opts.ask ?? DEFAULT_PING_ASK).trim();

  return {
    text: `Your ${name} post is ready to amplify!`,
    markdown: body([
      `Your *${name}* post is ready to amplify! ${ask}`,
      `<${opts.noteUrl}|Open the thread>`,
    ]),
    channel: opts.channel,
  };
}
