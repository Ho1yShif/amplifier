import type { PostMessageInput } from "@render-lab/tasks-slack";
import { section, THREAD_MARKER } from "./template.js";

/**
 * The line `renderParent` adds under the lead when the model wrote no summary.
 *
 * An edited note's lead line was written by a person, so the reason the model
 * did not write one no longer belongs under it.
 */
const FAILURE_LINE = /^_\(Summarization LLM call failed:.*\)_$/;

/** Index of the first section block, or -1. */
function sectionIndex(message: PostMessageInput): number {
  return (message.blocks ?? []).findIndex((block) => block["type"] === "section");
}

/**
 * The first section block's mrkdwn.
 *
 * The block's `text.text` is read through a cast, the way `announce.ts` reads
 * it for the dry-run log: `SlackBlock` is an index type, so the nested field
 * carries no type of its own.
 */
function sectionText(message: PostMessageInput, index: number): string | undefined {
  const block = (message.blocks ?? [])[index];
  const text = (block as { text?: { text?: unknown } } | undefined)?.text?.text;
  return typeof text === "string" ? text : undefined;
}

/**
 * A note's lead line: the summary or the call to action, without the 🧵.
 *
 * Read from the rendered message and not from the group that produced it,
 * because nothing stores the group. The modal prefills from this, and so does
 * nothing else.
 */
export function leadOf(message: PostMessageInput): string | undefined {
  const index = sectionIndex(message);
  if (index === -1) return undefined;
  const text = sectionText(message, index);
  if (text === undefined) return undefined;
  const first = text.split("\n")[0] ?? "";
  const lead = first.endsWith(THREAD_MARKER) ? first.slice(0, -THREAD_MARKER.length) : first;
  return lead === "" ? undefined : lead;
}

/**
 * The same note with a new lead line, or null when it has no section block.
 *
 * Only the first line of the first section block changes. The links, the
 * quoted preview and the dropped-platform line are the run's own record of what
 * Typefully published, so an edit must not touch them. The buttons are an
 * actions block and survive untouched for the same reason.
 *
 * `text` is the notification fallback and carries no marker, matching what
 * `renderParent` writes.
 */
export function withLead(message: PostMessageInput, lead: string): PostMessageInput | null {
  const index = sectionIndex(message);
  const text = sectionText(message, index);
  if (index === -1 || text === undefined) return null;

  const lines = text.split("\n");
  const marker = (lines[0] ?? "").endsWith(THREAD_MARKER) ? THREAD_MARKER : "";
  const rest = lines.slice(1).filter((line) => !FAILURE_LINE.test(line));

  const blocks = [...(message.blocks ?? [])];
  blocks[index] = section([`${lead}${marker}`, ...rest].join("\n"));
  return { ...message, text: lead, blocks };
}
