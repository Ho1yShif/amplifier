import { compareTime } from "../time.js";
import type { Platform, PlatformLink, PublishedPost, TypefullyDraft } from "./types.js";

/** Per-platform field names, so the mapper reads both platforms one way. */
const PLATFORM_FIELDS: Record<
  Platform,
  { at: keyof TypefullyDraft; url: keyof TypefullyDraft; enabled: keyof TypefullyDraft }
> = {
  linkedin: {
    at: "linkedin_post_published_at",
    url: "linkedin_published_url",
    enabled: "linkedin_post_enabled",
  },
  x: { at: "x_post_published_at", url: "x_published_url", enabled: "x_post_enabled" },
};

/** A raw field's value when it is a non-empty string, else undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Map a raw Typefully draft to a PublishedPost, or null when it is not an
 * announcement: no id, or no X/LinkedIn platform with a publish timestamp.
 *
 * A platform counts as published on its own `*_post_published_at` or its
 * `*_published_url`, not on `*_post_enabled` — enabled means it was queued for
 * that platform, which is still true while the publish is in flight or after it
 * errored. A permalink only exists once the post is live. Typefully sets
 * `x_published_url` but never `x_post_published_at`, so X needs the URL rule.
 *
 * When a platform has a permalink but no timestamp of its own, the link takes
 * the draft's `published_at`. That is the draft's time rather than the
 * platform's, off by seconds in practice, which is well inside the grouping
 * window.
 *
 * `pending` lists the platforms `*_post_enabled` queued that have no permalink
 * yet, so the publish is still in flight. A platform can be in both `links` and
 * `pending` when Typefully sets the timestamp before the URL.
 */
export function mapDraft(raw: TypefullyDraft): PublishedPost | null {
  if (raw.id === undefined || raw.id === null || raw.id === "") return null;

  const links: PlatformLink[] = [];
  const pending: Platform[] = [];
  for (const platform of Object.keys(PLATFORM_FIELDS) as Platform[]) {
    const fields = PLATFORM_FIELDS[platform];
    const platformAt = str(raw[fields.at]);
    const url = str(raw[fields.url]);
    if (raw[fields.enabled] === true && url === undefined) pending.push(platform);
    if (platformAt === undefined && url === undefined) continue;
    const publishedAt = platformAt ?? str(raw.published_at);
    if (publishedAt === undefined) continue;
    links.push({
      platform,
      ...(url !== undefined ? { url } : {}),
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
    pending,
  };
}
