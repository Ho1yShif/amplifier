import { describe, expect, it } from "vitest";
import type { PostGroup } from "../src/amplifier/group.js";
import { isSummary, summarizeGroup } from "../src/summary/summarize.js";
import { group as buildGroup } from "./support/fixtures.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const group = buildGroup({
  previews: ["We cut cold starts on Render by 40%."],
  links: [
    {
      platform: "linkedin",
      url: "https://linkedin.com/feed/update/2",
      publishedAt: "2026-09-04T15:00:00Z",
    },
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: "2026-09-04T15:02:00Z" },
  ],
});

function ctxFor(overrides: TaskHandlers = {}) {
  return taskCtx({
    "llm.complete": () => ({
      text: "Cold starts on Render are 40% faster. Please amplify!",
      model: "claude-sonnet-5",
      stopReason: "end",
    }),
    ...overrides,
  });
}

describe("summarizeGroup", () => {
  it("returns the model's line", async () => {
    const { ctx } = ctxFor();
    const outcome = await summarizeGroup(ctx, group);
    expect(outcome).toEqual({ line: "Cold starts on Render are 40% faster. Please amplify!" });
  });

  it("sends the prompt file as the system prompt and the previews as the user prompt", async () => {
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, group);
    const input = calls[0]?.input;
    expect(input.system).toContain("Write exactly one line");
    expect(input.prompt).toContain("We cut cold starts on Render by 40%.");
    expect(input.prompt).toContain("LinkedIn and X");
  });

  it("defaults to the newest Sonnet and gives thinking room", async () => {
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, group);
    expect(calls[0]?.input.model).toBe("anthropic/claude-sonnet-5");
    expect(calls[0]?.input.maxTokens).toBe(2048);
  });

  it("takes a model override", async () => {
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, group, { model: "anthropic/claude-haiku-4-5" });
    expect(calls[0]?.input.model).toBe("anthropic/claude-haiku-4-5");
  });

  it("reports the error instead of throwing when the task fails", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => {
        throw new Error("401 invalid x-api-key");
      },
    });
    const outcome = await summarizeGroup(ctx, group);
    expect(outcome).toEqual({ error: "401 invalid x-api-key" });
  });

  it("treats a truncated answer as a failure", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => ({ text: "Cold starts on", model: "m", stopReason: "length" }),
    });
    const outcome = await summarizeGroup(ctx, group);
    expect(isSummary(outcome)).toBe(false);
    expect(outcome).toHaveProperty("error", expect.stringContaining("2048"));
  });

  it("treats empty text as a failure", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => ({ text: "   ", model: "m", stopReason: "end" }),
    });
    expect(await summarizeGroup(ctx, group)).toEqual({ error: "the model returned no text" });
  });

  it("keeps only the first line of a multi-line answer", async () => {
    const { ctx } = ctxFor({
      "llm.complete": () => ({
        text: "\nCold starts are faster. Please amplify!\n\nAlso: unrelated.",
        model: "m",
        stopReason: "end",
      }),
    });
    expect(await summarizeGroup(ctx, group)).toEqual({
      line: "Cold starts are faster. Please amplify!",
    });
  });

  it("names both platforms of a grouped note and lists every preview", async () => {
    const grouped: PostGroup = {
      ...group,
      draftIds: ["1", "2"],
      previews: ["First draft text.", "Second draft text."],
    };
    const { ctx, calls } = ctxFor();
    await summarizeGroup(ctx, grouped);
    expect(calls[0]?.input.prompt).toContain("First draft text.");
    expect(calls[0]?.input.prompt).toContain("Second draft text.");
  });
});
