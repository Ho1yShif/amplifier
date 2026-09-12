import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, set as kvSet } from "@render-lab/tasks-render-kv";
import type { PostMessageInput } from "@render-lab/tasks-slack";

/**
 * A posted thread, kept so `amplifier.repost` can post it again.
 *
 * `amplifier.repost` needs the thread's content, and `@render-lab/tasks-slack`
 * 0.3.0 wraps no `conversations.replies` task, so reading the thread back from
 * Slack would mean a raw API call and a `channels:history` scope. `announce`
 * writes the rendered messages here instead, when it posts them.
 */
export interface StoredNote {
  parent: PostMessageInput;
  replies: PostMessageInput[];
}

/**
 * Key the posted thread is stored under. The button carries this string.
 *
 * Keyed by the group's drafts and not by the parent's `ts`, because the button
 * is built into the parent before it is posted and the `ts` only comes back
 * afterwards. Re-announcing the same drafts overwrites the record.
 */
export function noteKey(draftIds: string[]): string {
  return `amplifier:note:${draftIds.join("+")}`;
}

/** Store a posted thread under the announced marker's TTL. */
export async function storeNote(
  ctx: TaskContext,
  key: string,
  note: StoredNote,
  ttlSeconds: number,
): Promise<void> {
  await ctx.run(kvSet, { key, value: JSON.stringify(note), ttlSeconds });
}

/**
 * Read a stored thread back, or null when it is gone.
 *
 * The record carries the announced marker's TTL, so a miss means the note is
 * older than AMPLIFIER_SEEN_TTL_DAYS. Unparseable JSON reads as a miss, because
 * the only caller's answer to both is the same ephemeral message.
 */
export async function readNote(ctx: TaskContext, key: string): Promise<StoredNote | null> {
  const { value } = await ctx.run(kvGet, { key });
  if (value === null) return null;
  try {
    return JSON.parse(value) as StoredNote;
  } catch {
    console.error(`[amplifier] The stored note ${key} is not readable JSON.`);
    return null;
  }
}
