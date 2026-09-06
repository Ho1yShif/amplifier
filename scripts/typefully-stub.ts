/**
 * A stand-in for Typefully and a Slack incoming webhook, so the whole
 * announce-once path can run locally with no credentials.
 *
 *   pnpm stub
 *
 * It serves two routes:
 *
 *   GET  /v2/social-sets/:id/drafts   the canned drafts below, honouring `limit`
 *   POST /slack                       logs the note and returns 200
 *
 * Point the app at it with TYPEFULLY_BASE_URL and SLACK_WEBHOOK_URL. See
 * scripts/local-run.ts for the full command.
 *
 * The drafts are newest-first, which is what the real API is assumed to do.
 * Reverse DRAFTS to reproduce the oldest-first case where `limit` truncates the
 * window to nothing and every run posts nothing without erroring.
 */
import { createServer } from "node:http";
import type { TypefullyDraft } from "../src/typefully/types.js";

const PORT = Number(process.env.STUB_PORT ?? 8787);

/** Minutes before now, so the drafts always land inside the lookback window. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Draft 101 is a cross-post: one note covering X and LinkedIn four minutes
 * apart. Draft 102 is X only, far enough back to be its own note.
 */
const DRAFTS: TypefullyDraft[] = [
  {
    id: 101,
    preview: "We shipped instant Postgres restores.",
    status: "published",
    published_at: minutesAgo(20),
    share_url: "https://typefully.com/t/101",
    x_post_enabled: true,
    x_post_published_at: minutesAgo(20),
    x_published_url: "https://x.com/render/status/101",
    linkedin_post_enabled: true,
    linkedin_post_published_at: minutesAgo(16),
    linkedin_published_url: "https://linkedin.com/feed/update/101",
  },
  {
    id: 102,
    preview: "Workflows now retry a failed task without replaying the run.",
    status: "published",
    published_at: minutesAgo(55),
    share_url: "https://typefully.com/t/102",
    x_post_enabled: true,
    x_post_published_at: minutesAgo(55),
    x_published_url: "https://x.com/render/status/102",
  },
];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && /^\/v2\/social-sets\/[^/]+\/drafts$/.test(url.pathname)) {
    const limit = Number(url.searchParams.get("limit") ?? DRAFTS.length);
    const results = DRAFTS.slice(0, limit);
    console.log(`[stub] ${url.pathname}?${url.searchParams} -> ${results.length} drafts`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/slack") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const text = (JSON.parse(body || "{}") as { text?: string }).text;
      console.log(`[stub] slack <- ${text}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    return;
  }

  console.log(`[stub] 404 ${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[stub] Typefully and Slack on http://localhost:${PORT}`);
});
