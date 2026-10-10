// Trigger sources the agents engine does not have (src/bots/triggers.ts already delivers followed wallets' trades), on Monad:
//  · confluence  — a sliding window over wallet trades: one hit per token per window once ≥ minWallets distinct wallets did the side;
//  · price       — one batched price call per tick for every price trigger (Chord's Monad price map, the runner makes it), a small
//                  in-memory history per token for change_pct over windowMin (seeded from Chord's Monad candles), edge-triggered;
//  · schedule    — a timer: due when the interval has passed since the last run (the first run right away).
// The new-token and LP-event sources below read Solana feeds; the schema refuses those triggers on Monad, so they never run here.
import { QUOTE_MINTS } from "../bots/market";
import { smartTraders } from "../bots/tape";
import type { SourceTrade } from "../bots/types";
import { extJson } from "../chord/services/ask/extHttp";
import { AMM_DEXES, board, candles as chordCandles, LAUNCHPAD_DEXES, lpEvents, lpPool, tokenView, type Fetch, type TokenView } from "./chord";
import { EVERY_MS, type TriggerOf, type Wallets } from "./schema";

const MIN = 60_000;

// ── wallets ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The addresses a Wallets block means right now: the list as given, or the smart-traders board (Chord, cached 60 s). */
export async function resolveWallets(w: Wallets, board_ = smartTraders): Promise<string[]> {
  if ("list" in w) return [...w.list];
  const rows = await board_(w.smartTraders.days, w.smartTraders.top);
  return rows.map((r) => r.wallet).slice(0, w.smartTraders.top);
}

// ── confluence ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ConfluenceHit { mint: string; symbol: string | null; side: "buy" | "sell"; wallets: string[]; firstTs: number; ts: number; usd: number | null; trade: SourceTrade }

/** Distinct wallets doing `side` on one token inside a sliding window. push() answers a hit at most once per token per window
 *  (the window restarts at the hit), when the trade that arrives makes the count reach minWallets. */
export class ConfluenceWindow {
  private byMint = new Map<string, { at: Map<string, { ts: number; usd: number | null }>; lastHit: number | null; newest: number }>();
  private pushes = 0;
  readonly windowMs: number;
  constructor(readonly opts: { minWallets: number; windowMin: number; side: "buy" | "sell" }) {
    this.windowMs = opts.windowMin * MIN;
  }

  push(t: SourceTrade): ConfluenceHit | null {
    if (t.side !== this.opts.side) return null;
    if (++this.pushes % 500 === 0) this.sweep(t.ts);
    let m = this.byMint.get(t.mint);
    if (!m) this.byMint.set(t.mint, (m = { at: new Map(), lastHit: null, newest: t.ts }));
    m.newest = Math.max(m.newest, t.ts);
    const cut = m.newest - this.windowMs;
    if (t.ts < cut) return null; // too old for the window (a late tape row)
    const prev = m.at.get(t.wallet);
    m.at.set(t.wallet, { ts: Math.max(prev?.ts ?? 0, t.ts), usd: t.usd == null ? prev?.usd ?? null : (prev?.usd ?? 0) + t.usd });
    for (const [w, x] of m.at) if (x.ts < cut) m.at.delete(w);
    if (m.at.size < this.opts.minWallets) return null;
    if (m.lastHit != null && t.ts - m.lastHit < this.windowMs) return null;
    m.lastHit = t.ts;
    const entries = [...m.at.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const usd = entries.reduce((a, [, x]) => a + (x.usd ?? 0), 0);
    return { mint: t.mint, symbol: t.symbol, side: t.side, wallets: entries.map(([w]) => w), firstTs: entries[0][1].ts, ts: t.ts, usd: usd || null, trade: t };
  }

  /** Mints with nothing inside the window are forgotten. */
  sweep(now: number): void {
    for (const [mint, m] of this.byMint) {
      for (const [w, x] of m.at) if (x.ts < now - this.windowMs) m.at.delete(w);
      if (!m.at.size && (m.lastHit == null || now - m.lastHit >= this.windowMs)) this.byMint.delete(mint);
    }
  }
  size(): number { return this.byMint.size; }
}

// ── price ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SAMPLE_GAP_MS = 20_000;
const MAX_SAMPLES = 3_000;

/** A few hours of prices per mint (one sample every ≥ 20 s), enough for change_pct over the longest window asked for. */
export class PriceHistory {
  private s = new Map<string, { ts: number; p: number }[]>();
  constructor(private keepMs = 1445 * MIN) {}
  setKeep(ms: number): void { this.keepMs = Math.max(this.keepMs, ms + 5 * MIN); }

  record(mint: string, price: number, ts: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    let xs = this.s.get(mint);
    if (!xs) this.s.set(mint, (xs = []));
    const last = xs[xs.length - 1];
    if (last && ts < last.ts) return;
    // samples stay ≥ 20 s apart: inside the gap after the one before it, the newest sample is replaced, not added
    if (xs.length >= 2 && ts - xs[xs.length - 2].ts < SAMPLE_GAP_MS) { last.p = price; last.ts = ts; }
    else xs.push({ ts, p: price });
    const cut = ts - this.keepMs;
    let drop = 0;
    while (drop < xs.length - 1 && xs[drop + 1].ts <= cut) drop++;
    if (drop) xs.splice(0, drop);
    if (xs.length > MAX_SAMPLES) xs.splice(0, xs.length - MAX_SAMPLES);
  }
  /** Older points (candles), merged in before what is already there. */
  seed(mint: string, points: { ts: number; p: number }[]): void {
    const xs = this.s.get(mint) ?? [];
    const first = xs[0]?.ts ?? Infinity;
    const older = points.filter((x) => x.ts < first && x.p > 0).sort((a, b) => a.ts - b.ts);
    this.s.set(mint, [...older, ...xs]);
  }
  /** The newest sample at or before `ts`. */
  at(mint: string, ts: number): number | null {
    const xs = this.s.get(mint);
    if (!xs?.length) return null;
    let lo = 0, hi = xs.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (xs[mid].ts <= ts) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 ? xs[found].p : null;
  }
  oldest(mint: string): number | null { return this.s.get(mint)?.[0]?.ts ?? null; }
  latest(mint: string): { ts: number; p: number } | null { const xs = this.s.get(mint); return xs?.length ? xs[xs.length - 1] : null; }
  has(mint: string): boolean { return !!this.s.get(mint)?.length; }
  forget(keep: Set<string>): void { for (const m of this.s.keys()) if (!keep.has(m)) this.s.delete(m); }
}

export interface PriceCheck { met: boolean; price: number; changePct: number | null; detail: string; warming?: boolean }
/** Does a price trigger hold for one mint now. change_pct compares with the price windowMin ago (null until the history covers
 *  the window: warming up). */
export function checkPrice(t: TriggerOf<"price">, mint: string, price: number, now: number, h: PriceHistory): PriceCheck {
  if (t.op === "above") return { met: price > t.value, price, changePct: null, detail: `price $${fmt(price)} ${price > t.value ? "above" : "not above"} $${fmt(t.value)}` };
  if (t.op === "below") return { met: price < t.value, price, changePct: null, detail: `price $${fmt(price)} ${price < t.value ? "below" : "not below"} $${fmt(t.value)}` };
  const win = (t.windowMin ?? 60) * MIN;
  const oldest = h.oldest(mint);
  const then = oldest != null && oldest <= now - win + 60_000 ? h.at(mint, now - win) ?? h.at(mint, oldest) : null;
  if (then == null || !(then > 0)) return { met: false, price, changePct: null, detail: `warming up: needs ${t.windowMin ?? 60} min of prices`, warming: true };
  const pct = (price / then - 1) * 100;
  const met = t.value > 0 ? pct >= t.value - 1e-9 : pct <= t.value + 1e-9; // 1e-9: 1.15 / 1.00 is 14.999… in floating point
  return { met, price, changePct: pct, detail: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)} % in ${t.windowMin ?? 60} min ($${fmt(then)} → $${fmt(price)})` };
}
const fmt = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4));

/** Fires on the way in: true the first time a condition holds, then not again until it has stopped holding. */
export class EdgeTrigger {
  private on = new Map<string, boolean>();
  update(key: string, met: boolean): boolean {
    const was = this.on.get(key) ?? false;
    this.on.set(key, met);
    return met && !was;
  }
  forget(prefix: string): void { for (const k of this.on.keys()) if (k.startsWith(prefix)) this.on.delete(k); }
}

/** Older prices from Chord's candles (1-minute closes up to 1,000, 5-minute beyond), so change_pct does not wait a whole window. */
export async function seedFromCandles(mint: string, windowMin: number, f?: Fetch): Promise<{ ts: number; p: number }[]> {
  const tf = windowMin + 2 <= 1000 ? "1m" : "5m";
  const limit = tf === "1m" ? windowMin + 2 : Math.ceil(windowMin / 5) + 2;
  const cs = await chordCandles(mint, tf, limit, f);
  return cs.map((c) => ({ ts: c.t + (tf === "1m" ? 60_000 : 300_000), p: c.c }));
}

/** Chord's most traded Monad tokens: the 24 h volume board without the quote tokens (USDC, AUSD, USDT0, WMON, MON). */
export const TRENDING_SIZE = 20;
export async function trendingMints(limit = TRENDING_SIZE, f?: Fetch): Promise<string[]> {
  const rows = await board("volume", 60, f);
  return rows.filter((r) => !QUOTE_MINTS.has(r.mint) && !(r.symbol && QUOTE_MINTS.has(r.symbol))).slice(0, limit).map((r) => r.mint);
}

// ── schedule ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Is a schedule due: never run, or the interval has passed since the last run. */
export function scheduleDue(every: keyof typeof EVERY_MS, lastRunMs: number | null, now: number): boolean {
  return lastRunMs == null || now - lastRunMs >= EVERY_MS[every];
}

// ── new tokens / graduations ─────────────────────────────────────────────────────────────────────────────────────────
export interface NewTokenEvent {
  mint: string; symbol: string | null; source: "launch" | "graduation";
  /** unix ms of the launch (first trade) or the graduation (the curve's last trade, or when the move was seen) */
  ts: number; firstSeen: number | null; dex: string | null; pool: string | null;
  liquidityUsd: number | null; marketCapUsd: number | null; priceUsd: number | null; via: "chord" | "geckoterminal";
}
export interface NewTokenDeps {
  fetch?: Fetch;
  now: () => number;
  /** GeckoTerminal's new Solana pools (JSON:API), the fallback when Chord cannot be read. */
  geckoNewPools: () => Promise<any>;
}
/** A launch or graduation older than this when first seen is history, not a signal. */
export const FRESH_MS = 30 * MIN;
const LOOKUPS_PER_POLL = 12;
const GT = "https://api.geckoterminal.com/api/v2";

export const defaultGeckoNewPools = async () => (await extJson<any>("geckoterminal", `${GT}/networks/solana/new_pools?page=1&include=base_token,dex`, { ttlS: 60, staleS: 600, headers: { Accept: "application/json;version=20230203" }, timeoutMs: 8_000 })).data;

/** Polls the new-token board. The first answer is the baseline (nothing fires for tokens that were already there). */
export class NewTokenSource {
  private d: NewTokenDeps;
  private seen = new Map<string, { dex: string | null; firstSeen: number | null; at: number }>();
  private pending = new Set<string>();
  private baseline = false;
  private gtBaseline = false;
  private gtSeen = new Map<string, number>();
  lastError: string | null = null;
  lastVia: "chord" | "geckoterminal" | null = null;

  constructor(deps: Partial<NewTokenDeps> = {}) {
    this.d = { now: () => Date.now(), geckoNewPools: defaultGeckoNewPools, ...deps };
  }

  async poll(): Promise<NewTokenEvent[]> {
    try {
      const out = await this.pollChord();
      this.lastVia = "chord";
      return out;
    } catch (e) {
      this.lastError = `Chord new-token board: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
      try {
        const out = await this.pollGecko();
        this.lastVia = "geckoterminal";
        return out;
      } catch (e2) {
        this.lastError += `; GeckoTerminal: ${String((e2 as Error)?.message ?? e2).slice(0, 120)}`;
        return [];
      }
    }
  }

  private async pollChord(): Promise<NewTokenEvent[]> {
    const now = this.d.now();
    const rows = await board("new", 200, this.d.fetch);
    const out: NewTokenEvent[] = [];
    const lookups: typeof rows = [];
    for (const r of rows) {
      if (QUOTE_MINTS.has(r.mint)) continue;
      const prev = this.seen.get(r.mint);
      this.seen.set(r.mint, { dex: r.dex, firstSeen: r.firstSeen, at: now });
      if (!this.baseline) continue;
      const base = { mint: r.mint, symbol: r.symbol, firstSeen: r.firstSeen != null ? r.firstSeen * 1000 : null, dex: r.dex, pool: r.pool, liquidityUsd: r.liquidityUsd, marketCapUsd: r.marketCapUsd, priceUsd: r.priceUsd, via: "chord" as const };
      if (!prev || this.pending.has(r.mint)) {
        const fresh = r.firstSeen != null && now - r.firstSeen * 1000 <= FRESH_MS;
        if (r.dex && LAUNCHPAD_DEXES.has(r.dex)) { this.pending.delete(r.mint); if (fresh) out.push({ ...base, source: "launch", ts: r.firstSeen! * 1000 }); }
        else if (r.dex && AMM_DEXES.has(r.dex)) lookups.push(r); // a curve behind it = graduation, none = a launch straight on an AMM
        else this.pending.delete(r.mint);
      } else if (prev.dex && LAUNCHPAD_DEXES.has(prev.dex) && r.dex && AMM_DEXES.has(r.dex)) {
        out.push({ ...base, source: "graduation", ts: now });
      }
    }
    // tokens first met on an AMM: one token view each (a few a poll; the rest wait for the next poll)
    for (const r of lookups.slice(LOOKUPS_PER_POLL)) this.pending.add(r.mint);
    for (const r of lookups.slice(0, LOOKUPS_PER_POLL)) {
      this.pending.delete(r.mint);
      let v: TokenView | null = null;
      try { v = await tokenView(r.mint, 1, this.d.fetch); } catch { this.pending.add(r.mint); continue; }
      const base = { mint: r.mint, symbol: r.symbol, firstSeen: r.firstSeen != null ? r.firstSeen * 1000 : null, dex: r.dex, pool: r.pool, liquidityUsd: r.liquidityUsd, marketCapUsd: r.marketCapUsd, priceUsd: r.priceUsd, via: "chord" as const };
      const g = v ? graduationOf(v) : null;
      if (g != null) { if (now - g <= FRESH_MS) out.push({ ...base, source: "graduation", ts: g }); }
      else if (r.firstSeen != null && now - r.firstSeen * 1000 <= FRESH_MS) out.push({ ...base, source: "launch", ts: r.firstSeen * 1000 });
    }
    for (const [m, x] of this.seen) if (now - x.at > 48 * 3600_000) this.seen.delete(m);
    this.baseline = true;
    return out;
  }

  private async pollGecko(): Promise<NewTokenEvent[]> {
    const now = this.d.now();
    const j = await this.d.geckoNewPools();
    const rows = Array.isArray(j?.data) ? j.data : [];
    const out: NewTokenEvent[] = [];
    for (const p of rows) {
      const a = p?.attributes ?? {}, rel = p?.relationships ?? {};
      const baseId = String(rel.base_token?.data?.id ?? "");
      const mint = baseId.startsWith("solana_") ? baseId.slice(7) : "";
      const created = Date.parse(String(a.pool_created_at ?? ""));
      if (!mint || QUOTE_MINTS.has(mint) || !Number.isFinite(created)) continue;
      const key = `${mint}|${p?.id ?? ""}`;
      if (this.gtSeen.has(key)) continue;
      this.gtSeen.set(key, now);
      if (!this.gtBaseline || now - created > FRESH_MS) continue;
      const dex = String(rel.dex?.data?.id ?? "");
      // pump.fun's own curve (and the other launchpads) = a launch; a pump.fun mint's first AMM pool = its graduation
      const launchpad = /pump-fun|pumpfun|launchlab|dbc|bonk|moonshot/i.test(dex) && !/pumpswap/i.test(dex);
      const source = launchpad ? "launch" : /pump$/.test(mint) && /pumpswap|meteora|raydium/i.test(dex) ? "graduation" : "launch";
      const name = typeof a.name === "string" ? a.name.split("/")[0].trim() : null;
      out.push({
        mint, symbol: name || null, source, ts: created, firstSeen: created, dex: dex || null, pool: typeof a.address === "string" ? a.address : null,
        liquidityUsd: num(a.reserve_in_usd), marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd), priceUsd: num(a.base_token_price_usd), via: "geckoterminal",
      });
    }
    for (const [k, at] of this.gtSeen) if (now - at > 6 * 3600_000) this.gtSeen.delete(k);
    this.gtBaseline = true;
    return out;
  }
}
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** When a token graduated, from its pools: a bonding-curve pool that stopped trading while an AMM pool now holds the main
 *  liquidity. The curve's last trade is the graduation time (unix ms); null = not graduated (or launched straight on an AMM). */
export function graduationOf(v: TokenView): number | null {
  const curve = v.pools.filter((p) => LAUNCHPAD_DEXES.has(p.dex)).sort((a, b) => (b.lastTrade ?? 0) - (a.lastTrade ?? 0))[0];
  if (!curve || curve.lastTrade == null) return null;
  const amm = v.pools.filter((p) => AMM_DEXES.has(p.dex)).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
  if (!amm || (amm.liquidityUsd ?? 0) <= (curve.liquidityUsd ?? 0)) return null;
  if (amm.lastTrade != null && amm.lastTrade <= curve.lastTrade) return null; // the AMM has not traded since the curve
  return curve.lastTrade * 1000;
}

// ── LP events ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface LpSignal {
  pool: string; token: string | null; symbol: string | null; kind: "exodus" | "large_remove" | "large_add";
  /** exodus: the hour's withdrawals; large_*: the event's USD */
  usd: number; ts: number; hour?: number; depositsUsd?: number; withdrawalsUsd?: number; signature?: string | null;
}
export interface LpDeps { fetch?: Fetch; now: () => number }
const POOLS_PER_MINT = 3;
const POOL_TTL = 10 * MIN;
const MISSING_TTL = 10 * MIN;

/** Polls the LP tape of the pools the running lp_event bots watch. */
export class LpEventSource {
  private d: LpDeps;
  private poolsCache = new Map<string, { at: number; pools: string[] }>();
  private missing = new Map<string, number>();
  private cursor = new Map<string, number>();
  lastError: string | null = null;
  constructor(deps: Partial<LpDeps> = {}) { this.d = { now: () => Date.now(), ...deps }; }

  /** The token's busiest pools on venues whose liquidity the tape decodes (cached 10 min). */
  async poolsOf(mint: string): Promise<string[]> {
    const now = this.d.now();
    const hit = this.poolsCache.get(mint);
    if (hit && now - hit.at < POOL_TTL) return hit.pools;
    const v = await tokenView(mint, 1, this.d.fetch);
    const pools = (v?.pools ?? []).filter((p) => !LAUNCHPAD_DEXES.has(p.dex) && (p.liquidityUsd ?? 0) > 0)
      .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, POOLS_PER_MINT).map((p) => p.pool);
    this.poolsCache.set(mint, { at: now, pools });
    return pools;
  }

  /** Exodus state of the last two hours for every pool, plus add / remove events newer than the last poll for `withEvents`
   *  (the first poll of a pool is its baseline). */
  async poll(pools: string[], withEvents: Set<string>): Promise<LpSignal[]> {
    const now = this.d.now();
    const out: LpSignal[] = [];
    const jobs = [...new Set(pools)].filter((p) => { const m = this.missing.get(p); return m == null || now - m > MISSING_TTL; });
    let i = 0;
    const run = async () => {
      for (let pool = jobs[i++]; pool; pool = jobs[i++]) {
        try {
          const v = await lpPool(pool, 2, this.d.fetch);
          if (!v) { this.missing.set(pool, now); continue; }
          for (const h of v.hourly) {
            if (h.withdrawalsUsd > 2 * h.depositsUsd && h.withdrawalsUsd > 0) {
              out.push({ pool, token: v.token, symbol: v.symbol, kind: "exodus", usd: h.withdrawalsUsd, ts: Math.min(now, (h.hour + 3600) * 1000), hour: h.hour, depositsUsd: h.depositsUsd, withdrawalsUsd: h.withdrawalsUsd });
            }
          }
          if (!withEvents.has(pool)) continue;
          const evs = await lpEvents(pool, 50, null, this.d.fetch);
          const from = this.cursor.get(pool);
          const newest = evs.reduce((a, e) => Math.max(a, e.ts), from ?? 0);
          if (from !== undefined) {
            for (const e of evs) {
              if (e.ts <= from || (e.kind !== "add" && e.kind !== "remove") || e.usd == null) continue;
              out.push({ pool, token: v.token, symbol: v.symbol, kind: e.kind === "add" ? "large_add" : "large_remove", usd: e.usd, ts: e.ts * 1000, signature: e.signature });
            }
          }
          this.cursor.set(pool, from === undefined ? Math.max(newest, Math.floor(now / 1000) - 1) : newest);
        } catch (e) {
          this.lastError = `LP poll: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, run));
    for (const p of this.cursor.keys()) if (!pools.includes(p)) this.cursor.delete(p);
    return out;
  }
}
