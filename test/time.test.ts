import { describe, expect, it } from "vitest";
import { compareTime, timeMs } from "../src/time.js";

describe("timeMs", () => {
  it("parses an ISO timestamp", () => {
    expect(timeMs("2026-09-04T15:00:00Z")).toBe(Date.parse("2026-09-04T15:00:00Z"));
  });

  it("sends an unparseable timestamp to the end of the order", () => {
    expect(timeMs("not a date")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("compareTime", () => {
  it("orders by instant, not by string", () => {
    // The same instant in two formats.
    expect(compareTime("2026-09-04T15:00:00Z", "2026-09-04T17:00:00+02:00")).toBe(0);
    // 18:00+02:00 is 16:00Z, an hour earlier, though the string sorts later.
    expect(compareTime("2026-09-04T17:00:00Z", "2026-09-04T18:00:00+02:00")).toBe(1);
  });

  it("orders fractional seconds after the whole second", () => {
    expect(compareTime("2026-09-04T15:00:00Z", "2026-09-04T15:00:00.500Z")).toBe(-1);
  });

  it("treats two unparseable timestamps as equal", () => {
    expect(compareTime("nope", "also nope")).toBe(0);
  });
});
