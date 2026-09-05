import { compareTime } from "../time.js";
import type { Platform, PlatformLink, PublishedPost, TypefullyDraft } from "./types.js";

/** Per-platform field names, so the mapper reads both platforms one way. */
const PLATFORM_FIELDS: Record<Platform, { at: keyof TypefullyDraft; url: keyof TypefullyDraft }> = {
  linkedin: { at: "linkedin_post_published_at", url: "linkedin_published_url" },
  x: { at: "x_post_published_at", url: "x_published_url" },
};

/**
 * Map a raw Typefully draft to a PublishedPost, or null when it is not an
 * announcement: no id, or no X/LinkedIn platform with a publish timestamp.
 *
 * A platform counts as published on its own `*_post_published_at`, not on
 * `*_post_enabled` — enabled means it was queued for that platform, which is
 * still true while the publish is in flight or after it errored.
 */
export function mapDraft(raw: TypefullyDraft): PublishedPost | null {
  if (raw.id === undefined || raw.id === null || raw.id === "") return null;

  const links: PlatformLink[] = [];
  for (const platform of Object.keys(PLATFORM_FIELDS) as Platform[]) {
    const fields = PLATFORM_FIELDS[platform];
    const publishedAt = raw[fields.at];
    if (typeof publishedAt !== "string" || publishedAt === "") continue;
    const url = raw[fields.url];
    links.push({
      platform,
      ...(typeof url === "string" && url !== "" ? { url } : {}),
      publishedAt,
    });
  }
  if (links.length === 0) return null;

  links.sort((a, b) => compareTime(a.publishedAt, b.publishedAt));
  const first = links[0];
  if (!first) return null;

  return {
    draftId: String(raw.id),
    preview: raw.preview ?? "",
    publishedAt: first.publishedAt,
    ...(raw.share_url ? { shareUrl: raw.share_url } : {}),
    links,
  };
}
