import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { ping } from "../src/main.js";

describe("ping", () => {
  it("returns pong", async () => {
    expect(await ping.func(fakeCtx())).toBe("pong");
  });
});
