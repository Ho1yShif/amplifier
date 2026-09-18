import { describe, expect, it } from "vitest";
import type { PostMessageInput } from "@render-lab/tasks-slack";
import { leadOf, withLead } from "../src/amplifier/lead.js";
import { repostBlock, section, THREAD_MARKER } from "../src/amplifier/template.js";

/** A thread parent, the shape `renderParent` builds with a summary. */
function parent(): PostMessageInput {
  return {
    text: "Old summary",
    blocks: [
      section(
        `Old summary${THREAD_MARKER}\n\n_X had not published yet, so there is no link for it._`,
      ),
      repostBlock("amplify-queue", "amplifier:note:1"),
    ],
  };
}

/** A flat note whose summary failed, the shape `renderFlatNote` builds. */
function fallback(): PostMessageInput {
  return {
    text: "New Render social post!",
    blocks: [
      section(
        "New Render social post!\n_(Summarization LLM call failed: timeout)_\n\n> preview\n\n<https://x.com/1|X>",
      ),
    ],
  };
}

describe("leadOf", () => {
  it("reads the lead line without the thread marker", () => {
    expect(leadOf(parent())).toBe("Old summary");
  });

  it("reads the lead line of a note whose summary failed", () => {
    expect(leadOf(fallback())).toBe("New Render social post!");
  });

  it("has no lead for a message with no section block", () => {
    expect(leadOf({ text: "hi" })).toBeUndefined();
  });
});

describe("withLead", () => {
  it("replaces the lead line and keeps the marker and the rest of the block", () => {
    const edited = withLead(parent(), "Shifra's title");

    expect(edited?.blocks?.[0]).toEqual(
      section(
        `Shifra's title${THREAD_MARKER}\n\n_X had not published yet, so there is no link for it._`,
      ),
    );
  });

  it("keeps the buttons, so an edited note is still repostable", () => {
    const edited = withLead(parent(), "Shifra's title");

    expect(edited?.blocks?.[1]).toEqual(repostBlock("amplify-queue", "amplifier:note:1"));
  });

  it("rewrites the notification fallback without the marker", () => {
    expect(withLead(parent(), "Shifra's title")?.text).toBe("Shifra's title");
  });

  it("drops the summary-failed line, because a person wrote this line", () => {
    const edited = withLead(fallback(), "Shifra's title");

    expect(edited?.blocks?.[0]).toEqual(
      section("Shifra's title\n\n> preview\n\n<https://x.com/1|X>"),
    );
  });

  it("has nothing to edit in a message with no section block", () => {
    expect(withLead({ text: "hi" }, "Shifra's title")).toBeNull();
  });
});
