import { vi } from "vitest";

/**
 * A fetch answering one Web API body, recording the request it got.
 *
 * `callSlack` reads `ok` and `status` to decide whether the call failed in
 * transport, and `text` only for the error message on a non-2xx.
 */
export function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
}

/** Replace global fetch for one call, because callSlack defaults to it. */
export async function withFetch<T>(impl: unknown, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}
