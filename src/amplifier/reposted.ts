/**
 * Keys for the repost reminder.
 *
 * Separate from `remindRepost.ts`, because `amplifier.repost` writes the
 * reposted marker and importing the reminder task to reach the key would
 * register that task wherever the repost path is loaded.
 *
 * Both keys are built from the stored note's key, because the reminder and the
 * Repost button carry the same note key and different channel ids for the same
 * note. The reminder holds the id `chat.postMessage` echoed back and the button
 * holds the id in the click payload, so keying by channel reminded the channel
 * about notes somebody had already reposted.
 */

import { noteIds } from "./storedNote.js";

/**
 * Key `amplifier.repost` writes when a note has been reposted.
 *
 * A Key Value marker and not the note's reactions, because reading reactions
 * needs a `reactions:read` scope and a raw Slack call:
 * `@render-lab/tasks-slack` 0.3.0 wraps neither `reactions.get` nor
 * `conversations.replies`. A repost done by hand, without the button, writes no
 * marker and still gets a reminder.
 */
export function repostedKey(noteKey: string): string {
  return `amplifier:reposted:${noteIds(noteKey)}`;
}

/** Key the reminder writes before it posts, so one note gets one reminder. */
export function remindedKey(noteKey: string): string {
  return `amplifier:reminded:${noteIds(noteKey)}`;
}

/**
 * Key one click holds while it is reposting a note.
 *
 * Built from the note's drafts like the other two, so a click on the reminder
 * and a click on the parent contend for the same lock.
 */
export function repostInflightKey(noteKey: string): string {
  return `amplifier:repost-inflight:${noteIds(noteKey)}`;
}
