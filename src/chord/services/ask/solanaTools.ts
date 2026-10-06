// Ask tools for Solana through Jupiter's public API (tool-parity batch 2026-10-03, docs/prompts/ask-tool-parity-2026-10.md):
//   sol_tokens · sol_quote · sol_lend_rates
// Chord does not trade on Solana: these read Jupiter's token index, its live aggregator route and Jupiter Lend's rates for
// analysis only. Built from Jupiter's public docs (developers.jup.ag) and live responses, measured 2026-10-03:
//   · Tokens v2 — /tokens/v2/search?query= (symbol, name or mint, comma-separated mints; 20 rows), /tokens/v2/{toptrending|
//     toptraded|toporganicscore}/{5m|1h|6h|24h}?limit=≤100 (majors like SOL / USDC left out by Jupiter), /tokens/v2/recent (30
//     newest first pools, mostly pump.fun, `limit` ignored), /tokens/v2/tag?query=lst (165 rows; `verified` returns all ~3,900
//     verified mints = 5.4 MB, so the verified board is the toptraded list filtered on isVerified instead). Fields: usdPrice, mcap,
//     fdv, liquidity, holderCount, organicScore (0–100, Jupiter's estimate of non-bot trading) + label, isVerified, tags, statsXX
//     {priceChange %, buyVolume, sellVolume, numTraders …}, audit {mintAuthorityDisabled, freezeAuthorityDisabled,
//     topHoldersPercentage, devBalancePercentage}, mintAuthority / freezeAuthority (the holder's address when active), firstPool.
//   · Swap v1 — /swap/v1/quote: priceImpactPct is a FRACTION (0.138 = 13.8 %, checked against the spot price), routePlan
//     [{swapInfo {label, inputMint, outputMint}, percent}] where percent is the share of that step's input; 400 = no route /
//     token not tradable / same mint.
//   · Price v3 — /price/v3?ids= (≤50 mints): {mint: {usdPrice, decimals, priceChange24h, liquidity}}.
//   · Lend — /lend/v1/earn/tokens (rates "in 1e4 decimals": 348 = 3.48 %, amounts in the asset's base units) and
//     /lend/v1/borrow/vaults (82 vaults; borrowRateLiquidity = the asset's base borrow rate, borrowRate adds the vault's spread).
// Host: lite-api.jup.ag (keyless, no published cap) with api.jup.ag as the fallback when lite answers 5xx / 403 / 410 /
// times out — Jupiter is phasing lite out, keyless api.jup.ag allows 0.5 req/s. `JUPITER_API_KEY` (optional, free key from
// developers.jup.ag/portal) switches to api.jup.ag with the key. Token names and symbols are chosen by whoever launched the
// token: trimmed here, `untrusted` in the registry.

import { ExtError, extFailure, extJson, num, usdShort, type ExtToolResult } from "./extHttp";
import type { ToolMeta } from "./registry";
import type { AssetChip, Citation, Viz } from "../askAgent";

const SOURCE = "Jupiter";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** The three mints every Solana user means by these tickers (canonical, immutable): no search call, no look-alike. */
const WELL_KNOWN: Record<string, { mint: string; symbol: string; decimals: number }> = {
  sol: { mint: SOL_MINT, symbol: "SOL", decimals: 9 }, wsol: { mint: SOL_MINT, symbol: "SOL", decimals: 9 },
  usdc: { mint: USDC_MINT, symbol: "USDC", decimals: 6 }, usdt: { mint: USDT_MINT, symbol: "USDT", decimals: 6 },
};
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── small formatters (house style: 5 significant digits for prices, 2 decimals for %, whole dollars) ─────────────────────
const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const sig = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(5)));
const whole = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n));
const short = (m: string) => (m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);
/** Third-party text: one line, no control characters, capped. */
export const clean = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/^\$/, "").replace(/[^a-z0-9]+/g, "");
const pctCell = (n: number | null) => (n == null ? null : `${n}%`);
const usdCell = (n: number | null) => usdShort(n) ?? null;

export const tokenPage = (mint: string) => `https://jup.ag/tokens/${mint}`;
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;
/** Where a Solana token chip opens (board #113): Ask's own Solana view (web AskSolanaTrade), the mint exactly as given. */
export const solAskHref = (mint: string) => `/ask/trade/${mint}?chain=solana`;

// ── Jupiter host ladder ──────────────────────────────────────────────────────────────────────────────────────────────
const JUP_KEY = (process.env.JUPITER_API_KEY ?? "").trim();
const HOSTS = JUP_KEY ? ["https://api.jup.ag"] : ["https://lite-api.jup.ag", "https://api.jup.ag"];

/** A failure that says "this host is down", not "this request has no answer": only those move on to the next host. */
const hostFailure = (e: unknown) => !(e instanceof ExtError) || (!e.notFound && e.status !== 400 && e.status !== 429 && !/rate-limited/.test(e.message));

async function jup<T = any>(path: string, ttlS: number, staleS?: number): Promise<{ data: T; ageS: number }> {
  let last: unknown = null;
  for (const host of HOSTS) {
    try {
      return await extJson<T>("jupiter", `${host}${path}`, { ttlS, staleS, timeoutMs: 6_000, ...(JUP_KEY ? { headers: { "x-api-key": JUP_KEY } } : {}) });
    } catch (e) {
      last = e;
      if (!hostFailure(e)) throw e;
    }
  }
  throw last;
}

// ── tokens ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Interval = "5m" | "1h" | "6h" | "24h";
export type TokenMode = "search" | "trending" | "top_traded" | "top_organic" | "recent" | "verified" | "lst";
const INTERVALS: Interval[] = ["5m", "1h", "6h", "24h"];
const MODES: TokenMode[] = ["search", "trending", "top_traded", "top_organic", "recent", "verified", "lst"];
const STATS_KEY: Record<Interval, string> = { "5m": "stats5m", "1h": "stats1h", "6h": "stats6h", "24h": "stats24h" };
const MEANINGFUL_TAGS = new Set(["strict", "community", "lst", "stable", "token-2022", "yield", "moonshot-verified"]);

export const parseInterval = (v: unknown): Interval | null => {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const m: Record<string, Interval> = { "5m": "5m", "5min": "5m", "1h": "1h", "60m": "1h", hour: "1h", "6h": "6h", "24h": "24h", "1d": "24h", day: "24h" };
  return m[s] ?? null;
};
export const parseMode = (v: unknown): TokenMode | null => {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const alias: Record<string, TokenMode> = { top: "top_traded", traded: "top_traded", volume: "top_traded", organic: "top_organic", new: "recent", latest: "recent", lsts: "lst", staking: "lst", find: "search" };
  return (MODES as string[]).includes(s) ? (s as TokenMode) : alias[s] ?? null;
};

/** Jupiter's board path for a mode (verified = the toptraded board filtered on isVerified; see the header). */
export function boardPath(mode: Exclude<TokenMode, "search">, interval: Interval): string {
  switch (mode) {
    case "trending": return `/tokens/v2/toptrending/${interval}?limit=100`;
    case "top_organic": return `/tokens/v2/toporganicscore/${interval}?limit=100`;
    case "top_traded": case "verified": return `/tokens/v2/toptraded/${interval}?limit=100`;
    case "recent": return "/tokens/v2/recent";
    case "lst": return "/tokens/v2/tag?query=lst";
  }
}

/** "active" = someone still holds the key (can mint more / freeze holders); "disabled" = renounced; null = Jupiter did not say. */
export function authorityState(t: any, which: "mint" | "freeze"): "active" | "disabled" | null {
  const holder = t?.[`${which}Authority`];
  if (typeof holder === "string" && holder) return "active";
  const flag = t?.audit?.[`${which}AuthorityDisabled`];
  if (flag === true) return "disabled";
  if (flag === false) return "active";
  return null;
}

const ageDaysOf = (t: any, now: number): number | null => {
  const at = Date.parse(String(t?.firstPool?.createdAt ?? t?.createdAt ?? ""));
  if (!Number.isFinite(at)) return null;
  const d = Math.max(0, (now - at) / 86_400_000);
  return d < 1 ? Math.round(d * 100) / 100 : d < 10 ? Math.round(d * 10) / 10 : Math.round(d);
};

export interface SolTokenRow {
  symbol: string; name: string; mint: string; priceUsd: number | null; change24hPct: number | null;
  marketCapUsd: number | null; liquidityUsd: number | null; holders: number | null; organicScore: number | null; organicLabel: string | null;
  volume24hUsd: number | null; buyVolume24hUsd: number | null; sellVolume24hUsd: number | null; traders24h: number | null;
  verified: boolean; mintAuthority: "active" | "disabled" | null; freezeAuthority: "active" | "disabled" | null;
  topHoldersPct: number | null; devHoldsPct?: number; launchpad?: string; ageDays?: number | null; ageMinutes?: number; tags?: string[];
  [window: string]: unknown;
}

/** One Jupiter token record → the compact row the model reads (pure, tested). `interval` ≠ 24h adds that window's numbers. */
export function tokenRow(t: any, interval: Interval = "24h", now = Date.now(), opts: { minutes?: boolean } = {}): SolTokenRow {
  const s24 = t?.stats24h ?? {};
  const buy = num(s24.buyVolume), sell = num(s24.sellVolume);
  const dev = r2(num(t?.audit?.devBalancePercentage));
  const tags = Array.isArray(t?.tags) ? t.tags.filter((x: unknown) => typeof x === "string" && MEANINGFUL_TAGS.has(x)).slice(0, 5) : [];
  const row: SolTokenRow = {
    symbol: clean(t?.symbol, 24) || short(String(t?.id ?? "")), name: clean(t?.name, 60), mint: String(t?.id ?? ""),
    priceUsd: sig(num(t?.usdPrice)), change24hPct: r2(num(s24.priceChange)),
    marketCapUsd: whole(num(t?.mcap)), liquidityUsd: whole(num(t?.liquidity)), holders: num(t?.holderCount),
    organicScore: whole(num(t?.organicScore)), organicLabel: typeof t?.organicScoreLabel === "string" ? t.organicScoreLabel : null,
    volume24hUsd: buy == null && sell == null ? null : whole((buy ?? 0) + (sell ?? 0)), buyVolume24hUsd: whole(buy), sellVolume24hUsd: whole(sell),
    traders24h: num(s24.numTraders),
    verified: t?.isVerified === true, mintAuthority: authorityState(t, "mint"), freezeAuthority: authorityState(t, "freeze"),
    topHoldersPct: r2(num(t?.audit?.topHoldersPercentage)),
    ...(dev != null && dev >= 0.01 ? { devHoldsPct: dev } : {}),
    ...(typeof t?.launchpad === "string" && t.launchpad ? { launchpad: clean(t.launchpad, 30) } : {}),
    ageDays: ageDaysOf(t, now),
    ...(tags.length ? { tags } : {}),
  };
  if (opts.minutes) {
    // New pools: minutes say more than "0 days".
    const at = Date.parse(String(t?.firstPool?.createdAt ?? t?.createdAt ?? ""));
    if (Number.isFinite(at)) { row.ageMinutes = Math.max(0, Math.round((now - at) / 60_000)); delete row.ageDays; }
  }
  if (interval !== "24h") {
    const w = t?.[STATS_KEY[interval]] ?? {};
    const wb = num(w.buyVolume), ws = num(w.sellVolume);
    row[`change${interval}Pct`] = r2(num(w.priceChange));
    row[`volume${interval}Usd`] = wb == null && ws == null ? null : whole((wb ?? 0) + (ws ?? 0));
    row[`traders${interval}`] = num(w.numTraders);
  }
  return row;
}

/** Search hits in reading order: verified first, then an exact symbol, then an exact name; Jupiter's order otherwise (pure). */
export function rankSearch(query: string, rows: any[]): any[] {
  const qn = norm(query);
  const score = (r: any) => (r?.isVerified === true ? 4 : 0) + (qn && norm(r?.symbol) === qn ? 2 : 0) + (qn && norm(r?.name) === qn ? 1 : 0);
  return (rows ?? []).filter((r) => r && typeof r.id === "string").map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
}

/** A board's rows after the mode's own filter / order (pure). */
export function boardRows(mode: Exclude<TokenMode, "search">, rows: any[]): any[] {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === "string");
  if (mode === "verified") return list.filter((r) => r.isVerified === true);
  if (mode === "lst") return [...list].sort((a, b) => (num(b.mcap) ?? 0) - (num(a.mcap) ?? 0));
  return list;
}

export function tokenChip(t: any): AssetChip | null {
  const mint = String(t?.id ?? "");
  if (!MINT.test(mint)) return null;
  const s24 = t?.stats24h ?? {};
  const vol = (num(s24.buyVolume) ?? 0) + (num(s24.sellVolume) ?? 0);
  const icon = typeof t?.icon === "string" && /^https:\/\//.test(t.icon) ? t.icon : null;
  return {
    id: `sol:${mint}`, symbol: clean(t?.symbol, 24) || short(mint), label: clean(t?.name, 60) || clean(t?.symbol, 24), price: sig(num(t?.usdPrice)),
    change24hPct: r2(num(s24.priceChange)), hl: null, href: solAskHref(mint), ...(icon ? { logo: icon } : {}),
    marketCapUsd: whole(num(t?.mcap)), volume24hUsd: whole(vol), liquidityUsd: whole(num(t?.liquidity)), fdvUsd: whole(num(t?.fdv)),
    kind: "crypto", chainName: "Solana",
  };
}
/** Chips only for tokens with a real market: copycats and dead launches stay in the table. */
const chipWorthy = (t: any) => (num(t?.liquidity) ?? 0) >= 10_000 && (num(t?.stats24h?.buyVolume) ?? 0) + (num(t?.stats24h?.sellVolume) ?? 0) >= 1_000;

const TOKEN_NOTE = "Anyone can launch a Solana token with any name and logo: check liquidity, holders, organic score and the authorities before naming one. verified = Jupiter's verification, not an endorsement. organicScore (0-100) is Jupiter's estimate of trading by real wallets rather than bots. mintAuthority active = the issuer can still mint more; freezeAuthority active = the issuer can freeze holders' tokens (normal for regulated stablecoins such as USDC, a red flag on a meme). topHoldersPct = share of supply in the largest holders (Jupiter's figure, pools and exchanges included). Liquidity under $10k = hard to sell.";
const MODE_NOTE: Record<TokenMode, string> = {
  search: "Several tokens can share a ticker: give the mint for the one you mean and say if it is unverified.",
  trending: "Jupiter's trending board for the window (attention and trading, not quality); majors such as SOL and USDC are left out by Jupiter.",
  top_traded: "Ranked by trading volume in the window; majors such as SOL and USDC are left out by Jupiter.",
  top_organic: "Ranked by Jupiter's organic score (share of trading by real wallets) in the window.",
  recent: "Tokens whose first pool was created minutes ago, mostly pump.fun bonding curves: no history, most never trade again. Say so plainly.",
  verified: "The most traded Jupiter-verified tokens in the window (majors such as SOL and USDC are left out by Jupiter).",
  lst: "Liquid staking SOL tokens by market cap; Jupiter does not publish their staking yield here.",
};

async function solTokens(args: Record<string, any>): Promise<ExtToolResult> {
  const query = clean(args.query, 80).replace(/^\$/, "");
  const mode: TokenMode = parseMode(args.mode) ?? (query ? "search" : "trending");
  if (args.mode != null && args.mode !== "" && !parseMode(args.mode)) return bad(`mode must be one of ${MODES.join(", ")}.`);
  const askedIv = args.interval == null || args.interval === "" ? null : parseInterval(args.interval);
  if (args.interval != null && args.interval !== "" && !askedIv) return bad("interval must be 5m, 1h, 6h or 24h.");
  const interval: Interval = askedIv ?? (mode === "trending" ? "1h" : "24h");
  const now = Date.now();

  if (mode === "search") {
    if (!query) return bad("search needs a query: a symbol, a name or a mint address.");
    const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
    let res: { data: any[]; ageS: number };
    try { res = await jup<any[]>(`/tokens/v2/search?query=${encodeURIComponent(query)}`, 120); } catch (e) { return fail(e); }
    const ranked = rankSearch(query, Array.isArray(res.data) ? res.data : []).slice(0, limit);
    if (!ranked.length) return { data: { found: false, query, source: `${SOURCE} Tokens API`, note: `No Solana token in Jupiter's index answers to "${query.slice(0, 40)}". Say so; do not guess a mint.` }, addresses: [], citations: [] };
    const rows = ranked.map((t) => tokenRow(t, "24h", now));
    return tokensResult({ mode, interval: null, query, rows, raw: ranked, ageS: res.ageS, title: `"${query.slice(0, 24)}" on Solana` });
  }

  const limit = Math.max(1, Math.min(25, Number(args.limit) || 12));
  let res: { data: any[]; ageS: number };
  try { res = await jup<any[]>(boardPath(mode, interval), mode === "lst" ? 120 : 60); } catch (e) { return fail(e); }
  const raw = boardRows(mode, res.data).slice(0, limit);
  if (!raw.length) return { data: { found: false, mode, source: `${SOURCE} Tokens API`, note: "Jupiter returned an empty board just now. Say so." }, addresses: [], citations: [] };
  const rows = raw.map((t) => tokenRow(t, mode === "recent" || mode === "lst" ? "24h" : interval, now, { minutes: mode === "recent" }));
  const label = { trending: "trending", top_traded: "top traded", top_organic: "top organic", recent: "new pools", verified: "top verified", lst: "liquid staking tokens" }[mode];
  const ivLabel = mode === "recent" || mode === "lst" ? "" : ` · ${interval}`;
  return tokensResult({ mode, interval: mode === "recent" || mode === "lst" ? null : interval, rows, raw, ageS: res.ageS, title: `Solana · ${label}${ivLabel}` });
}

function tokensResult(p: { mode: TokenMode; interval: Interval | null; query?: string; rows: SolTokenRow[]; raw: any[]; ageS: number; title: string }): ExtToolResult {
  const iv = p.interval && p.interval !== "24h" ? p.interval : null;
  const changeCol = iv ? `change${iv}Pct` : "change24hPct";
  const unverifiedLookAlikes = p.mode === "search" && p.rows.some((r) => r.verified) && p.rows.some((r) => !r.verified && norm(r.symbol) === norm(p.query));
  const data = {
    source: `${SOURCE} Tokens API`, mode: p.mode, ...(p.interval ? { interval: p.interval } : {}), ...(p.query ? { query: p.query } : {}),
    ...(p.ageS ? { dataAgeS: p.ageS } : {}),
    rows: p.rows,
    note: [MODE_NOTE[p.mode], unverifiedLookAlikes ? "Unverified tokens share this ticker with the verified one: name the verified mint and call the others look-alikes." : null, iv ? `change${iv}Pct / volume${iv}Usd / traders${iv} cover the last ${iv}; the other numbers are 24h.` : null, TOKEN_NOTE].filter(Boolean).join(" "),
  };
  // A board cites Jupiter's board and its first VERIFIED row only: a fresh launch's page is not a source worth a link.
  const top = p.mode === "search" ? p.raw[0] : p.raw.find((r) => r?.isVerified === true);
  const citations: Citation[] = p.mode === "search"
    ? [{ label: `${clean(top?.symbol, 24)} on Jupiter`, href: tokenPage(top.id) }, { label: `${clean(top?.symbol, 24)} on Solscan`, href: solscanToken(top.id) }]
    : [{ label: "Jupiter token board", href: "https://jup.ag/spot" }, ...(top ? [{ label: `${clean(top.symbol, 24)} on Jupiter`, href: tokenPage(top.id) }] : [])];
  const viz: Viz[] = [{
    kind: "table", title: `${p.title} (Jupiter)`,
    columns: ["Token", "Price", iv ? iv : "24h", "Mkt cap", "Liquidity", "Holders", "Organic", "Verified"],
    rows: p.rows.slice(0, 15).map((r) => [r.name && norm(r.name) !== norm(r.symbol) ? `${r.symbol} · ${r.name.slice(0, 22)}` : r.symbol, r.priceUsd, pctCell((r[changeCol] as number | null) ?? null), usdCell(r.marketCapUsd), usdCell(r.liquidityUsd), r.holders, r.organicScore, r.verified ? "yes" : "no"]),
    align: ["l", "r", "r", "r", "r", "r", "r", "l"],
  }];
  const chipCandidates = p.raw.filter(chipWorthy).map(tokenChip).filter((c): c is AssetChip => !!c);
  return { data, addresses: p.rows.map((r) => r.mint), citations, viz, chipCandidates };
}

// ── quote ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface SolToken { mint: string; symbol: string; decimals: number; verified: boolean | null; liquidityUsd: number | null }
export interface Candidate { symbol: string; mint: string; verified: boolean; liquidityUsd: number | null; holders: number | null }
const asSolToken = (t: any): SolToken | null => {
  const decimals = num(t?.decimals);
  if (!t || typeof t.id !== "string" || decimals == null || decimals < 0 || decimals > 18) return null;
  return { mint: t.id, symbol: clean(t.symbol, 24) || short(t.id), decimals, verified: t.isVerified === true, liquidityUsd: whole(num(t.liquidity)) };
};
const asCandidate = (t: any): Candidate => ({ symbol: clean(t?.symbol, 24), mint: String(t?.id ?? ""), verified: t?.isVerified === true, liquidityUsd: whole(num(t?.liquidity)), holders: num(t?.holderCount) });

/** A ticker / name / mint → one token from Jupiter's search rows, or the candidates to ask about (pure, tested).
 *  Exact symbol or name matches only; verified beats unverified, an exact symbol beats an exact name, then liquidity. The top
 *  one wins when it is the only match, verified against unverified, or ≥10× the next one's liquidity; else it is ambiguous. */
export function pickToken(query: string, rows: any[]): { token: SolToken } | { candidates: Candidate[] } | null {
  const q = query.trim().replace(/^\$/, "");
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === "string");
  if (MINT.test(q)) { const hit = asSolToken(list.find((r) => r.id === q)); return hit ? { token: hit } : null; }
  const qn = norm(q);
  if (!qn) return null;
  const symHit = (r: any) => norm(r.symbol) === qn;
  const exact = list.filter((r) => symHit(r) || norm(r.name) === qn);
  if (!exact.length) return list.length ? { candidates: rankSearch(q, list).slice(0, 6).map(asCandidate) } : null;
  const liq = (r: any) => num(r?.liquidity) ?? 0;
  const ranked = [...exact].sort((a, b) => Number(b.isVerified === true) - Number(a.isVerified === true) || Number(symHit(b)) - Number(symHit(a)) || liq(b) - liq(a));
  const [top, second] = ranked;
  const clear = !second || (top.isVerified === true && second.isVerified !== true) || liq(top) >= 10 * Math.max(liq(second), 1);
  const tok = clear ? asSolToken(top) : null;
  return tok ? { token: tok } : { candidates: ranked.slice(0, 6).map(asCandidate) };
}

/** "1.5" with 9 decimals → "1500000000" (extra fraction digits are cut, not rounded). null = not a positive amount. */
export function toRaw(amount: string, decimals: number): string | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(String(amount ?? "").replace(/[,_\s$]/g, ""));
  if (!m || (!m[1] && !m[2])) return null;
  const v = BigInt((m[1] || "0") + (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0"));
  return v > 0n ? v.toString() : null;
}
/** Base units → a human amount with at most 6 fraction digits. */
export function toHuman(raw: string, decimals: number): string {
  const v = BigInt(raw); const d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return frac ? `${v / d}.${frac}` : (v / d).toString();
}

export interface RouteLeg { from: string; to: string; venues: { venue: string; pct: number | null }[] }
/** Jupiter's flat routePlan → legs (input → output mint) with the venue split of each (pure, tested). */
export function routeLegs(plan: any[], symbolOf: (mint: string) => string): RouteLeg[] {
  const legs = new Map<string, RouteLeg>();
  for (const step of Array.isArray(plan) ? plan : []) {
    const si = step?.swapInfo ?? {};
    const a = String(si.inputMint ?? ""), b = String(si.outputMint ?? "");
    if (!a || !b) continue;
    const key = `${a}>${b}`;
    const leg = legs.get(key) ?? { from: symbolOf(a), to: symbolOf(b), venues: [] };
    const pct = num(step?.percent) ?? (num(step?.bps) != null ? num(step.bps)! / 100 : null);
    leg.venues.push({ venue: clean(si.label, 40) || "Unknown venue", pct: r2(pct) });
    legs.set(key, leg);
  }
  return [...legs.values()];
}

/** Jupiter's quote + the two tokens (+ optional USD prices) → what the model reads (pure, tested). */
export function quoteSummary(q: any, a: SolToken, b: SolToken, prices: Record<string, number | null> = {}) {
  const amountIn = toHuman(String(q.inAmount), a.decimals), amountOut = toHuman(String(q.outAmount), b.decimals);
  const minReceived = q.otherAmountThreshold != null ? toHuman(String(q.otherAmountThreshold), b.decimals) : null;
  const inN = Number(BigInt(String(q.inAmount))) / 10 ** a.decimals, outN = Number(BigInt(String(q.outAmount))) / 10 ** b.decimals;
  const impactFrac = num(q.priceImpactPct);
  const symbols = new Map<string, string>([[SOL_MINT, "SOL"], [USDC_MINT, "USDC"], [USDT_MINT, "USDT"], [a.mint, a.symbol], [b.mint, b.symbol]]);
  const pIn = prices[a.mint] ?? null, pOut = prices[b.mint] ?? null;
  const valueIn = pIn != null ? inN * pIn : num(q.swapUsdValue);
  const valueOut = pOut != null ? outN * pOut : null;
  return {
    amountIn, tokenIn: a.symbol, amountOut, tokenOut: b.symbol, minReceived,
    rate: inN > 0 ? `1 ${a.symbol} = ${sig(outN / inN)} ${b.symbol}` : null,
    inverseRate: outN > 0 ? `1 ${b.symbol} = ${sig(inN / outN)} ${a.symbol}` : null,
    priceImpactPct: impactFrac == null ? null : Math.round(impactFrac * 100 * 1000) / 1000,
    slippageBps: num(q.slippageBps),
    route: routeLegs(q.routePlan, (m) => symbols.get(m) ?? short(m)),
    valueInUsd: valueIn != null && valueIn >= 1000 ? whole(valueIn) : r2(valueIn),
    valueOutUsd: valueOut != null && valueOut >= 1000 ? whole(valueOut) : r2(valueOut),
    outVsInValuePct: valueIn && valueOut != null && pIn != null ? r2((valueOut / valueIn - 1) * 100) : null,
  };
}

type Resolved = (({ token: SolToken } | { candidates: Candidate[] }) & { ageS?: number }) | null;
async function resolveSide(q: string): Promise<Resolved> {
  const s = q.trim().replace(/^\$/, "");
  const known = WELL_KNOWN[s.toLowerCase()];
  if (known) return { token: { mint: known.mint, symbol: known.symbol, decimals: known.decimals, verified: true, liquidityUsd: null } };
  const wk = Object.values(WELL_KNOWN).find((w) => w.mint === s);
  if (wk) return { token: { mint: wk.mint, symbol: wk.symbol, decimals: wk.decimals, verified: true, liquidityUsd: null } };
  const res = await jup<any[]>(`/tokens/v2/search?query=${encodeURIComponent(s)}`, 120);
  const hit = pickToken(s, Array.isArray(res.data) ? res.data : []);
  return hit ? { ...hit, ageS: res.ageS } : null;
}

async function solQuote(args: Record<string, any>): Promise<ExtToolResult> {
  const fromQ = clean(args.from, 60) || "USDC", toQ = clean(args.to, 60) || "USDC";
  if (fromQ.toLowerCase() === toQ.toLowerCase()) return bad("from and to are the same token: say what to swap into what.");
  const amount = String(args.amount ?? "").trim();
  if (!amount) return bad("amount is required: the human amount of the token paid, e.g. 1.5 for 1.5 SOL.");
  const slippageBps = Math.max(1, Math.min(1000, Math.round(Number(args.slippage_bps) || 50)));
  let a: Resolved, b: Resolved;
  try { [a, b] = await Promise.all([resolveSide(fromQ), resolveSide(toQ)]); } catch (e) { return fail(e); }
  for (const [side, q, r] of [["from", fromQ, a], ["to", toQ, b]] as const) {
    if (!r) return { data: { error: `No Solana token in Jupiter's index matches "${q.slice(0, 40)}" (${side}).`, note: "Say so; do not guess a mint. sol_tokens with mode search lists near matches." }, addresses: [], citations: [] };
    if ("candidates" in r) {
      return {
        data: { ambiguous: true, side, query: q.slice(0, 40), candidates: r.candidates, source: `${SOURCE} Tokens API`, note: `Several Solana tokens answer to "${q.slice(0, 40)}" and none is clearly the one meant. List them with their mints and ask which one; do not pick for the person.` },
        addresses: r.candidates.map((c) => c.mint), citations: [],
      };
    }
  }
  const ta = (a as { token: SolToken }).token, tb = (b as { token: SolToken }).token;
  if (ta.mint === tb.mint) return bad("Both sides resolve to the same token.");
  const raw = toRaw(amount, ta.decimals);
  if (!raw) return bad("Amount not understood: give a positive number of the token paid, e.g. 250 or 0.75.");
  const addrs = [ta.mint, tb.mint];
  let quote: { data: any; ageS: number };
  let prices: Record<string, number | null> = {};
  try {
    const [qr, pr] = await Promise.all([
      jup(`/swap/v1/quote?inputMint=${ta.mint}&outputMint=${tb.mint}&amount=${raw}&slippageBps=${slippageBps}`, 10, 60),
      jup<Record<string, any>>(`/price/v3?ids=${ta.mint},${tb.mint}`, 15, 300).catch(() => null),
    ]);
    quote = qr;
    if (pr?.data && typeof pr.data === "object") for (const m of addrs) prices[m] = num(pr.data[m]?.usdPrice);
  } catch (e) {
    if (e instanceof ExtError && e.status === 400) {
      return { data: { error: `Jupiter has no route from ${ta.symbol} to ${tb.symbol} for that amount right now (or one side is not tradable).`, note: "Say there is no route now; a smaller amount may route. Do not call sol_quote again for this pair in this answer." }, addresses: addrs, citations: [] };
    }
    return fail(e);
  }
  const q = quote.data;
  if (!q || !Array.isArray(q.routePlan) || !q.routePlan.length || !/^\d+$/.test(String(q.outAmount ?? "")) || String(q.outAmount) === "0") {
    return { data: { error: `Jupiter returned no usable route from ${ta.symbol} to ${tb.symbol}.`, note: "Say there is no route now; do not estimate." }, addresses: addrs, citations: [] };
  }
  const s = quoteSummary(q, ta, tb, prices);
  const ageS = Math.max(quote.ageS, a && "ageS" in a ? a.ageS ?? 0 : 0, b && "ageS" in b ? b.ageS ?? 0 : 0);
  const unverified = [ta, tb].filter((t) => t.verified === false).map((t) => t.symbol);
  const impact = s.priceImpactPct ?? 0;
  const data = {
    source: `${SOURCE} Swap API`, ...(quote.ageS ? { dataAgeS: quote.ageS } : {}),
    from: { symbol: ta.symbol, mint: ta.mint, verified: ta.verified }, to: { symbol: tb.symbol, mint: tb.mint, verified: tb.verified },
    ...s,
    note: [
      "Jupiter's live route, for analysis only: Chord does not trade on Solana, and the route moves every slot (about 0.4 s).",
      `minReceived = the least the route pays at ${slippageBps / 100}% slippage. priceImpactPct is Jupiter's estimate for this size; outVsInValuePct compares both sides at Jupiter's USD prices (fees and impact included).`,
      impact >= 5 ? `Price impact is ${impact}%: the pool is thin for this size; say so.` : null,
      unverified.length ? `${unverified.join(" and ")} ${unverified.length > 1 ? "are" : "is"} not verified by Jupiter: name the mint and say anyone can launch a token with that ticker.` : null,
      ageS > 20 ? `Served from a ${ageS}s old copy because Jupiter did not answer fresh; say the quote may be stale.` : null,
    ].filter(Boolean).join(" "),
  };
  const citations: Citation[] = [
    { label: `${ta.symbol} → ${tb.symbol} on Jupiter`, href: `https://jup.ag/swap/${ta.mint}-${tb.mint}` },
    ...[ta, tb].filter((t) => t.mint !== SOL_MINT && t.mint !== USDC_MINT && t.mint !== USDT_MINT).slice(0, 1).map((t) => ({ label: `${t.symbol} on Jupiter`, href: tokenPage(t.mint) })),
  ];
  const viz: Viz[] = [{
    kind: "table", title: `${s.amountIn} ${ta.symbol} → ${tb.symbol} on Jupiter · route`,
    columns: ["Leg", "Venue", "Share"],
    rows: s.route.flatMap((l) => l.venues.map((v) => [`${l.from} → ${l.to}`, v.venue, v.pct == null ? null : `${v.pct}%`])).slice(0, 20),
    align: ["l", "l", "r"],
  }];
  return { data, addresses: addrs, citations, viz };
}

// ── Jupiter Lend ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Base units (a decimal string) → a float in whole tokens; null when unreadable. */
const units = (raw: unknown, decimals: number | null): number | null => {
  if (decimals == null || !/^\d+$/.test(String(raw ?? ""))) return null;
  return Number(BigInt(String(raw))) / 10 ** decimals;
};
/** Jupiter Lend rates come "in 1e4 decimals": 348 → 3.48 %. */
const ratePct = (v: unknown): number | null => { const n = num(v); return n == null ? null : r2(n / 100); };

export interface LendRow {
  asset: string; mint: string; jlToken: string; supplyApyPct: number | null; rewardsApyPct: number | null; totalApyPct: number | null;
  suppliedUsd: number | null; supplied: number | null; withdrawableNowUsd: number | null; priceUsd: number | null;
  borrowRatePct?: number | null; vaultBorrowRangePct?: [number, number]; borrowableInVaults?: number; borrowAgainst?: string[];
}

/** /earn/tokens (+ /borrow/vaults when it answered) → one row per asset, largest first (pure, tested). */
export function lendRows(earn: any[], vaults: any[] | null): LendRow[] {
  const borrow = new Map<string, { base: number | null; rates: number[]; n: number; against: string[] }>();
  for (const v of Array.isArray(vaults) ? vaults : []) {
    const m = String(v?.borrowToken?.address ?? "");
    if (!m) continue;
    const cur = borrow.get(m) ?? { base: ratePct(v.borrowRateLiquidity), rates: [], n: 0, against: [] };
    const r = ratePct(v.borrowRate);
    if (r != null) cur.rates.push(r);
    cur.n++;
    const coll = clean(v?.supplyToken?.uiSymbol ?? v?.supplyToken?.symbol, 16);
    if (coll && !cur.against.includes(coll)) cur.against.push(coll);
    borrow.set(m, cur);
  }
  const rows: LendRow[] = [];
  for (const t of Array.isArray(earn) ? earn : []) {
    const asset = t?.asset ?? {};
    const mint = String(asset.address ?? t?.assetAddress ?? "");
    if (!mint) continue;
    const dec = num(asset.decimals) ?? num(t?.decimals);
    const price = num(asset.price);
    const supplied = units(t?.totalAssets, dec);
    const withdrawable = units(t?.liquiditySupplyData?.withdrawable, dec);
    const supply = ratePct(t?.supplyRate), rewards = ratePct(t?.rewardsRate);
    const total = ratePct(t?.totalRate) ?? (supply != null ? r2(supply + (rewards ?? 0)) : null);
    const b = borrow.get(mint);
    const lo = b?.rates.length ? Math.min(...b.rates) : null, hi = b?.rates.length ? Math.max(...b.rates) : null;
    rows.push({
      asset: clean(asset.uiSymbol ?? asset.symbol, 16) || short(mint), mint, jlToken: clean(t?.symbol, 16),
      supplyApyPct: supply, rewardsApyPct: rewards, totalApyPct: total,
      suppliedUsd: supplied != null && price != null ? whole(supplied * price) : null, supplied: whole(supplied),
      withdrawableNowUsd: withdrawable != null && price != null ? whole(withdrawable * price) : null, priceUsd: sig(price),
      ...(b ? {
        borrowRatePct: b.base, borrowableInVaults: b.n, borrowAgainst: b.against.slice(0, 8),
        ...(lo != null && hi != null && lo !== hi ? { vaultBorrowRangePct: [lo, hi] as [number, number] } : {}),
      } : {}),
    });
  }
  return rows.sort((x, y) => (y.suppliedUsd ?? 0) - (x.suppliedUsd ?? 0));
}

const assetMatches = (r: LendRow, q: string): boolean => {
  const s = norm(q);
  if (!s) return true;
  const alias = s === "sol" ? "wsol" : s === "wsol" ? "sol" : s;
  return r.mint === q.trim() || [r.asset, r.jlToken].some((x) => { const n = norm(x); return n === s || n === alias || n === `jl${s}`; });
};

async function solLendRates(args: Record<string, any>): Promise<ExtToolResult> {
  const q = clean(args.asset, 60).replace(/^\$/, "");
  let earn: { data: any[]; ageS: number };
  let vaults: { data: any[]; ageS: number } | null = null;
  try {
    [earn, vaults] = await Promise.all([jup<any[]>("/lend/v1/earn/tokens", 300), jup<any[]>("/lend/v1/borrow/vaults", 300).catch(() => null)]);
  } catch (e) { return fail(e); }
  const all = lendRows(earn.data, vaults?.data ?? null);
  const rows = all.filter((r) => assetMatches(r, q));
  if (!rows.length) {
    return { data: { found: false, asset: q, available: all.map((r) => r.asset), source: `${SOURCE} Lend API`, note: `Jupiter Lend has no earn market for "${q.slice(0, 30)}". Name the assets it does have.` }, addresses: [], citations: [{ label: "Jupiter Lend", href: "https://jup.ag/lend/earn" }] };
  }
  const ageS = Math.max(earn.ageS, vaults?.ageS ?? 0);
  const data = {
    source: `${SOURCE} Lend API`, ...(ageS ? { dataAgeS: ageS } : {}), ...(q ? { asset: q } : {}), rows,
    note: [
      "Jupiter Lend's current annual rates; they move with utilization, so quote them as of now. totalApyPct = supply + rewards.",
      "withdrawableNowUsd = what can leave the pool at once under Jupiter's withdrawal limit (the limit expands over time), not all of the supply.",
      vaults ? "borrowRatePct = the asset's base borrow rate; each vault adds its own spread (vaultBorrowRangePct); borrowAgainst = collateral those vaults accept." : "Borrow rates were not available just now; say so if asked.",
      "Jupiter does not publish utilization here: do not compute one.",
    ].join(" "),
  };
  const viz: Viz[] = [{
    kind: "table", title: "Jupiter Lend · earn rates",
    columns: ["Asset", "Supply APY", "Rewards", "Total APY", "Supplied", "Withdrawable now", "Borrow rate"],
    rows: rows.map((r) => [r.asset, pctCell(r.supplyApyPct), pctCell(r.rewardsApyPct), pctCell(r.totalApyPct), usdCell(r.suppliedUsd), usdCell(r.withdrawableNowUsd), r.borrowRatePct == null ? null : `${r.borrowRatePct}%`]),
    align: ["l", "r", "r", "r", "r", "r", "r"],
  }];
  const citations: Citation[] = [{ label: "Jupiter Lend · Earn", href: "https://jup.ag/lend/earn" }, ...(vaults ? [{ label: "Jupiter Lend · Borrow", href: "https://jup.ag/lend/borrow" }] : [])];
  return { data, addresses: rows.map((r) => r.mint), citations, viz };
}

// ── results / dispatch ───────────────────────────────────────────────────────────────────────────────────────────────
const bad = (error: string): ExtToolResult => ({ data: { error, note: "Fix the arguments or ask the person; do not guess." }, addresses: [], citations: [] });
const fail = (e: unknown): ExtToolResult => ({ data: extFailure(SOURCE, e), addresses: [], citations: [] });

export const SOLANA_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "sol_tokens",
      description: "Solana tokens from Jupiter's token index. mode search finds one token by symbol, name or mint (verified first, look-alikes sharing the ticker shown); the boards list trending, top_traded, top_organic (most trading by real wallets), recent (pools created minutes ago, mostly pump.fun), verified (most traded Jupiter-verified tokens) and lst (liquid staking SOL tokens). Each row: price, market cap, liquidity, holders, organic score, 24h change, 24h buy vs sell volume, traders, Jupiter verified flag, mint / freeze authority and the top holders' share of supply. Use for 'what is trending on Solana', 'top Solana memes today', 'is $XYZ on Solana legit', 'new pump.fun launches', 'best SOL liquid staking tokens', 'find the BONK mint'.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["search", "trending", "top_traded", "top_organic", "recent", "verified", "lst"], description: "default search when a query is given, else trending" },
          query: { type: "string", description: "search: a symbol, name or mint address" },
          interval: { type: "string", enum: ["5m", "1h", "6h", "24h"], description: "board window; default 1h for trending, 24h otherwise" },
          limit: { type: "integer", description: "search 1..10 (default 5), boards 1..25 (default 12)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sol_quote",
      description: "What an amount of one Solana token buys of another on Jupiter right now (its live route across Solana DEXs): amount out, the minimum received at the slippage, the effective rate both ways, price impact, the route legs with each venue's share, and both sides in USD. A ticker resolves through Jupiter's token list (verified first; an ambiguous ticker returns candidates to ask about); a mint is used as given. Analysis only: Chord does not trade on Solana. Use for 'how much USDC for 10 SOL', 'price impact of selling 50M BONK', 'best route SOL to JUP', 'what does $5k of WIF buy'.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "token paid: symbol or mint, default USDC" },
          to: { type: "string", description: "token received: symbol or mint, default USDC" },
          amount: { type: "string", description: "human amount of `from`, e.g. 10 for 10 SOL" },
          slippage_bps: { type: "integer", description: "1..1000, default 50 (0.5%)" },
        },
        required: ["amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sol_lend_rates",
      description: "Jupiter Lend (Solana) earn rates per asset: supply APY with rewards split out, total supplied in USD, what can be withdrawn right now, and the asset's borrow rate (base, the range across vaults and the collateral it can be borrowed against). Use for 'Jupiter Lend USDC rate', 'best stablecoin yield on Jupiter', 'borrow rate for SOL on Jupiter Lend', 'jlUSDC APY'.",
      parameters: { type: "object", properties: { asset: { type: "string", description: "optional filter: USDC, USDT, SOL, EURC … or a mint" } }, required: [] },
    },
  },
];

export const SOLANA_TOOL_META: Record<string, ToolMeta> = {
  sol_tokens: { group: "solana", label: "Reading Solana tokens on Jupiter", market: true, untrusted: true, timeoutMs: 15_000 },
  sol_quote: { group: "solana", label: "Asking Jupiter for a Solana route", dyor: true, timeoutMs: 20_000 },
  sol_lend_rates: { group: "solana", label: "Reading Jupiter Lend rates", market: true, timeoutMs: 15_000 },
};

export const SOLANA_TOOL_NAMES = ["sol_tokens", "sol_quote", "sol_lend_rates"] as const;
export const isSolanaTool = (name: string): boolean => (SOLANA_TOOL_NAMES as readonly string[]).includes(name);

/** Runs one sol_* tool. Never throws: bad input and source failures come back as `{ error, note }`. */
export async function runSolanaTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  try {
    switch (name) {
      case "sol_tokens": return await solTokens(args ?? {});
      case "sol_quote": return await solQuote(args ?? {});
      case "sol_lend_rates": return await solLendRates(args ?? {});
      default: return bad(`unknown tool ${name}`);
    }
  } catch (e) {
    return fail(e);
  }
}
