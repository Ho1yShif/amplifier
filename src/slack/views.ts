import type { FetchLike } from "@render-lab/tasks-core";
import { callSlack } from "./api.js";
import type { SlackView } from "./editModal.js";

/**
 * Open a modal on a `trigger_id`.
 *
 * Called from the HTTP handler, because a `trigger_id` expires in three seconds
 * and starting a workflow run first would spend that budget. `view` is a JSON
 * string, because `callSlack` posts form-encoded.
 */
export async function openView(
  triggerId: string,
  view: SlackView,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<{ opened: true } | { opened: false; error: string }> {
  const body = await callSlack(
    "views.open",
    { trigger_id: triggerId, view: JSON.stringify(view) },
    opts,
  );
  if (body.ok !== true) return { opened: false, error: body.error ?? "unknown_error" };
  return { opened: true };
}
