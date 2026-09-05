import { randomUUID } from "node:crypto";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { postMessage } from "@render-lab/tasks-slack";
import { loadConfig, type CheckPostsInput } from "../config.js";
import { listPublished } from "../typefully/listPublished.js";
import type { Platform } from "../typefully/types.js";
import { groupPosts } from "./group.js";
import { announcedDraftIds, claimGroup, markAnnounced, releaseGroup } from "./seen.js";
import { notePlatforms, renderNote } from "./template.js";
import { withinWindow } from "./window.js";

/** One announcement's outcome. */
export interface NoteResult {
  draftIds: string[];
  platforms: Platform[];
  /** false in dry run, and false when Slack fell back to the console. */
  delivered: boolean;
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
   * Announcements this run did not make: drafts an earlier run already
   * announced, plus groups another run is announcing right now.
   */
  skipped: number;
  dryRun: boolean;
  notes: NoteResult[];
}

/** Raw implementation of amplifier.checkPosts. */
export async function checkPostsImpl(
  ctx: TaskContext,
  input: CheckPostsInput = {},
): Promise<CheckPostsResult> {
  const config = loadConfig(input);
  const nowMs = input.now ? Date.parse(input.now) : Date.now();

  // Unique per invocation and stable within it. The SDK 1.0 TaskContext exposes
  // no run id, and the in-flight lock only has to tell this run's lock from
  // another run's.
  const runToken = `amplifier:run:${randomUUID()}`;

  const { posts } = await ctx.run(listPublished, {
    ...(config.socialSetId ? { socialSetId: config.socialSetId } : {}),
    limit: config.limit,
  });

  const recent = withinWindow(posts, nowMs, config.lookbackMinutes);

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
    const claims = await claimGroup(ctx, group, runToken);
    if (claims === null) {
      skipped += 1;
      continue;
    }

    const message = renderNote(group, {
      ...(config.slackChannel ? { channel: config.slackChannel } : {}),
      callToAction: config.callToAction,
    });
    const platforms = notePlatforms(group);

    if (config.dryRun) {
      console.log(`[dry run] would post:\n${message.markdown ?? message.text}`);
      await releaseGroup(ctx, claims);
      notes.push({ draftIds: group.draftIds, platforms, delivered: false });
      continue;
    }

    let delivered = false;
    try {
      ({ delivered } = await ctx.run(postMessage, message));
    } catch (err) {
      await releaseGroup(ctx, claims);
      throw err;
    }

    if (delivered) {
      await markAnnounced(ctx, group.draftIds, config.seenTtlSeconds);
    } else {
      // Slack fell back to the console because no bot token and no webhook URL
      // is set. Nothing reached the channel, so leave the drafts unannounced.
      console.error(
        `[amplifier] Slack did not accept the note for ${group.draftIds.join(", ")}. Set ` +
          `SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL. A later run will retry.`,
      );
    }
    await releaseGroup(ctx, claims);
    notes.push({ draftIds: group.draftIds, platforms, delivered });
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
