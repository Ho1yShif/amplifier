import { describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { announcePostImpl, type AnnouncePostInput } from "../src/amplifier/announcePost.js";
import { post } from "./support/fixtures.js";
import { runCtx } from "./support/handlers.js";
import type { TaskHandlers } from "./support/taskCtx.js";

const X_POST = post("1", "2026-09-04T15:30:00Z", ["x"]);
const LI_POST = post("2", "2026-09-04T15:35:00Z", ["linkedin"]);

/** A context with both fixture posts published, which every test here wants. */
function ctxFor(overrides: TaskHandlers = {}) {
  return runCtx({
    "typefully.listPublished": () => ({ posts: [X_POST, LI_POST] }),
    ...overrides,
  });
}

/**
 * Run with only the social set in the environment, so a developer's shell
 * cannot reach loadConfig and change a result.
 */
function announce(ctx: TaskContext, input: AnnouncePostInput) {
  return announcePostImpl(ctx, input, { TYPEFULLY_SOCIAL_SET_ID: "set_1" });
}

describe("announcePostImpl", () => {
  it("announces the post an X URL names", async () => {
    const { ctx, calls } = ctxFor();

    const result = await announce(ctx, { url: "https://example.com/x/1" });

    expect(result.draftId).toBe("1");
    expect(result.note?.delivered).toBe(true);
    expect(calls.filter((c) => c.name === "amplifier.postNote")).toHaveLength(1);
  });

  it("announces the post a LinkedIn URL names", async () => {
    const { ctx } = ctxFor();

    const result = await announce(ctx, { url: "https://example.com/linkedin/2" });

    expect(result.draftId).toBe("2");
    expect(result.note?.platforms).toEqual(["linkedin"]);
  });

  it("announces the post a draftId names", async () => {
    const { ctx } = ctxFor();

    const result = await announce(ctx, { draftId: "2" });

    expect(result.draftId).toBe("2");
    expect(result.note?.delivered).toBe(true);
  });

  it("pulls the widest limit Typefully allows", async () => {
    const { ctx, calls } = ctxFor();

    await announce(ctx, { draftId: "1" });

    const list = calls.find((c) => c.name === "typefully.listPublished");
    expect(list?.input).toEqual({ socialSetId: "set_1", limit: 50 });
  });

  it("throws with neither url nor draftId", async () => {
    const { ctx } = ctxFor();

    await expect(announce(ctx, {})).rejects.toThrow(/url.*draftId/s);
  });

  it("throws when no published draft matches", async () => {
    const { ctx, calls } = ctxFor();

    await expect(announce(ctx, { url: "https://example.com/x/99" })).rejects.toThrow(
      /No published draft matches/,
    );
    expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
  });

  it("skips a draft the marker already records", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx, calls } = ctxFor({ "kv.get": () => ({ value: "announced" }) });

      const result = await announce(ctx, { draftId: "1" });

      expect(result).toEqual({ draftId: "1", dryRun: false, skipped: "announced" });
      expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("clears the marker and re-posts with force", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // The marker read before the claim sees it; claimGroup's re-read runs
      // after kv.delete, so it must not.
      let reads = 0;
      const { ctx, calls } = ctxFor({
        "kv.get": () => ({ value: reads++ === 0 ? "announced" : null }),
      });

      const result = await announce(ctx, { draftId: "1", force: true });

      expect(calls.filter((c) => c.name === "kv.delete")).toEqual([
        { name: "kv.delete", input: { keys: ["amplifier:seen:1"] } },
      ]);
      expect(result.note?.delivered).toBe(true);
      expect(calls.filter((c) => c.name === "amplifier.postNote")).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("posts nothing and writes no marker in a dry run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx, calls } = ctxFor();

      const result = await announce(ctx, { draftId: "1", dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.note?.delivered).toBe(false);
      expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
      expect(calls.filter((c) => c.name === "kv.set")).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("reports a refused claim instead of throwing", async () => {
    const { ctx, calls } = ctxFor({ "kv.lock": () => ({ acquired: false }) });

    const result = await announce(ctx, { draftId: "1" });

    expect(result).toEqual({ draftId: "1", dryRun: false, skipped: "claimed" });
    expect(calls.filter((c) => c.name === "amplifier.postNote")).toEqual([]);
  });
});
