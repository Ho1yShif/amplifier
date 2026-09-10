import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { TaskRegistry } from "@renderinc/sdk/workflows";
import { ping } from "../src/main.js";

describe("ping", () => {
  it("returns pong", async () => {
    expect(await ping.func(fakeCtx())).toBe("pong");
  });
});

describe("task registration", () => {
  const names = TaskRegistry.getInstance().getAllTaskNames();

  it("registers the two entry tasks", () => {
    expect(names).toContain("amplifier.checkPosts");
    expect(names).toContain("amplifier.handleEvent");
  });

  it("registers the tasks they compose", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "typefully.listPublished",
        "llm.complete",
        "amplifier.postNote",
        "kv.lock",
        "kv.unlock",
        "kv.get",
        "kv.set",
      ]),
    );
  });
});
