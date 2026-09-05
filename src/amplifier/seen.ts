import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, lock, unlock } from "@render-lab/tasks-render-kv";
import type { PostGroup } from "./group.js";

/** A Key Value claim this run holds on one draft. */
export interface Claim {
  key: string;
  token: string;
}

/** Key that records a draft as announced. */
export function seenKey(draftId: string): string {
  return `amplifier:seen:${draftId}`;
}

/**
 * Fencing token for a group, derived from its sorted draft ids so every attempt
 * at the same announcement produces the same token.
 */
export function groupToken(group: PostGroup): string {
  return `amplifier:${[...group.draftIds].sort().join("+")}`;
}

/**
 * Claim every draft in the group, or nothing.
 *
 * Returns the claims on success and `null` when the group was already
 * announced. A failed `kv.lock` is ambiguous — another run may hold the key, or
 * this run may have claimed it and crashed before posting — so the stored token
 * is read to tell the two apart. Claims already taken are released before
 * giving up, so the next run can retry the drafts that are still unannounced.
 */
export async function claimGroup(
  ctx: TaskContext,
  group: PostGroup,
  ttlSeconds: number,
): Promise<Claim[] | null> {
  const token = groupToken(group);
  const claims: Claim[] = [];

  for (const draftId of group.draftIds) {
    const key = seenKey(draftId);
    const { acquired } = await ctx.run(lock, { key, token, ttlSeconds });
    if (acquired) {
      claims.push({ key, token });
      continue;
    }

    const { value } = await ctx.run(kvGet, { key });
    if (value === token) {
      claims.push({ key, token });
      continue;
    }

    await releaseGroup(ctx, claims);
    return null;
  }

  return claims;
}

/** Release claims so a later run can announce these drafts. */
export async function releaseGroup(ctx: TaskContext, claims: Claim[]): Promise<void> {
  for (const claim of claims) {
    await ctx.run(unlock, { key: claim.key, token: claim.token });
  }
}
