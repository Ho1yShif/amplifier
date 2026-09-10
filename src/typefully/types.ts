// JSON-serializable DTOs for the typefully.* tasks.

/** The two platforms amplifier announces. Typefully supports more; we ignore them. */
export type Platform = "x" | "linkedin";

/** One platform a draft actually went live on. */
export interface PlatformLink {
  platform: Platform;
  /** Permalink to the live post. Absent when Typefully has not reported one yet. */
  url?: string;
  /** ISO 8601 timestamp this platform published at, or the draft's when it reports none. */
  publishedAt: string;
}

/** A Typefully draft that went live on at least one platform we care about. */
export interface PublishedPost {
  draftId: string;
  /** Typefully's 100-char smart-trimmed text preview. */
  preview: string;
  /** Earliest publish time across `links`. */
  publishedAt: string;
  /** Typefully's public share URL, used as a fallback when a permalink is missing. */
  shareUrl?: string;
  /** One entry per platform that published. Never empty. */
  links: PlatformLink[];
}

/**
 * Typefully's draft response, covering both the fields amplifier reads and
 * the ones it deliberately ignores. Every field is optional because the API
 * adds fields over time and a missing one must not throw — `mapDraft`
 * decides what is usable.
 */
export interface TypefullyDraft {
  id?: string | number;
  preview?: string;
  /** Not read. `mapDraft` decides a platform published from its own fields. */
  status?: string;
  /** The draft's publish time. Used as a link's timestamp when the platform has none. */
  published_at?: string | null;
  share_url?: string | null;
  /** Not read. `mapDraft` uses `x_published_url` to decide whether X published. */
  x_post_enabled?: boolean;
  x_post_published_at?: string | null;
  x_published_url?: string | null;
  /**
   * Not read. `mapDraft` uses `linkedin_post_published_at` or
   * `linkedin_published_url` to decide whether LinkedIn published.
   */
  linkedin_post_enabled?: boolean;
  linkedin_post_published_at?: string | null;
  linkedin_published_url?: string | null;
}

export interface ListPublishedInput {
  /** Typefully social set to read. Defaults to env TYPEFULLY_SOCIAL_SET_ID. */
  socialSetId?: string;
  /** Max drafts to pull in one call. Default 25. */
  limit?: number;
}

export interface ListPublishedResult {
  posts: PublishedPost[];
}
