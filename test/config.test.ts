import { describe, expect, it } from "vitest";
import { loadConfig, MAX_LIMIT } from "../src/config.js";
import { MAX_SETTLE_MINUTES } from "../src/amplifier/retry.js";
import { DEFAULT_CALL_TO_ACTION } from "../src/amplifier/template.js";
import { DEFAULT_SUMMARY_MODEL } from "../src/summary/model.js";

describe("loadConfig", () => {
  it("uses the defaults with an empty env", () => {
    expect(loadConfig({}, {})).toEqual({
      limit: 25,
      lookbackMinutes: 90,
      groupWindowMinutes: 10,
      settleMinutes: 10,
      seenTtlSeconds: 30 * 86_400,
      callToAction: DEFAULT_CALL_TO_ACTION,
      summaryModel: DEFAULT_SUMMARY_MODEL,
      dryRun: true,
    });
  });

  it("reads the env", () => {
    const config = loadConfig(
      {},
      {
        TYPEFULLY_SOCIAL_SET_ID: "set_1",
        AMPLIFIER_LOOKBACK_MINUTES: "30",
        AMPLIFIER_GROUP_WINDOW_MINUTES: "5",
        AMPLIFIER_SETTLE_MINUTES: "3",
        AMPLIFIER_SEEN_TTL_DAYS: "7",
        AMPLIFIER_LIMIT: "50",
        AMPLIFIER_CALL_TO_ACTION: "Boost it.",
        SLACK_CHANNEL: "social",
        DRY_RUN: "false",
      },
    );
    expect(config).toEqual({
      socialSetId: "set_1",
      limit: 50,
      lookbackMinutes: 30,
      groupWindowMinutes: 5,
      settleMinutes: 3,
      seenTtlSeconds: 7 * 86_400,
      slackChannel: "social",
      callToAction: "Boost it.",
      summaryModel: DEFAULT_SUMMARY_MODEL,
      dryRun: false,
    });
  });

  it("lets a per-run input override the env", () => {
    const config = loadConfig(
      { lookbackMinutes: 5, dryRun: true },
      {
        AMPLIFIER_LOOKBACK_MINUTES: "90",
        DRY_RUN: "false",
      },
    );
    expect(config.lookbackMinutes).toBe(5);
    expect(config.dryRun).toBe(true);
  });

  it("takes a channel with or without a leading #", () => {
    expect(loadConfig({}, { SLACK_CHANNEL: "#social" }).slackChannel).toBe("social");
    expect(loadConfig({}, { SLACK_CHANNEL: " social " }).slackChannel).toBe("social");
    expect(loadConfig({ slackChannel: "#social" }, {}).slackChannel).toBe("social");
    expect(loadConfig({}, { SLACK_CHANNEL: " " }).slackChannel).toBeUndefined();
  });

  it("stays in dry run unless DRY_RUN is exactly false", () => {
    expect(loadConfig({}, { DRY_RUN: "0" }).dryRun).toBe(true);
    expect(loadConfig({}, { DRY_RUN: "no" }).dryRun).toBe(true);
    expect(loadConfig({}, { DRY_RUN: "false" }).dryRun).toBe(false);
  });

  it("uses the default for a blank env value", () => {
    // A declared-but-empty Render env var is normal, and Number("") is 0.
    expect(loadConfig({}, { AMPLIFIER_LIMIT: "" }).limit).toBe(25);
    expect(loadConfig({}, { AMPLIFIER_SEEN_TTL_DAYS: "  " }).seenTtlSeconds).toBe(30 * 86_400);
  });

  it("treats a blank call to action as unset", () => {
    expect(loadConfig({}, { AMPLIFIER_CALL_TO_ACTION: "" }).callToAction).toBe(
      DEFAULT_CALL_TO_ACTION,
    );
  });

  it("treats a whitespace-only call to action as unset", () => {
    expect(loadConfig({}, { AMPLIFIER_CALL_TO_ACTION: "  " }).callToAction).toBe(
      DEFAULT_CALL_TO_ACTION,
    );
  });

  it("throws on a non-numeric env value", () => {
    expect(() => loadConfig({}, { AMPLIFIER_LOOKBACK_MINUTES: "soon" })).toThrow(
      "AMPLIFIER_LOOKBACK_MINUTES must be a whole number of at least 1",
    );
  });

  it("throws on a value below the minimum", () => {
    expect(() => loadConfig({}, { AMPLIFIER_LIMIT: "0" })).toThrow("AMPLIFIER_LIMIT");
    expect(() => loadConfig({}, { AMPLIFIER_SEEN_TTL_DAYS: "-1" })).toThrow(
      "AMPLIFIER_SEEN_TTL_DAYS",
    );
  });

  it("throws on a fractional value", () => {
    expect(() => loadConfig({}, { AMPLIFIER_LIMIT: "2.5" })).toThrow("AMPLIFIER_LIMIT");
  });

  it("accepts a group window of 0, which turns grouping off", () => {
    expect(loadConfig({}, { AMPLIFIER_GROUP_WINDOW_MINUTES: "0" }).groupWindowMinutes).toBe(0);
  });

  it("defaults the settle window to 10 minutes", () => {
    expect(loadConfig({}, {}).settleMinutes).toBe(10);
  });

  it("reads the settle window from the env", () => {
    expect(loadConfig({}, { AMPLIFIER_SETTLE_MINUTES: "0" }).settleMinutes).toBe(0);
  });

  it("falls back to the default settle window on a blank variable", () => {
    expect(loadConfig({}, { AMPLIFIER_SETTLE_MINUTES: "  " }).settleMinutes).toBe(10);
  });

  it("rejects a negative settle window", () => {
    expect(() => loadConfig({}, { AMPLIFIER_SETTLE_MINUTES: "-1" })).toThrow(
      `AMPLIFIER_SETTLE_MINUTES must be a whole number between 0 and ${MAX_SETTLE_MINUTES}`,
    );
  });

  it("caps the settle window at the retry budget on amplifier.handleEvent", () => {
    expect(
      loadConfig({}, { AMPLIFIER_SETTLE_MINUTES: String(MAX_SETTLE_MINUTES) }).settleMinutes,
    ).toBe(MAX_SETTLE_MINUTES);
    expect(() =>
      loadConfig({}, { AMPLIFIER_SETTLE_MINUTES: String(MAX_SETTLE_MINUTES + 1) }),
    ).toThrow(
      `AMPLIFIER_SETTLE_MINUTES must be a whole number between 0 and ${MAX_SETTLE_MINUTES}`,
    );
  });

  it("validates a per-run override the same way", () => {
    expect(() => loadConfig({ limit: 0 }, {})).toThrow("AMPLIFIER_LIMIT");
  });

  it("caps AMPLIFIER_LIMIT, because the limit is also the concurrent subtask burst", () => {
    expect(loadConfig({}, { AMPLIFIER_LIMIT: String(MAX_LIMIT) }).limit).toBe(MAX_LIMIT);
    expect(() => loadConfig({}, { AMPLIFIER_LIMIT: String(MAX_LIMIT + 1) })).toThrow(
      `AMPLIFIER_LIMIT must be a whole number between 1 and ${MAX_LIMIT}`,
    );
  });
  it("defaults the summary model to the newest Sonnet", () => {
    expect(loadConfig({}, {}).summaryModel).toBe("anthropic/claude-sonnet-5");
  });

  it("reads the summary model from the environment", () => {
    expect(
      loadConfig({}, { AMPLIFIER_SUMMARY_MODEL: "anthropic/claude-haiku-4-5" }).summaryModel,
    ).toBe("anthropic/claude-haiku-4-5");
  });

  it("prefers the per-run summary model", () => {
    const config = loadConfig(
      { summaryModel: "openai/gpt-4o" },
      { AMPLIFIER_SUMMARY_MODEL: "anthropic/claude-haiku-4-5" },
    );
    expect(config.summaryModel).toBe("openai/gpt-4o");
  });

  it("treats a blank summary model as unset", () => {
    expect(loadConfig({}, { AMPLIFIER_SUMMARY_MODEL: "  " }).summaryModel).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
});
