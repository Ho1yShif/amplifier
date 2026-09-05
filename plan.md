# Amplifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Render post goes live on X or LinkedIn, post one templated amplify note to a Slack channel.

**Architecture:** A Render Workflow service registers `amplifier.checkPosts`. A Render cron job dispatches that task every 30 minutes through `@render-lab/triggers`. The task reads published drafts from the Typefully API, keeps the ones published inside a lookback window, drops the drafts Render Key Value already records as announced, groups the rest of the co-published posts into a single note, and posts through `slack.postMessage`.

**Tech Stack:** Node 22.12, TypeScript 6 (NodeNext), Vitest 4, `@renderinc/sdk@1.0.0` Workflows SDK, and the published `@render-lab/*` task packages: `tasks-slack@0.3.0`, `tasks-render-kv@0.3.0`, `tasks-core@0.3.0`, `triggers@0.2.0`, `test-utils@0.1.0`.

**Spec:** This document. The design was settled in conversation and is recorded in the Design Decisions section below.

## Global Constraints

- Node 22.12 or later. `.node-version` pins `22.12.0`.
- `@renderinc/sdk` is pinned to exactly `1.0.0`. Every task package in this repo declares the same version, so all tasks register into one shared `TaskRegistry`.
- TypeScript config extends the same options `render-tasks` uses: `strict`, `noUncheckedIndexedAccess`, `module: NodeNext`, `target: ES2022`, ESM only (`"type": "module"`), `.js` extensions on relative imports.
- Task names are namespaced: `typefully.*` for source tasks, `amplifier.*` for the composition.
- Task inputs and outputs are JSON-serializable DTOs. Never pass a vendor SDK object across a task boundary.
- Credentials are read lazily inside a port at first call, never at module import.
- Every impl is exported twice: the wrapped `task()` and the raw `*Impl` with an injectable `deps` parameter, so unit tests need no secrets.
- `DRY_RUN` defaults to `true`. The Slack post happens only when `DRY_RUN=false`.
- No live network calls in tests. Inject a fake `fetch` into the Typefully port, and drive composed tasks with a `fakeCtx` whose `run` is stubbed per task name.

## Design Decisions

**Correction after the final review (announce-once).** The "Announce-once state" decision below, and Task 7 and Task 9 as written, produce duplicate announcements. One Key Value value cannot record both "in flight by me" and "already announced": a run that posted and a run that crashed before posting left identical state, so the next cron run adopted the claim and posted again. Deciding dedupe per group made it worse, because group membership depends on what the API returned on that run, so a draft that joined an already-announced group was dropped. The shipped code splits the two records. `amplifier:seen:<draftId>` is a plain marker written with `kv.set` after Slack accepts the note, with the 30-day TTL. The in-flight lock lives at `amplifier:inflight:<draftId>` with a token unique per invocation and a 5-minute TTL, so a crashed run's lock lapses and the next run retries. `checkPostsImpl` drops already-announced drafts before grouping. Read the code in `src/amplifier/seen.ts` for the current design; the task steps below stay as the historical record.

**Source: Typefully only.** Typefully already publishes to both the Render X and LinkedIn accounts, so one API key covers both. The X API v2 requires a paid tier to read an account's own posts, and LinkedIn organization posts require Community Management API access that goes through a partner review.

**Typefully API v2 facts this plan depends on:**

- Base URL `https://api.typefully.com`, header `Authorization: Bearer <key>`.
- `GET /v2/social-sets` lists social sets. `GET /v2/social-sets/{id}/drafts?status=published` lists published drafts.
- Each draft carries per-platform fields: `x_post_enabled`, `x_post_published_at`, `x_published_url`, and the matching `linkedin_post_enabled`, `linkedin_post_published_at`, `linkedin_published_url`. Also `id`, `preview` (100-char smart-trimmed text), `status`, `published_at`, `share_url`.
- Query parameters beyond `status` are not documented publicly. Task 3, Step 7 confirms the sort order and page size against a real key and adjusts `listPublished` if the response is not newest-first.

**Grouping.** A post sent to both X and LinkedIn is one Typefully draft holding both URLs, so it becomes one note without any extra work. Two separate drafts merge into one note only when they were published within `AMPLIFIER_GROUP_WINDOW_MINUTES` of each other *and* target disjoint platforms. Two X posts 5 minutes apart stay two notes, because they are two announcements rather than one cross-post.

**Polling, not webhooks.** Typefully has outbound webhooks, but the event catalog is not in the public docs. The cron runs every 30 minutes with a 90-minute lookback, so one skipped run still catches up. Webhooks are a later upgrade: `@render-lab/triggers` already ships an HTTP dispatch server, so it would mean adding a trigger web service without changing `amplifier.checkPosts`.

**Announce-once state.** Render Key Value holds `amplifier:seen:<draftId>`, written with `SET NX EX` through the existing `kv.lock` task and released through `kv.unlock`. The token is derived from the group's draft ids, so a workflow retry after a crash recognizes its own claim and finishes the post instead of dropping it.

## File Structure

```
amplifier/
  package.json          deps, scripts
  tsconfig.json         extends the render-tasks compiler options
  vitest.config.ts      test include globs
  .node-version         22.12.0
  .gitignore
  .env.example          the full env contract
  render.yaml           Blueprint for the cron trigger service
  README.md             what it does, how to run it, how to deploy it
  plan.md               this file
  src/
    main.ts             Workflow entry point; imports the tasks, registers ping
    cron-trigger.ts     cron entry point; runCron()
    config.ts           env + per-run overrides -> AmplifierConfig
    typefully/
      types.ts          TypefullyDraft, PublishedPost, PlatformLink, task DTOs
      client.ts         TypefullyPort, typefullyPort(), defaultDeps
      map.ts            mapDraft(): raw draft -> PublishedPost | null
      retry.ts          TYPEFULLY_RETRY
      listPublished.ts  task typefully.listPublished
    amplifier/
      window.ts         withinWindow(): lookback filter
      group.ts          groupPosts(): merge co-published drafts
      template.ts       renderNote(): PostGroup -> PostMessageInput
      seen.ts           claimGroup() / releaseGroup() over kv.lock
      checkPosts.ts     task amplifier.checkPosts
  test/
    map.test.ts
    listPublished.test.ts
    window.test.ts
    group.test.ts
    template.test.ts
    seen.test.ts
    config.test.ts
    checkPosts.test.ts
```

`src/typefully/` owns everything that knows the vendor's field names. `src/amplifier/` works only on the `PublishedPost` DTO, so swapping in a direct X or LinkedIn source later means adding a sibling directory and a second `listPublished`-shaped task.

---

### Task 1: Repo scaffold and a ping task

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.node-version`, `.gitignore`, `src/main.ts`
- Test: `test/main.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable ESM TypeScript package with `pnpm build`, `pnpm test`, `pnpm typecheck`, and a registered `ping` task.

- [ ] **Step 1: Write the config files**

`package.json`:

```json
{
  "name": "amplifier",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Posts an amplify note to Slack when a Render post goes live on X or LinkedIn.",
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/main.js",
    "trigger:cron": "node dist/cron-trigger.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@render-lab/tasks-core": "0.3.0",
    "@render-lab/tasks-render-kv": "0.3.0",
    "@render-lab/tasks-slack": "0.3.0",
    "@render-lab/triggers": "0.2.0",
    "@renderinc/sdk": "1.0.0"
  },
  "devDependencies": {
    "@render-lab/test-utils": "0.1.0",
    "@types/node": "^24.0.0",
    "tsx": "^4.23.0",
    "typescript": "^6.0.0",
    "vitest": "^4.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

`.node-version`:

```
22.12.0
```

`.gitignore`:

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: all five runtime deps resolve from npm.

- [ ] **Step 3: Write the failing test**

`test/main.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { ping } from "../src/main.js";

describe("ping", () => {
  it("returns pong", async () => {
    expect(await ping.func(fakeCtx())).toBe("pong");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- test/main.test.ts`
Expected: FAIL — cannot resolve `../src/main.js`.

- [ ] **Step 5: Write minimal implementation**

`src/main.ts`:

```ts
// Entry point for the amplifier Workflow service.
//
// Importing the task modules registers amplifier.checkPosts and, transitively,
// every task it composes — typefully.listPublished, slack.postMessage, kv.lock,
// kv.unlock, kv.get — because each module calls task(...) at load. They all
// register into the one shared @renderinc/sdk TaskRegistry.
import { task, type TaskContext } from "@renderinc/sdk/workflows";

// Zero-dep smoke task, handy for verifying the service is live.
export const ping = task({ name: "ping" }, function ping(ctx: TaskContext): string {
  return "pong";
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- test/main.test.ts && pnpm typecheck && pnpm build`
Expected: PASS, clean typecheck, `dist/main.js` written.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .node-version .gitignore src/main.ts test/main.test.ts pnpm-lock.yaml
git commit -m "chore: scaffold the amplifier workflow service"
```

---

### Task 2: Typefully DTOs and the draft mapper

**Files:**
- Create: `src/typefully/types.ts`, `src/typefully/map.ts`
- Test: `test/map.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Platform = "x" | "linkedin"`
  - `interface PlatformLink { platform: Platform; url?: string; publishedAt: string }`
  - `interface PublishedPost { draftId: string; preview: string; publishedAt: string; shareUrl?: string; links: PlatformLink[] }`
  - `interface TypefullyDraft` — the raw response shape, every field optional
  - `mapDraft(raw: TypefullyDraft): PublishedPost | null`

- [ ] **Step 1: Write the types**

`src/typefully/types.ts`:

```ts
// JSON-serializable DTOs for the typefully.* tasks.

/** The two platforms amplifier announces. Typefully supports more; we ignore them. */
export type Platform = "x" | "linkedin";

/** One platform a draft actually went live on. */
export interface PlatformLink {
  platform: Platform;
  /** Permalink to the live post. Absent when Typefully has not reported one yet. */
  url?: string;
  /** ISO 8601 timestamp this platform published at. */
  publishedAt: string;
}

/** A Typefully draft that went live on at least one platform we care about. */
export interface PublishedPost {
  draftId: string;
  /** Typefully's 100-char smart-trimmed text preview. */
  preview: string;
  /** Earliest publish time across `links`. */
  publishedAt: string;
  /** Typefully's public share URL, used as a fallback when a permalink is missing. */
  shareUrl?: string;
  /** One entry per platform that published. Never empty. */
  links: PlatformLink[];
}

/**
 * The subset of Typefully's draft response amplifier reads. Every field is
 * optional because the API adds fields over time and a missing one must not
 * throw — `mapDraft` decides what is usable.
 */
export interface TypefullyDraft {
  id?: string | number;
  preview?: string;
  status?: string;
  published_at?: string | null;
  share_url?: string | null;
  x_post_enabled?: boolean;
  x_post_published_at?: string | null;
  x_published_url?: string | null;
  linkedin_post_enabled?: boolean;
  linkedin_post_published_at?: string | null;
  linkedin_published_url?: string | null;
}

export interface ListPublishedInput {
  /** Typefully social set to read. Defaults to env TYPEFULLY_SOCIAL_SET_ID. */
  socialSetId?: string;
  /** Max drafts to pull in one call. Default 25. */
  limit?: number;
}

export interface ListPublishedResult {
  posts: PublishedPost[];
}
```

- [ ] **Step 2: Write the failing test**

`test/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapDraft } from "../src/typefully/map.js";
import type { TypefullyDraft } from "../src/typefully/types.js";

const crossPosted: TypefullyDraft = {
  id: 4211,
  preview: "We cut cold starts on Render by 40%.",
  status: "published",
  share_url: "https://typefully.com/t/abc123",
  x_post_enabled: true,
  x_post_published_at: "2026-09-04T15:02:00Z",
  x_published_url: "https://x.com/render/status/1",
  linkedin_post_enabled: true,
  linkedin_post_published_at: "2026-09-04T15:00:00Z",
  linkedin_published_url: "https://linkedin.com/feed/update/2",
};

describe("mapDraft", () => {
  it("returns one post with a link per platform that published", () => {
    const post = mapDraft(crossPosted);
    expect(post).toEqual({
      draftId: "4211",
      preview: "We cut cold starts on Render by 40%.",
      publishedAt: "2026-09-04T15:00:00Z",
      shareUrl: "https://typefully.com/t/abc123",
      links: [
        {
          platform: "linkedin",
          url: "https://linkedin.com/feed/update/2",
          publishedAt: "2026-09-04T15:00:00Z",
        },
        {
          platform: "x",
          url: "https://x.com/render/status/1",
          publishedAt: "2026-09-04T15:02:00Z",
        },
      ],
    });
  });

  it("sets publishedAt to the earliest platform time", () => {
    expect(mapDraft(crossPosted)?.publishedAt).toBe("2026-09-04T15:00:00Z");
  });

  it("keeps a platform whose permalink has not arrived yet", () => {
    const post = mapDraft({
      id: 7,
      x_post_published_at: "2026-09-04T15:00:00Z",
      x_published_url: null,
    });
    expect(post?.links).toEqual([
      { platform: "x", publishedAt: "2026-09-04T15:00:00Z" },
    ]);
  });

  it("ignores a platform that is enabled but not published", () => {
    const post = mapDraft({
      id: 8,
      x_post_enabled: true,
      x_post_published_at: "2026-09-04T15:00:00Z",
      x_published_url: "https://x.com/render/status/8",
      linkedin_post_enabled: true,
      linkedin_post_published_at: null,
    });
    expect(post?.links.map((l) => l.platform)).toEqual(["x"]);
  });

  it("returns null when no platform published", () => {
    expect(mapDraft({ id: 9, status: "scheduled" })).toBeNull();
  });

  it("returns null without an id", () => {
    expect(mapDraft({ x_post_published_at: "2026-09-04T15:00:00Z" })).toBeNull();
  });

  it("falls back to an empty preview", () => {
    expect(mapDraft({ id: 10, x_post_published_at: "2026-09-04T15:00:00Z" })?.preview).toBe("");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- test/map.test.ts`
Expected: FAIL — cannot resolve `../src/typefully/map.js`.

- [ ] **Step 4: Write minimal implementation**

`src/typefully/map.ts`:

```ts
import type { Platform, PlatformLink, PublishedPost, TypefullyDraft } from "./types.js";

/** Per-platform field names, so the mapper reads both platforms one way. */
const PLATFORM_FIELDS: Record<Platform, { at: keyof TypefullyDraft; url: keyof TypefullyDraft }> = {
  linkedin: { at: "linkedin_post_published_at", url: "linkedin_published_url" },
  x: { at: "x_post_published_at", url: "x_published_url" },
};

/**
 * Map a raw Typefully draft to a PublishedPost, or null when it is not an
 * announcement: no id, or no X/LinkedIn platform with a publish timestamp.
 *
 * A platform counts as published on its own `*_post_published_at`, not on
 * `*_post_enabled` — enabled means it was queued for that platform, which is
 * still true while the publish is in flight or after it errored.
 */
export function mapDraft(raw: TypefullyDraft): PublishedPost | null {
  if (raw.id === undefined || raw.id === null || raw.id === "") return null;

  const links: PlatformLink[] = [];
  for (const platform of Object.keys(PLATFORM_FIELDS) as Platform[]) {
    const fields = PLATFORM_FIELDS[platform];
    const publishedAt = raw[fields.at];
    if (typeof publishedAt !== "string" || publishedAt === "") continue;
    const url = raw[fields.url];
    links.push({
      platform,
      ...(typeof url === "string" && url !== "" ? { url } : {}),
      publishedAt,
    });
  }
  if (links.length === 0) return null;

  links.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const first = links[0];
  if (!first) return null;

  return {
    draftId: String(raw.id),
    preview: raw.preview ?? "",
    publishedAt: first.publishedAt,
    ...(raw.share_url ? { shareUrl: raw.share_url } : {}),
    links,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- test/map.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/typefully/types.ts src/typefully/map.ts test/map.test.ts
git commit -m "feat(typefully): map published drafts to a platform-link DTO"
```

---

### Task 3: Typefully port, retry policy, and `typefully.listPublished`

**Files:**
- Create: `src/typefully/retry.ts`, `src/typefully/client.ts`, `src/typefully/listPublished.ts`
- Test: `test/listPublished.test.ts`

**Interfaces:**
- Consumes: `mapDraft`, `TypefullyDraft`, `ListPublishedInput`, `ListPublishedResult` from Task 2.
- Produces:
  - `interface TypefullyPort { listPublishedDrafts(socialSetId: string, limit: number): Promise<TypefullyDraft[]> }`
  - `interface TypefullyDeps { typefully: TypefullyPort }`
  - `function typefullyPort(opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike }): TypefullyPort`
  - `const defaultDeps: TypefullyDeps`
  - `const TYPEFULLY_RETRY: Retry`
  - `listPublishedImpl(ctx, input, deps?): Promise<ListPublishedResult>` and the wrapped `listPublished` task named `typefully.listPublished`

- [ ] **Step 1: Write the retry policy**

`src/typefully/retry.ts`:

```ts
import type { Retry } from "@renderinc/sdk/workflows";

/**
 * Retry policy for the Typefully REST API — transient 5xx and network blips.
 * Backoff over ~2s, 4s, 8s. Rate limits are absorbed in-process by the
 * createHttpClient retry in client.ts, so this covers the longer tail.
 */
export const TYPEFULLY_RETRY: Retry = {
  maxRetries: 3,
  waitDurationMs: 2_000,
  backoffScaling: 2,
};
```

- [ ] **Step 2: Write the failing test**

`test/listPublished.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { listPublishedImpl } from "../src/typefully/listPublished.js";
import { typefullyPort } from "../src/typefully/client.js";
import type { TypefullyDeps, TypefullyDraft } from "../src/typefully/types.js";

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- test/listPublished.test.ts`
Expected: FAIL — cannot resolve `../src/typefully/client.js`.

- [ ] **Step 4: Write the port**

`src/typefully/client.ts`:

```ts
import { createHttpClient, type FetchLike } from "@render-lab/tasks-core";
import type { TypefullyDraft } from "./types.js";

/**
 * The slice of the Typefully API amplifier needs. The impl depends on this port
 * so it can be unit-tested with a fake; the default is a REST client.
 */
export interface TypefullyPort {
  /** Published drafts for one social set, newest first. */
  listPublishedDrafts(socialSetId: string, limit: number): Promise<TypefullyDraft[]>;
}

export interface TypefullyDeps {
  typefully: TypefullyPort;
}

/** v2 wraps lists in `results`; accept a bare array so a shape change is not an outage. */
function readDrafts(body: unknown): TypefullyDraft[] {
  if (Array.isArray(body)) return body as TypefullyDraft[];
  if (body && typeof body === "object") {
    const results = (body as { results?: unknown }).results;
    if (Array.isArray(results)) return results as TypefullyDraft[];
  }
  return [];
}

/**
 * Default Typefully port. The API key is read from TYPEFULLY_API_KEY on first
 * call, never at import, so a missing secret fails on use.
 *
 * The in-process retry absorbs a 429 burst: Typefully rate-limits per key, so a
 * durable re-dispatch that re-fires the same request would sustain the limit.
 */
export function typefullyPort(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): TypefullyPort {
  const env = opts.env ?? process.env;
  const client = createHttpClient({
    baseUrl: "https://api.typefully.com",
    label: "Typefully API",
    fetchImpl: opts.fetchImpl,
    auth: () => {
      const key = env.TYPEFULLY_API_KEY;
      if (!key) {
        throw new Error(
          "TYPEFULLY_API_KEY is required for the typefully tasks. Create a key in " +
            "Typefully under Settings > Integrations.",
        );
      }
      return { authorization: `Bearer ${key}` };
    },
    retry: { maxRetries: 3, baseDelayMs: 1_000 },
  });

  return {
    async listPublishedDrafts(socialSetId, limit) {
      const body = await client.call(
        `/v2/social-sets/${socialSetId}/drafts?status=published&limit=${limit}`,
      );
      return readDrafts(body);
    },
  };
}

/** Default deps used by the wrapped task in production. */
export const defaultDeps: TypefullyDeps = { typefully: typefullyPort() };
```

- [ ] **Step 5: Write the task**

`src/typefully/listPublished.ts`:

```ts
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { defaultDeps, type TypefullyDeps } from "./client.js";
import { mapDraft } from "./map.js";
import { TYPEFULLY_RETRY } from "./retry.js";
import type { ListPublishedInput, ListPublishedResult, PublishedPost } from "./types.js";

/** Raw implementation of typefully.listPublished. */
export async function listPublishedImpl(
  ctx: TaskContext,
  input: ListPublishedInput,
  deps: TypefullyDeps = defaultDeps,
): Promise<ListPublishedResult> {
  const socialSetId = input.socialSetId ?? process.env.TYPEFULLY_SOCIAL_SET_ID;
  if (!socialSetId) {
    throw new Error(
      "No social set configured. Set TYPEFULLY_SOCIAL_SET_ID or pass { socialSetId }. " +
        "List yours with GET https://api.typefully.com/v2/social-sets.",
    );
  }

  const drafts = await deps.typefully.listPublishedDrafts(socialSetId, input.limit ?? 25);
  const posts = drafts
    .map(mapDraft)
    .filter((p): p is PublishedPost => p !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return { posts };
}

/** Published drafts for a Typefully social set, as platform-link DTOs. */
export const listPublished = task(
  { name: "typefully.listPublished", retry: TYPEFULLY_RETRY },
  listPublishedImpl,
);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- test/listPublished.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Confirm the real response shape**

With a Typefully key in hand, run:

```bash
curl -s -H "Authorization: Bearer $TYPEFULLY_API_KEY" \
  https://api.typefully.com/v2/social-sets | head -40
curl -s -H "Authorization: Bearer $TYPEFULLY_API_KEY" \
  "https://api.typefully.com/v2/social-sets/<id>/drafts?status=published&limit=5" | head -80
```

Check three things and fix `client.ts` if any differ: the list is wrapped in `results`, `limit` is honored, and the order is newest-first. If the API rejects `limit` or ignores it, drop the parameter and rely on the lookback filter from Task 4 instead.

- [ ] **Step 8: Commit**

```bash
git add src/typefully/retry.ts src/typefully/client.ts src/typefully/listPublished.ts test/listPublished.test.ts
git commit -m "feat(typefully): add typefully.listPublished"
```

---

### Task 4: Lookback window filter

**Files:**
- Create: `src/amplifier/window.ts`
- Test: `test/window.test.ts`

**Interfaces:**
- Consumes: `PublishedPost` from Task 2.
- Produces: `withinWindow(posts: PublishedPost[], nowMs: number, lookbackMinutes: number): PublishedPost[]`

Why this exists: a cold start with an empty Key Value would otherwise announce every post Typefully has ever published. The window bounds that to recent history, and the Key Value claim from Task 6 handles the overlap between runs.

- [ ] **Step 1: Write the failing test**

`test/window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { withinWindow } from "../src/amplifier/window.js";
import type { PublishedPost } from "../src/typefully/types.js";

const NOW = Date.parse("2026-09-04T16:00:00Z");

function post(draftId: string, publishedAt: string): PublishedPost {
  return {
    draftId,
    preview: "p",
    publishedAt,
    links: [{ platform: "x", url: "https://x.com/render/status/1", publishedAt }],
  };
}

describe("withinWindow", () => {
  it("keeps a post inside the window", () => {
    const posts = [post("1", "2026-09-04T15:30:00Z")];
    expect(withinWindow(posts, NOW, 90).map((p) => p.draftId)).toEqual(["1"]);
  });

  it("drops a post older than the window", () => {
    const posts = [post("1", "2026-09-04T14:00:00Z")];
    expect(withinWindow(posts, NOW, 90)).toEqual([]);
  });

  it("keeps a post exactly on the boundary", () => {
    const posts = [post("1", "2026-09-04T14:30:00Z")];
    expect(withinWindow(posts, NOW, 90).map((p) => p.draftId)).toEqual(["1"]);
  });

  it("keeps a post dated slightly in the future", () => {
    const posts = [post("1", "2026-09-04T16:00:30Z")];
    expect(withinWindow(posts, NOW, 90).map((p) => p.draftId)).toEqual(["1"]);
  });

  it("drops a post with an unparseable timestamp", () => {
    const posts = [post("1", "not-a-date")];
    expect(withinWindow(posts, NOW, 90)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/window.test.ts`
Expected: FAIL — cannot resolve `../src/amplifier/window.js`.

- [ ] **Step 3: Write minimal implementation**

`src/amplifier/window.ts`:

```ts
import type { PublishedPost } from "../typefully/types.js";

/**
 * Keep the posts published within `lookbackMinutes` of `nowMs`.
 *
 * Future timestamps are kept: a small clock difference between Typefully and
 * the workflow instance must not swallow a post that just went live. A
 * timestamp that will not parse is dropped, because it cannot be windowed.
 */
export function withinWindow(
  posts: PublishedPost[],
  nowMs: number,
  lookbackMinutes: number,
): PublishedPost[] {
  const cutoff = nowMs - lookbackMinutes * 60_000;
  return posts.filter((p) => {
    const at = Date.parse(p.publishedAt);
    return Number.isFinite(at) && at >= cutoff;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/window.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/amplifier/window.ts test/window.test.ts
git commit -m "feat(amplifier): filter published posts to a lookback window"
```

---

### Task 5: Group co-published posts into one note

**Files:**
- Create: `src/amplifier/group.ts`
- Test: `test/group.test.ts`

**Interfaces:**
- Consumes: `PublishedPost`, `PlatformLink` from Task 2.
- Produces:
  - `interface PostGroup { draftIds: string[]; previews: string[]; links: PlatformLink[]; publishedAt: string; shareUrl?: string }`
  - `groupPosts(posts: PublishedPost[], groupWindowMinutes: number): PostGroup[]`

A draft cross-posted to X and LinkedIn is already one `PublishedPost` with two links, so it becomes one group by default. Two separate drafts merge only when both hold: published within `groupWindowMinutes` of the group's first post, and no platform overlap with the group. Two X posts stay separate because they are two announcements.

- [ ] **Step 1: Write the failing test**

`test/group.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupPosts } from "../src/amplifier/group.js";
import type { Platform, PublishedPost } from "../src/typefully/types.js";

function post(draftId: string, at: string, platforms: Platform[]): PublishedPost {
  return {
    draftId,
    preview: `preview ${draftId}`,
    publishedAt: at,
    shareUrl: `https://typefully.com/t/${draftId}`,
    links: platforms.map((platform) => ({
      platform,
      url: `https://example.com/${platform}/${draftId}`,
      publishedAt: at,
    })),
  };
}

describe("groupPosts", () => {
  it("keeps a cross-posted draft as one group with both links", () => {
    const groups = groupPosts([post("1", "2026-09-04T15:00:00Z", ["x", "linkedin"])], 10);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.links.map((l) => l.platform).sort()).toEqual(["linkedin", "x"]);
    expect(groups[0]?.draftIds).toEqual(["1"]);
  });

  it("merges two drafts on different platforms inside the window", () => {
    const groups = groupPosts(
      [
        post("1", "2026-09-04T15:00:00Z", ["x"]),
        post("2", "2026-09-04T15:04:00Z", ["linkedin"]),
      ],
      10,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.draftIds).toEqual(["1", "2"]);
    expect(groups[0]?.previews).toEqual(["preview 1", "preview 2"]);
    expect(groups[0]?.publishedAt).toBe("2026-09-04T15:00:00Z");
  });

  it("does not merge two drafts on the same platform", () => {
    const groups = groupPosts(
      [post("1", "2026-09-04T15:00:00Z", ["x"]), post("2", "2026-09-04T15:04:00Z", ["x"])],
      10,
    );
    expect(groups.map((g) => g.draftIds)).toEqual([["1"], ["2"]]);
  });

  it("does not merge drafts outside the window", () => {
    const groups = groupPosts(
      [
        post("1", "2026-09-04T15:00:00Z", ["x"]),
        post("2", "2026-09-04T15:20:00Z", ["linkedin"]),
      ],
      10,
    );
    expect(groups.map((g) => g.draftIds)).toEqual([["1"], ["2"]]);
  });

  it("measures the window from the group's first post, not the previous one", () => {
    const groups = groupPosts(
      [
        post("1", "2026-09-04T15:00:00Z", ["x"]),
        post("2", "2026-09-04T15:08:00Z", ["linkedin"]),
      ],
      10,
    );
    expect(groups[0]?.draftIds).toEqual(["1", "2"]);
  });

  it("orders groups oldest first regardless of input order", () => {
    const groups = groupPosts(
      [post("2", "2026-09-04T16:00:00Z", ["x"]), post("1", "2026-09-04T15:00:00Z", ["x"])],
      10,
    );
    expect(groups.map((g) => g.draftIds)).toEqual([["1"], ["2"]]);
  });

  it("carries the first share URL in the group", () => {
    const groups = groupPosts(
      [
        post("1", "2026-09-04T15:00:00Z", ["x"]),
        post("2", "2026-09-04T15:04:00Z", ["linkedin"]),
      ],
      10,
    );
    expect(groups[0]?.shareUrl).toBe("https://typefully.com/t/1");
  });

  it("returns nothing for no posts", () => {
    expect(groupPosts([], 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/group.test.ts`
Expected: FAIL — cannot resolve `../src/amplifier/group.js`.

- [ ] **Step 3: Write minimal implementation**

`src/amplifier/group.ts`:

```ts
import type { PlatformLink, PublishedPost } from "../typefully/types.js";

/** One Slack note's worth of published posts. */
export interface PostGroup {
  /** Every draft announced by this note. Drives the Key Value claim. */
  draftIds: string[];
  /** One preview per draft, in the same order as `draftIds`. */
  previews: string[];
  /** Every platform link across the group's drafts. */
  links: PlatformLink[];
  /** Earliest publish time in the group. */
  publishedAt: string;
  /** First Typefully share URL in the group, used when a permalink is missing. */
  shareUrl?: string;
}

/**
 * Collapse posts into one group per announcement.
 *
 * A draft cross-posted to X and LinkedIn arrives as a single post holding both
 * links, so it is already one group. Two separate drafts join the same group
 * only when the later one lands within `groupWindowMinutes` of the group's
 * first post AND adds a platform the group does not have yet — two X posts
 * minutes apart are two announcements, not one cross-post.
 */
export function groupPosts(posts: PublishedPost[], groupWindowMinutes: number): PostGroup[] {
  const windowMs = groupWindowMinutes * 60_000;
  const ordered = [...posts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const groups: PostGroup[] = [];
  let current: PostGroup | undefined;
  let currentStartMs = 0;
  let currentPlatforms = new Set<string>();

  for (const post of ordered) {
    const startMs = Date.parse(post.publishedAt);
    const platforms = post.links.map((l) => l.platform);
    const overlaps = platforms.some((p) => currentPlatforms.has(p));
    const inWindow = current !== undefined && startMs - currentStartMs <= windowMs;

    if (current && inWindow && !overlaps) {
      current.draftIds.push(post.draftId);
      current.previews.push(post.preview);
      current.links.push(...post.links);
      if (!current.shareUrl && post.shareUrl) current.shareUrl = post.shareUrl;
      for (const p of platforms) currentPlatforms.add(p);
      continue;
    }

    current = {
      draftIds: [post.draftId],
      previews: [post.preview],
      links: [...post.links],
      publishedAt: post.publishedAt,
      ...(post.shareUrl ? { shareUrl: post.shareUrl } : {}),
    };
    currentStartMs = startMs;
    currentPlatforms = new Set<string>(platforms);
    groups.push(current);
  }

  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/group.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/amplifier/group.ts test/group.test.ts
git commit -m "feat(amplifier): group co-published posts into one note"
```

---

### Task 6: The Slack note template

**Files:**
- Create: `src/amplifier/template.ts`
- Test: `test/template.test.ts`

**Interfaces:**
- Consumes: `PostGroup` from Task 5, `Platform` from Task 2, `PostMessageInput` from `@render-lab/tasks-slack`.
- Produces:
  - `const DEFAULT_CALL_TO_ACTION: string`
  - `interface RenderNoteOptions { channel?: string; callToAction?: string }`
  - `notePlatforms(group: PostGroup): Platform[]` — one entry per platform, X first
  - `renderNote(group: PostGroup, opts?: RenderNoteOptions): PostMessageInput`

- [ ] **Step 1: Write the failing test**

`test/template.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { notePlatforms, renderNote } from "../src/amplifier/template.js";
import type { PostGroup } from "../src/amplifier/group.js";

const crossPost: PostGroup = {
  draftIds: ["1"],
  previews: ["We cut cold starts on Render by 40%."],
  publishedAt: "2026-09-04T15:00:00Z",
  shareUrl: "https://typefully.com/t/abc",
  links: [
    {
      platform: "linkedin",
      url: "https://linkedin.com/feed/update/2",
      publishedAt: "2026-09-04T15:00:00Z",
    },
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: "2026-09-04T15:02:00Z" },
  ],
};

describe("renderNote", () => {
  it("links every platform in one message", () => {
    const note = renderNote(crossPost);
    expect(note.markdown).toContain("<https://x.com/render/status/1|X>");
    expect(note.markdown).toContain("<https://linkedin.com/feed/update/2|LinkedIn>");
  });

  it("puts X before LinkedIn", () => {
    const md = renderNote(crossPost).markdown ?? "";
    expect(md.indexOf("|X>")).toBeLessThan(md.indexOf("|LinkedIn>"));
  });

  it("quotes the preview", () => {
    expect(renderNote(crossPost).markdown).toContain("> We cut cold starts on Render by 40%.");
  });

  it("ends with the call to action", () => {
    expect(renderNote(crossPost).markdown?.endsWith(
      "Give it a like and a repost when you get a minute.",
    )).toBe(true);
  });

  it("takes a custom call to action", () => {
    const note = renderNote(crossPost, { callToAction: "Boost it please." });
    expect(note.markdown).toContain("Boost it please.");
  });

  it("sets a title and a plain-text fallback", () => {
    const note = renderNote(crossPost);
    expect(note.title).toBe("New Render post to amplify");
    expect(note.text).toContain("https://x.com/render/status/1");
  });

  it("passes the channel through", () => {
    expect(renderNote(crossPost, { channel: "#social" }).channel).toBe("#social");
  });

  it("omits the channel when none is given", () => {
    expect(renderNote(crossPost).channel).toBeUndefined();
  });

  it("quotes one preview per draft when drafts merged", () => {
    const merged: PostGroup = {
      draftIds: ["1", "2"],
      previews: ["first", "second"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [
        { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
        { platform: "linkedin", url: "https://linkedin.com/b", publishedAt: "2026-09-04T15:04:00Z" },
      ],
    };
    expect(renderNote(merged).markdown).toContain("> first");
    expect(renderNote(merged).markdown).toContain("> second");
  });

  it("falls back to the Typefully draft when a permalink is missing", () => {
    const pending: PostGroup = { ...crossPost, links: [
      { platform: "x", publishedAt: "2026-09-04T15:00:00Z" },
    ] };
    expect(renderNote(pending).markdown).toContain(
      "<https://typefully.com/t/abc|X (Typefully draft)>",
    );
  });

  it("says the link is pending with no permalink and no share URL", () => {
    const pending: PostGroup = {
      draftIds: ["1"],
      previews: ["p"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }],
    };
    expect(renderNote(pending).markdown).toContain("X (link pending)");
  });

  it("keeps one link per platform when two drafts share a platform", () => {
    const dupe: PostGroup = {
      draftIds: ["1"],
      previews: ["p"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [
        { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
        { platform: "x", url: "https://x.com/b", publishedAt: "2026-09-04T15:01:00Z" },
      ],
    };
    expect(notePlatforms(dupe)).toEqual(["x"]);
    expect(renderNote(dupe).markdown).not.toContain("https://x.com/b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/template.test.ts`
Expected: FAIL — cannot resolve `../src/amplifier/template.js`.

- [ ] **Step 3: Write minimal implementation**

`src/amplifier/template.ts`:

```ts
import type { PostMessageInput } from "@render-lab/tasks-slack";
import type { Platform, PlatformLink } from "../typefully/types.js";
import type { PostGroup } from "./group.js";

/** What the note asks the team to do. Override with AMPLIFIER_CALL_TO_ACTION. */
export const DEFAULT_CALL_TO_ACTION = "Give it a like and a repost when you get a minute.";

const NOTE_TITLE = "New Render post to amplify";

/** Display order in the note, so every note reads the same way. */
const PLATFORM_ORDER: Platform[] = ["x", "linkedin"];

const PLATFORM_LABELS: Record<Platform, string> = { x: "X", linkedin: "LinkedIn" };

export interface RenderNoteOptions {
  /** Slack channel to post to. Requires SLACK_BOT_TOKEN to be honored. */
  channel?: string;
  callToAction?: string;
}

/** One link per platform in display order, keeping the earliest of any duplicates. */
function orderedLinks(group: PostGroup): PlatformLink[] {
  const byPlatform = new Map<Platform, PlatformLink>();
  for (const link of group.links) {
    const seen = byPlatform.get(link.platform);
    if (!seen || link.publishedAt.localeCompare(seen.publishedAt) < 0) {
      byPlatform.set(link.platform, link);
    }
  }
  return PLATFORM_ORDER.flatMap((p) => {
    const link = byPlatform.get(p);
    return link ? [link] : [];
  });
}

/** Platforms this note covers, in display order. */
export function notePlatforms(group: PostGroup): Platform[] {
  return orderedLinks(group).map((l) => l.platform);
}

function linkMrkdwn(link: PlatformLink, shareUrl: string | undefined): string {
  const label = PLATFORM_LABELS[link.platform];
  if (link.url) return `<${link.url}|${label}>`;
  if (shareUrl) return `<${shareUrl}|${label} (Typefully draft)>`;
  return `${label} (link pending)`;
}

/**
 * Build the Slack message for one announcement: the post text as a quote, a
 * link per platform, and the amplify ask.
 *
 * `text` is the notification fallback Slack shows in the sidebar and in push
 * notifications, so it carries the URLs rather than only the title.
 */
export function renderNote(group: PostGroup, opts: RenderNoteOptions = {}): PostMessageInput {
  const links = orderedLinks(group);
  const linkLine = links.map((l) => linkMrkdwn(l, group.shareUrl)).join("  ·  ");
  const quotes = group.previews.filter((p) => p !== "").map((p) => `> ${p}`).join("\n>\n");
  const callToAction = opts.callToAction ?? DEFAULT_CALL_TO_ACTION;

  const markdown = [quotes, linkLine, callToAction].filter((s) => s !== "").join("\n\n");
  const urls = links.map((l) => l.url).filter((u): u is string => u !== undefined);
  const text = `${NOTE_TITLE}: ${urls.length > 0 ? urls.join(" ") : (group.shareUrl ?? "link pending")}`;

  return {
    text,
    title: NOTE_TITLE,
    markdown,
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/template.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/amplifier/template.ts test/template.test.ts
git commit -m "feat(amplifier): render the amplify note"
```

---

### Task 7: Announce each post once

> **Corrected after the final review.** The design in this task re-announces every
> post on each cron run, and drops a draft that joins an already-announced group.
> `groupToken` is gone. The announced marker and the in-flight lock are now separate
> keys, dedupe is per draft rather than per group, and the marker is written after
> the Slack post returns. See the correction note at the top of Design Decisions and
> `src/amplifier/seen.ts`. The steps below record what was built first.

**Files:**
- Create: `src/amplifier/seen.ts`
- Test: `test/seen.test.ts`

**Interfaces:**
- Consumes: `PostGroup` from Task 5; `kv.lock`, `kv.unlock`, `kv.get` from `@render-lab/tasks-render-kv`.
- Produces:
  - `interface Claim { key: string; token: string }`
  - `seenKey(draftId: string): string`
  - `groupToken(group: PostGroup): string`
  - `claimGroup(ctx: TaskContext, group: PostGroup, ttlSeconds: number): Promise<Claim[] | null>` — `null` means already announced
  - `releaseGroup(ctx: TaskContext, claims: Claim[]): Promise<void>`

`kv.lock` is `SET key token NX EX ttl`, which is the claim primitive. The token is derived from the group's draft ids, so it is the same on every attempt at the same announcement. That is what lets a retry after a crash tell "someone else already announced this" from "I claimed this a moment ago and died before posting".

- [ ] **Step 1: Write the failing test**

`test/seen.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/seen.test.ts`
Expected: FAIL — cannot resolve `../src/amplifier/seen.js`.

- [ ] **Step 3: Write minimal implementation**

`src/amplifier/seen.ts`:

```ts
import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, lock, unlock } from "@render-lab/tasks-render-kv";
import type { PostGroup } from "./group.js";

/** A Key Value claim this run holds on one draft. */
export interface Claim {
  key: string;
  token: string;
}

/** Key that records a draft as announced. */
export function seenKey(draftId: string): string {
  return `amplifier:seen:${draftId}`;
}

/**
 * Fencing token for a group, derived from its sorted draft ids so every attempt
 * at the same announcement produces the same token.
 */
export function groupToken(group: PostGroup): string {
  return `amplifier:${[...group.draftIds].sort().join("+")}`;
}

/**
 * Claim every draft in the group, or nothing.
 *
 * Returns the claims on success and `null` when the group was already
 * announced. A failed `kv.lock` is ambiguous — another run may hold the key, or
 * this run may have claimed it and crashed before posting — so the stored token
 * is read to tell the two apart. Claims already taken are released before
 * giving up, so the next run can retry the drafts that are still unannounced.
 */
export async function claimGroup(
  ctx: TaskContext,
  group: PostGroup,
  ttlSeconds: number,
): Promise<Claim[] | null> {
  const token = groupToken(group);
  const claims: Claim[] = [];

  for (const draftId of group.draftIds) {
    const key = seenKey(draftId);
    const { acquired } = await ctx.run(lock, { key, token, ttlSeconds });
    if (acquired) {
      claims.push({ key, token });
      continue;
    }

    const { value } = await ctx.run(kvGet, { key });
    if (value === token) {
      claims.push({ key, token });
      continue;
    }

    await releaseGroup(ctx, claims);
    return null;
  }

  return claims;
}

/** Release claims so a later run can announce these drafts. */
export async function releaseGroup(ctx: TaskContext, claims: Claim[]): Promise<void> {
  for (const claim of claims) {
    await ctx.run(unlock, { key: claim.key, token: claim.token });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/seen.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/amplifier/seen.ts test/seen.test.ts
git commit -m "feat(amplifier): claim each draft in Key Value so it posts once"
```

---

### Task 8: Run configuration

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CALL_TO_ACTION` from Task 6.
- Produces:
  - `interface CheckPostsInput { socialSetId?, limit?, lookbackMinutes?, groupWindowMinutes?, seenTtlDays?, slackChannel?, callToAction?, dryRun?, now? }`
  - `interface AmplifierConfig { socialSetId?: string; limit: number; lookbackMinutes: number; groupWindowMinutes: number; seenTtlSeconds: number; slackChannel?: string; callToAction: string; dryRun: boolean }`
  - `loadConfig(input?: CheckPostsInput, env?: NodeJS.ProcessEnv): AmplifierConfig`

Precedence is per-run override, then environment, then default. `socialSetId` stays optional here — `typefully.listPublished` owns that error message, so there is one place it is raised.

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_CALL_TO_ACTION } from "../src/amplifier/template.js";

describe("loadConfig", () => {
  it("uses the defaults with an empty env", () => {
    expect(loadConfig({}, {})).toEqual({
      limit: 25,
      lookbackMinutes: 90,
      groupWindowMinutes: 10,
      seenTtlSeconds: 30 * 86_400,
      callToAction: DEFAULT_CALL_TO_ACTION,
      dryRun: true,
    });
  });

  it("reads the env", () => {
    const config = loadConfig({}, {
      TYPEFULLY_SOCIAL_SET_ID: "set_1",
      AMPLIFIER_LOOKBACK_MINUTES: "30",
      AMPLIFIER_GROUP_WINDOW_MINUTES: "5",
      AMPLIFIER_SEEN_TTL_DAYS: "7",
      AMPLIFIER_LIMIT: "50",
      AMPLIFIER_CALL_TO_ACTION: "Boost it.",
      SLACK_CHANNEL: "#social",
      DRY_RUN: "false",
    });
    expect(config).toEqual({
      socialSetId: "set_1",
      limit: 50,
      lookbackMinutes: 30,
      groupWindowMinutes: 5,
      seenTtlSeconds: 7 * 86_400,
      slackChannel: "#social",
      callToAction: "Boost it.",
      dryRun: false,
    });
  });

  it("lets a per-run input override the env", () => {
    const config = loadConfig({ lookbackMinutes: 5, dryRun: true }, {
      AMPLIFIER_LOOKBACK_MINUTES: "90",
      DRY_RUN: "false",
    });
    expect(config.lookbackMinutes).toBe(5);
    expect(config.dryRun).toBe(true);
  });

  it("stays in dry run unless DRY_RUN is exactly false", () => {
    expect(loadConfig({}, { DRY_RUN: "0" }).dryRun).toBe(true);
    expect(loadConfig({}, { DRY_RUN: "no" }).dryRun).toBe(true);
    expect(loadConfig({}, { DRY_RUN: "false" }).dryRun).toBe(false);
  });

  it("ignores a non-numeric env value", () => {
    expect(loadConfig({}, { AMPLIFIER_LOOKBACK_MINUTES: "soon" }).lookbackMinutes).toBe(90);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write minimal implementation**

`src/config.ts`:

```ts
import { DEFAULT_CALL_TO_ACTION } from "./amplifier/template.js";

/** Overrides accepted per run; anything omitted falls back to env, then defaults. */
export interface CheckPostsInput {
  socialSetId?: string;
  limit?: number;
  lookbackMinutes?: number;
  groupWindowMinutes?: number;
  seenTtlDays?: number;
  slackChannel?: string;
  callToAction?: string;
  dryRun?: boolean;
  /** ISO 8601 "now", for tests and for replaying a past window. */
  now?: string;
}

export interface AmplifierConfig {
  socialSetId?: string;
  limit: number;
  lookbackMinutes: number;
  groupWindowMinutes: number;
  seenTtlSeconds: number;
  slackChannel?: string;
  callToAction: string;
  dryRun: boolean;
}

/**
 * Resolve run config from per-run overrides, then environment, then defaults.
 *
 * DRY_RUN defaults to true: the first deploy logs the note it would post and
 * writes nothing to Slack unless DRY_RUN is explicitly "false".
 *
 * The lookback default of 90 minutes is deliberately wider than the 30-minute
 * cron schedule, so one skipped run still catches up. The Key Value claim makes
 * the overlap safe.
 */
export function loadConfig(
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): AmplifierConfig {
  const socialSetId = input.socialSetId ?? env.TYPEFULLY_SOCIAL_SET_ID;
  const slackChannel = input.slackChannel ?? env.SLACK_CHANNEL;
  const seenTtlDays = input.seenTtlDays ?? numberFromEnv(env.AMPLIFIER_SEEN_TTL_DAYS, 30);

  return {
    ...(socialSetId ? { socialSetId } : {}),
    limit: input.limit ?? numberFromEnv(env.AMPLIFIER_LIMIT, 25),
    lookbackMinutes: input.lookbackMinutes ?? numberFromEnv(env.AMPLIFIER_LOOKBACK_MINUTES, 90),
    groupWindowMinutes:
      input.groupWindowMinutes ?? numberFromEnv(env.AMPLIFIER_GROUP_WINDOW_MINUTES, 10),
    seenTtlSeconds: seenTtlDays * 86_400,
    ...(slackChannel ? { slackChannel } : {}),
    callToAction: input.callToAction ?? env.AMPLIFIER_CALL_TO_ACTION ?? DEFAULT_CALL_TO_ACTION,
    dryRun: input.dryRun ?? env.DRY_RUN !== "false",
  };
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- test/config.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(amplifier): resolve run config from input, env, defaults"
```

---

### Task 9: Compose `amplifier.checkPosts`

**Files:**
- Create: `src/amplifier/checkPosts.ts`
- Modify: `src/main.ts` (add the import that registers the task)
- Test: `test/checkPosts.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `CheckPostsInput` (Task 8); `listPublished` (Task 3); `withinWindow` (Task 4); `groupPosts` (Task 5); `renderNote`, `notePlatforms` (Task 6); `claimGroup`, `releaseGroup` (Task 7); `postMessage` from `@render-lab/tasks-slack`.
- Produces:
  - `interface NoteResult { draftIds: string[]; platforms: Platform[]; delivered: boolean }`
  - `interface CheckPostsResult { scanned: number; inWindow: number; groups: number; notified: number; skipped: number; dryRun: boolean; notes: NoteResult[] }`
  - `checkPostsImpl(ctx, input?): Promise<CheckPostsResult>` and the wrapped `checkPosts` task named `amplifier.checkPosts`

In dry run the claim is taken and then released, so the dedupe path runs on every deploy while leaving Key Value clean for the first real run.

- [ ] **Step 1: Write the failing test**

`test/checkPosts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import type { TaskDefinition } from "@renderinc/sdk/workflows";
import { checkPostsImpl } from "../src/amplifier/checkPosts.js";
import type { PublishedPost } from "../src/typefully/types.js";

const NOW = "2026-09-04T16:00:00Z";

function post(draftId: string, at: string, platforms: Array<"x" | "linkedin">): PublishedPost {
  return {
    draftId,
    preview: `preview ${draftId}`,
    publishedAt: at,
    links: platforms.map((platform) => ({
      platform,
      url: `https://example.com/${platform}/${draftId}`,
      publishedAt: at,
    })),
  };
}

/** ctx.run dispatched by task name, with sensible defaults per task. */
function runCtx(overrides: Record<string, (input: any) => unknown> = {}) {
  const calls: Array<{ name: string; input: any }> = [];
  const handlers: Record<string, (input: any) => unknown> = {
    "typefully.listPublished": () => ({ posts: [] }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "kv.get": () => ({ value: null }),
    "slack.postMessage": () => ({ delivered: true }),
    ...overrides,
  };
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

const BASE = { now: NOW, dryRun: false, socialSetId: "set_1", slackChannel: "#social" };

describe("checkPostsImpl", () => {
  it("posts one note for a cross-posted draft", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x", "linkedin"])],
      }),
    });

    const result = await checkPostsImpl(ctx, BASE);

    const posts = calls.filter((c) => c.name === "slack.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.input.channel).toBe("#social");
    expect(posts[0]?.input.markdown).toContain("|X>");
    expect(posts[0]?.input.markdown).toContain("|LinkedIn>");
    expect(result.notified).toBe(1);
  });

  it("posts one note when an X post and a LinkedIn post land together", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [
          post("1", "2026-09-04T15:30:00Z", ["x"]),
          post("2", "2026-09-04T15:33:00Z", ["linkedin"]),
        ],
      }),
    });

    const result = await checkPostsImpl(ctx, BASE);

    expect(calls.filter((c) => c.name === "slack.postMessage")).toHaveLength(1);
    expect(result.notes[0]?.draftIds).toEqual(["1", "2"]);
  });

  it("drops posts older than the lookback window", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T10:00:00Z", ["x"])],
      }),
    });

    const result = await checkPostsImpl(ctx, { ...BASE, lookbackMinutes: 90 });

    expect(calls.filter((c) => c.name === "slack.postMessage")).toEqual([]);
    expect(result.inWindow).toBe(0);
  });

  it("skips a group another run already announced", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "kv.lock": () => ({ acquired: false }),
      "kv.get": () => ({ value: "amplifier:someone-else" }),
    });

    const result = await checkPostsImpl(ctx, BASE);

    expect(calls.filter((c) => c.name === "slack.postMessage")).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("claims the drafts before posting", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    await checkPostsImpl(ctx, BASE);

    const names = calls.map((c) => c.name);
    expect(names.indexOf("kv.lock")).toBeLessThan(names.indexOf("slack.postMessage"));
  });

  it("releases the claim when the Slack post fails", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
      "slack.postMessage": () => {
        throw new Error("slack down");
      },
    });

    await expect(checkPostsImpl(ctx, BASE)).rejects.toThrow("slack down");
    expect(calls.filter((c) => c.name === "kv.unlock").map((c) => c.input.key)).toEqual([
      "amplifier:seen:1",
    ]);
  });

  it("posts nothing in dry run and leaves no claim behind", async () => {
    const { ctx, calls } = runCtx({
      "typefully.listPublished": () => ({
        posts: [post("1", "2026-09-04T15:30:00Z", ["x"])],
      }),
    });

    const result = await checkPostsImpl(ctx, { ...BASE, dryRun: true });

    expect(calls.filter((c) => c.name === "slack.postMessage")).toEqual([]);
    expect(calls.filter((c) => c.name === "kv.unlock")).toHaveLength(1);
    expect(result.dryRun).toBe(true);
    expect(result.notified).toBe(0);
    expect(result.notes[0]?.draftIds).toEqual(["1"]);
  });

  it("passes the social set and limit to typefully.listPublished", async () => {
    const { ctx, calls } = runCtx();
    await checkPostsImpl(ctx, { ...BASE, limit: 7 });
    expect(calls[0]).toEqual({
      name: "typefully.listPublished",
      input: { socialSetId: "set_1", limit: 7 },
    });
  });

  it("reports counts for an empty run", async () => {
    const { ctx } = runCtx();
    expect(await checkPostsImpl(ctx, BASE)).toEqual({
      scanned: 0,
      inWindow: 0,
      groups: 0,
      notified: 0,
      skipped: 0,
      dryRun: false,
      notes: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/checkPosts.test.ts`
Expected: FAIL — cannot resolve `../src/amplifier/checkPosts.js`.

- [ ] **Step 3: Write minimal implementation**

`src/amplifier/checkPosts.ts`:

```ts
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { postMessage } from "@render-lab/tasks-slack";
import { loadConfig, type CheckPostsInput } from "../config.js";
import { listPublished } from "../typefully/listPublished.js";
import type { Platform } from "../typefully/types.js";
import { groupPosts } from "./group.js";
import { claimGroup, releaseGroup } from "./seen.js";
import { notePlatforms, renderNote } from "./template.js";
import { withinWindow } from "./window.js";

/** One announcement's outcome. */
export interface NoteResult {
  draftIds: string[];
  platforms: Platform[];
  /** false in dry run, and false when Slack fell back to the console. */
  delivered: boolean;
}

export interface CheckPostsResult {
  /** Published drafts Typefully returned. */
  scanned: number;
  /** Of those, the ones inside the lookback window. */
  inWindow: number;
  /** Announcements those posts collapsed into. */
  groups: number;
  notified: number;
  /** Groups a previous run already announced. */
  skipped: number;
  dryRun: boolean;
  notes: NoteResult[];
}

/** Raw implementation of amplifier.checkPosts. */
export async function checkPostsImpl(
  ctx: TaskContext,
  input: CheckPostsInput = {},
): Promise<CheckPostsResult> {
  const config = loadConfig(input);
  const nowMs = input.now ? Date.parse(input.now) : Date.now();

  const { posts } = await ctx.run(listPublished, {
    ...(config.socialSetId ? { socialSetId: config.socialSetId } : {}),
    limit: config.limit,
  });

  const recent = withinWindow(posts, nowMs, config.lookbackMinutes);
  const groups = groupPosts(recent, config.groupWindowMinutes);

  const notes: NoteResult[] = [];
  let skipped = 0;

  for (const group of groups) {
    const claims = await claimGroup(ctx, group, config.seenTtlSeconds);
    if (claims === null) {
      skipped += 1;
      continue;
    }

    const message = renderNote(group, {
      ...(config.slackChannel ? { channel: config.slackChannel } : {}),
      callToAction: config.callToAction,
    });
    const platforms = notePlatforms(group);

    if (config.dryRun) {
      // Release the claim so the first real run still announces this post.
      console.log(`[dry run] would post:\n${message.markdown ?? message.text}`);
      await releaseGroup(ctx, claims);
      notes.push({ draftIds: group.draftIds, platforms, delivered: false });
      continue;
    }

    try {
      const { delivered } = await ctx.run(postMessage, message);
      notes.push({ draftIds: group.draftIds, platforms, delivered });
    } catch (err) {
      await releaseGroup(ctx, claims);
      throw err;
    }
  }

  return {
    scanned: posts.length,
    inWindow: recent.length,
    groups: groups.length,
    notified: notes.filter((n) => n.delivered).length,
    skipped,
    dryRun: config.dryRun,
    notes,
  };
}

/** Announce newly published Render posts to Slack, once each. */
export const checkPosts = task({ name: "amplifier.checkPosts" }, checkPostsImpl);
```

- [ ] **Step 4: Register the task on the service**

Add the import to `src/main.ts`, above the `ping` definition:

```ts
import "./amplifier/checkPosts.js";
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS across all eight test files, clean typecheck, `dist/` written.

- [ ] **Step 6: Commit**

```bash
git add src/amplifier/checkPosts.ts src/main.ts test/checkPosts.test.ts
git commit -m "feat(amplifier): compose amplifier.checkPosts"
```

---

### Task 10: Cron trigger, Blueprint, and docs

**Files:**
- Create: `src/cron-trigger.ts`, `render.yaml`, `.env.example`, `README.md`
- Test: manual — `render workflows dev`, then a real cron dispatch

**Interfaces:**
- Consumes: `runCron` from `@render-lab/triggers`; the `amplifier.checkPosts` task name from Task 9.
- Produces: a deployable cron entry point and the Blueprint that runs it every 30 minutes.

- [ ] **Step 1: Write the cron entry point**

`src/cron-trigger.ts`:

```ts
// Cron job entry point — a SEPARATE Render cron service, not the Workflow.
// Render Workflows have no built-in scheduler, so this dispatches the workflow
// on a schedule via @render-lab/triggers. Deploy as a Render cron job with
// WORKFLOW_SLUG + RENDER_API_KEY set; CRON_TASK / CRON_INPUT override the task
// and its args.
import { runCron } from "@render-lab/triggers";

runCron({ task: process.env.CRON_TASK ?? "amplifier.checkPosts" })
  .then((r) => {
    console.log(`dispatched ${r.runId}: ${r.status}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 2: Write the env contract**

`.env.example`:

```
# Copy to .env for local dev: `render workflows dev` loads it automatically.

# --- Typefully (the post source) ---
TYPEFULLY_API_KEY=tf_...
# List your sets: curl -H "Authorization: Bearer $TYPEFULLY_API_KEY" \
#   https://api.typefully.com/v2/social-sets
TYPEFULLY_SOCIAL_SET_ID=

# --- @render-lab/tasks-slack ---
# A bot token is what makes SLACK_CHANNEL work. With only a webhook, the
# webhook's own channel wins. With neither, the note prints to the console.
SLACK_BOT_TOKEN=xoxb-...
# SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_CHANNEL=#social

# --- @render-lab/tasks-render-kv (announce-once state) ---
REDIS_URL=redis://localhost:6379

# --- amplifier config ---
DRY_RUN=true                       # default; set to false to post to Slack
# AMPLIFIER_LOOKBACK_MINUTES=90    # wider than the 30-minute schedule on purpose
# AMPLIFIER_GROUP_WINDOW_MINUTES=10
# AMPLIFIER_SEEN_TTL_DAYS=30
# AMPLIFIER_LIMIT=25
# AMPLIFIER_CALL_TO_ACTION=Give it a like and a repost when you get a minute.

# --- trigger layer (@render-lab/triggers): the cron service only ---
# These only need dispatch credentials. The vendor keys above live on the
# Workflow service, not on the cron service.
# RENDER_API_KEY=rnd_...
# WORKFLOW_SLUG=amplifier
# CRON_TASK=amplifier.checkPosts
# CRON_INPUT={}
```

- [ ] **Step 3: Write the Blueprint**

`render.yaml`:

```yaml
# Blueprint for the amplifier trigger layer: the cron service that starts
# workflow runs, plus the Key Value instance that records which posts have
# already been announced. The Workflow service itself is created separately
# because Blueprints don't support Workflows yet.
#
# Order: create the Workflow service, apply this Blueprint, then copy the
# amplifier-kv internal connection string into the Workflow service's REDIS_URL.
projects:
  - name: amplifier
    environments:
      - name: Production
        services:
          - type: cron
            name: amplifier-cron
            runtime: node
            plan: starter
            region: oregon
            schedule: "*/30 * * * *"
            buildCommand: pnpm install && pnpm build
            startCommand: node dist/cron-trigger.js
            autoDeployTrigger: commit
            envVars:
              - fromGroup: amplifier-triggers

          - type: keyvalue
            name: amplifier-kv
            plan: starter
            region: oregon
            maxmemoryPolicy: noeviction
            # Reachable only over the private network.
            ipAllowList: []

        envVarGroups:
          - name: amplifier-triggers
            envVars:
              # The cron service only starts runs. TYPEFULLY_API_KEY,
              # SLACK_BOT_TOKEN, and REDIS_URL live on the Workflow service.
              - key: RENDER_API_KEY
                sync: false
              - key: WORKFLOW_SLUG
                value: amplifier
              - key: CRON_TASK
                value: amplifier.checkPosts
              - key: CRON_INPUT
                value: "{}"
```

- [ ] **Step 4: Validate the Blueprint**

Run: `render blueprints validate render.yaml`
Expected: no errors. `maxmemoryPolicy: noeviction` matters — dedupe keys must not be evicted under memory pressure, or a post gets announced twice.

- [ ] **Step 5: Write the README**

`README.md`:

````markdown
# Amplifier

Amplifier posts one note to Slack when a Render post goes live on X or LinkedIn, asking the team to amplify it.

It reads published drafts from Typefully, which is where the Render X and LinkedIn accounts are scheduled. A post sent to both platforms produces one note with both links.

## How it works

A Render cron job runs every 30 minutes and dispatches `amplifier.checkPosts` on the amplifier Workflow service. That task:

1. Calls `typefully.listPublished` for published drafts in the configured social set.
2. Keeps the drafts published in the last 90 minutes.
3. Claims each draft id in Render Key Value, so each post is announced once.
4. Groups drafts published close together on different platforms into one note.
5. Posts the note through `slack.postMessage`.

## Local development

```bash
pnpm install
pnpm test          # unit tests, no secrets needed
cp .env.example .env
render workflows dev -- pnpm dev
# in another terminal:
render workflows tasks list --local
render workflows start amplifier.checkPosts --local --input='[{}]'
```

`DRY_RUN=true` is the default, so a local run logs the note it would post and writes nothing to Slack.

## Deployment

1. Create a Workflow service in the Render Dashboard from this repo, with build `pnpm install && pnpm build` and start `node dist/main.js`. Note its slug.
2. Apply `render.yaml` to create the cron job and the Key Value instance. Set `RENDER_API_KEY` and confirm `WORKFLOW_SLUG` matches the slug from step 1.
3. On the Workflow service, set `TYPEFULLY_API_KEY`, `TYPEFULLY_SOCIAL_SET_ID`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, and `REDIS_URL` (the `amplifier-kv` internal connection string).
4. Leave `DRY_RUN=true` for a couple of cron runs and read the Workflow logs.
5. Set `DRY_RUN=false`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `TYPEFULLY_API_KEY` | — | Required. Typefully Settings > Integrations. |
| `TYPEFULLY_SOCIAL_SET_ID` | — | Required. `GET /v2/social-sets` lists them. |
| `SLACK_BOT_TOKEN` | — | Required for `SLACK_CHANNEL` to be honored. |
| `SLACK_CHANNEL` | — | Channel the note goes to. |
| `REDIS_URL` | — | Required. The `amplifier-kv` internal connection string. |
| `DRY_RUN` | `true` | Set to `false` to post to Slack. |
| `AMPLIFIER_LOOKBACK_MINUTES` | `90` | Wider than the 30-minute schedule, so a skipped run catches up. |
| `AMPLIFIER_GROUP_WINDOW_MINUTES` | `10` | How close two drafts must be to share a note. |
| `AMPLIFIER_SEEN_TTL_DAYS` | `30` | How long a draft stays marked as announced. |
| `AMPLIFIER_LIMIT` | `25` | Drafts pulled per run. |
| `AMPLIFIER_CALL_TO_ACTION` | see below | The ask at the end of the note. |

Default call to action: "Give it a like and a repost when you get a minute."

## Adding X or LinkedIn directly

Everything that knows Typefully's field names lives in `src/typefully/`. `src/amplifier/` works only on the `PublishedPost` DTO, so a direct X or LinkedIn source means adding a sibling directory with a second task shaped like `typefully.listPublished` and merging its posts in `checkPosts.ts`.
````

- [ ] **Step 6: Commit**

```bash
git add src/cron-trigger.ts render.yaml .env.example README.md
git commit -m "feat: add the cron trigger, Blueprint, and README"
```

- [ ] **Step 7: Verify against the real services**

Run through the deployment steps above, then confirm each of these:

1. `render workflows tasks list` shows `amplifier.checkPosts`, `typefully.listPublished`, `slack.postMessage`, `kv.lock`, `kv.unlock`, `kv.get`, `ping`.
2. A manual run with `DRY_RUN=true` logs a note for a post you know went live in the last 90 minutes.
3. With `DRY_RUN=false`, one manual run posts to `SLACK_CHANNEL`.
4. A second manual run right after posts nothing and reports `skipped: 1`.
5. The cron job's logs show `dispatched <runId>: running` on the half hour.

Report any step that does not behave this way rather than adjusting the plan silently.

---

## Open Questions

Two things to confirm during Task 3, both cheap to check with a real API key and neither one blocking the build:

1. Whether `GET /v2/social-sets/{id}/drafts?status=published` accepts `limit` and returns newest-first. If not, drop `limit` and lean on the lookback filter.
2. Whether Typefully sets `x_published_url` and `linkedin_published_url` at the same moment as the matching `*_post_published_at`. If a permalink lags, the note falls back to the Typefully draft link, and widening `AMPLIFIER_GROUP_WINDOW_MINUTES` is not the fix — the post is still announced once.

## Later Work

Not in this plan, listed so they are not mistaken for oversights:

- **Typefully webhooks** instead of polling, which would cut the delay from 30 minutes to seconds. Blocked on Typefully documenting its event types. It would add a trigger web service using the dispatch server in `@render-lab/triggers` and would not change `amplifier.checkPosts`.
- **Extracting `packages/tasks-typefully`** into `render-tasks` once the tasks have run in production for a while.
- **Engagement follow-up**, such as a note when a post passes an impression threshold. Typefully exposes `GET /v2/social-sets/{id}/analytics/{platform}/posts` for this.
