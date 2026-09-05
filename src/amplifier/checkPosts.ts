import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { postMessage } from "@render-lab/tasks-slack";
import { loadConfig, type CheckPostsInput } from "../config.js";
import { listPublished } from "../typefully/listPublished.js";
import type { Platform } from "../typefully/types.js";
import { groupPosts } from "./group.js";
import { claimGroup, releaseGroup } from "./seen.js";
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
  /** Published drafts Typefully returned. */
  scanned: number;
  /** Of those, the ones inside the lookback window. */
  inWindow: number;
  /** Announcements those posts collapsed into. */
  groups: number;
  notified: number;
  /** Groups a previous run already announced. */
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

  const { posts } = await ctx.run(listPublished, {
    ...(config.socialSetId ? { socialSetId: config.socialSetId } : {}),
    limit: config.limit,
  });

  const recent = withinWindow(posts, nowMs, config.lookbackMinutes);
  const groups = groupPosts(recent, config.groupWindowMinutes);

  const notes: NoteResult[] = [];
  let skipped = 0;

  for (const group of groups) {
    const claims = await claimGroup(ctx, group, config.seenTtlSeconds);
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
      // Release the claim so the first real run still announces this post.
      console.log(`[dry run] would post:\n${message.markdown ?? message.text}`);
      await releaseGroup(ctx, claims);
      notes.push({ draftIds: group.draftIds, platforms, delivered: false });
      continue;
    }

    try {
      const { delivered } = await ctx.run(postMessage, message);
      notes.push({ draftIds: group.draftIds, platforms, delivered });
    } catch (err) {
      await releaseGroup(ctx, claims);
      throw err;
    }
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
