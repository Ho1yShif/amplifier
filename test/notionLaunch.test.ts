import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readLaunch } from "../src/notion/launch.js";
import { isLaunch, type NotionPage } from "../src/notion/types.js";

/** A page response shaped from Notion's documented page object. */
const PAGE: NotionPage = JSON.parse(
  readFileSync(new URL("./support/notion-page.json", import.meta.url), "utf8"),
);

const OPTS = { typefullyProperty: "Typefully", ownersProperty: "Owner" };

/** The fixture page with one property replaced, or dropped when it is null. */
function pageWith(name: string, value: unknown): NotionPage {
  const properties = { ...PAGE.properties };
  if (value === null) delete properties[name];
  else properties[name] = value as never;
  return { ...PAGE, properties };
}

describe("readLaunch", () => {
  it("reads the URL, the title and both owners", () => {
    const outcome = readLaunch(PAGE, OPTS);

    if (!isLaunch(outcome)) throw new Error(`expected a launch, got ${outcome.skip}`);
    expect(outcome.typefullyUrl).toBe("https://typefully.com/?d=10628613&a=1");
    expect(outcome.name).toBe("Origin is a supported Git provider");
    expect(outcome.owners.map((o) => o.email)).toEqual(["dana@render.com", "sam@render.com"]);
    expect(outcome.owners[0]?.name).toBe("Dana Reed");
    expect(outcome.pageUrl).toBe(PAGE.url);
  });

  it("skips a page whose Typefully URL is empty", () => {
    const outcome = readLaunch(pageWith("Typefully", { type: "url", url: null }), OPTS);
    expect(outcome).toEqual({ skip: "no-url" });
  });

  it("skips a page whose owner property is empty", () => {
    const outcome = readLaunch(pageWith("Owner", { type: "people", people: [] }), OPTS);
    expect(outcome).toEqual({ skip: "no-owners" });
  });

  it("skips a value in the URL property that is not a URL", () => {
    const outcome = readLaunch(pageWith("Typefully", { type: "url", url: "not scheduled" }), OPTS);
    expect(outcome).toEqual({ skip: "no-url" });
  });

  it("finds a property whose name only contains the configured one", () => {
    const renamed = pageWith("Typefully URL", PAGE.properties?.["Typefully"]);
    delete renamed.properties?.["Typefully"];

    const outcome = readLaunch(renamed, OPTS);

    expect(isLaunch(outcome)).toBe(true);
  });

  it("matches a property name that differs only in case", () => {
    const renamed = pageWith("owner", PAGE.properties?.["Owner"]);
    delete renamed.properties?.["Owner"];

    const outcome = readLaunch(renamed, OPTS);

    expect(isLaunch(outcome)).toBe(true);
  });

  it("keeps an owner Notion reports with no email", () => {
    const page = pageWith("Owner", {
      type: "people",
      people: [{ object: "user", id: "u1", name: "Dana Reed", type: "person", person: {} }],
    });

    const outcome = readLaunch(page, OPTS);

    if (!isLaunch(outcome)) throw new Error(`expected a launch, got ${outcome.skip}`);
    expect(outcome.owners).toEqual([{ notionUserId: "u1", name: "Dana Reed" }]);
  });

  it("reads an owner property that holds an address instead of a person", () => {
    const page = pageWith("Owner", { type: "email", email: "Dana@Render.com" });

    const outcome = readLaunch(page, OPTS);

    if (!isLaunch(outcome)) throw new Error(`expected a launch, got ${outcome.skip}`);
    expect(outcome.owners).toEqual([{ email: "dana@render.com" }]);
  });

  it("reads addresses out of an owner property somebody typed by hand", () => {
    const page = pageWith("Owner", {
      type: "rich_text",
      rich_text: [{ plain_text: "dana@render.com, sam@render.com" }],
    });

    const outcome = readLaunch(page, OPTS);

    if (!isLaunch(outcome)) throw new Error(`expected a launch, got ${outcome.skip}`);
    expect(outcome.owners.map((o) => o.email)).toEqual(["dana@render.com", "sam@render.com"]);
  });

  it("skips a page from another database when one is configured", () => {
    const outcome = readLaunch(PAGE, { ...OPTS, databaseId: "11111111111111111111111111111111" });
    expect(outcome).toEqual({ skip: "other-database" });
  });

  it("accepts the configured database id written without dashes", () => {
    const outcome = readLaunch(PAGE, {
      ...OPTS,
      databaseId: "7dabf9f3eeb64800bdf6b919611ff771",
    });
    expect(isLaunch(outcome)).toBe(true);
  });

  it("accepts a page whose parent reports no database id", () => {
    const page = { ...PAGE, parent: { type: "data_source", data_source_id: "ds_1" } };
    const outcome = readLaunch(page, { ...OPTS, databaseId: "7dabf9f3eeb64800bdf6b919611ff771" });
    expect(isLaunch(outcome)).toBe(true);
  });

  it("throws on a page response with no id, which is not a launch state", () => {
    const { id: _id, ...noId } = PAGE;
    expect(() => readLaunch(noId, OPTS)).toThrow(/no id/);
  });

  it("reports an empty title as an empty name rather than throwing", () => {
    const page = pageWith("Name", { type: "title", title: [] });

    const outcome = readLaunch(page, OPTS);

    if (!isLaunch(outcome)) throw new Error(`expected a launch, got ${outcome.skip}`);
    expect(outcome.name).toBe("");
  });
});
