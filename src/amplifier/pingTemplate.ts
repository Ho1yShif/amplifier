import type { PostMessageInput } from "@render-lab/tasks-slack";
import type { Launch, Owner } from "../notion/types.js";

/** The ask at the end of an owner's DM. Override with AMPLIFIER_PING_ASK. */
export const DEFAULT_PING_ASK =
  "Please review it in Typefully, then like and share it when it goes live.";

/** Shown in place of a launch name when the Notion page has an empty title. */
const UNTITLED_LAUNCH = "A Render social post";

export interface PingOptions {
  /** The DM channel from `conversations.open`, or the fallback note's channel. */
  channel: string;
  /** The ask in the DM. Defaults to DEFAULT_PING_ASK. */
  ask?: string;
}

/** One owner the run could not DM, and the reason in words. */
export interface UnreachableOwner {
  owner: Owner;
  /** Why no DM went out, such as `no Slack account for name@render.com`. */
  reason: string;
}

/** Join the non-empty parts of a message the way Slack renders paragraphs. */
function body(parts: string[]): string {
  return parts.filter((s) => s !== "").join("\n\n");
}

/** The launch's title, or a stand-in when the page has none. */
function launchName(launch: Launch): string {
  return launch.name.trim() || UNTITLED_LAUNCH;
}

/** An owner as the channel should name them: their name, else their address. */
export function ownerLabel(owner: Owner): string {
  return owner.name?.trim() || owner.email?.trim() || "an unnamed owner";
}

/**
 * The DM one owner gets.
 *
 * The Typefully link is the point of the message, so it leads the second line
 * as a labelled link rather than a bare URL — `amplifier.postNote` sends
 * `unfurl_links: false`, and a bare URL with no preview card reads as a stray
 * string.
 */
export function renderPingDm(launch: Launch, opts: PingOptions): PostMessageInput {
  const name = launchName(launch);
  const links = [`<${launch.typefullyUrl}|Open it in Typefully>`];
  if (launch.pageUrl) links.push(`<${launch.pageUrl}|Notion page>`);

  return {
    text: `${name} is ready to amplify.`,
    markdown: body([
      `*${name}* is ready to amplify, and you own it.`,
      links.join("  ·  "),
      (opts.ask ?? DEFAULT_PING_ASK).trim(),
    ]),
    channel: opts.channel,
  };
}

/**
 * The channel note naming owners nobody could DM.
 *
 * It @-mentions nobody. The whole reason it exists is that the run has no
 * Slack user id for these people, so there is nothing to mention.
 */
export function renderUnreachableNote(
  launch: Launch,
  unreachable: UnreachableOwner[],
  opts: PingOptions,
): PostMessageInput {
  const name = launchName(launch);
  const lines = unreachable.map((u) => `• ${ownerLabel(u.owner)} — ${u.reason}`);
  const owners = unreachable.length > 1 ? "these owners" : "this owner";

  return {
    text: `No DM went out for ${name}.`,
    markdown: body([
      `I could not DM ${owners} about *${name}*:`,
      lines.join("\n"),
      `<${launch.typefullyUrl}|Open it in Typefully>`,
      "Please pass it along by hand.",
    ]),
    channel: opts.channel,
  };
}
