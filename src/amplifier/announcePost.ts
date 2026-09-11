import { randomUUID } from "node:crypto";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { deleteKeys, get as kvGet } from "@render-lab/tasks-render-kv";
import { loadConfig, MAX_LIMIT } from "../config.js";
import { listPublished } from "../typefully/listPublished.js";
import type { PublishedPost } from "../typefully/types.js";
import { announceGroups, type NoteResult } from "./announce.js";
import { groupPosts } from "./group.js";
import { seenKey } from "./seen.js";

export interface AnnouncePostInput {
  /** Permalink to the live post, X or LinkedIn. Either this or draftId. */
  url?: string;
  /** Typefully draft id, when the URL is not to hand. */
  draftId?: string;
  /** Announce a draft the seen marker already records. Re-posts the note. */
  force?: boolean;
  dryRun?: boolean;
  slackChannel?: string;
}

export interface AnnouncePostResult {
  draftId: string;
  dryRun: boolean;
  /** Absent when the draft was already announced and force was not set. */
  note?: NoteResult;
  /** Set when nothing was posted, naming why. */
  skipped?: "announced" | "claimed";
}

/** The draft matching the input, by draft id when given and otherwise by permalink. */
function findPost(posts: PublishedPost[], input: AnnouncePostInput): PublishedPost | undefined {
  if (input.draftId !== undefined) {
    return posts.find((p) => p.draftId === input.draftId);
  }
  return posts.find((p) => p.links.some((l) => l.url === input.url));
}

/** Raw implementation of amplifier.announcePost. */
export async function announcePostImpl(
  ctx: TaskContext,
  input: AnnouncePostInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnnouncePostResult> {
  if (input.url === undefined && input.draftId === undefined) {
    throw new Error("Pass the post's permalink as url, or its Typefully id as draftId.");
  }

  const config = loadConfig(
    {
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.slackChannel !== undefined ? { slackChannel: input.slackChannel } : {}),
    },
    env,
  );

  // Fifty is the widest Typefully allows, and this task runs once, by hand.
  const { posts } = await ctx.run(listPublished, {
    ...(config.socialSetId ? { socialSetId: config.socialSetId } : {}),
    limit: MAX_LIMIT,
  });

  const post = findPost(posts, input);
  if (!post) {
    const target = input.draftId !== undefined ? `draft ${input.draftId}` : `${input.url}`;
    throw new Error(
      `No published draft matches ${target} among the newest ${posts.length} Typefully ` +
        `returned. The post may be older than those, or its permalink may not be on X or ` +
        `LinkedIn.`,
    );
  }

  const key = seenKey(post.draftId);
  const { value } = await ctx.run(kvGet, { key });
  if (value !== null) {
    if (!input.force) {
      console.log(
        `[amplifier] Draft ${post.draftId} is already announced. Pass force: true to re-post it.`,
      );
      return { draftId: post.draftId, dryRun: config.dryRun, skipped: "announced" };
    }
    await ctx.run(deleteKeys, { keys: [key] });
    console.log(`[amplifier] Cleared the announced marker for draft ${post.draftId}.`);
  }

  // A group window of 0, so a cross-posted draft still makes one note holding
  // both permalinks and no neighbouring draft joins it.
  const groups = groupPosts([post], 0);
  const runToken = `amplifier:run:${randomUUID()}`;
  const { notes } = await announceGroups(ctx, groups, config, runToken);

  const note = notes[0];
  if (!note) {
    // Another run holds the claim and is posting the same note right now.
    return { draftId: post.draftId, dryRun: config.dryRun, skipped: "claimed" };
  }
  return { draftId: post.draftId, dryRun: config.dryRun, note };
}

/**
 * Announce one published post to Slack, given its permalink.
 *
 * No retry policy, matching `amplifier.checkPosts`. A human is watching this
 * one, and a retry after a delivered note would read its own marker and do
 * nothing useful.
 */
export const announcePost = task({ name: "amplifier.announcePost" }, announcePostImpl);
