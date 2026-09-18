import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, lock } from "@render-lab/tasks-render-kv";
import { repostedKey, repostInflightKey } from "./reposted.js";
import { type Claim, INFLIGHT_TTL_SECONDS, releaseClaim } from "./seen.js";

/**
 * Why a click did not claim the note.
 *
 * `reposted` means the note already has its marker. `in-flight` means another
 * click is posting the thread right now. Both mean this click must not post.
 */
export interface RepostClaimRefusal {
  reason: "reposted" | "in-flight";
}

export type RepostClaimOutcome = { claim: Claim } | RepostClaimRefusal;

/** Whether `claimNote` handed back the lock. */
export function isRepostClaimed(outcome: RepostClaimOutcome): outcome is { claim: Claim } {
  return "claim" in outcome;
}

/**
 * Take the repost lock on a note, or refuse.
 *
 * Lock first and marker second, the order `claimGroup` uses: a marker read
 * before the lock leaves a window where the other click writes its marker in
 * between. The lock is released again on a refusal and on a failed marker
 * read, so the next click can take it without waiting out the TTL.
 */
export async function claimNote(
  ctx: TaskContext,
  noteKey: string,
  token: string,
  ttlSeconds: number = INFLIGHT_TTL_SECONDS,
): Promise<RepostClaimOutcome> {
  const key = repostInflightKey(noteKey);
  const { acquired } = await ctx.run(lock, { key, token, ttlSeconds });
  if (!acquired) return { reason: "in-flight" };

  const claim: Claim = { key, token };
  let value: string | null;
  try {
    ({ value } = await ctx.run(kvGet, { key: repostedKey(noteKey) }));
  } catch (err) {
    await releaseClaim(ctx, claim);
    throw err;
  }
  if (value !== null) {
    await releaseClaim(ctx, claim);
    return { reason: "reposted" };
  }
  return { claim };
}
