import { vi } from "vitest";
import type { NotionPort } from "../../src/notion/client.js";
import type { NotionPage } from "../../src/notion/types.js";

/**
 * A Notion port whose every method is a mock, so a test names only the calls
 * it cares about. The unnamed ones throw, which is how a test hears about a
 * call it did not expect.
 */
export function fakeNotion(overrides: Partial<NotionPort> = {}): NotionPort {
  const unexpected = (method: string) =>
    vi.fn(async () => {
      throw new Error(`Unexpected Notion call: ${method}`);
    });
  return {
    getPage: overrides.getPage ?? (unexpected("getPage") as NotionPort["getPage"]),
    getDatabase: overrides.getDatabase ?? (unexpected("getDatabase") as NotionPort["getDatabase"]),
    getDataSource:
      overrides.getDataSource ?? (unexpected("getDataSource") as NotionPort["getDataSource"]),
    queryDataSource:
      overrides.queryDataSource ?? (unexpected("queryDataSource") as NotionPort["queryDataSource"]),
  };
}

/** A page carrying one Typefully URL, for the search tests. */
export function launchPage(id: string, url: string, property = "Typefully"): NotionPage {
  return { id, properties: { [property]: { type: "url", url } } };
}
