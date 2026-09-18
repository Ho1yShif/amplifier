import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { SLACK_RETRY, type SlackBlock } from "@render-lab/tasks-slack";
import { callSlack } from "./api.js";

export interface UpdateNoteInput {
  /** Channel the note is in, as an id. */
  channel: string;
  /** The note's `ts`. */
  messageTs: string;
  /** The new notification fallback. */
  text: string;
  /** The new blocks. Omitted leaves Slack rendering `text` alone. */
  blocks?: SlackBlock[];
}

/** Whether the note was rewritten, or the Slack error code that says why not. */
export type UpdateNoteResult = { updated: true } | { updated: false; error: string };

/**
 * Raw implementation of amplifier.updateNote.
 *
 * `@render-lab/tasks-slack` 0.3.0 wraps no `chat.update`, so this goes through
 * `callSlack` and keeps SLACK_API_BASE_URL pointing it at the local stub.
 *
 * The bot token, not the editor's. The bot posted the note, and `chat.update`
 * only rewrites a message the calling token authored.
 *
 * An `ok: false` body is returned rather than thrown, matching
 * `amplifier.messageLink`: `message_not_found` is an answer about one message,
 * and the editor is told it instead of watching the run retry.
 */
export async function updateNoteImpl(
  _ctx: TaskContext,
  input: UpdateNoteInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateNoteResult> {
  const body = await callSlack(
    "chat.update",
    {
      channel: input.channel,
      ts: input.messageTs,
      text: input.text,
      ...(input.blocks ? { blocks: JSON.stringify(input.blocks) } : {}),
    },
    { env },
  );
  if (body.ok !== true) return { updated: false, error: body.error ?? "unknown_error" };
  return { updated: true };
}

/** Rewrite one posted note in place. */
export const updateNote = task(
  { name: "amplifier.updateNote", retry: SLACK_RETRY },
  updateNoteImpl,
);
