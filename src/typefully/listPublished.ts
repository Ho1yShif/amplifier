import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { defaultDeps, type TypefullyDeps } from "./client.js";
import { mapDraft } from "./map.js";
import { TYPEFULLY_RETRY } from "./retry.js";
import type { ListPublishedInput, ListPublishedResult, PublishedPost } from "./types.js";

/** Raw implementation of typefully.listPublished. */
export async function listPublishedImpl(
  ctx: TaskContext,
  input: ListPublishedInput,
  deps: TypefullyDeps = defaultDeps,
): Promise<ListPublishedResult> {
  const socialSetId = input.socialSetId ?? process.env.TYPEFULLY_SOCIAL_SET_ID;
  if (!socialSetId) {
    throw new Error(
      "No social set configured. Set TYPEFULLY_SOCIAL_SET_ID or pass { socialSetId }. " +
        "List yours with GET https://api.typefully.com/v2/social-sets.",
    );
  }

  const drafts = await deps.typefully.listPublishedDrafts(socialSetId, input.limit ?? 25);
  const posts = drafts
    .map(mapDraft)
    .filter((p): p is PublishedPost => p !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return { posts };
}

/** Published drafts for a Typefully social set, as platform-link DTOs. */
export const listPublished = task(
  { name: "typefully.listPublished", retry: TYPEFULLY_RETRY },
  listPublishedImpl,
);
