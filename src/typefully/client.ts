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

/** Typefully's real API. TYPEFULLY_BASE_URL overrides it for a local stub. */
export const TYPEFULLY_BASE_URL = "https://api.typefully.com";

/** Hostnames that can only be this machine, in the forms `new URL` reports. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The base URL to send the API key to, or a throw.
 *
 * TYPEFULLY_BASE_URL exists to point a run at `scripts/typefully-stub.ts`, and
 * `auth` sends `Bearer $TYPEFULLY_API_KEY` to whatever host it names. Anything
 * that is neither the real API nor a loopback address is refused, so the key
 * cannot be redirected to a third party by setting one environment variable.
 */
function checkedBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === TYPEFULLY_BASE_URL) return TYPEFULLY_BASE_URL;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`TYPEFULLY_BASE_URL is not a URL: ${trimmed}`);
  }
  // "localhost:8787" parses, as a URL whose scheme is "localhost" and whose
  // host is empty, so check the scheme before the host to name that typo.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`TYPEFULLY_BASE_URL needs an http:// or https:// scheme; got ${trimmed}.`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `TYPEFULLY_BASE_URL is ${trimmed}, and TYPEFULLY_API_KEY would be sent to ` +
        `${url.hostname}. It only takes a loopback address, for the local stub, or ` +
        `${TYPEFULLY_BASE_URL}. Leave it unset in production.`,
    );
  }
  return trimmed;
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
    baseUrl: checkedBaseUrl(env.TYPEFULLY_BASE_URL),
    label: "Typefully API",
    // createHttpClient's fetchImpl is optional but not nullable, so omitting
    // the key selects global fetch. Spread it rather than pass undefined.
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
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
        `/v2/social-sets/${encodeURIComponent(socialSetId)}/drafts?status=published&limit=${limit}`,
      );
      return readDrafts(body);
    },
  };
}

/**
 * Default deps used by the wrapped task in production.
 *
 * The port is built on first use, not at import, so TYPEFULLY_API_KEY and
 * TYPEFULLY_BASE_URL are read from the environment the run actually has.
 */
let port: TypefullyPort | undefined;
export const defaultDeps: TypefullyDeps = {
  get typefully(): TypefullyPort {
    return (port ??= typefullyPort());
  },
};
