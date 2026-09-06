import { describe, expect, it } from "vitest";
import {
  announcedDraftIds,
  claimGroup,
  inflightKey,
  isClaimed,
  markAnnounced,
  releaseGroup,
  seenKey,
  INFLIGHT_TTL_SECONDS,
} from "../src/amplifier/seen.js";
import type { PostGroup } from "../src/amplifier/group.js";
import { taskCtx } from "./support/taskCtx.js";

const group: PostGroup = {
  draftIds: ["1", "2"],
  previews: ["a", "b"],
  publishedAt: "2026-09-04T15:00:00Z",
  links: [
    { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
    { platform: "linkedin", url: "https://linkedin.com/b", publishedAt: "2026-09-04T15:01:00Z" },
  ],
};

const TOKEN = "amplifier:run:this-run";

describe("keys", () => {
  it("namespaces the announced marker by draft id", () => {
    expect(seenKey("41")).toBe("amplifier:seen:41");
  });

  it("keeps the in-flight lock on its own key", () => {
    expect(inflightKey("41")).toBe("amplifier:inflight:41");
  });
});

describe("announcedDraftIds", () => {
  it("reports the drafts with an announced marker", async () => {
    const { ctx, calls } = taskCtx({
      "kv.get": (input) => ({ value: input.key === "amplifier:seen:1" ? "announced" : null }),
    });

    expect(await announcedDraftIds(ctx, ["1", "2"])).toEqual(new Set(["1"]));
    // Sorted, because the reads are dispatched together and no order is promised.
    expect(calls.map((c) => c.input.key).sort()).toEqual(["amplifier:seen:1", "amplifier:seen:2"]);
  });

  it("reports nothing when no draft has been announced", async () => {
    const { ctx } = taskCtx({ "kv.get": () => ({ value: null }) });
    expect(await announcedDraftIds(ctx, ["1", "2"])).toEqual(new Set());
  });
});

describe("claimGroup", () => {
  const unannounced = { "kv.get": () => ({ value: null }) };

  it("locks every draft in the group with this run's token", async () => {
    const { ctx, calls } = taskCtx({ "kv.lock": () => ({ acquired: true }), ...unannounced });

    const outcome = await claimGroup(ctx, group, TOKEN);

    expect(isClaimed(outcome) && outcome.claims).toEqual([
      { key: "amplifier:inflight:1", token: TOKEN },
      { key: "amplifier:inflight:2", token: TOKEN },
    ]);
    expect(calls[0]?.input.ttlSeconds).toBe(INFLIGHT_TTL_SECONDS);
  });

  it("refuses the group when another run holds a live lock", async () => {
    const { ctx } = taskCtx({ "kv.lock": () => ({ acquired: false }), ...unannounced });
    expect(await claimGroup(ctx, group, TOKEN)).toEqual({ reason: "in-flight", draftId: "1" });
  });

  it("refuses the group when a marker appears after the lock is acquired", async () => {
    // The window this closes: announcedDraftIds ran before the lock, so another
    // run can finish announcing the draft in between.
    const { ctx, calls } = taskCtx({
      "kv.lock": () => ({ acquired: true }),
      "kv.get": (input) => ({ value: input.key === "amplifier:seen:2" ? "announced" : null }),
      "kv.unlock": () => ({ released: true }),
    });

    expect(await claimGroup(ctx, group, TOKEN)).toEqual({ reason: "announced", draftId: "2" });
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:inflight:1",
      "amplifier:inflight:2",
    ]);
  });

  it("re-reads the marker, not the lock's own value", async () => {
    const { ctx, calls } = taskCtx({ "kv.lock": () => ({ acquired: true }), ...unannounced });

    await claimGroup(ctx, group, TOKEN);

    expect(calls.filter((c) => c.name === "kv.get").map((c) => c.input.key)).toEqual([
      "amplifier:seen:1",
      "amplifier:seen:2",
    ]);
  });

  it("releases the locks it took before giving up", async () => {
    const { ctx, calls } = taskCtx({
      "kv.lock": (input) => ({ acquired: input.key === "amplifier:inflight:1" }),
      "kv.unlock": () => ({ released: true }),
      ...unannounced,
    });

    expect(await claimGroup(ctx, group, TOKEN)).toEqual({ reason: "in-flight", draftId: "2" });
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:inflight:1",
    ]);
  });
});

describe("markAnnounced", () => {
  it("writes one marker per draft with the given TTL", async () => {
    const { ctx, calls } = taskCtx({ "kv.set": () => ({ ok: true }) });

    await markAnnounced(ctx, group.draftIds, 86_400);

    // Sorted, because the writes are dispatched together and no order is promised.
    expect(calls.map((c) => c.input).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "amplifier:seen:1", value: "announced", ttlSeconds: 86_400 },
      { key: "amplifier:seen:2", value: "announced", ttlSeconds: 86_400 },
    ]);
    expect(calls.every((c) => c.name === "kv.set")).toBe(true);
  });
});

describe("releaseGroup", () => {
  it("unlocks every claim with its token", async () => {
    const { ctx, calls } = taskCtx({ "kv.unlock": () => ({ released: true }) });

    await releaseGroup(ctx, [{ key: "amplifier:inflight:1", token: TOKEN }]);

    expect(calls).toEqual([
      { name: "kv.unlock", input: { key: "amplifier:inflight:1", token: TOKEN } },
    ]);
  });

  it("does nothing for no claims", async () => {
    const { ctx, calls } = taskCtx({});
    await releaseGroup(ctx, []);
    expect(calls).toEqual([]);
  });
});
