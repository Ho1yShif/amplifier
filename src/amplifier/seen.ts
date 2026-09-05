import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, lock, set as kvSet, unlock } from "@render-lab/tasks-render-kv";
import type { PostGroup } from "./group.js";

/** A Key Value in-flight lock this run holds on one draft. */
export interface Claim {
  key: string;
  token: string;
}

/**
 * How long an in-flight lock survives without being released. A run that dies
 * between the lock and the Slack post leaves the lock behind, so the TTL is
 * short enough that the next cron run retries the draft.
 */
export const INFLIGHT_TTL_SECONDS = 300;

/** Key that records a draft as announced. Written after Slack accepts the note. */
export function seenKey(draftId: string): string {
  return `amplifier:seen:${draftId}`;
}

/** Key one run holds while it is announcing a draft. */
export function inflightKey(draftId: string): string {
  return `amplifier:inflight:${draftId}`;
}

/**
 * Which of these drafts an earlier run already announced.
 *
 * Read this before grouping. Group membership depends on what Typefully
 * returned on this run, so it is not stable across runs and cannot be the unit
 * of dedupe. A draft is.
 */
export async function announcedDraftIds(
  ctx: TaskContext,
  draftIds: string[],
): Promise<Set<string>> {
  const announced = new Set<string>();
  for (const draftId of draftIds) {
    const { value } = await ctx.run(kvGet, { key: seenKey(draftId) });
    if (value !== null) announced.add(draftId);
  }
  return announced;
}

/**
 * Take an in-flight lock on every draft in the group, or nothing.
 *
 * Returns the claims on success and `null` when another run holds a lock and is
 * announcing one of these drafts right now. `token` is unique per run, so a
 * failed `kv.lock` always means someone else. Locks already taken are released
 * before giving up.
 */
export async function claimGroup(
  ctx: TaskContext,
  group: PostGroup,
  token: string,
  ttlSeconds: number = INFLIGHT_TTL_SECONDS,
): Promise<Claim[] | null> {
  const claims: Claim[] = [];

  for (const draftId of group.draftIds) {
    const key = inflightKey(draftId);
    const { acquired } = await ctx.run(lock, { key, token, ttlSeconds });
    if (!acquired) {
      await releaseGroup(ctx, claims);
      return null;
    }
    claims.push({ key, token });
  }

  return claims;
}

/**
 * Record every draft in the group as announced, with the 30-day TTL.
 *
 * Call this only after `slack.postMessage` reports the note delivered. The
 * marker is separate from the in-flight lock, so a lock left behind by a
 * crashed run never reads as a completed announcement.
 */
export async function markAnnounced(
  ctx: TaskContext,
  draftIds: string[],
  ttlSeconds: number,
): Promise<void> {
  for (const draftId of draftIds) {
    await ctx.run(kvSet, { key: seenKey(draftId), value: "announced", ttlSeconds });
  }
}

/** Release in-flight locks so a later run can announce these drafts. */
export async function releaseGroup(ctx: TaskContext, claims: Claim[]): Promise<void> {
  for (const claim of claims) {
    await ctx.run(unlock, { key: claim.key, token: claim.token });
  }
}
