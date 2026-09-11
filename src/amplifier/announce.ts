import type { TaskContext } from "@renderinc/sdk/workflows";
import type { AmplifierConfig } from "../config.js";
import { postNote } from "../slack/postNote.js";
import { isSummary, summarizeGroup } from "../summary/summarize.js";
import type { Platform } from "../typefully/types.js";
import type { PostGroup } from "./group.js";
import { claimGroup, isClaimed, markAnnounced, releaseGroup } from "./seen.js";
import { notePlatforms, renderNote } from "./template.js";

/** One announcement's outcome. */
export interface NoteResult {
  draftIds: string[];
  platforms: Platform[];
  /** false in dry run, and false when the Slack port reported no delivery. */
  delivered: boolean;
  /** Whether the model wrote this note's lead line. False means the fallback text. */
  summarized: boolean;
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

    const message = renderNote(group, {
      ...(config.slackChannel ? { channel: config.slackChannel } : {}),
      callToAction: config.callToAction,
      ...(isSummary(summary) ? { summary: summary.line } : { summaryError: summary.error }),
      ...(dropped.length > 0 ? { droppedPlatforms: dropped } : {}),
    });
    const platforms = notePlatforms(group);

    let delivered = false;
    if (config.dryRun) {
      console.log(`[dry run] would post:\n${message.markdown ?? message.text}`);
    } else {
      try {
        ({ delivered } = await ctx.run(postNote, message));
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
      }
    }
    await releaseGroup(ctx, claims);
    notes.push({
      draftIds: group.draftIds,
      platforms,
      delivered,
      summarized: isSummary(summary),
    });
  }

  return { notes, skipped };
}
