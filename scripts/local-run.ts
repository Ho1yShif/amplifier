/**
 * Run amplifier.checkPosts locally against the stub and a local Key Value.
 *
 *   redis-server &
 *   pnpm stub &
 *   pnpm local:run 2
 *
 * The argument is how many runs to do in a row. Two is the interesting number:
 * the first reports notified 2, the second reports notified 0 and skipped 2,
 * which proves the announce-once guarantee holds across runs, without
 * deploying and without a Typefully key.
 *
 * localCtx executes each chained task in this process with no retries and no
 * timeouts, so this checks the wiring and the Key Value state, not durability.
 */
import { localCtx } from "@render-lab/test-utils";
import { checkPostsImpl } from "../src/amplifier/checkPosts.js";
import { TYPEFULLY_BASE_URL } from "../src/typefully/client.js";

const STUB = "http://localhost:8787";
const PLACEHOLDER_KEY = "stub-key";

const env: NodeJS.ProcessEnv = {
  ...process.env,
  TYPEFULLY_API_KEY: process.env.TYPEFULLY_API_KEY ?? PLACEHOLDER_KEY,
  TYPEFULLY_SOCIAL_SET_ID: process.env.TYPEFULLY_SOCIAL_SET_ID ?? "set_local",
  TYPEFULLY_BASE_URL: process.env.TYPEFULLY_BASE_URL ?? STUB,
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL ?? `${STUB}/slack`,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  DRY_RUN: process.env.DRY_RUN ?? "false",
};

if (env.TYPEFULLY_API_KEY === PLACEHOLDER_KEY && env.TYPEFULLY_BASE_URL === TYPEFULLY_BASE_URL) {
  throw new Error(
    `TYPEFULLY_BASE_URL is ${TYPEFULLY_BASE_URL} and no real TYPEFULLY_API_KEY is set, so ` +
      `every request would be a 401 from the real API. Start the stub with \`pnpm stub\`.`,
  );
}

const runs = Number(process.argv[2] ?? 1);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`Pass a whole number of runs; got ${process.argv[2]}.`);
}

// The tasks read their environment on first use, not at import, so assigning
// here is enough. checkPostsImpl also takes env directly.
Object.assign(process.env, env);

const ctx = localCtx();
for (let n = 1; n <= runs; n++) {
  const result = await checkPostsImpl(ctx, {}, env);
  console.log(`\n--- run ${n} ---\n${JSON.stringify(result, null, 2)}`);
}

// ioredis keeps its socket open and the KV tasks expose no way to close it.
process.exit(0);
