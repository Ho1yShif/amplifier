import { randomUUID } from "node:crypto";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { loadConfig, MAX_LIMIT, type CheckPostsInput } from "../config.js";
import { postNote } from "../slack/postNote.js";
import { listPublished } from "../typefully/listPublished.js";
import type { Platform } from "../typefully/types.js";
import { groupPosts } from "./group.js";
import { announcedDraftIds, claimGroup, isClaimed, markAnnounced, releaseGroup } from "./seen.js";
import { notePlatforms, renderNote } from "./template.js";
import { isSummary, summarizeGroup } from "../summary/summarize.js";
import { withinWindow } from "./window.js";

/** One announcement's outcome. */
export interface NoteResult {
  draftIds: string[];
  platforms: Platform[];
  /** false in dry run, and false when Slack fell back to the console. */
  delivered: boolean;
  /** Whether the model wrote this note's lead line. False means the fallback text. */
  summarized: boolean;
}

export interface CheckPostsResult {
  /** Published drafts that mapped to a post amplifier can announce. */
  scanned: number;
  /** Of those, the ones inside the lookback window. */
  inWindow: number;
  /** Announcements the unannounced posts collapsed into. */
  groups: number;
  notified: number;
  /**
   * Drafts this run did not announce: ones an earlier run already announced,
   * plus ones in a group another run is announcing right now.
   */
  skipped: number;
  dryRun: boolean;
  notes: NoteResult[];
}

/** Raw implementation of amplifier.checkPosts. */
export async function checkPostsImpl(
  ctx: TaskContext,
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckPostsResult> {
  const config = loadConfig(input, env);
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new Error(`input.now is not a parseable timestamp: ${input.now}`);
  }

  // Unique per invocation and stable within it. The SDK 1.0 TaskContext exposes
  // no run id, and the in-flight lock only has to tell this run's lock from
  // another run's.
  const runToken = `amplifier:run:${randomUUID()}`;

  const { posts } = await ctx.run(listPublished, {
    ...(config.socialSetId ? { socialSetId: config.socialSetId } : {}),
    limit: config.limit,
  });

  const recent = withinWindow(posts, nowMs, config.lookbackMinutes);
  if (posts.length >= config.limit && recent.length === 0) {
    console.warn(
      `[amplifier] Typefully returned ${posts.length} posts, the requested limit, and none ` +
        `is inside the ${config.lookbackMinutes}-minute lookback. The response may be ` +
        `truncated to the oldest published drafts. Raise AMPLIFIER_LIMIT, up to ${MAX_LIMIT}.`,
    );
  }

  // Dedupe per draft, before grouping: which drafts share a note depends on
  // what this run's response held, so the group is not a stable identity.
  const announced = await announcedDraftIds(
    ctx,
    recent.map((p) => p.draftId),
  );
  const unannounced = recent.filter((p) => !announced.has(p.draftId));
  const groups = groupPosts(unannounced, config.groupWindowMinutes);

  const notes: NoteResult[] = [];
  let skipped = announced.size;

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

    const message = renderNote(group, {
      ...(config.slackChannel ? { channel: config.slackChannel } : {}),
      callToAction: config.callToAction,
      ...(isSummary(summary) ? { summary: summary.line } : { summaryError: summary.error }),
    });
    const platforms = notePlatforms(group);

    if (config.dryRun) {
      console.log(`[dry run] would post:\n${message.markdown ?? message.text}`);
      await releaseGroup(ctx, claims);
      notes.push({
        draftIds: group.draftIds,
        platforms,
        delivered: false,
        summarized: isSummary(summary),
      });
      continue;
    }

    let delivered = false;
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
      // Slack fell back to the console because no bot token and no webhook URL
      // is set. Nothing reached the channel, so leave the drafts unannounced.
      console.error(
        `[amplifier] Slack did not accept the note for ${group.draftIds.join(", ")}. Set ` +
          `SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL. A later run will retry.`,
      );
    }
    await releaseGroup(ctx, claims);
    notes.push({
      draftIds: group.draftIds,
      platforms,
      delivered,
      summarized: isSummary(summary),
    });
  }

  return {
    scanned: posts.length,
    inWindow: recent.length,
    groups: groups.length,
    notified: notes.filter((n) => n.delivered).length,
    skipped,
    dryRun: config.dryRun,
    notes,
  };
}

/** Announce newly published Render posts to Slack, once each. */
export const checkPosts = task({ name: "amplifier.checkPosts" }, checkPostsImpl);
