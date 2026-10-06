// Tools over the existing Chord databases (read-only, src/db/pg.ts). Hourly / daily rollups for boards and chain totals;
// raw trades only through index-bounded, LIMITed reads (token+ts, wallet+ts). Never a full scan.
import bs58 from "bs58";
import { config, chordHeaders } from "../config";
import { isPubkey } from "../solana/tokens";
import { short, solscan, ToolInputError, type Source, type Tool } from "../types";
import { dbEnabled, q } from "./pg";

export type ChainKey = "monad" | "robinhood" | "arc" | "avalanche" | "base" | "bnb" | "solana";
type ChainDef = { id: number; name: string; rollup: "rh" | "arc" | "keyed" | null; raw: "dex_trades" | "chain_trades" | "sol"; tx: ((h: string) => string) | null };
export const CHAINS: Record<ChainKey, ChainDef> = {
  monad: { id: 143, name: "Monad", rollup: null, raw: "dex_trades", tx: null },
  robinhood: { id: 4663, name: "Robinhood Chain", rollup: "rh", raw: "dex_trades", tx: null },
  arc: { id: 5042, name: "Arc", rollup: "arc", raw: "dex_trades", tx: null },
  avalanche: { id: 43114, name: "Avalanche", rollup: "keyed", raw: "chain_trades", tx: (h) => `https://snowtrace.io/tx/${h}` },
  base: { id: 8453, name: "Base", rollup: "keyed", raw: "chain_trades", tx: (h) => `https://basescan.org/tx/${h}` },
  bnb: { id: 56, name: "BNB Chain", rollup: "keyed", raw: "chain_trades", tx: (h) => `https://bscscan.com/tx/${h}` },
  solana: { id: 0, name: "Solana", rollup: null, raw: "sol", tx: solscan.tx },
};
const SOL_DEX: Record<number, string> = { 1: "pumpswap", 2: "pumpfun", 3: "meteora_dbc", 4: "meteora_damm_v2", 5: "meteora_dlmm", 6: "raydium_clmm",
  7: "orca", 8: "raydium_cpmm", 9: "raydium_v4", 10: "meteora_pools", 11: "raydium_launchlab" };

/** A token-hour above this is a decoding / pricing error, not trading (06/10: one Meteora pool token read $154T in a day). */
export const MAX_SANE_HOUR_USD = 5e9;

/** Chains this deployment can read: listed in INDEX_CHAINS and backed by a connected database. */
export function enabledChains(): ChainKey[] {
  return config.indexChains().filter((c): c is ChainKey => c in CHAINS && (c === "solana" ? dbEnabled("solana") : dbEnabled("index")));
}
function chainOf(v: unknown): ChainKey {
  const k = String(v ?? "").toLowerCase().replace(/\s+chain$/, "").replace(/^bsc$/, "bnb").replace(/^avax$/, "avalanche").replace(/^rh$/, "robinhood");
  const ok = enabledChains();
  if (!ok.includes(k as ChainKey)) throw new ToolInputError(`chain must be one of ${ok.join(", ")}`);
  return k as ChainKey;
}
const evmAddr = (v: unknown, what: string) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) throw new ToolInputError(`${what} must be a 0x address on this chain`);
  return s;
};
const solHex = (v: unknown, what: string) => {
  const s = String(v ?? "").trim();
  if (!isPubkey(s)) throw new ToolInputError(`${what} must be a Solana base58 address`);
  return Buffer.from(bs58.decode(s)).toString("hex");
};
const b58 = (hex: string | null) => (hex ? bs58.encode(Buffer.from(hex, "hex")) : null);
const now = () => Math.floor(Date.now() / 1000);
const n = (x: unknown) => (x == null ? null : Number(x));
const indexSource = (c: ChainKey, what: string): Source => ({ kind: "index", id: `${c}:${what}`, label: `Chord index · ${CHAINS[c].name}`, url: null });

// Symbols for EVM tokens come from Chord's public token list for the chain (the DB keys tokens by address only).
const symCache = new Map<number, { at: number; map: Map<string, string> }>();
async function evmSymbols(chain: number): Promise<Map<string, string>> {
  const hit = symCache.get(chain);
  if (hit && Date.now() - hit.at < 600_000) return hit.map;
  const map = new Map<string, string>();
  const api = config.chordApi();
  if (api) {
    try {
      const r = await fetch(`${api}/v1/tokens?chain=${chain}`, { headers: chordHeaders(), signal: AbortSignal.timeout(8000) });
      const j: any = await r.json();
      for (const t of (Array.isArray(j) ? j : j.tokens ?? [])) if (t.address && t.symbol) map.set(String(t.address).toLowerCase(), t.symbol);
    } catch { /* no symbols is fine: addresses still answer */ }
  }
  symCache.set(chain, { at: Date.now(), map });
  return map;
}

const DAYS_TABLE: Record<"rh" | "arc", string> = { rh: "rh_chain_daily", arc: "arc_chain_daily" };
const HOURLY_TABLE: Record<"rh" | "arc", string> = { rh: "rh_token_hourly", arc: "arc_token_hourly" };

const chainActivity: Tool = {
  name: "index_chain_activity",
  via: "index",
  label: "Reading chain totals",
  description: "Daily DEX activity of a chain from Chord's own index: volume (USD), swaps, tokens traded (and wallets, venues where kept). Chains: {CHAINS}.",
  parameters: { type: "object", properties: { chain: { type: "string" }, days: { type: "number", description: "1-14, default 7" } }, required: ["chain"] },
  async run(a) {
    const c = chainOf(a.chain), def = CHAINS[c];
    const days = Math.max(1, Math.min(14, Number(a.days) || 7));
    const from = Math.floor(now() / 86400 - days + 1) * 86400;
    let rows: any[];
    let excluded = { hours: 0, usd: 0 };
    if (c === "solana") {
      if (!dbEnabled("solana")) throw new ToolInputError("the Solana index database is not connected");
      rows = await q("solana", `SELECT (hour / 24) * 86400 AS day, sum(vol_usd) FILTER (WHERE vol_usd < $2::float8) AS vol_usd, sum(n)::bigint AS swaps,
                                  count(DISTINCT token)::int AS tokens, count(*) FILTER (WHERE vol_usd >= $2::float8)::int AS bad_hours,
                                  coalesce(sum(vol_usd) FILTER (WHERE vol_usd >= $2::float8), 0) AS bad_usd
                                FROM sol_token_hourly WHERE hour >= $1::int GROUP BY 1 ORDER BY 1 DESC`, [from / 3600, MAX_SANE_HOUR_USD]);
      for (const r of rows) { excluded.hours += Number(r.bad_hours) || 0; excluded.usd += Number(r.bad_usd) || 0; }
    } else {
      if (!dbEnabled("index")) throw new ToolInputError("the index database is not connected");
      if (!def.rollup) throw new ToolInputError(`${def.name} has no daily rollup in the index; ask about its tokens or wallets instead`);
      rows = def.rollup === "keyed"
        ? await q("index", "SELECT day, swaps, vol_usd, tokens, wallets, venues FROM chain_chain_daily WHERE chain = $1 AND day >= $2 ORDER BY day DESC", [def.id, from])
        : await q("index", `SELECT day, swaps, vol_usd, tokens, wallets, venues FROM ${DAYS_TABLE[def.rollup]} WHERE day >= $1 ORDER BY day DESC`, [from]);
    }
    const out = rows.map((r) => ({ day: new Date(Number(r.day) * 1000).toISOString().slice(0, 10), volumeUsd: Math.round(Number(r.vol_usd) || 0), swaps: Number(r.swaps) || 0,
      tokens: n(r.tokens), wallets: n(r.wallets), venues: n(r.venues) }));
    return {
      data: { chain: def.name, days: out, note: out[0] ? "The latest day is partial (UTC)." : "No rows in this window.",
        ...(excluded.hours ? { excludedAsErrors: { tokenHours: excluded.hours, usd: excluded.usd, rule: `token-hours over $${MAX_SANE_HOUR_USD / 1e9}B are pricing errors and left out` } } : {}) },
      sources: [indexSource(c, "daily")],
      summary: out[0] ? `${out.length} days, latest $${(out[0].volumeUsd / 1e6).toFixed(1)}M` : "no data",
    };
  },
};

const topTokens: Tool = {
  name: "index_top_tokens",
  via: "index",
  label: "Reading the token board",
  description: "The most traded tokens on a chain over the last N hours from Chord's index: volume, trades, buys vs sells, last price. Chains: {CHAINS}.",
  parameters: { type: "object", properties: { chain: { type: "string" }, hours: { type: "number", description: "1-72, default 24" }, limit: { type: "number", description: "1-25, default 10" } }, required: ["chain"] },
  async run(a) {
    const c = chainOf(a.chain), def = CHAINS[c];
    const hours = Math.max(1, Math.min(72, Number(a.hours) || 24));
    const limit = Math.max(1, Math.min(25, Number(a.limit) || 10));
    const fromHour = Math.floor(now() / 3600) - hours + 1;
    let rows: any[];
    if (c === "solana") {
      if (!dbEnabled("solana")) throw new ToolInputError("the Solana index database is not connected");
      rows = await q("solana", `
        WITH h AS (SELECT token, sum(vol_usd) AS vol, sum(n)::int AS trades, sum(buys)::int AS buys, sum(buy_usd) AS buy_usd
                   FROM sol_token_hourly WHERE hour >= $1::int AND vol_usd < $3::float8 GROUP BY token ORDER BY vol DESC LIMIT $2::int)
        SELECT encode(h.token, 'hex') AS token, h.vol, h.trades, h.buys, h.buy_usd, k.symbol, k.name, p.price_usd, p.liq_usd, p.dex
        FROM h LEFT JOIN sol_tokens k ON k.mint = h.token
        LEFT JOIN LATERAL (SELECT price_usd, liq_usd, dex FROM sol_pools WHERE token = h.token AND price_usd IS NOT NULL ORDER BY liq_usd DESC NULLS LAST LIMIT 1) p ON true
        ORDER BY h.vol DESC`, [fromHour, limit, MAX_SANE_HOUR_USD]);
      const list = rows.map((r) => ({ token: b58(r.token), symbol: r.symbol ?? null, name: r.name ?? null, volumeUsd: Math.round(Number(r.vol)), trades: Number(r.trades),
        buys: Number(r.buys), buyShare: Number(r.vol) > 0 ? +(Number(r.buy_usd) / Number(r.vol)).toFixed(3) : null, priceUsd: n(r.price_usd), liquidityUsd: n(r.liq_usd), mainVenue: r.dex == null ? null : SOL_DEX[Number(r.dex)] ?? null }));
      return {
        data: { chain: "Solana", hours, tokens: list, rule: `token-hours over $${MAX_SANE_HOUR_USD / 1e9}B are treated as pricing errors and left out` },
        sources: [indexSource(c, "board"), ...list.slice(0, 5).map((t): Source => ({ kind: "token", id: t.token!, label: t.symbol ?? short(t.token!), url: solscan.token(t.token!) }))],
        summary: list[0] ? `top: ${list.slice(0, 3).map((t) => t.symbol ?? short(t.token!)).join(", ")}` : "no trades",
      };
    }
    if (!dbEnabled("index")) throw new ToolInputError("the index database is not connected");
    if (!def.rollup) throw new ToolInputError(`${def.name} has no hourly rollup in the index`);
    const select = `SELECT token, sum(vol_usd) AS vol, sum(trades)::int AS trades, sum(buys)::int AS buys, sum(sells)::int AS sells, sum(buy_usd) AS buy_usd,
                           (array_agg(price_last ORDER BY last_ts DESC))[1] AS price`;
    rows = def.rollup === "keyed"
      ? await q("index", `${select} FROM chain_token_hourly WHERE chain = $1 AND hour >= $2 AND vol_usd < $4 GROUP BY token ORDER BY vol DESC LIMIT $3`, [def.id, fromHour * 3600, limit, MAX_SANE_HOUR_USD])
      : await q("index", `${select} FROM ${HOURLY_TABLE[def.rollup]} WHERE hour >= $1 AND vol_usd < $3 GROUP BY token ORDER BY vol DESC LIMIT $2`, [fromHour * 3600, limit, MAX_SANE_HOUR_USD]);
    const syms = await evmSymbols(def.id);
    const list = rows.map((r) => ({ token: r.token, symbol: syms.get(String(r.token).toLowerCase()) ?? null, volumeUsd: Math.round(Number(r.vol)), trades: Number(r.trades),
      buys: Number(r.buys), sells: Number(r.sells), buyShare: Number(r.vol) > 0 ? +(Number(r.buy_usd) / Number(r.vol)).toFixed(3) : null, priceUsd: n(r.price) }));
    return {
      data: { chain: def.name, hours, tokens: list },
      sources: [indexSource(c, "board")],
      summary: list[0] ? `top: ${list.slice(0, 3).map((t) => t.symbol ?? short(t.token)).join(", ")}` : "no trades",
    };
  },
};

const tokenTrades: Tool = {
  name: "index_token_trades",
  via: "index",
  label: "Reading the trade tape",
  description: "The latest DEX trades of one token from Chord's index: time, side, USD, price, venue, wallet and transaction. Chains: {CHAINS}.",
  parameters: { type: "object", properties: { chain: { type: "string" }, token: { type: "string", description: "Token address (0x… or Solana mint)" }, limit: { type: "number", description: "1-50, default 20" } }, required: ["chain", "token"] },
  async run(a) {
    const c = chainOf(a.chain), def = CHAINS[c];
    const limit = Math.max(1, Math.min(50, Number(a.limit) || 20));
    let trades: { ts: number; side: string; usd: number | null; priceUsd: number | null; amount: number; dex: string; wallet: string | null; tx: string }[];
    if (c === "solana") {
      if (!dbEnabled("solana")) throw new ToolInputError("the Solana index database is not connected");
      const hex = solHex(a.token, "token");
      const pools = await q("solana", "SELECT encode(pool, 'hex') AS pool FROM sol_pools WHERE token = decode($1, 'hex') ORDER BY last_ts DESC LIMIT 30", [hex]);
      if (!pools.length) return { data: { chain: "Solana", token: a.token, trades: [], note: "No pools for this mint in the index." }, sources: [], summary: "no pools" };
      const hi = now() + 60;
      const rows = await q("solana", `SELECT t.ts, t.side, t.usd, t.price_usd, t.token_amt, t.dex, encode(t.wallet, 'hex') AS wallet, encode(t.sig, 'hex') AS sig
         FROM unnest($1::text[]) AS x(h) CROSS JOIN LATERAL (
           SELECT * FROM sol_swaps WHERE pool = decode(x.h, 'hex') AND ts >= $2::int AND ts < $3::int ORDER BY ts DESC, slot DESC, tx_index DESC, ev_index DESC LIMIT $4::int) t
         ORDER BY t.ts DESC, t.slot DESC LIMIT $4::int`, [`{${pools.map((p) => p.pool).join(",")}}`, hi - 2 * 86400, hi, limit]);
      trades = rows.map((r) => ({ ts: Number(r.ts), side: Number(r.side) === 1 ? "buy" : "sell", usd: n(r.usd), priceUsd: n(r.price_usd), amount: Number(r.token_amt), dex: SOL_DEX[Number(r.dex)] ?? `dex_${r.dex}`, wallet: b58(r.wallet), tx: b58(r.sig)! }));
    } else {
      if (!dbEnabled("index")) throw new ToolInputError("the index database is not connected");
      const token = evmAddr(a.token, "token");
      const since = now() - 7 * 86400;
      const rows = def.raw === "chain_trades"
        ? await q("index", "SELECT tx, ts, side, usd, price_usd, token_amt, dex, wallet FROM chain_trades WHERE chain = $1 AND token = $2 AND ts >= $3 ORDER BY ts DESC LIMIT $4", [def.id, token, since, limit])
        : await q("index", "SELECT tx, ts, side, usd, price_usd, token_amt, dex, wallet FROM dex_trades WHERE token = $2 AND ts >= $3 AND chain = $1 ORDER BY ts DESC LIMIT $4", [def.id, token, since, limit]);
      trades = rows.map((r) => ({ ts: Number(r.ts), side: r.side, usd: n(r.usd), priceUsd: n(r.price_usd), amount: Number(r.token_amt), dex: r.dex, wallet: r.wallet, tx: r.tx }));
    }
    const out = trades.map((t) => ({ ...t, time: new Date(t.ts * 1000).toISOString() }));
    return {
      data: { chain: def.name, token: a.token, trades: out },
      sources: [indexSource(c, "tape"), ...out.slice(0, 4).map((t): Source => ({ kind: c === "solana" ? "tx" : "index", id: t.tx, label: `Tx ${short(t.tx)}`, url: def.tx ? def.tx(t.tx) : null }))],
      summary: `${out.length} trade${out.length === 1 ? "" : "s"}`,
    };
  },
};

const walletBook: Tool = {
  name: "index_wallet",
  via: "index",
  label: "Reading the wallet's trades",
  description: "What a wallet traded on a chain over the last N days from Chord's index: per token bought and sold in USD, trade counts, plus its latest trades. Chains: {CHAINS}.",
  parameters: { type: "object", properties: { chain: { type: "string" }, wallet: { type: "string" }, days: { type: "number", description: "1-30, default 7" } }, required: ["chain", "wallet"] },
  async run(a) {
    const c = chainOf(a.chain), def = CHAINS[c];
    const days = Math.max(1, Math.min(30, Number(a.days) || 7));
    if (c === "solana") {
      if (!dbEnabled("solana")) throw new ToolInputError("the Solana index database is not connected");
      const hex = solHex(a.wallet, "wallet");
      const day = Math.floor(now() / 86400);
      const rows = await q("solana", `SELECT encode(w.token, 'hex') AS token, w.bu, w.su, w.nb, w.ns, k.symbol
         FROM (SELECT token, sum(buy_usd) AS bu, sum(sell_usd) AS su, sum(n_buy)::int AS nb, sum(n_sell)::int AS ns
               FROM sol_wallet_token_daily WHERE wallet = decode($1, 'hex') AND day >= $2::int GROUP BY token ORDER BY sum(buy_usd) + sum(sell_usd) DESC LIMIT 25) w
         LEFT JOIN sol_tokens k ON k.mint = w.token`, [hex, day - days + 1]);
      const tokens = rows.map((r) => ({ token: b58(r.token), symbol: r.symbol ?? null, boughtUsd: Math.round(Number(r.bu)), soldUsd: Math.round(Number(r.su)), buys: Number(r.nb), sells: Number(r.ns) }));
      return { data: { chain: "Solana", wallet: a.wallet, days, tokens }, sources: [indexSource(c, "wallet"), { kind: "account", id: a.wallet, label: `Wallet ${short(a.wallet)}`, url: solscan.account(a.wallet) }],
        summary: `${tokens.length} token${tokens.length === 1 ? "" : "s"} traded` };
    }
    if (!dbEnabled("index")) throw new ToolInputError("the index database is not connected");
    const wallet = evmAddr(a.wallet, "wallet");
    const since = now() - days * 86400;
    const table = def.raw === "chain_trades" ? "chain_trades" : "dex_trades";
    const rows = await q("index", `SELECT tx, ts, token, side, usd, price_usd, token_amt, dex FROM ${table} WHERE chain = $1 AND wallet = $2 AND ts >= $3 ORDER BY ts DESC LIMIT 200`, [def.id, wallet, since]);
    const syms = await evmSymbols(def.id);
    const by = new Map<string, { token: string; symbol: string | null; boughtUsd: number; soldUsd: number; buys: number; sells: number }>();
    for (const r of rows) {
      const t = by.get(r.token) ?? { token: r.token, symbol: syms.get(String(r.token).toLowerCase()) ?? null, boughtUsd: 0, soldUsd: 0, buys: 0, sells: 0 };
      if (r.side === "buy") { t.boughtUsd += Number(r.usd) || 0; t.buys++; } else { t.soldUsd += Number(r.usd) || 0; t.sells++; }
      by.set(r.token, t);
    }
    const tokens = [...by.values()].map((t) => ({ ...t, boughtUsd: Math.round(t.boughtUsd), soldUsd: Math.round(t.soldUsd) })).sort((x, y) => y.boughtUsd + y.soldUsd - (x.boughtUsd + x.soldUsd));
    const latest = rows.slice(0, 10).map((r) => ({ time: new Date(Number(r.ts) * 1000).toISOString(), token: r.token, symbol: syms.get(String(r.token).toLowerCase()) ?? null, side: r.side, usd: n(r.usd), tx: r.tx }));
    return {
      data: { chain: def.name, wallet, days, trades: rows.length, capped: rows.length === 200, tokens: tokens.slice(0, 25), latest },
      sources: [indexSource(c, "wallet"), ...latest.slice(0, 3).map((t): Source => ({ kind: "index", id: t.tx, label: `Tx ${short(t.tx)}`, url: def.tx ? def.tx(t.tx) : null }))],
      summary: `${rows.length} trade${rows.length === 1 ? "" : "s"} in ${days}d`,
    };
  },
};

const ROLLUP: ChainKey[] = ["robinhood", "arc", "avalanche", "base", "bnb", "solana"];
export const dbTools = (): Tool[] => {
  const chains = enabledChains();
  if (!chains.length) return [];
  const list = (only?: ChainKey[]) => chains.filter((c) => !only || only.includes(c)).join(", ");
  const withChains = (t: Tool, only?: ChainKey[]): Tool => ({ ...t, description: t.description.replace("{CHAINS}", list(only)) });
  const out = [withChains(tokenTrades), withChains(walletBook)];
  if (chains.some((c) => ROLLUP.includes(c))) out.unshift(withChains(chainActivity, ROLLUP), withChains(topTokens, ROLLUP));
  return out;
};
