import { vi } from "vitest";
import type { NotionPort } from "../../src/notion/client.js";
import type { NotionPage } from "../../src/notion/types.js";

/**
 * A Notion port whose every method is a mock, so a test names only the calls
 * it cares about. The unnamed ones throw, which is how a test hears about a
 * call it did not expect.
 */
export function fakeNotion(overrides: Partial<NotionPort> = {}): NotionPort {
  const unexpected = <M extends keyof NotionPort>(method: M): NotionPort[M] =>
    vi.fn(async () => {
      throw new Error(`Unexpected Notion call: ${method}`);
    }) as NotionPort[M];
  return {
    getPage: unexpected("getPage"),
    getDatabase: unexpected("getDatabase"),
    getDataSource: unexpected("getDataSource"),
    queryDataSource: unexpected("queryDataSource"),
    ...overrides,
  };
}

/** A page carrying one Typefully URL, for the search tests. */
export function launchPage(id: string, url: string, property = "Typefully"): NotionPage {
  return { id, properties: { [property]: { type: "url", url } } };
}
