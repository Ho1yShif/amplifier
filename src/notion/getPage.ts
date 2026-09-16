import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { defaultDeps, type NotionDeps } from "./client.js";
import { NOTION_RETRY } from "./retry.js";
import type { GetPageInput, GetPageResult } from "./types.js";

/** Raw implementation of notion.getPage. */
export async function getPageImpl(
  _ctx: TaskContext,
  input: GetPageInput,
  deps: NotionDeps = defaultDeps,
): Promise<GetPageResult> {
  if (!input.pageId) {
    throw new Error("Pass the Notion page id as pageId.");
  }
  const page = await deps.notion.getPage(input.pageId);
  return { page };
}

/** One Notion page and its properties. */
export const getPage = task({ name: "notion.getPage", retry: NOTION_RETRY }, getPageImpl);
