import type { Launch, LaunchOutcome, NotionPage, NotionPropertyValue, Owner } from "./types.js";

export interface ReadLaunchOptions {
  /** Name of the URL property holding the Typefully link. */
  typefullyProperty: string;
  /** Name of the property naming the launch's owners. */
  ownersProperty: string;
  /** Launch database id. Unset means accept a page from any database. */
  databaseId?: string;
}

/** Addresses inside a text property, for an owner field that is free text. */
const EMAIL_PATTERN = /[^\s<>,;:"']+@[^\s<>,;:"']+\.[a-z]{2,}/gi;

/** A Notion id with its dashes and case dropped, so two spellings compare equal. */
function normalizeId(value: string | undefined | null): string | undefined {
  const id = value?.replace(/-/g, "").trim().toLowerCase();
  return id || undefined;
}

/** A property value's text, joined across its rich-text spans. */
function plainText(value: NotionPropertyValue): string {
  const spans = value.title ?? value.rich_text ?? [];
  return spans
    .map((span) => span.plain_text ?? "")
    .join("")
    .trim();
}

/**
 * The key under which a property lives, matched loosely.
 *
 * Notion keys `properties` by the property's display name, so the exact
 * spelling is configuration rather than a constant. An exact match is tried
 * first, then a case-insensitive one, then any property of the right type
 * whose name contains the configured one or is contained by it. The loose
 * match is what lets `Typefully` find a column somebody renamed to
 * `Typefully URL` without a redeploy.
 *
 * Returns the key rather than the value, because a data source's schema is
 * keyed by name too and a query filter names the property by its exact name.
 */
export function matchPropertyName<T extends { type?: string }>(
  properties: Record<string, T>,
  name: string,
  types: string[],
): string | undefined {
  if (properties[name]) return name;

  const wanted = name.trim().toLowerCase();
  const entries = Object.entries(properties);
  const sameName = entries.find(([key]) => key.trim().toLowerCase() === wanted);
  if (sameName) return sameName[0];

  const sameType = entries.find(([key, value]) => {
    if (!value.type || !types.includes(value.type)) return false;
    const candidate = key.trim().toLowerCase();
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  return sameType?.[0];
}

/** The property value a name refers to, matched by {@link matchPropertyName}. */
function findProperty(
  properties: Record<string, NotionPropertyValue>,
  name: string,
  types: string[],
): NotionPropertyValue | undefined {
  const key = matchPropertyName(properties, name, types);
  return key === undefined ? undefined : properties[key];
}

/** The page's title, or "" when it has none. */
function pageTitle(properties: Record<string, NotionPropertyValue>): string {
  const title = Object.values(properties).find((value) => value.type === "title");
  return title ? plainText(title) : "";
}

/** The Typefully link on the page, from a url property or from text. */
function typefullyUrl(value: NotionPropertyValue | undefined): string | undefined {
  if (!value) return undefined;
  const url = value.url?.trim() || plainText(value);
  if (!url) return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * The Typefully link on a page, or undefined when it carries none.
 *
 * Exported for the URL search, which ranks the pages a query returned without
 * caring whether they have owners yet.
 */
export function readTypefullyUrl(page: NotionPage, property: string): string | undefined {
  return typefullyUrl(findProperty(page.properties ?? {}, property, ["url", "rich_text"]));
}

/**
 * The owners a property names.
 *
 * A people property is the shape this was built for, and each entry carries an
 * email only when the integration has the user-email capability. An email or
 * text property is accepted too, because an owner field somebody typed by hand
 * still resolves to a Slack user.
 */
function readOwners(value: NotionPropertyValue | undefined): Owner[] {
  if (!value) return [];

  if (value.people?.length) {
    return value.people.flatMap((person) => {
      const id = person.id?.trim();
      const name = person.name?.trim();
      const email = person.person?.email?.trim();
      if (!id && !name && !email) return [];
      return [
        {
          ...(id ? { notionUserId: id } : {}),
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
        },
      ];
    });
  }

  const text = value.email?.trim() || plainText(value);
  const emails = text.match(EMAIL_PATTERN) ?? [];
  return emails.map((email) => ({ email: email.toLowerCase() }));
}

/**
 * Read a launch out of a Notion page, or name why it produces no DMs.
 *
 * A page with no Typefully URL is the usual state of a launch page, and a page
 * whose owner property is empty is the second-most usual, so both are skips
 * rather than errors. Owners with no email are kept, and
 * `amplifier.pingOwners` logs them as unreachable.
 */
export function readLaunch(page: NotionPage, opts: ReadLaunchOptions): LaunchOutcome {
  const pageId = page.id?.trim();
  if (!pageId) {
    throw new Error("The Notion page response carried no id, so there is nothing to ping about.");
  }

  // Only checked when the page reports a database parent. Notion 2025-09-03
  // parents a page on a data source, whose id is not the database's, so a page
  // with no `database_id` is accepted rather than skipped.
  const wantedDatabase = normalizeId(opts.databaseId);
  const parentDatabase = normalizeId(page.parent?.database_id);
  if (wantedDatabase && parentDatabase && parentDatabase !== wantedDatabase) {
    return { skip: "other-database" };
  }

  const properties = page.properties ?? {};
  const url = typefullyUrl(findProperty(properties, opts.typefullyProperty, ["url", "rich_text"]));
  if (!url) return { skip: "no-url" };

  const owners = readOwners(
    findProperty(properties, opts.ownersProperty, ["people", "email", "rich_text"]),
  );
  if (owners.length === 0) return { skip: "no-owners" };

  const launch: Launch = {
    pageId,
    name: pageTitle(properties),
    typefullyUrl: url,
    ...(page.url ? { pageUrl: page.url } : {}),
    owners,
  };
  return launch;
}
