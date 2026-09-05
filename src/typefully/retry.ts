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
