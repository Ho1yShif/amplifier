import { describe, expect, it, beforeEach } from "vitest";
import { clearPromptCache, loadPrompt } from "../src/summary/prompt.js";

describe("loadPrompt", () => {
  beforeEach(clearPromptCache);

  it("reads the prompt file", () => {
    expect(loadPrompt()).toContain("Write exactly one line");
  });

  it("carries the examples", () => {
    expect(loadPrompt()).toContain("Cursor Origin is now a supported Git provider on Render");
  });

  it("returns the same string on a second call", () => {
    expect(loadPrompt()).toBe(loadPrompt());
  });
});
