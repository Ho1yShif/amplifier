import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet } from "@render-lab/tasks-render-kv";
import { addReaction } from "@render-lab/tasks-slack";
import { loadConfig } from "../config.js";
import { authorizeUrl, CALLBACK_PATH, publicBaseUrl, userTokenKey } from "../slack/oauth.js";
import { postNote } from "../slack/postNote.js";
import { respondEphemeral, type ResponseFetch } from "../slack/respond.js";
import { signState } from "../slack/oauth.js";
import { readNote } from "./storedNote.js";
import { withoutRepostButton } from "./template.js";
import { REPOST_RETRY } from "./retry.js";

export interface RepostInput {
  /** Channel the clicked note is in. */
  channel: string;
  /** The clicked parent message's `ts`. */
  messageTs: string;
  /** Slack id of the person who clicked. */
  userId: string;
  /** Key Value key of the stored note. */
  noteKey: string;
  /** Slack URL for answering the clicker privately. */
  responseUrl: string;
}

/** Why a click produced no repost. */
export type RepostRefusal =
  "no-token" | "no-note" | "not-in-channel" | "no-repost-channel" | "no-authorize-link";

export interface RepostResult {
  reposted: boolean;
  reason?: RepostRefusal;
  /** The reposted parent's `ts` in the repost channel. */
  threadTs?: string;
}

export interface RepostDeps {
  /** Used for the `response_url` posts, which are not Slack API calls. */
  fetchImpl?: ResponseFetch;
  now?: () => Date;
}

/** Whether a thrown Slack error carries a given `error` code. */
function isSlackError(err: unknown, code: string): boolean {
  return err instanceof Error && err.message.includes(code);
}

/**
 * Raw implementation of amplifier.repost.
 *
 * The clicker's own user token posts the thread, so the repost reads as theirs
 * and not as the bot's. Everything in the source channel — the reaction and the
 * "Reposted by" reply — uses the bot token, because the clicker never needs
 * write access to a channel they only clicked in.
 */
export async function repostImpl(
  ctx: TaskContext,
  input: RepostInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: RepostDeps = {},
): Promise<RepostResult> {
  const config = loadConfig({}, env);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const reply = (text: string) => respondEphemeral(input.responseUrl, text, deps.fetchImpl);

  // Hoisted, because the narrowing does not survive into the closure below.
  const repostChannel = config.repostChannel;
  if (!repostChannel) {
    await reply(
      "Reposting is not set up. Ask the amplifier owner to set AMPLIFIER_REPOST_CHANNEL.",
    );
    return { reposted: false, reason: "no-repost-channel" };
  }

  const { value: userToken } = await ctx.run(kvGet, { key: userTokenKey(input.userId) });
  if (userToken === null) {
    return {
      reposted: false,
      reason: await sendAuthorizeLink(input, config.slackClientId, env, nowMs, reply),
    };
  }

  const note = await readNote(ctx, input.noteKey);
  if (note === null) {
    await reply(
      `Amplifier has no stored text for this note, so it cannot repost it. A note is ` +
        `kept for ${config.seenTtlSeconds / 86_400} days, so this one has probably ` +
        `expired. Copy the links across by hand.`,
    );
    return { reposted: false, reason: "no-note" };
  }

  const parent = { ...withoutRepostButton(note.parent), channel: repostChannel };
  const replies = note.replies.map((r) => ({ ...r, channel: repostChannel }));

  if (config.dryRun) {
    console.log(`[dry run] would repost to #${repostChannel} as ${input.userId}`);
    return { reposted: false };
  }

  let threadTs: string | undefined;
  try {
    ({ ts: threadTs } = await ctx.run(postNote, { ...parent, userToken }));
  } catch (err) {
    if (!isSlackError(err, "not_in_channel")) throw err;
    await reply(
      `Join #${repostChannel} and click Repost again — Slack will not post you into a ` +
        `channel you are not in.`,
    );
    return { reposted: false, reason: "not-in-channel" };
  }

  // Sequential, because the order the links appear in the thread is part of the
  // format. A failure is logged rather than thrown: the parent is already
  // posted, so a retry would post the whole thread a second time.
  for (const message of replies) {
    try {
      await ctx.run(postNote, { ...message, userToken, ...(threadTs ? { threadTs } : {}) });
    } catch (err) {
      console.error("[amplifier] A reposted thread is missing one of its links.", err);
    }
  }

  await markSource(ctx, input, config.repostEmoji);
  await reply(`Reposted to #${repostChannel}.`);
  return { reposted: true, ...(threadTs ? { threadTs } : {}) };
}

/**
 * Send the one-time authorize link.
 *
 * Nobody is onboarded in advance, so the first click is what asks for the
 * token. A missing client id or public URL is the deployment's problem and not
 * the clicker's, so the message says who to ask.
 */
async function sendAuthorizeLink(
  input: RepostInput,
  clientId: string | undefined,
  env: NodeJS.ProcessEnv,
  nowMs: number,
  reply: (text: string) => Promise<void>,
): Promise<RepostRefusal> {
  console.log(`[amplifier] No stored Slack token for ${input.userId}; sending the authorize link.`);
  const secret = env.SLACK_SIGNING_SECRET?.trim();
  const base = publicBaseUrl(env);
  if (!clientId || !secret || !base) {
    await reply(
      "Reposting needs a one-time authorization, but this deployment has no authorize link. " +
        "Ask the amplifier owner to set SLACK_CLIENT_ID, SLACK_SIGNING_SECRET and " +
        "AMPLIFIER_PUBLIC_URL.",
    );
    return "no-authorize-link";
  }
  const url = authorizeUrl({
    clientId,
    redirectUri: `${base}${CALLBACK_PATH}`,
    state: signState(input.userId, secret, nowMs),
  });
  await reply(
    `Authorize amplifier to post as you once, then click Repost again: <${url}|Authorize>`,
  );
  return "no-token";
}

/**
 * Mark the source thread as reposted: a reaction on the parent and a reply
 * naming who did it.
 *
 * Neither failure stops the run. The repost is already posted, so a missing
 * reaction is cosmetic, and throwing here would retry the whole task and post
 * the thread a second time.
 */
async function markSource(ctx: TaskContext, input: RepostInput, emoji: string): Promise<void> {
  try {
    await ctx.run(addReaction, { channel: input.channel, ts: input.messageTs, emoji });
  } catch (err) {
    // Slack answers `already_reacted` on a repeat click, which is the state
    // this was trying to reach.
    if (!isSlackError(err, "already_reacted")) {
      console.error(`[amplifier] Could not add :${emoji}: to the reposted note.`, err);
    }
  }
  try {
    await ctx.run(postNote, {
      channel: input.channel,
      text: "Reposted",
      markdown: `Reposted by <@${input.userId}>`,
      threadTs: input.messageTs,
    });
  } catch (err) {
    console.error("[amplifier] Could not post the Reposted-by reply in the source thread.", err);
  }
}

/**
 * Repost an announcement thread into the repost channel, as the clicker.
 *
 * REPOST_RETRY is short because a person is waiting on the ephemeral answer. A
 * retry can only fire before the parent is posted: everything after it either
 * swallows its own failure or answers the clicker and returns.
 */
export const repost = task({ name: "amplifier.repost", retry: REPOST_RETRY }, repostImpl);
