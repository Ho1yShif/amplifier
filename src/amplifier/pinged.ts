import type { TaskContext } from "@renderinc/sdk/workflows";
import { unlock } from "@render-lab/tasks-render-kv";
import { INFLIGHT_TTL_SECONDS } from "./seen.js";

/**
 * Keys for the Notion ping path.
 *
 * Separate from `seen.ts`: every key there is built from a Typefully draft id
 * and these are built from a Notion page id, so sharing the module would put
 * two kinds of id in one namespace.
 */

/** Key that records a page's owners as pinged. Written after Slack accepts. */
export function pingedKey(pageId: string): string {
  return `amplifier:pinged:${pageId}`;
}

/** Key one run holds while it is pinging a page's owners. */
export function pingInflightKey(pageId: string): string {
  return `amplifier:ping-inflight:${pageId}`;
}

/**
 * Release the in-flight lock so a later run can ping this page.
 *
 * A failed unlock is logged, not thrown. The lock expires on its own after
 * `INFLIGHT_TTL_SECONDS`, so releasing it early only brings the next attempt
 * forward, and a caller that is already throwing must not lose its error to a
 * cleanup failure.
 */
export async function releasePing(ctx: TaskContext, key: string, token: string): Promise<void> {
  try {
    await ctx.run(unlock, { key, token });
  } catch (err) {
    console.error(
      `[amplifier] Could not release the in-flight lock ${key}. It expires in ` +
        `${INFLIGHT_TTL_SECONDS}s and the next delivery retries the page.`,
      err,
    );
  }
}
