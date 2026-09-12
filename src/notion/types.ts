// JSON-serializable DTOs for the notion.* tasks.

/**
 * A Notion user as a people property reports it.
 *
 * `person.email` is present only when the integration has the "Read user
 * information, including email addresses" capability. Without it Notion omits the
 * field and returns no error, so a missing email reads the same as a person
 * who has none.
 */
export interface NotionUser {
  object?: string;
  id?: string;
  name?: string | null;
  type?: string;
  person?: { email?: string | null };
}

/** One rich-text span, of which amplifier reads only the plain text. */
export interface NotionRichText {
  plain_text?: string;
}

/**
 * One property value on a page, covering the four types amplifier reads.
 *
 * Notion keys a page's properties by name and tags each value with its own
 * `type`, so this is the union of every shape flattened into optional fields —
 * the same convention `TypefullyDraft` uses.
 */
export interface NotionPropertyValue {
  id?: string;
  type?: string;
  url?: string | null;
  email?: string | null;
  people?: NotionUser[];
  rich_text?: NotionRichText[];
  title?: NotionRichText[];
}

/** A page's parent, read only to check the page came from the launch database. */
export interface NotionParent {
  type?: string;
  database_id?: string;
  /** Notion 2025-09-03 parents a page on a data source inside the database. */
  data_source_id?: string;
  page_id?: string;
}

/**
 * Notion's page response, as far as amplifier reads it. Every field is
 * optional because Notion adds fields over time and a missing one must not
 * throw — `readLaunch` decides what is usable.
 */
export interface NotionPage {
  object?: string;
  id?: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: NotionParent;
  properties?: Record<string, NotionPropertyValue>;
}

/** One property as the data source's schema reports it. */
export interface NotionPropertySchema {
  id?: string;
  name?: string;
  type?: string;
}

/** A data source under a database, as the database response lists it. */
export interface NotionDataSourceRef {
  id?: string;
  name?: string;
}

/**
 * Notion's database response. Since 2025-09-03 a database holds one or more
 * data sources, and a query goes to a data source rather than the database.
 */
export interface NotionDatabase {
  id?: string;
  data_sources?: NotionDataSourceRef[];
}

/** A data source, read only for its property schema. */
export interface NotionDataSource {
  id?: string;
  properties?: Record<string, NotionPropertySchema>;
}

/** One page of query results. */
export interface QueryResult {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface GetPageInput {
  pageId: string;
}

export interface GetPageResult {
  page: NotionPage;
}

export interface FindLaunchesInput {
  /** The launch database. Its first data source is the one queried. */
  databaseId: string;
  /** Display name of the property holding the Typefully link. Matched loosely. */
  typefullyProperty: string;
  /** Strings to look for inside that property. A page matching any one is returned. */
  needles: string[];
}

export interface FindLaunchesResult {
  /** Every page whose Typefully property contains one of the needles. */
  pages: NotionPage[];
  /** True when the database holds more matches than one query page returned. */
  truncated: boolean;
}

/** One person named by the page's owner property. */
export interface Owner {
  /** Absent when the owner property holds an address rather than a Notion person. */
  notionUserId?: string;
  name?: string;
  /** Absent when the integration cannot read emails, or the owner has none. */
  email?: string;
}

/** A launch page that carries a Typefully URL and at least one owner. */
export interface Launch {
  pageId: string;
  /** The page's title, or "" when the title is empty. */
  name: string;
  typefullyUrl: string;
  /** The page's own Notion URL, for the DM to link back to. */
  pageUrl?: string;
  owners: Owner[];
}

/** Why a page produces no DMs. Both reasons are the normal state of a launch page. */
export interface LaunchSkip {
  skip: "no-url" | "no-owners" | "other-database";
}

export type LaunchOutcome = Launch | LaunchSkip;

/** Whether `readLaunch` found a page worth pinging. */
export function isLaunch(outcome: LaunchOutcome): outcome is Launch {
  return !("skip" in outcome);
}
