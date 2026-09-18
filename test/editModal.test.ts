import { describe, expect, it } from "vitest";
import {
  decodeMeta,
  editView,
  encodeMeta,
  EDIT_CALLBACK_ID,
  LEAD_ACTION_ID,
  LEAD_BLOCK_ID,
  MAX_LEAD_LENGTH,
} from "../src/slack/editModal.js";

const META = {
  channel: "C1",
  messageTs: "17580000.001",
  noteKey: "amplifier:note:1",
  responseUrl: "https://hooks.slack.com/actions/T/1/2",
};

describe("encodeMeta and decodeMeta", () => {
  it("round-trips the note the modal is editing", () => {
    expect(decodeMeta(encodeMeta(META))).toEqual(META);
  });

  it("stays well under Slack's 3000-character metadata limit", () => {
    expect(encodeMeta(META).length).toBeLessThan(500);
  });

  it("reads nothing out of a metadata string that is not amplifier's", () => {
    expect(decodeMeta("not json")).toBeNull();
    expect(decodeMeta(JSON.stringify({ channel: "C1" }))).toBeNull();
    expect(decodeMeta(undefined)).toBeNull();
  });
});

describe("editView", () => {
  const view = editView(META, "Old summary") as Record<string, any>;

  it("is a modal the receiver can recognize on submit", () => {
    expect(view["type"]).toBe("modal");
    expect(view["callback_id"]).toBe(EDIT_CALLBACK_ID);
  });

  it("carries the note it is editing, so the submission needs no lookup", () => {
    expect(decodeMeta(view["private_metadata"])).toEqual(META);
  });

  it("prefills the current lead line, so an edit is not a retype", () => {
    const input = view["blocks"][0];
    expect(input["block_id"]).toBe(LEAD_BLOCK_ID);
    expect(input["element"]["action_id"]).toBe(LEAD_ACTION_ID);
    expect(input["element"]["initial_value"]).toBe("Old summary");
    expect(input["element"]["multiline"]).toBe(true);
  });

  it("caps the input under Slack's section-block limit", () => {
    expect(MAX_LEAD_LENGTH).toBeLessThan(3000);
    expect(view["blocks"][0]["element"]["max_length"]).toBe(MAX_LEAD_LENGTH);
  });
});
