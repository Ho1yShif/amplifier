import type { TaskHandlers } from "./taskCtx.js";

/**
 * A Map-backed fake Key Value with a virtual clock, so TTLs expire the way a
 * real instance's do. Share one across runs to represent the state an earlier
 * run left behind.
 *
 * `at` moves the clock, which is how a test ages a marker or an in-flight lock
 * without waiting. `keys` reports the keys that are still live.
 */
export function kvStore(startIso: string) {
  const store = new Map<string, { value: string; expiresAtMs: number }>();
  let nowMs = Date.parse(startIso);

  function live(key: string) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  const handlers: TaskHandlers = {
    "kv.lock": ({ key, token, ttlSeconds }) => {
      if (live(key)) return { acquired: false };
      store.set(key, { value: token, expiresAtMs: nowMs + ttlSeconds * 1000 });
      return { acquired: true };
    },
    "kv.unlock": ({ key, token }) => {
      const entry = live(key);
      if (!entry || entry.value !== token) return { released: false };
      store.delete(key);
      return { released: true };
    },
    "kv.get": ({ key }) => ({ value: live(key)?.value ?? null }),
    "kv.set": ({ key, value, ttlSeconds }) => {
      const expiresAtMs = ttlSeconds ? nowMs + ttlSeconds * 1000 : Number.POSITIVE_INFINITY;
      store.set(key, { value, expiresAtMs });
      return { ok: true };
    },
  };

  return {
    handlers,
    at(iso: string) {
      nowMs = Date.parse(iso);
    },
    keys() {
      return [...store.keys()].sort();
    },
  };
}

export type KvStore = ReturnType<typeof kvStore>;
