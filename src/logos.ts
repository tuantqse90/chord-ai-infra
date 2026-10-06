// GET /v1/logo/solana/:mint — a token's real picture for the Agents page. Chord's logo route answers a generic SVG for most
// memes, Jupiter's token list has their icon: ask Jupiter first (mints requested within 60 ms share one search call, up to 100),
// redirect to the icon, else to Chord's picture. Hits are cached 24 h, misses 1 h. Only https icons are ever redirected to.
import { Hono } from "hono";
import { http } from "./bots/market";
import { isPubkey } from "./solana/tokens";

const JUP = () => ((process.env.JUPITER_API_URL ?? "").trim().replace(/\/$/, "") || "https://lite-api.jup.ag/swap/v1").replace(/\/swap\/v1$/, "/tokens/v2");
const chordLogo = (mint: string) => `https://api.getchord.xyz/v1/logo/solana/${encodeURIComponent(mint)}`;
const HIT_MS = 24 * 3600_000, MISS_MS = 3600_000, BATCH_WAIT_MS = 60, BATCH_MAX = 100, CACHE_MAX = 20_000;

const cache = new Map<string, { url: string | null; at: number }>();
let queue = new Map<string, ((u: string | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  timer = null;
  const batch = queue;
  queue = new Map();
  const mints = [...batch.keys()];
  for (let i = 0; i < mints.length; i += BATCH_MAX) {
    const part = mints.slice(i, i + BATCH_MAX);
    const found = new Map<string, string>();
    try {
      const r = await http(`${JUP()}/search?query=${part.join(",")}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
      if (r.ok) for (const t of (await r.json()) as any[]) if (t && typeof t.id === "string" && typeof t.icon === "string" && /^https:\/\//.test(t.icon)) found.set(t.id, t.icon);
    } catch { /* every mint of the batch falls back to Chord's picture this time */ }
    const now = Date.now();
    for (const m of part) {
      const url = found.get(m) ?? null;
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(m, { url, at: now });
      for (const done of batch.get(m) ?? []) done(url);
    }
  }
}

/** The token's icon URL from Jupiter, or null (cached). */
export function iconOf(mint: string): Promise<string | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < (hit.url ? HIT_MS : MISS_MS)) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    const waiting = queue.get(mint);
    if (waiting) waiting.push(resolve); else queue.set(mint, [resolve]);
    if (!timer) timer = setTimeout(() => void flush(), BATCH_WAIT_MS);
  });
}

export const logos = new Hono();
logos.get("/solana/:mint", async (c) => {
  const mint = c.req.param("mint");
  if (!isPubkey(mint)) return c.json({ error: "bad_mint" }, 400);
  const url = (await iconOf(mint)) ?? chordLogo(mint);
  c.header("Cache-Control", "public, max-age=3600");
  return c.redirect(url, 302);
});
export function _resetLogos(): void { cache.clear(); queue = new Map(); if (timer) clearTimeout(timer); timer = null; }
