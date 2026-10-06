// In-process stand-in for the Redis client the Chord modules expect (ask2049 runs one process and has no Redis). Covers
// the subset they call: get / set (EX, NX) / del / incr / incrby / incrbyfloat / expire / ttl / keys. Values live in a Map
// with an optional expiry; a sweep every minute drops expired keys and caps the store so a key spray cannot grow it forever.
const MAX_KEYS = 50_000;
type Entry = { v: string; exp: number | null };
const store = new Map<string, Entry>();
const now = () => Date.now();
const live = (k: string): Entry | null => {
  const e = store.get(k);
  if (!e) return null;
  if (e.exp !== null && e.exp <= now()) { store.delete(k); return null; }
  return e;
};
setInterval(() => {
  const t = now();
  for (const [k, e] of store) if (e.exp !== null && e.exp <= t) store.delete(k);
  while (store.size > MAX_KEYS) { const k = store.keys().next().value; if (k === undefined) break; store.delete(k); }
}, 60_000).unref?.();

const toRe = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export const memRedis = {
  async get(k: string): Promise<string | null> { return live(k)?.v ?? null; },
  /** set(k, v) · set(k, v, "EX", s) · set(k, v, "EX", s, "NX") · set(k, v, "NX", "EX", s) */
  async set(k: string, v: string | number, ...opts: (string | number)[]): Promise<"OK" | null> {
    let exp: number | null = null, nx = false, keepTtl = false;
    for (let i = 0; i < opts.length; i++) {
      const o = String(opts[i]).toUpperCase();
      if (o === "EX") exp = now() + Number(opts[++i]) * 1000;
      else if (o === "PX") exp = now() + Number(opts[++i]);
      else if (o === "NX") nx = true;
      else if (o === "KEEPTTL") keepTtl = true;
    }
    const cur = live(k);
    if (nx && cur) return null;
    store.set(k, { v: String(v), exp: keepTtl && cur ? cur.exp : exp });
    return "OK";
  },
  async del(...ks: string[]): Promise<number> { let n = 0; for (const k of ks.flat()) if (store.delete(k)) n++; return n; },
  async incrby(k: string, by: number): Promise<number> {
    const cur = live(k);
    const n = (cur ? Number(cur.v) || 0 : 0) + Number(by);
    store.set(k, { v: String(n), exp: cur?.exp ?? null });
    return n;
  },
  async incr(k: string): Promise<number> { return memRedis.incrby(k, 1); },
  async incrbyfloat(k: string, by: number | string): Promise<string> {
    const cur = live(k);
    const n = (cur ? Number(cur.v) || 0 : 0) + Number(by);
    store.set(k, { v: String(n), exp: cur?.exp ?? null });
    return String(n);
  },
  async expire(k: string, s: number): Promise<number> { const e = live(k); if (!e) return 0; e.exp = now() + s * 1000; return 1; },
  async ttl(k: string): Promise<number> { const e = live(k); if (!e) return -2; return e.exp === null ? -1 : Math.ceil((e.exp - now()) / 1000); },
  async keys(pattern: string): Promise<string[]> { const re = toRe(pattern); return [...store.keys()].filter((k) => re.test(k) && live(k)); },
};
export type MemRedis = typeof memRedis;
export const getRedis = () => memRedis;
/** Tests: start from an empty store. */
export const _resetRedis = () => store.clear();
