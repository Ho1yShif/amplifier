import { describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { listPublishedImpl } from "../src/typefully/listPublished.js";
import { typefullyPort } from "../src/typefully/client.js";
import type { TypefullyDeps } from "../src/typefully/client.js";
import type { TypefullyDraft } from "../src/typefully/types.js";

const draft: TypefullyDraft = {
  id: 1,
  preview: "hello",
  x_post_published_at: "2026-09-04T15:00:00Z",
  x_published_url: "https://x.com/render/status/1",
};

function fakeDeps(drafts: TypefullyDraft[]): TypefullyDeps {
  return {
    typefully: {
      listPublishedDrafts: vi.fn(async () => drafts),
    },
  };
}

describe("listPublishedImpl", () => {
  it("maps drafts to posts", async () => {
    const result = await listPublishedImpl(fakeCtx(), { socialSetId: "set_1" }, fakeDeps([draft]));
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.draftId).toBe("1");
  });

  it("drops drafts that never published", async () => {
    const result = await listPublishedImpl(
      fakeCtx(),
      { socialSetId: "set_1" },
      fakeDeps([draft, { id: 2, status: "scheduled" }]),
    );
    expect(result.posts.map((p) => p.draftId)).toEqual(["1"]);
  });

  it("passes the social set and limit through to the port", async () => {
    const deps = fakeDeps([]);
    await listPublishedImpl(fakeCtx(), { socialSetId: "set_9", limit: 5 }, deps);
    expect(deps.typefully.listPublishedDrafts).toHaveBeenCalledWith("set_9", 5);
  });

  it("defaults the limit to 25", async () => {
    const deps = fakeDeps([]);
    await listPublishedImpl(fakeCtx(), { socialSetId: "set_9" }, deps);
    expect(deps.typefully.listPublishedDrafts).toHaveBeenCalledWith("set_9", 25);
  });

  it("throws a clear error without a social set id", async () => {
    // stubEnv so a TYPEFULLY_SOCIAL_SET_ID in the developer's shell can't hide the error.
    vi.stubEnv("TYPEFULLY_SOCIAL_SET_ID", "");
    await expect(listPublishedImpl(fakeCtx(), {}, fakeDeps([]))).rejects.toThrow(
      /TYPEFULLY_SOCIAL_SET_ID/,
    );
    vi.unstubAllEnvs();
  });
});

/** A fake fetch typed with its parameters, so mock.calls destructures under strict. */
function fakeFetch(body: unknown) {
  return vi.fn(
    async (_url: string, _init?: { method?: string; headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => body,
    }),
  );
}

describe("typefullyPort", () => {
  it("calls the v2 published-drafts endpoint with a bearer token", async () => {
    const fetchImpl = fakeFetch({ results: [draft] });
    const port = typefullyPort({ env: { TYPEFULLY_API_KEY: "key_1" }, fetchImpl });

    const drafts = await port.listPublishedDrafts("set_1", 25);

    expect(drafts).toEqual([draft]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.typefully.com/v2/social-sets/set_1/drafts?status=published&limit=25",
    );
    expect(init?.headers?.authorization ?? init?.headers?.Authorization).toBe("Bearer key_1");
  });

  it("reads a bare array response too", async () => {
    const port = typefullyPort({
      env: { TYPEFULLY_API_KEY: "key_1" },
      fetchImpl: fakeFetch([draft]),
    });
    expect(await port.listPublishedDrafts("set_1", 25)).toEqual([draft]);
  });

  it("fails on first use when the key is missing", async () => {
    const port = typefullyPort({ env: {}, fetchImpl: fakeFetch([]) });
    await expect(port.listPublishedDrafts("set_1", 25)).rejects.toThrow(/TYPEFULLY_API_KEY/);
  });
});
