import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import type { TaskDefinition } from "@renderinc/sdk/workflows";
import { claimGroup, groupToken, releaseGroup, seenKey } from "../src/amplifier/seen.js";
import type { PostGroup } from "../src/amplifier/group.js";

const group: PostGroup = {
  draftIds: ["1", "2"],
  previews: ["a", "b"],
  publishedAt: "2026-09-04T15:00:00Z",
  links: [
    { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
    { platform: "linkedin", url: "https://linkedin.com/b", publishedAt: "2026-09-04T15:01:00Z" },
  ],
};

/** A ctx whose run() dispatches by task name to a handler map. */
function kvCtx(handlers: Record<string, (input: any) => unknown>) {
  const calls: Array<{ name: string; input: any }> = [];
  const ctx = fakeCtx({
    run: (async (t: TaskDefinition<any, any>, input: any) => {
      calls.push({ name: t.name, input });
      const handler = handlers[t.name];
      if (!handler) throw new Error(`unexpected task ${t.name}`);
      return handler(input);
    }) as any,
  });
  return { ctx, calls };
}

describe("seenKey / groupToken", () => {
  it("namespaces the key by draft id", () => {
    expect(seenKey("41")).toBe("amplifier:seen:41");
  });

  it("derives the same token regardless of draft order", () => {
    const reversed: PostGroup = { ...group, draftIds: ["2", "1"] };
    expect(groupToken(reversed)).toBe(groupToken(group));
  });
});

describe("claimGroup", () => {
  it("claims every draft in the group", async () => {
    const { ctx, calls } = kvCtx({ "kv.lock": () => ({ acquired: true }) });
    const claims = await claimGroup(ctx, group, 60);
    expect(claims).toHaveLength(2);
    expect(calls.map((c) => c.input.key)).toEqual(["amplifier:seen:1", "amplifier:seen:2"]);
    expect(calls[0]?.input.ttlSeconds).toBe(60);
  });

  it("returns null when another run already announced the draft", async () => {
    const { ctx } = kvCtx({
      "kv.lock": () => ({ acquired: false }),
      "kv.get": () => ({ value: "amplifier:someone-else" }),
    });
    expect(await claimGroup(ctx, group, 60)).toBeNull();
  });

  it("adopts its own claim after a crash and continues", async () => {
    const token = groupToken(group);
    const { ctx } = kvCtx({
      "kv.lock": (input) => ({ acquired: input.key === "amplifier:seen:2" }),
      "kv.get": () => ({ value: token }),
    });
    const claims = await claimGroup(ctx, group, 60);
    expect(claims?.map((c) => c.key)).toEqual(["amplifier:seen:1", "amplifier:seen:2"]);
  });

  it("releases the claims it took before giving up", async () => {
    const { ctx, calls } = kvCtx({
      "kv.lock": (input) => ({ acquired: input.key === "amplifier:seen:1" }),
      "kv.get": () => ({ value: "amplifier:someone-else" }),
      "kv.unlock": () => ({ released: true }),
    });
    expect(await claimGroup(ctx, group, 60)).toBeNull();
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:seen:1",
    ]);
  });
});

describe("releaseGroup", () => {
  it("unlocks every claim with its token", async () => {
    const { ctx, calls } = kvCtx({ "kv.unlock": () => ({ released: true }) });
    await releaseGroup(ctx, [{ key: "amplifier:seen:1", token: "t" }]);
    expect(calls).toEqual([
      { name: "kv.unlock", input: { key: "amplifier:seen:1", token: "t" } },
    ]);
  });

  it("does nothing for no claims", async () => {
    const { ctx, calls } = kvCtx({});
    await releaseGroup(ctx, []);
    expect(calls).toEqual([]);
  });
});
