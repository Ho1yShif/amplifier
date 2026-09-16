import { describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { findLaunchesImpl } from "../src/notion/findLaunches.js";
import type { NotionDataSource, NotionDatabase } from "../src/notion/types.js";
import { fakeNotion, launchPage } from "./support/notionPort.js";

const DB: NotionDatabase = { id: "db_1", data_sources: [{ id: "ds_1", name: "Calendar" }] };
const SCHEMA: NotionDataSource = {
  id: "ds_1",
  properties: {
    Name: { type: "title" },
    "Typefully URL": { type: "url" },
    Owner: { type: "people" },
  },
};
const MATCH = launchPage("page_1", "https://typefully.com/t/abc123", "Typefully URL");

/** A port answering the three calls the search makes, with the match above. */
function port(overrides: Parameters<typeof fakeNotion>[0] = {}) {
  const queryDataSource = vi.fn(async (_dataSourceId: string, _body: unknown) => ({
    results: [MATCH],
  }));
  const notion = fakeNotion({
    getDatabase: vi.fn(async () => DB),
    getDataSource: vi.fn(async () => SCHEMA),
    queryDataSource,
    ...overrides,
  });
  return { deps: { notion }, queryDataSource };
}

const INPUT = {
  databaseId: "db_1",
  typefullyProperty: "Typefully",
  needles: ["https://typefully.com/t/abc123", "abc123"],
};

describe("findLaunchesImpl", () => {
  it("queries the database's first data source", async () => {
    const { deps, queryDataSource } = port();

    const { pages, truncated } = await findLaunchesImpl(fakeCtx(), INPUT, deps);

    expect(queryDataSource.mock.calls[0]?.[0]).toBe("ds_1");
    expect(pages).toEqual([MATCH]);
    expect(truncated).toBe(false);
  });

  it("filters on the property's real name and type", async () => {
    const { deps, queryDataSource } = port();

    await findLaunchesImpl(fakeCtx(), INPUT, deps);

    expect(queryDataSource.mock.calls[0]?.[1]).toEqual({
      filter: {
        or: [
          { property: "Typefully URL", url: { contains: "https://typefully.com/t/abc123" } },
          { property: "Typefully URL", url: { contains: "abc123" } },
        ],
      },
      page_size: 10,
    });
  });

  it("filters a text property as rich_text", async () => {
    const { deps, queryDataSource } = port({
      getDataSource: vi.fn(async () => ({
        properties: { Typefully: { type: "rich_text" } },
      })),
    });

    await findLaunchesImpl(fakeCtx(), INPUT, deps);

    const { filter } = queryDataSource.mock.calls[0]?.[1] as { filter: { or: unknown[] } };
    expect(filter.or[0]).toEqual({
      property: "Typefully",
      rich_text: { contains: INPUT.needles[0] },
    });
  });

  it("drops needles too short to identify a draft", async () => {
    const { deps, queryDataSource } = port();

    await findLaunchesImpl(fakeCtx(), { ...INPUT, needles: ["abc123", "7"] }, deps);

    const { filter } = queryDataSource.mock.calls[0]?.[1] as { filter: { or: unknown[] } };
    expect(filter.or).toHaveLength(1);
  });

  it("reports more matches than one query page holds", async () => {
    const { deps } = port({
      queryDataSource: vi.fn(async () => ({ results: [MATCH], has_more: true })),
    });

    const { truncated } = await findLaunchesImpl(fakeCtx(), INPUT, deps);

    expect(truncated).toBe(true);
  });

  it("returns no pages when nothing matches", async () => {
    const { deps } = port({ queryDataSource: vi.fn(async () => ({ results: [] })) });

    const { pages } = await findLaunchesImpl(fakeCtx(), INPUT, deps);

    expect(pages).toEqual([]);
  });

  it("names the first data source when the database has several", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { deps } = port({
        getDatabase: vi.fn(async () => ({
          data_sources: [
            { id: "ds_1", name: "Calendar" },
            { id: "ds_2", name: "Archive" },
          ],
        })),
      });

      await findLaunchesImpl(fakeCtx(), INPUT, deps);

      expect(log.mock.calls[0]?.[0]).toMatch(/Calendar/);
    } finally {
      log.mockRestore();
    }
  });

  it("throws when the database reports no data source", async () => {
    const { deps } = port({ getDatabase: vi.fn(async () => ({ id: "db_1" })) });

    await expect(findLaunchesImpl(fakeCtx(), INPUT, deps)).rejects.toThrow(/no data sources/);
  });

  it("throws when no property is named like the configured one", async () => {
    const { deps } = port({
      getDataSource: vi.fn(async () => ({ properties: { Name: { type: "title" } } })),
    });

    await expect(findLaunchesImpl(fakeCtx(), INPUT, deps)).rejects.toThrow(/No property named/);
  });

  it("throws when the property cannot be filtered by text", async () => {
    const { deps } = port({
      getDataSource: vi.fn(async () => ({ properties: { Typefully: { type: "formula" } } })),
    });

    await expect(findLaunchesImpl(fakeCtx(), INPUT, deps)).rejects.toThrow(/formula property/);
  });

  it("refuses an empty database id", async () => {
    const { deps } = port();

    await expect(findLaunchesImpl(fakeCtx(), { ...INPUT, databaseId: " " }, deps)).rejects.toThrow(
      /NOTION_DATABASE_ID/,
    );
  });

  it("refuses a needle list with nothing usable in it", async () => {
    const { deps } = port();

    await expect(findLaunchesImpl(fakeCtx(), { ...INPUT, needles: ["7"] }, deps)).rejects.toThrow(
      /at least one needle/,
    );
  });
});
