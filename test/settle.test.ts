import { describe, expect, it } from "vitest";
import { pendingForDraft, settleDeadlineMs } from "../src/amplifier/settle.js";
import { post } from "./support/fixtures.js";

const EVENT_AT = "2026-09-04T15:00:00Z";
const EVENT_MS = Date.parse(EVENT_AT);

describe("settleDeadlineMs", () => {
  it("puts the deadline settleMinutes after the event", () => {
    expect(settleDeadlineMs(EVENT_AT, 10)).toBe(EVENT_MS + 600_000);
  });

  it("returns a deadline in the future for an event that just arrived", () => {
    expect(settleDeadlineMs(new Date().toISOString(), 10)).toBeGreaterThan(Date.now());
  });

  it("returns a deadline in the past for an old event", () => {
    expect(settleDeadlineMs("2020-01-01T00:00:00Z", 10)).toBeLessThan(Date.now());
  });

  it("makes the deadline the event time when settleMinutes is zero", () => {
    expect(settleDeadlineMs(EVENT_AT, 0)).toBe(EVENT_MS);
  });

  it("throws on an eventAt that will not parse", () => {
    expect(() => settleDeadlineMs("not a time", 10)).toThrow(/not a parseable timestamp/);
  });
});

describe("pendingForDraft", () => {
  const posts = [
    post("1", EVENT_AT, ["linkedin"], { pending: ["x"] }),
    post("2", EVENT_AT, ["x", "linkedin"]),
  ];

  it("returns the pending platforms of an incomplete draft", () => {
    expect(pendingForDraft(posts, "1")).toEqual(["x"]);
  });

  it("returns [] for a complete draft", () => {
    expect(pendingForDraft(posts, "2")).toEqual([]);
  });

  it("returns [] for a draft id that is not in posts", () => {
    expect(pendingForDraft(posts, "404")).toEqual([]);
  });
});
