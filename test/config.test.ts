import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_CALL_TO_ACTION } from "../src/amplifier/template.js";

describe("loadConfig", () => {
  it("uses the defaults with an empty env", () => {
    expect(loadConfig({}, {})).toEqual({
      limit: 25,
      lookbackMinutes: 90,
      groupWindowMinutes: 10,
      seenTtlSeconds: 30 * 86_400,
      callToAction: DEFAULT_CALL_TO_ACTION,
      dryRun: true,
    });
  });

  it("reads the env", () => {
    const config = loadConfig({}, {
      TYPEFULLY_SOCIAL_SET_ID: "set_1",
      AMPLIFIER_LOOKBACK_MINUTES: "30",
      AMPLIFIER_GROUP_WINDOW_MINUTES: "5",
      AMPLIFIER_SEEN_TTL_DAYS: "7",
      AMPLIFIER_LIMIT: "50",
      AMPLIFIER_CALL_TO_ACTION: "Boost it.",
      SLACK_CHANNEL: "#social",
      DRY_RUN: "false",
    });
    expect(config).toEqual({
      socialSetId: "set_1",
      limit: 50,
      lookbackMinutes: 30,
      groupWindowMinutes: 5,
      seenTtlSeconds: 7 * 86_400,
      slackChannel: "#social",
      callToAction: "Boost it.",
      dryRun: false,
    });
  });

  it("lets a per-run input override the env", () => {
    const config = loadConfig({ lookbackMinutes: 5, dryRun: true }, {
      AMPLIFIER_LOOKBACK_MINUTES: "90",
      DRY_RUN: "false",
    });
    expect(config.lookbackMinutes).toBe(5);
    expect(config.dryRun).toBe(true);
  });

  it("stays in dry run unless DRY_RUN is exactly false", () => {
    expect(loadConfig({}, { DRY_RUN: "0" }).dryRun).toBe(true);
    expect(loadConfig({}, { DRY_RUN: "no" }).dryRun).toBe(true);
    expect(loadConfig({}, { DRY_RUN: "false" }).dryRun).toBe(false);
  });

  it("ignores a non-numeric env value", () => {
    expect(loadConfig({}, { AMPLIFIER_LOOKBACK_MINUTES: "soon" }).lookbackMinutes).toBe(90);
  });
});
