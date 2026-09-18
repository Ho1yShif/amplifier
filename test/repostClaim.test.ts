import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimNote, isRepostClaimed } from "../src/amplifier/repostClaim.js";
import { repostedKey, repostInflightKey } from "../src/amplifier/reposted.js";
import { INFLIGHT_TTL_SECONDS } from "../src/amplifier/seen.js";
import { noteKey } from "../src/amplifier/storedNote.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const NOTE = noteKey(["1", "2"]);
const TOKEN = "amplifier:run:abc";

function handlers(overrides: TaskHandlers = {}): TaskHandlers {
  return {
    "kv.lock": () => ({ acquired: true }),
    "kv.get": () => ({ value: null }),
    "kv.unlock": () => ({ released: true }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("repostInflightKey", () => {
  it("keeps the repost lock on its own key, built from the note's drafts", () => {
    expect(repostInflightKey(NOTE)).toBe("amplifier:repost-inflight:1+2");
  });
});

describe("claimNote", () => {
  it("locks the note with this run's token and the in-flight TTL", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const outcome = await claimNote(ctx, NOTE, TOKEN);

    expect(isRepostClaimed(outcome)).toBe(true);
    expect(calls[0]).toEqual({
      name: "kv.lock",
      input: { key: repostInflightKey(NOTE), token: TOKEN, ttlSeconds: INFLIGHT_TTL_SECONDS },
    });
  });

  it("reads the reposted marker after the lock, not before", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await claimNote(ctx, NOTE, TOKEN);

    expect(calls.map((c) => c.name)).toEqual(["kv.lock", "kv.get"]);
    expect(calls[1]?.input).toEqual({ key: repostedKey(NOTE) });
  });

  it("refuses the note when another click holds the lock", async () => {
    const { ctx, calls } = taskCtx(handlers({ "kv.lock": () => ({ acquired: false }) }));
    const outcome = await claimNote(ctx, NOTE, TOKEN);

    expect(outcome).toEqual({ reason: "in-flight" });
    // Nothing was taken, so nothing is released.
    expect(calls.map((c) => c.name)).toEqual(["kv.lock"]);
  });

  it("refuses the note when the marker is already set, and releases the lock", async () => {
    const { ctx, calls } = taskCtx(handlers({ "kv.get": () => ({ value: "reposted" }) }));
    const outcome = await claimNote(ctx, NOTE, TOKEN);

    expect(outcome).toEqual({ reason: "reposted" });
    expect(calls.at(-1)).toEqual({
      name: "kv.unlock",
      input: { key: repostInflightKey(NOTE), token: TOKEN },
    });
  });

  it("releases the lock and rethrows when the marker cannot be read", async () => {
    const { ctx, calls } = taskCtx(
      handlers({
        "kv.get": () => {
          throw new Error("kv down");
        },
      }),
    );

    await expect(claimNote(ctx, NOTE, TOKEN)).rejects.toThrow("kv down");
    expect(calls.at(-1)?.name).toBe("kv.unlock");
  });

  it("takes the TTL it is given", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await claimNote(ctx, NOTE, TOKEN, 60);

    expect(calls[0]?.input.ttlSeconds).toBe(60);
  });
});
