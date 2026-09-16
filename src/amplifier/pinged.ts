/**
 * Keys for the Notion ping path.
 *
 * Separate from `seen.ts`: every key there is built from a Typefully draft id
 * and these are built from a Notion page id, so sharing the module would put
 * two kinds of id in one namespace.
 */

/** Key that records a page's owners as pinged. Written after Slack accepts. */
export function pingedKey(pageId: string): string {
  return `amplifier:pinged:${pageId}`;
}

/** Key one run holds while it is pinging a page's owners. */
export function pingInflightKey(pageId: string): string {
  return `amplifier:ping-inflight:${pageId}`;
}
