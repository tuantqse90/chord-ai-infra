// Stale-while-revalidate for the slow reads behind the Agents page (smart money now, the smart-LP board, the LP scan): a
// request is answered at once from the last good value and, when that value is older than its TTL, one refresh runs in the
// background. Only the very first ask of a key waits. Measured 07/10 on the throttled box: smart-now 13 s, LP scan 58 s,
// smart LPs > 90 s when computed on the request path. A failed refresh keeps the last good value (and its age).
type Entry<T> = { at: number; v: T } ;
const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_KEYS = 200;

function refresh<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = run().then((v) => {
    if (cache.size >= MAX_KEYS && !cache.has(key)) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), v });
    return v;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The value of `key`: the cached one at once (refreshed in the background when older than `ttlMs`), else the first run. */
export function swr<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (!hit) return refresh(key, run);
  if (Date.now() - hit.at >= ttlMs) refresh(key, run).catch(() => { /* the last good value stays */ });
  return Promise.resolve(hit.v);
}

/** Refresh `key` every `everyMs` in the background (first run right away), so even its first visitor does not wait. */
export function keepFresh<T>(key: string, everyMs: number, run: () => Promise<T>): () => void {
  if (process.env.NODE_ENV === "test") return () => {};
  const go = () => { refresh(key, run).catch(() => { /* next tick tries again */ }); };
  go();
  const h = setInterval(go, everyMs);
  (h as any).unref?.();
  return () => clearInterval(h);
}

export function _resetSwr(): void { cache.clear(); inflight.clear(); }
