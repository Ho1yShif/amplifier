import type { TaskContext } from "@renderinc/sdk/workflows";
import type { PostMessageInput } from "@render-lab/tasks-slack";
import type { AmplifierConfig } from "../config.js";
import { postNote } from "../slack/postNote.js";
import { isSummary, summarizeGroup } from "../summary/summarize.js";
import type { Platform } from "../typefully/types.js";
import type { PostGroup } from "./group.js";
import { claimGroup, isClaimed, markAnnounced, releaseGroup } from "./seen.js";
import { noteKey, storeNote } from "./storedNote.js";
import {
  notePlatforms,
  renderChildren,
  renderFlatNote,
  renderParent,
  type RenderNoteOptions,
} from "./template.js";

/** One announcement's outcome. */
export interface NoteResult {
  draftIds: string[];
  platforms: Platform[];
  /** false in dry run, and false when the Slack port reported no delivery. */
  delivered: boolean;
  /** Whether the model wrote this note's lead line. False means the fallback text. */
  summarized: boolean;
  /** The parent message's `ts`, when the note was posted as a thread. */
  threadTs?: string;
}

export interface AnnounceOptions {
  /** Platforms to name as dropped, and the draft whose note names them. */
  droppedFor?: { draftId: string; platforms: Platform[] };
}

export interface AnnounceResult {
  notes: NoteResult[];
  /** Drafts left unannounced because another run holds the claim or already announced them. */
  skipped: number;
}

/**
 * Summarize, claim, post, mark, release — once per group.
 *
 * Both `amplifier.checkPosts` and `amplifier.announcePost` call this, so the
 * announce-once guarantee has one implementation.
 */
export async function announceGroups(
  ctx: TaskContext,
  groups: PostGroup[],
  config: AmplifierConfig,
  runToken: string,
  opts: AnnounceOptions = {},
): Promise<AnnounceResult> {
  const notes: NoteResult[] = [];
  let skipped = 0;

  for (const group of groups) {
    // Before the claim, not inside it. LLM_RETRY spends about 62 seconds of
    // backoff across 5 retries plus six call durations, and the in-flight lock
    // lives 300 seconds — inside the claim, the lock can expire mid-flight and
    // the next run re-posts the note. The cost is one wasted call when two runs
    // race the same group.
    const summary = await summarizeGroup(ctx, group, { model: config.summaryModel });
    if (!isSummary(summary)) {
      console.error(
        `[amplifier] No summary for ${group.draftIds.join(", ")}: ${summary.error}. ` +
          `Posting the fallback note.`,
      );
    }

    const outcome = await claimGroup(ctx, group, runToken);
    if (!isClaimed(outcome)) {
      skipped += group.draftIds.length;
      continue;
    }
    const { claims } = outcome;

    // Only the event's draft went through the settle check, so only its note
    // names the platforms the deadline dropped.
    const dropped =
      opts.droppedFor !== undefined && group.draftIds.includes(opts.droppedFor.draftId)
        ? opts.droppedFor.platforms
        : [];

    const noteOpts: RenderNoteOptions = {
      ...(config.slackChannel ? { channel: config.slackChannel } : {}),
      callToAction: config.callToAction,
      ...(isSummary(summary) ? { summary: summary.line } : { summaryError: summary.error }),
      ...(dropped.length > 0 ? { droppedPlatforms: dropped } : {}),
    };
    const platforms = notePlatforms(group);
    const replies = platforms.length > 1 ? renderChildren(group, noteOpts) : [];
    const key = noteKey(group.draftIds);
    const parent =
      replies.length > 0
        ? renderParent(group, {
            ...noteOpts,
            ...(config.repostChannel ? { repostChannel: config.repostChannel, noteKey: key } : {}),
          })
        : renderFlatNote(group, noteOpts);

    let delivered = false;
    let threadTs: string | undefined;
    if (config.dryRun) {
      logDryRun(parent, replies);
    } else {
      try {
        const posted = await ctx.run(postNote, parent);
        delivered = posted.delivered;
        threadTs = posted.ts;
        if (delivered) {
          await markAnnounced(ctx, group.draftIds, config.seenTtlSeconds);
        }
      } catch (err) {
        await releaseGroup(ctx, claims);
        throw err;
      }

      if (!delivered) {
        // The Slack port reported the note undelivered without throwing. The
        // real ports either deliver or throw, so this is reachable only through
        // injected deps. Nothing reached the channel, so leave the drafts
        // unannounced and let a later run retry them.
        console.error(
          `[amplifier] The Slack port reported the note for ${group.draftIds.join(", ")} ` +
            `undelivered. Those drafts stay unannounced and a later run retries them.`,
        );
      } else if (replies.length > 0) {
        if (config.repostChannel) {
          await storeNote(ctx, key, { parent, replies }, config.seenTtlSeconds);
        }
        await postReplies(ctx, group, replies, threadTs);
      }
    }
    await releaseGroup(ctx, claims);
    notes.push({
      draftIds: group.draftIds,
      platforms,
      delivered,
      summarized: isSummary(summary),
      ...(threadTs ? { threadTs } : {}),
    });
  }

  return { notes, skipped };
}

/**
 * Post the thread's replies, in order.
 *
 * Sequential and not `Promise.all`, because the order the links appear in the
 * thread is part of the format.
 *
 * A failed reply is logged rather than thrown. The announced marker is already
 * written, so throwing here would leave the drafts unmarked and a later run
 * would post a second parent; a thread missing one link is the smaller problem.
 * Each reply is its own subtask under SLACK_RETRY, so a transient failure has
 * already been retried by the time this catches.
 */
async function postReplies(
  ctx: TaskContext,
  group: PostGroup,
  replies: PostMessageInput[],
  threadTs: string | undefined,
): Promise<void> {
  if (threadTs === undefined) {
    console.error(
      `[amplifier] Slack returned no ts for the note on ${group.draftIds.join(", ")}, so its ` +
        `${replies.length} links cannot be posted as replies.`,
    );
    return;
  }
  for (const reply of replies) {
    try {
      await ctx.run(postNote, { ...reply, threadTs });
    } catch (err) {
      console.error(
        `[amplifier] A thread reply for ${group.draftIds.join(", ")} failed. The thread is ` +
          `missing a link and the drafts stay announced.`,
        err,
      );
    }
  }
}

/** Log the parent and every reply, in the order a real run would post them. */
function logDryRun(parent: PostMessageInput, replies: PostMessageInput[]): void {
  console.log(`[dry run] would post:\n${messageText(parent)}`);
  for (const reply of replies) {
    console.log(`[dry run] would reply:\n${messageText(reply)}`);
  }
}

/**
 * A message's body as text, for the dry-run log.
 *
 * The parent carries `blocks` and no `markdown`, so the section blocks are read
 * back out. Anything else falls back to the notification text.
 */
function messageText(message: PostMessageInput): string {
  if (message.markdown) return message.markdown;
  const sections = (message.blocks ?? []).flatMap((block) => {
    const text = (block as { text?: { text?: unknown } }).text?.text;
    return typeof text === "string" ? [text] : [];
  });
  return sections.length > 0 ? sections.join("\n\n") : message.text;
}
