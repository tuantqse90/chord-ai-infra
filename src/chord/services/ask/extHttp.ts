// One cached, rate-budgeted GET / POST for the third-party data sources behind the Ask tools added 2026-10-03 (owner: "check
// ProjectVex 200 tools, làm nếu thiếu" — docs/prompts/ask-tool-parity-2026-10.md): GeckoTerminal, DexScreener, GoPlus,
// Lighter, Pendle, Morpho, Jupiter, Virtuals, Bankr (pools.fun), Polymarket, Elfa, Nasdaq, mempool.space. Same shape as services/coingecko `cg()`:
//   · every answer is cached in Redis (`ext:v1:{source}:{sha1(request)}`), fresh within `ttlS`, kept `staleS` for fallback;
//   · each source has a per-minute budget shared by the box (`ext:rl:{source}:{minute}`) — over budget, or a 429 (which
//     also sets `ext:backoff:{source}` for 60 s), serves the stale copy, and with none throws "{source} is rate-limited";
//   · a 404 throws `notFound` (never served stale: the thing does not exist);
//   · concurrent identical requests share one fetch (in-process).
// None of these sources needs a key. Their text (names, descriptions, socials) is chosen by whoever launched the token or
// wrote the market — the tools mark it untrusted in services/ask/registry.ts.
import { createHash } from "node:crypto";
import { getRedis } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { coalescer } from "../../utils/boundedCache";
import type { AssetChip, Citation, Viz } from "../askAgent";

/** What every tool module of this batch returns to askAgent.runTool (the same fields as services/ask/chainTools). */
export interface ExtToolResult { data: unknown; addresses: string[]; citations: Citation[]; viz?: Viz[]; assets?: AssetChip[]; /** rows that become asset chips only when the answer names them */ chipCandidates?: AssetChip[] }

export type ExtSource = "geckoterminal" | "dexscreener" | "goplus" | "lighter" | "pendle" | "morpho" | "jupiter" | "virtuals" | "bankr" | "polymarket" | "elfa" | "nasdaq" | "mempool";

/** Calls per minute for the whole box. Free tiers measured / documented 2026-10-03: GeckoTerminal ~10/min, DexScreener 60–300,
 *  GoPlus ~30, Morpho (keyless GraphQL, bans abusers for days) kept low on purpose. */
const RPM: Record<ExtSource, number> = {
  geckoterminal: 8 /* docs ~10/min; 429s seen at 8.5/min, and a 429 pauses the box 60 s */, dexscreener: 120, goplus: 25, lighter: 100 /* 60 per venue, two venues */, pendle: 60, morpho: 15, jupiter: 22 /* keyless: 5 per 10 s per IP; the odds-alert worker takes ≤ 6/min of it */, virtuals: 20, bankr: 30, polymarket: 60,
  // Elfa bills every call ($0.0145–0.0725, docs/prompts/ask-elfa-skills-2026-10.md): the budget here is a burst guard, the
  // daily spend cap lives in services/ask/elfaTools.ts. Nasdaq + mempool.space are free public APIs.
  elfa: 30, nasdaq: 30, mempool: 60,
};
const DEFAULT_STALE_S = 6 * 3600;
const UA = "Mozilla/5.0 (compatible; ChordAsk/1.0; +https://getchord.xyz)";

export class ExtError extends Error {
  constructor(message: string, readonly notFound = false, readonly status = 0) { super(message); }
}

async function budgetOk(source: ExtSource): Promise<boolean> {
  try {
    const r = getRedis();
    if (await r.get(`ext:backoff:${source}`)) return false;
    const k = `ext:rl:${source}:${Math.floor(Date.now() / 60_000)}`;
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, 90);
    return n <= RPM[source];
  } catch { return true; } // Redis down: let the call through rather than answer nothing
}

export interface ExtOpts {
  /** Fresh for this many seconds. */
  ttlS: number;
  /** Keep (and serve when the source fails) for this many seconds. Default 6 h. */
  staleS?: number;
  method?: "GET" | "POST";
  /** JSON body for POST (GraphQL). Part of the cache key. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const inflight = coalescer<{ data: unknown; ageS: number }>();

/** Fetch JSON from a third-party source through the shared cache + budget. `ageS` > 0 = served from cache. */
export async function extJson<T = any>(source: ExtSource, url: string, opts: ExtOpts): Promise<{ data: T; ageS: number }> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const bodyText = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const key = `ext:v1:${source}:${createHash("sha1").update(`${method} ${url} ${bodyText}`).digest("hex")}`;
  return inflight(key, async () => {
    const now = Math.floor(Date.now() / 1000);
    let cached: { t: number; d: unknown } | null = null;
    try { const raw = await getRedis().get(key); if (raw) cached = JSON.parse(raw); } catch { /* fetch */ }
    if (cached && now - cached.t < opts.ttlS) return { data: cached.d, ageS: now - cached.t };
    if (!(await budgetOk(source))) {
      if (cached) return { data: cached.d, ageS: now - cached.t };
      throw new ExtError(`${source} is rate-limited right now`);
    }
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: "application/json", "User-Agent": UA, ...(bodyText ? { "Content-Type": "application/json" } : {}), ...opts.headers },
        body: bodyText || undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (res.status === 429) { await getRedis().set(`ext:backoff:${source}`, "1", "EX", 60).catch(() => {}); throw new ExtError(`${source} 429`, false, 429); }
      if (res.status === 404) throw new ExtError("not found", true, 404);
      if (!res.ok) throw new ExtError(`${source} ${res.status}`, false, res.status);
      const d = await res.json();
      await getRedis().set(key, JSON.stringify({ t: now, d }), "EX", opts.staleS ?? DEFAULT_STALE_S).catch(() => {});
      return { data: d, ageS: 0 };
    } catch (e) {
      if (e instanceof ExtError && e.notFound) throw e;
      logger.debug({ err: String(e), source, url: url.slice(0, 160) }, "ask ext: call failed");
      if (cached) return { data: cached.d, ageS: now - cached.t };
      throw e instanceof ExtError ? e : new ExtError(`${source} unavailable`);
    }
  }) as Promise<{ data: T; ageS: number }>;
}

/** Query string from a params object: undefined / "" dropped, keys kept in the given order. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Number from a third-party field that may be a string, null or garbage. */
export const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Short "$1.23M" style for model-facing text. */
export const usdShort = (n: number | null | undefined): string | null => {
  if (n == null || !Number.isFinite(n)) return null;
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(1)}k` : `${s}$${a.toFixed(a >= 1 ? 2 : 6)}`;
};

/** A source failure as the tool's answer: the model says the source is unavailable instead of guessing. */
export function extFailure(source: string, e: unknown): { error: string; note: string } {
  const msg = e instanceof ExtError ? e.message : String(e).slice(0, 120);
  return { error: `${source}: ${msg}`, note: `${source} did not answer just now. Say the data is unavailable right now; do not guess numbers.` };
}
