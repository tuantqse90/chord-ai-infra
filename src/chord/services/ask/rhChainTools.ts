// Chord Ask's chain-index tools, ported from Chord (2026-10-06) and rebuilt on Chord's PUBLIC REST API (api.getchord.xyz/v1,
// through services/chordApi.ts) instead of Chord's Postgres / Redis / Solana box:
//   monad   monad_tokens · monad_token · monad_token_trades · monad_token_traders · monad_wallet_pnl · monad_top_wallets
//   rh      rh_stocks · rh_tokens · rh_token · rh_token_trades · rh_wallet_pnl · rh_overview · rh_venues · rh_search ·
//           rh_token_flow · rh_candles · rh_wallet_trades · rh_wallet_pnl_calendar · rh_top_wallets · rh_compare · rh_holders
//   chains  chain_overview · chain_tokens · chain_token · chain_token_trades · chain_wallet          (Avalanche / Base / BNB)
//   solana  sol_tape_market · sol_tape_token · sol_tape_trades · sol_tape_wallet                     (Chord's own Solana tape)
// Sources: Chord's askAgent.ts `runTool` cases (monad_* / rh_*), services/ask/chainTools.ts and services/ask/solTapeTools.ts.
// Output fields, notes, citations, addresses and viz are Chord's; only the data access changed, and every change is marked
// `// ask2049:`. Route per tool:
//   monad_tokens        /v1/tokens?chain=143 + /v1/tokens/market?chain=143
//   monad_token         /v1/tokens?chain=143 (+ /v1/tokens/search) · /v1/tokens/stats/:a · /v1/tokens/market · /v1/candles?chain=143
//   monad_token_trades  /v1/tokens/trades/:a?side=&min=&limit=
//   monad_token_traders /v1/tokens/traders/:a?window=&limit=          (Monad-listed tokens only — the route's guard)
//   monad_wallet_pnl    /v1/portfolio/:w/pnl?chain=143
//   monad_top_wallets   /v1/smart-money/top?source=onchain&chain=143
//   rh_stocks           /v1/rh/stocks                    rh_tokens   /v1/rh/tokens?limit=200&sort=
//   rh_token            /v1/tokens?chain=4663 · /v1/tokens/stats/:a · /v1/rh/token/:a?hours=168 · /v1/rh/stocks · /v1/candles?chain=4663
//   rh_token_trades     /v1/tokens/trades/:a             rh_wallet_pnl  /v1/portfolio/:w/pnl?chain=4663
//   rh_overview         /v1/rh/overview                  rh_venues      /v1/rh/venues?days=
//   rh_search           /v1/tokens?chain=4663 · /v1/rh/tokens?includeUnlisted=1 · /v1/tokens/search?chain=4663
//   rh_token_flow       /v1/tokens/stats/:a              rh_candles     /v1/candles?chain=4663&tf=
//   rh_wallet_trades    /v1/tokens/trades/:a?wallet= or /v1/portfolio/:w/trades?chain=4663
//   rh_wallet_pnl_calendar /v1/portfolio/:w/pnl-calendar?chain=4663
//   rh_top_wallets      /v1/smart-money/top?source=onchain&chain=4663   rh_compare  /v1/rh/tokens + /v1/rh/stocks
//   rh_holders          /v1/rh/token/:a/holders
//   chain_*             /v1/chains/:chain/{overview,tokens,token/:a,token/:a/trades,wallet/:w} + /v1/tokens?chain=
//   sol_tape_*          /v1/chains/solana/{overview,tokens,traders,search,token/:m,token/:m/trades,token/:m/candles,
//                       token/:m/traders,wallet/:w,wallet/:w/trades}  (public for anonymous callers since 2026-10-04)
// Not ported (no public route serves what the case reads, or a write / trade): rh_quote and chain_quote (buying — this app
// has its own swap tool), rh_token_traders (/v1/tokens/traders is guarded to the Monad list), rh_price_analysis (computed
// in-process from Chord's tape), rh_wallet_profile (Chord's bot set + 500-deep board rank are not public), rh_largest_trades
// (no chain-wide Robinhood prints route; /v1/smart-money/whales is Monad router flow), rh_tx (no swaps-by-hash route; this
// app's chain_tx reads any tx from the chain). Chord's side panels (`artifact` / `walletArtifact`) are not part of an
// ExtToolResult and are left out. Solana mints and wallets are case-sensitive: never lower-cased on this path.
import { config } from "../../../config";
import { ChordApiNotFound, chordGet, chordMarketMap, chordTokenList, type ChordListToken } from "../chordApi";
import { chainMeta, type ChainMeta } from "../../shared";
import type { AssetChip, Citation, Viz } from "../askAgent";
import { extFailure, type ExtToolResult } from "./extHttp";
import type { ToolMeta } from "./registry";
import { SOL_MINT, USDC_MINT, USDT_MINT, clean, solAskHref, solscanToken } from "./solanaTools";

// ── Chord public API reads ─────────────────────────────────────────────────────────────────────────────────────────

/** A public route answered an error (status + Chord's {error, message}), or did not answer (status 0). */
export class ChordReadError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message); }
}
const UA = "Mozilla/5.0 (compatible; ask2049)"; // = services/chordApi.ts (Cloudflare blocks bare clients)

/** One uncached GET that keeps the status and Chord's error body — only called after chordGet failed, to say why. */
async function chordStatus(path: string, timeoutMs: number): Promise<{ status: number; body: any }> {
  const base = config.chordApi() || "https://api.getchord.xyz";
  try {
    const r = await fetch(`${base}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
    let body: any = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/** chordGet (cached, last-good served on a failure) with this family's TTLs; a failure is re-read once for its status and
 *  error body so the tool can say "not served" / "still building" instead of a bare failure. A 404 stays ChordApiNotFound. */
async function read<T>(path: string, ttlMs: number, timeoutMs = 8_000): Promise<T> {
  try {
    return await chordGet<T>(path, ttlMs, timeoutMs);
  } catch (e) {
    if (e instanceof ChordApiNotFound) throw e;
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ChordReadError(0, "TIMEOUT", `Chord API ${path.split("?")[0]} did not answer in time`);
    const s = await chordStatus(path, timeoutMs);
    if (s.status >= 200 && s.status < 300 && s.body != null) return s.body as T;
    if (s.status === 404) throw new ChordApiNotFound(`Chord API ${path.split("?")[0]}: not found`);
    const code = typeof s.body?.error === "string" ? s.body.error : null;
    const msg = typeof s.body?.message === "string" ? s.body.message.slice(0, 200) : `Chord API ${path.split("?")[0]} did not answer${s.status ? ` (${s.status})` : ""}`;
    throw new ChordReadError(s.status, code, msg);
  }
}
const enc = encodeURIComponent;
const qs = (p: Record<string, string | number | undefined | null>) => {
  const parts = Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

// Shapes of the public answers (the fields these tools read), from Chord's services (rhRollup, analyticsDb, portfolioHistory,
// smartMoney, rhHolders, chainRollup, chainWallet) and schemas/sol.ts.
interface RhTokenRow {
  address: string; symbol: string | null; name: string | null; decimals: number | null; logoURI: string | null; tags: string[]; listed: boolean;
  priceUsd: number | null; change24hPct: number | null; liquidityUsd: number | null;
  volume24h: number; buyVolume24h: number; sellVolume24h: number; trades24h: number; buys24h: number; sells24h: number; traders: number; lastTradeTs: number;
}
interface RhStockRow extends RhTokenRow { navUsd: number | null; basisPct: number | null; offHours7d: { volUsd: number; sharePct: number | null; trades: number } }
interface RhOverview {
  last24h: { volUsd: number; swaps: number; tokens: number };
  venues24h: { dex: string; volUsd: number; trades: number; sharePct: number }[];
  daily: { day: number; swaps: number; volUsd: number; tokens: number; wallets: number }[];
  coverage: { stale: boolean };
}
interface RhVenues { days: number; venues: { dex: string; volUsd: number; trades: number; sharePct: number }[]; totals: { volUsd: number; trades: number } }
interface RhTokenHourly { series: { hour: number; volUsd: number }[]; byDex: { dex: string; volUsd: number; sharePct: number }[] }
interface WindowStats { change: number | null; txns: number; buys: number; sells: number; buyVol: number; sellVol: number; makers: number; buyers: number; sellers: number }
interface TokenStats {
  priceUsd: number | null; windows: { m5: WindowStats; h1: WindowStats; h6: WindowStats; h24: WindowStats }; liquidityUsd: number | null;
  ath: { priceUsd: number; ts: number } | null; range24h: { high: number; low: number } | null; firstTradeTs: number | null; totalTxns: number;
}
interface DexTradeRow { tx: string; dex: string; token: string; side: "buy" | "sell"; tokenAmt: number; usd: number; priceUsd: number; ts: number; wallet?: string | null }
interface TradesPage { trades: DexTradeRow[]; total: number; stats24h: { buys: number; sells: number; buyUsd: number; sellUsd: number } }
interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
interface TokenPnl { token: string; symbol: string; realizedUsd: number; unrealizedUsd: number; totalUsd: number; curValue: number; roiPct: number | null; stillHoldsUsd?: number; currentValueUsd?: number }
interface WalletPnl { tokens: TokenPnl[]; realized: number; unrealized: number; total: number; exitedWithoutSale?: { tokens: number; costUsd: number; top: { symbol: string; costUsd: number }[] } }
interface PfTrade { t: number; side: "buy" | "sell"; usd: number; tokenAmt: number; token: string; symbol: string; tx: string }
interface PnlCalendar { days: { date: string; realizedUsd: number; trades: number }[]; firstDate: string | null; realizedTotal: number }
interface SmWallet { wallet: string; pnlUsd: number; realizedUsd: number; volumeUsd: number; trades: number; winRate: number; archetype: string; topToken?: { symbol: string } }
interface TraderRow { wallet: string; pnlUsd: number; realizedUsd: number; unrealizedUsd: number; boughtUsd: number; buys: number; soldUsd: number; sells: number; remainingAmt: number; lastTs: number }
interface RhHolders {
  holders: number; complete: boolean; coverage: { backfillPct: number | null }; heldByWalletsPct: number | null;
  concentration: Record<string, number> | null; top: { holder: string; sharePct: number | null; amount: number | null; kind: string }[];
}
type MonadToken = ChordListToken & { verified?: boolean; liquidityUsd?: number };

const RH = 4663;
const USDG_RH = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });
const r2 = (n: number) => Math.round(n * 100) / 100;
// ask2049: Chord's askAgent `sig` takes a number; null-safe here (rows from a public answer may carry null).
const sig = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(5)));
const minsAgo = (ts: number) => Math.round((Date.now() / 1000 - ts) / 60);
const walletCite = (w: string): Citation => ({ label: `Wallet ${w.slice(0, 6)}…${w.slice(-4)}`, href: `/portfolio?address=${w}` });
const monadCite = (t: { address: string; symbol: string }): Citation => ({ label: `${t.symbol} on Monad`, href: `/token/${t.address}` });
const rhCite = (t: { address: string; symbol: string }): Citation => ({ label: `${t.symbol} on Robinhood Chain`, href: `/ask/trade/${t.address.toLowerCase()}` });
const cleanStockName = (n: string | null | undefined) => (n ?? "").replace(/\s*•\s*Robinhood Token$/i, "").trim();
const none: ExtToolResult = { data: null, addresses: [], citations: [] };
// ask2049: Chord's portfolio routes answer an EMPTY payload (never an error) when the compute fails, so "nothing" here can
// mean "no swaps" or "the index did not answer" — the model must not present it as a $0 result.
const EMPTY_WALLET_NOTE = "Chord's index returned nothing for this wallet: either it has no swaps on Chord's tape for this chain, or the index did not answer just now. Say no data was found; do not report $0 as the wallet's result.";

// Readers (TTL ≈ the route's own cache).
const monadList = () => chordTokenList(143) as Promise<MonadToken[]>;
const rhList = () => chordTokenList(RH);
const rhStocks = () => read<{ stocks: RhStockRow[] }>("/v1/rh/stocks", 60_000);
/** ask2049: Chord reads its 24h board 2,000 rows deep (listed + unlisted memes); the public /v1/rh/tokens caps at 200 rows,
 *  so an unlisted meme past the 200 busiest is not on this board (resolveRhAny falls back to /v1/tokens/search for it). */
const rhBoard = () => read<{ tokens: RhTokenRow[] }>("/v1/rh/tokens?limit=200&sort=volume&includeUnlisted=1", 60_000);
const tokenStats = (a: string) => read<TokenStats>(`/v1/tokens/stats/${a.toLowerCase()}`, 30_000, 15_000);
const candles = async (chain: number, a: string, tf: string, limit: number): Promise<Candle[]> =>
  (await read<{ candles?: Candle[] }>(`/v1/candles${qs({ chain, token: a.toLowerCase(), tf, limit })}`, 30_000)).candles ?? [];
const tradesPage = (a: string, p: { side?: string; min?: number; wallet?: string; limit: number }) =>
  read<TradesPage>(`/v1/tokens/trades/${a.toLowerCase()}${qs({ side: p.side, min: p.min || undefined, wallet: p.wallet, limit: p.limit })}`, 10_000, 15_000);
const walletPnl = (w: string, chain: number) => read<WalletPnl>(`/v1/portfolio/${w.toLowerCase()}/pnl?chain=${chain}`, 60_000, 25_000);
const topWallets = (window: string, chain: number, limit: number) =>
  read<{ wallets: SmWallet[] }>(`/v1/smart-money/top?window=${window}&source=onchain&chain=${chain}&limit=${limit}`, 60_000, 15_000);

/** Symbol / name / address → one token of the Robinhood listed set (stocks, USDG, WETH …). Exact symbol wins, then a name match. */
async function resolveRhToken(q: string): Promise<ChordListToken | null> {
  const s = q.trim();
  if (!s) return null;
  const list = await rhList();
  const byAddr = list.find((t) => t.address.toLowerCase() === s.toLowerCase());
  if (byAddr) return byAddr;
  const sym = s.toLowerCase().replace(/^\$/, "");
  const bySym = list.find((t) => t.symbol.toLowerCase() === sym);
  if (bySym) return bySym;
  const byName = list.filter((t) => cleanStockName(t.name).toLowerCase().includes(sym));
  return byName.length === 1 ? byName[0]! : byName.find((t) => t.tags?.includes("stock")) ?? null;
}
type RhAny = { address: string; symbol: string; name: string | null; decimals: number | null; logoURI: string | null; tags: string[] };
/** A listed Robinhood token, or an unlisted meme that traded in the last 24h (exact symbol / address). */
async function resolveRhAny(q: string): Promise<RhAny | null> {
  const t = await resolveRhToken(q);
  if (t) return { address: t.address.toLowerCase(), symbol: t.symbol, name: cleanStockName(t.name) || null, decimals: t.decimals, logoURI: t.logoURI ?? null, tags: t.tags ?? [] };
  // Chord's askChains.resolveRh: unlisted but traded — exact address or symbol on the 24h board, busiest first.
  const s = q.trim().toLowerCase().replace(/^\$/, "");
  if (!s) return null;
  const board = (await rhBoard().catch(() => null))?.tokens ?? [];
  const hits = board.filter((b) => b.address.toLowerCase() === s || (b.symbol ?? "").toLowerCase() === s).sort((x, y) => y.volume24h - x.volume24h);
  const b = hits[0];
  if (b) return { address: b.address.toLowerCase(), symbol: b.symbol ?? b.address.slice(0, 8), name: b.name, decimals: b.decimals, logoURI: b.logoURI, tags: b.tags ?? [] };
  // ask2049: past the 200-row public board — /v1/tokens/search?chain=4663 searches Chord's full 24h board (unlisted = verified false).
  const found = await read<{ tokens?: { address: string; symbol: string; name?: string; decimals?: number | null; logoURI?: string | null; tags?: string[] }[] }>(
    `/v1/tokens/search?q=${enc(s.slice(0, 64))}&chain=${RH}&limit=8`, 60_000).catch(() => null);
  const x = (found?.tokens ?? []).find((r) => r.address.toLowerCase() === s || r.symbol.toLowerCase() === s);
  return x ? { address: x.address.toLowerCase(), symbol: x.symbol, name: x.name ?? null, decimals: x.decimals ?? null, logoURI: x.logoURI ?? null, tags: x.tags ?? [] } : null;
}
/** Robinhood 24h board row (listed + unlisted memes), by address. */
async function rhRowOf(address: string): Promise<RhTokenRow | null> {
  const r = await rhBoard().catch(() => null);
  return r?.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? null;
}
/** Monad symbol/address → registry token (exact symbol first, then the registry's own search). */
async function resolveMonadToken(q: string): Promise<MonadToken | null> {
  const s = q.trim();
  if (!s) return null;
  const list = await monadList();
  const byAddr = list.find((t) => t.address.toLowerCase() === s.toLowerCase());
  if (byAddr) return byAddr;
  const bySym = list.filter((t) => t.symbol.toLowerCase() === s.toLowerCase());
  if (bySym.length) return bySym.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0]!;
  // Chord's tokenRegistry.searchTokens (off-list discovery) = GET /v1/tokens/search?q= (no chain).
  const hits = await read<{ tokens?: MonadToken[] }>(`/v1/tokens/search?q=${enc(s.slice(0, 64))}`, 60_000).then((r) => r.tokens ?? []).catch(() => [] as MonadToken[]);
  return hits[0] ?? null;
}
const notFoundToNull = <T>(e: unknown): T | null => { if (e instanceof ChordApiNotFound) return null; throw e; };

// ── Monad + Robinhood Chain (Chord's askAgent.ts runTool cases) ─────────────────────────────────────────────────────

async function runMonadRh(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  switch (name) {
    // ── Monad ──
    case "monad_tokens": {
      const [list, map] = await Promise.all([monadList(), chordMarketMap(143)]);
      const q = String(args.query ?? "").trim().toLowerCase();
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
      const rows = list
        .filter((t) => !q || t.symbol.toLowerCase().includes(q) || (t.name ?? "").toLowerCase().includes(q) || t.address.toLowerCase() === q)
        .map((t) => { const m = map[t.address.toLowerCase()] ?? {}; return { symbol: t.symbol, name: t.name, address: t.address, priceUsd: m.priceUsd ?? null, change24hPct: m.change24h ?? null, volume24hUsd: Math.round(m.volume24h ?? 0), tags: t.tags ?? [], verified: !!t.verified }; })
        .filter((r) => r.priceUsd != null)
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
        .slice(0, limit);
      return { ...none, data: { chain: 143, tokens: rows }, addresses: rows.map((r) => r.address), citations: [{ label: "Monad markets", href: "https://nullterminal.xyz/tokens" }], viz: [vTable(`Monad · by 24h volume`, ["Token", "Price", "24h", "Volume"], rows.map((r) => [r.symbol, r.priceUsd, r.change24hPct == null ? null : +r.change24hPct.toFixed(1), r.volume24hUsd]), ["l", "r", "r", "r"])] };
    }
    case "monad_token": {
      const t = await resolveMonadToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No token on Monad matches that. Say so; do not guess an address." } };
      // ask2049: Chord's getDbChart → GET /v1/candles (the same index-only candle builder), last 24 hourly candles.
      const [st, c1h] = await Promise.all([tokenStats(t.address).catch(() => null), candles(143, t.address, "1h", 24).catch(() => [] as Candle[])]);
      const m = (await chordMarketMap(143))[t.address.toLowerCase()] ?? {};
      return {
        ...none,
        data: { found: true, chain: 143, token: { symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, tags: t.tags ?? [], verified: !!t.verified }, priceUsd: st?.priceUsd ?? m.priceUsd ?? null, change24hPct: m.change24h ?? st?.windows.h24.change ?? null, volume24hUsd: Math.round(m.volume24h ?? 0), windows: st?.windows ?? null, liquidityUsd: st?.liquidityUsd ?? null, ath: st?.ath ?? null, range24h: st?.range24h ?? null, firstTradeMinutesAgo: st?.firstTradeTs ? minsAgo(st.firstTradeTs) : null, totalTxns: st?.totalTxns ?? 0, last24hHourly: c1h.slice(-24).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: Math.round(c.v) })) },
        addresses: [t.address],
        citations: [monadCite(t)],
        viz: c1h.length > 2 ? [{ kind: "line", title: `${t.symbol} · 1h close`, x: c1h.slice(-24).map((c) => new Date(c.t * 1000).toISOString().slice(11, 16)), series: [{ name: "Close", values: c1h.slice(-24).map((c) => c.c) }], unit: "price", chart: { chain: 143, address: t.address, tf: "1h" } }] : [],
      };
    }
    case "monad_token_trades": {
      const t = await resolveMonadToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No token on Monad matches that." } };
      const side = args.side === "buy" || args.side === "sell" ? args.side : undefined;
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const page = await tradesPage(t.address, { side, min: Math.max(0, Number(args.min_usd) || 0), limit });
      const trades = page.trades.map((r) => ({ side: r.side, usd: Math.round(r.usd), tokens: Math.round(r.tokenAmt), priceUsd: r.priceUsd, wallet: r.wallet ?? null, dex: r.dex, minutesAgo: minsAgo(r.ts), tx: r.tx }));
      return { ...none, data: { chain: 143, token: t.symbol, stats24h: page.stats24h, trades }, addresses: [t.address, ...trades.map((x) => x.wallet).filter((w): w is string => !!w)], citations: [monadCite(t)], viz: [vTable(`${t.symbol} · recent prints`, ["Side", "USD", "Tokens", "Price", "Wallet", "Ago"], trades.map((x) => [x.side, x.usd, x.tokens, x.priceUsd, x.wallet ? shortAddr(x.wallet) : "—", `${x.minutesAgo}m`]), ["l", "r", "r", "r", "l", "r"])] };
    }
    case "monad_token_traders": {
      const t = await resolveMonadToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No token on Monad matches that." } };
      const window = (["24h", "7d", "all"] as const).includes(args.window) ? String(args.window) : "7d";
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
      const price = (await chordMarketMap(143))[t.address.toLowerCase()]?.priceUsd ?? (await tokenStats(t.address).catch(() => null))?.priceUsd ?? 0;
      // ask2049: Chord's getTokenTopTraders → GET /v1/tokens/traders/:a, which prices at the market map (else the last trade)
      // and answers only for tokens on the Monad list.
      const r = await read<{ traders: TraderRow[] }>(`/v1/tokens/traders/${t.address.toLowerCase()}?window=${window}&limit=${limit}`, 60_000, 15_000).catch((e) => notFoundToNull<{ traders: TraderRow[] }>(e));
      if (!r) return { ...none, data: { found: false, token: t.symbol, note: "Chord ranks traders only for tokens on its Monad list, and this token is not on it. Say the trader ranking is not available for it." }, addresses: [t.address], citations: [monadCite(t)] };
      const rows = r.traders.slice(0, limit);
      const data = rows.map((r, i) => ({ rank: i + 1, wallet: r.wallet, pnlUsd: Math.round(r.pnlUsd), realizedUsd: Math.round(r.realizedUsd), unrealizedUsd: Math.round(r.unrealizedUsd), boughtUsd: Math.round(r.boughtUsd), buys: r.buys, soldUsd: Math.round(r.soldUsd), sells: r.sells, stillHolding: r.remainingAmt > 0, lastTradeMinutesAgo: minsAgo(r.lastTs) }));
      return { ...none, data: { chain: 143, token: t.symbol, window, priceUsedUsd: price, traders: data, note: "PnL at the current price; realized = sold − cost of the sold part." }, addresses: [t.address, ...rows.map((r) => r.wallet)], citations: [monadCite(t)], viz: [vTable(`${t.symbol} · top traders by PnL · ${window}`, ["#", "Wallet", "PnL", "Realized", "Bought", "Sold", "Holds"], data.map((r) => [r.rank, shortAddr(r.wallet), r.pnlUsd, r.realizedUsd, r.boughtUsd, r.soldUsd, r.stillHolding ? "yes" : "no"]), ["r", "l", "r", "r", "r", "r", "l"])] };
    }
    case "monad_wallet_pnl": {
      const w = String(args.wallet ?? "").toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const p = await walletPnl(w, 143);
      const rows = [...p.tokens].sort((a, b) => Math.abs(b.totalUsd) - Math.abs(a.totalUsd)).slice(0, 15);
      const empty = !p.tokens.length && !p.realized; // ask2049: see EMPTY_WALLET_NOTE
      return { ...none, data: { chain: 143, wallet: w, realizedUsd: Math.round(p.realized), unrealizedUsd: Math.round(p.unrealized), totalUsd: Math.round(p.total), tokens: rows.map((t) => ({ symbol: t.symbol, token: t.token, realizedUsd: Math.round(t.realizedUsd), unrealizedUsd: Math.round(t.unrealizedUsd), totalUsd: Math.round(t.totalUsd), stillHoldsUsd: Math.round(t.curValue), roiPct: t.roiPct == null ? null : +t.roiPct.toFixed(1) })), note: `Average-cost PnL from swaps in the tape; tokens that arrived by transfer have no cost basis.${empty ? ` ${EMPTY_WALLET_NOTE}` : ""}` }, addresses: [w, ...rows.map((t) => t.token)], citations: [walletCite(w)], viz: [vTable(`${shortAddr(w)} · Monad PnL by token`, ["Token", "Realized", "Unrealized", "Total", "Still holds", "ROI"], rows.map((t) => [t.symbol, Math.round(t.realizedUsd), Math.round(t.unrealizedUsd), Math.round(t.totalUsd), Math.round(t.curValue), t.roiPct == null ? null : +t.roiPct.toFixed(0)]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "monad_top_wallets": {
      const window = (["24h", "7d", "30d"] as const).includes(args.window) ? String(args.window) : "7d";
      const limit = Math.max(1, Math.min(15, Number(args.limit) || 8));
      // ask2049: Chord's getAllMonadLeaderboard + scoreAndRank(…, "all", limit) = GET /v1/smart-money/top (same ranking).
      const ranked = (await topWallets(window, 143, limit)).wallets.slice(0, limit);
      return {
        ...none,
        data: { chain: 143, wallets: ranked.map((w, i) => ({ rank: i + 1, wallet: w.wallet, pnlUsd: Math.round(w.pnlUsd), realizedUsd: Math.round(w.realizedUsd), volumeUsd: Math.round(w.volumeUsd), trades: w.trades, winRatePct: +(w.winRate * 100).toFixed(0), archetype: w.archetype, topToken: w.topToken?.symbol ?? null })) },
        addresses: ranked.map((w) => w.wallet),
        citations: [{ label: "Top wallets on Monad", href: "https://nullterminal.xyz/smart-money" }],
        viz: [vTable(`Top wallets on Monad · ${window}`, ["#", "Wallet", "PnL", "Realized", "Volume", "Trades", "Win rate", "Type", "Top token"], ranked.map((w, i) => [i + 1, shortAddr(w.wallet), Math.round(w.pnlUsd), Math.round(w.realizedUsd), Math.round(w.volumeUsd), w.trades, +(w.winRate * 100).toFixed(0), w.archetype, w.topToken?.symbol ?? "—"]), ["r", "l", "r", "r", "r", "r", "r", "l", "l"])],
      };
    }
    // ── Robinhood Chain ──
    case "rh_stocks":
    case "rh_tokens": {
      const sort = (["volume", "change", "trades", "traders"] as const).find((x) => x === args.sort) ?? "volume";
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
      const rows: RhTokenRow[] = name === "rh_stocks" ? (await rhStocks()).stocks : (await read<{ tokens: RhTokenRow[] }>(`/v1/rh/tokens?limit=200&sort=${sort}`, 60_000)).tokens;
      const sorted = [...rows].filter((r) => r.symbol).sort((a, b) => sort === "change" ? (b.change24hPct ?? -1e9) - (a.change24hPct ?? -1e9) : sort === "trades" ? b.trades24h - a.trades24h : sort === "traders" ? b.traders - a.traders : b.volume24h - a.volume24h).slice(0, limit);
      const data = sorted.map((r) => ({ symbol: r.symbol, name: cleanStockName(r.name), address: r.address, priceUsd: r.priceUsd, change24hPct: r.change24hPct == null ? null : r2(r.change24hPct), volume24hUsd: Math.round(r.volume24h), buyVolumeUsd: Math.round(r.buyVolume24h), sellVolumeUsd: Math.round(r.sellVolume24h), trades24h: r.trades24h, traders: r.traders, liquidityUsd: r.liquidityUsd == null ? null : Math.round(r.liquidityUsd), ...("navUsd" in r ? { navUsd: (r as any).navUsd, basisPct: (r as any).basisPct == null ? null : r2((r as any).basisPct), offHoursSharePct: (r as any).offHours7d?.sharePct == null ? null : r2((r as any).offHours7d.sharePct) } : {}) }));
      return { ...none, data: { chain: RH, sort, rows: data, note: "Prices are the last on-chain trade; stocks trade 24/7 here, NAV is the reference from the underlying market." }, addresses: data.map((d) => d.address), citations: data.slice(0, 3).map((d) => rhCite({ address: d.address, symbol: d.symbol! })),
        viz: [vTable(name === "rh_stocks" ? "Stocks on Robinhood Chain · 24h" : "Robinhood Chain · 24h", ["Token", "Price", "24h", "Volume", ...(name === "rh_stocks" ? ["vs NAV"] : ["Trades"])], data.slice(0, 12).map((d) => [d.symbol!, d.priceUsd == null ? "—" : `$${d.priceUsd >= 100 ? d.priceUsd.toFixed(2) : d.priceUsd.toPrecision(4)}`, d.change24hPct == null ? "—" : `${d.change24hPct}%`, `$${Math.round(d.volume24hUsd).toLocaleString("en-US")}`, name === "rh_stocks" ? ((d as any).basisPct == null ? "—" : `${(d as any).basisPct}%`) : d.trades24h]), ["l", "r", "r", "r", "r"])] };
    }
    case "rh_token": {
      const t = await resolveRhToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No listed token on Robinhood Chain matches that. Say so; do not guess an address." } };
      const [st, hourly, stocks, c1h] = await Promise.all([
        tokenStats(t.address).catch(() => null),
        read<RhTokenHourly>(`/v1/rh/token/${t.address.toLowerCase()}?hours=168`, 60_000).catch(() => null),
        t.tags?.includes("stock") ? rhStocks().catch(() => null) : Promise.resolve(null),
        candles(RH, t.address, "1h", 24).catch(() => [] as Candle[]), // ask2049: Chord's getDbChart → GET /v1/candles
      ]);
      const stock = stocks?.stocks.find((s) => s.address.toLowerCase() === t.address.toLowerCase()) ?? null;
      const days = new Map<string, number>();
      for (const h of hourly?.series ?? []) { const d = new Date(h.hour * 1000).toISOString().slice(5, 10); days.set(d, (days.get(d) ?? 0) + h.volUsd); }
      return {
        ...none,
        data: { found: true, chain: RH, token: { symbol: t.symbol, name: cleanStockName(t.name), address: t.address, decimals: t.decimals, tags: t.tags ?? [], stock: !!t.tags?.includes("stock") }, priceUsd: st?.priceUsd ?? stock?.priceUsd ?? null, windows: st?.windows ?? null, liquidityUsd: st?.liquidityUsd ?? stock?.liquidityUsd ?? null,
          // Basis against the price this row reports: the stocks row prices off the hourly rollup, and a premium from
          // one price next to another price read as "224.44 vs NAV 224.42 = +0.11 %" (self-test 2026-09-26).
          ...(stock ? { navUsd: stock.navUsd, basisPct: (() => { const px = st?.priceUsd ?? stock.priceUsd; return stock.navUsd != null && stock.navUsd > 0 && px != null ? r2((px / stock.navUsd - 1) * 100) : stock.basisPct == null ? null : r2(stock.basisPct); })(), offHours7d: stock.offHours7d } : {}),
          volume7dByDay: [...days.entries()].map(([d, v]) => ({ day: d, volumeUsd: Math.round(v) })), venues7d: (hourly?.byDex ?? []).map((v) => ({ dex: v.dex, volumeUsd: Math.round(v.volUsd), sharePct: r2(v.sharePct) })),
          note: "Buys on Chord pull from USDG cash and sells land as USDG — the Trade tab (/ask/trade) opens this token; no gas needed." },
        addresses: [t.address],
        citations: [rhCite(t)],
        viz: c1h.length > 2 ? [{ kind: "line", title: `${t.symbol} · 1h close`, x: c1h.slice(-24).map((c) => new Date(c.t * 1000).toISOString().slice(11, 16)), series: [{ name: "Close", values: c1h.slice(-24).map((c) => c.c) }], unit: "price", chart: { chain: 4663, address: t.address, tf: "1h" } }] : [],
      };
    }
    case "rh_token_trades": {
      const t = await resolveRhToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No listed token on Robinhood Chain matches that." } };
      const side = args.side === "buy" || args.side === "sell" ? args.side : undefined;
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const minUsdR = Math.max(0, Number(args.min_usd) || 0);
      const page = await tradesPage(t.address, { side, min: minUsdR, limit });
      // Big prints = the last 24 h: NVDA prints ~40k a day and 31 of 116k were ≥ $25k over 3 days — unbounded, the scan timed out.
      // ask2049: the public route takes no `since`, so the 24 h window is applied to the rows it returns.
      const since = minUsdR >= 1000 ? Math.floor(Date.now() / 1000) - 86_400 : 0;
      const trades = page.trades.filter((r) => r.ts >= since).map((r) => ({ side: r.side, usd: Math.round(r.usd), tokens: r2(r.tokenAmt), priceUsd: r.priceUsd, wallet: r.wallet ?? null, dex: r.dex, minutesAgo: minsAgo(r.ts), tx: r.tx }));
      return { ...none, data: { chain: RH, token: t.symbol, ...(minUsdR >= 1000 ? { window: "last 24 h (prints of that size over longer periods are not scanned here)" } : {}), stats24h: page.stats24h, trades }, addresses: [t.address, ...trades.map((x) => x.wallet).filter((w): w is string => !!w)], citations: [rhCite(t)], viz: [vTable(`${t.symbol} · recent trades`, ["Side", "USD", "Price", "Wallet", "Ago"], trades.slice(0, 12).map((x) => [x.side, `$${x.usd.toLocaleString("en-US")}`, x.priceUsd == null ? "—" : `$${x.priceUsd >= 100 ? x.priceUsd.toFixed(2) : x.priceUsd.toPrecision(4)}`, x.wallet ? `${x.wallet.slice(0, 6)}…${x.wallet.slice(-4)}` : "—", `${x.minutesAgo}m`]), ["l", "r", "r", "l", "r"])] };
    }
    case "rh_wallet_pnl": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const p = await walletPnl(w, RH);
      const rows = [...p.tokens].sort((a, b) => Math.abs(b.totalUsd) - Math.abs(a.totalUsd)).slice(0, 15);
      const empty = !p.tokens.length && !p.realized; // ask2049: see EMPTY_WALLET_NOTE
      // ask2049: Chord reads `stillHoldsUsd ?? currentValueUsd` here, which the PnL rows do not carry (always 0); the rows'
      // current value is `curValue` (what monad_wallet_pnl reads), so it is read last instead of answering $0.
      return { ...none, data: { chain: RH, wallet: w, realizedUsd: Math.round(p.realized), unrealizedUsd: Math.round(p.unrealized), totalUsd: Math.round(p.total), ...(p.exitedWithoutSale ? { exitedWithoutSale: { ...p.exitedWithoutSale, costUsd: Math.round(p.exitedWithoutSale.costUsd), note: "Tokens this wallet bought that left it with no sale on Chord's tape (sent elsewhere, or sold through a contract the tape credits to another address). Their result is unknown and NOT in the PnL above — say so and give the cost." } } : {}), tokens: rows.map((t) => ({ symbol: t.symbol, realizedUsd: Math.round(t.realizedUsd), unrealizedUsd: Math.round(t.unrealizedUsd), totalUsd: Math.round(t.totalUsd), stillHoldsUsd: Math.round(t.stillHoldsUsd ?? t.currentValueUsd ?? t.curValue ?? 0) })), ...(empty ? { note: EMPTY_WALLET_NOTE } : {}) }, addresses: [w], citations: [{ label: "Portfolio on Robinhood Chain", href: `/portfolio?address=${w}` }] };
    }
    case "rh_overview": {
      const d = await read<RhOverview>("/v1/rh/overview", 60_000);
      const daily = d.daily.slice(-14);
      return { ...none, data: { chain: RH, last24h: { volUsd: Math.round(d.last24h.volUsd), swaps: d.last24h.swaps, tokens: d.last24h.tokens }, venues24h: d.venues24h.slice(0, 8).map((v) => ({ dex: v.dex, volUsd: Math.round(v.volUsd), trades: v.trades, sharePct: r2(v.sharePct) })), daily: daily.map((x) => ({ day: new Date(x.day * 1000).toISOString().slice(0, 10), volUsd: Math.round(x.volUsd), swaps: x.swaps, wallets: x.wallets, tokens: x.tokens })), stale: d.coverage.stale }, citations: [{ label: "Robinhood Chain on Ask", href: "/ask/trade" }], viz: [
        { kind: "bar", title: "Robinhood Chain · daily volume", x: daily.map((x) => new Date(x.day * 1000).toISOString().slice(5, 10)), series: [{ name: "Volume", values: daily.map((x) => Math.round(x.volUsd)) }], unit: "usd" },
        { kind: "donut", title: "Robinhood Chain · venues, 24h", slices: d.venues24h.slice(0, 8).map((v) => ({ name: v.dex, value: Math.round(v.volUsd) })), unit: "usd" },
      ] };
    }
    case "rh_venues": {
      const d = await read<RhVenues>(`/v1/rh/venues?days=${Math.max(1, Math.min(90, Number(args.days) || 7))}`, 60_000);
      const vs = d.venues.map((v) => ({ dex: v.dex, volUsd: Math.round(v.volUsd), trades: v.trades, sharePct: r2(v.sharePct) }));
      return { ...none, data: { chain: RH, days: d.days, totals: { volUsd: Math.round(d.totals.volUsd), trades: d.totals.trades }, venues: vs }, citations: [{ label: "Robinhood Chain on Ask", href: "/ask/trade" }], viz: [{ kind: "donut", title: `Robinhood Chain venues · ${d.days}d volume share`, slices: vs.slice(0, 8).map((v) => ({ name: v.dex, value: v.volUsd })), unit: "usd" }] };
    }
    case "rh_search": {
      const q = String(args.query ?? "").trim().toLowerCase().replace(/^\$/, "");
      if (!q) return { ...none, data: { error: "empty query" } };
      const [list, board, found] = await Promise.all([
        rhList(), rhBoard().catch(() => null),
        // ask2049: unlisted rows past the public board's 200 come from /v1/tokens/search (Chord's full 24h board, no prices).
        read<{ tokens?: { address: string; symbol: string; name?: string; verified?: boolean; tags?: string[] }[] }>(`/v1/tokens/search?q=${enc(q.slice(0, 64))}&chain=${RH}&limit=25`, 60_000).catch(() => null),
      ]);
      const byAddr = new Map((board?.tokens ?? []).map((t) => [t.address.toLowerCase(), t]));
      const listed = list.filter((t) => t.address.toLowerCase() === q || t.symbol.toLowerCase().includes(q) || cleanStockName(t.name).toLowerCase().includes(q));
      const extra = (board?.tokens ?? []).filter((t) => !t.listed && ((t.symbol ?? "").toLowerCase().includes(q) || t.address.toLowerCase() === q));
      const seen = new Set([...listed, ...extra].map((t) => t.address.toLowerCase()));
      const more = (found?.tokens ?? []).filter((t) => t.verified === false && !seen.has(t.address.toLowerCase()));
      // Unlisted names / symbols are whatever the deployer typed (seen: rows of ~1 kB) — clipped before the model reads them.
      const rows = [...listed.map((t) => ({ address: t.address.toLowerCase(), symbol: t.symbol, name: cleanStockName(t.name), tags: t.tags ?? [], listed: true })), ...[...extra, ...more].map((t) => ({ address: t.address.toLowerCase(), symbol: (t.symbol ?? t.address.slice(0, 8)).slice(0, 24), name: (t.name ?? "").slice(0, 60), tags: (t.tags ?? []).slice(0, 4), listed: false }))]
        // ask2049: a row missing from the 200-row board has no price / volume here: null, never a guessed 0.
        .map((t) => { const b = byAddr.get(t.address); return { ...t, priceUsd: b?.priceUsd ?? null, change24hPct: b?.change24hPct == null ? null : r2(b.change24hPct), volume24hUsd: b ? Math.round(b.volume24h) : null }; })
        .sort((a, b) => Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q) || (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1)).slice(0, 10);
      return { ...none, data: { chain: RH, matches: rows, note: "listed = on Robinhood's token list (stocks carry the 'stock' tag); unlisted rows are memes that traded in the last 24h — name which one you used." }, addresses: rows.map((r) => r.address), citations: rows.slice(0, 2).map((r) => rhCite(r)) };
    }
    case "rh_token_flow": {
      const t = await resolveRhAny(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      // ask2049: GET /v1/tokens/stats answers for listed Robinhood tokens only (404 for an unlisted meme).
      const st = await tokenStats(t.address).catch((e) => notFoundToNull<TokenStats>(e));
      if (!st) return { ...none, data: { found: false, token: t.symbol, note: "Chord's public stats cover listed Robinhood Chain tokens only; this one is unlisted. Say its order flow is not available here." }, addresses: [t.address], citations: [rhCite(t)] };
      const w = (x: WindowStats) => ({ changePct: x.change, trades: x.txns, buys: x.buys, sells: x.sells, buyUsd: Math.round(x.buyVol), sellUsd: Math.round(x.sellVol), buyers: x.buyers, sellers: x.sellers, wallets: x.makers });
      const W = [["5m", st.windows.m5], ["1h", st.windows.h1], ["6h", st.windows.h6], ["24h", st.windows.h24]] as const;
      return { ...none, data: { chain: RH, token: t.symbol, priceUsd: st.priceUsd, windows: { m5: w(st.windows.m5), h1: w(st.windows.h1), h6: w(st.windows.h6), h24: w(st.windows.h24) }, ath: st.ath, range24h: st.range24h, firstTradeMinutesAgo: st.firstTradeTs ? minsAgo(st.firstTradeTs) : null, totalTrades: st.totalTxns }, addresses: [t.address], citations: [rhCite(t)], viz: [
        { kind: "bar", title: `${t.symbol} · buy vs sell USD by window`, x: W.map((x) => x[0]), series: [{ name: "Bought", values: W.map((x) => Math.round(x[1].buyVol)) }, { name: "Sold", values: W.map((x) => Math.round(x[1].sellVol)) }], unit: "usd" },
      ] };
    }
    case "rh_candles": {
      const t = await resolveRhAny(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const tf = (["5m", "15m", "1h", "4h", "1d"] as const).includes(args.tf) ? String(args.tf) : "1h";
      const limit = Math.max(1, Math.min(120, Number(args.limit) || 48));
      const cs = await candles(RH, t.address, tf, limit).catch(() => [] as Candle[]); // ask2049: Chord's getDbChart → GET /v1/candles
      const sl = cs.slice(-limit);
      const lab = (c: Candle) => { const d = new Date(c.t * 1000); return tf === "1d" ? d.toISOString().slice(5, 10) : `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`; };
      return { ...none, data: { chain: RH, token: t.symbol, tf, candles: sl.map((c) => ({ timeUtc: new Date(c.t * 1000).toISOString().slice(0, 16).replace("T", " "), o: sig(c.o), h: sig(c.h), l: sig(c.l), c: sig(c.c), volUsd: Math.round(c.v) })) }, addresses: [t.address], citations: [rhCite(t)], viz: sl.length > 1 ? [
        { kind: "line", title: `${t.symbol} · close, ${tf} candles`, x: sl.map(lab), series: [{ name: "Close", values: sl.map((c) => sig(c.c)) }], unit: "price", chart: { chain: 4663, address: t.address, tf } },
        { kind: "bar", title: `${t.symbol} · volume per ${tf} candle`, x: sl.map(lab), series: [{ name: "Volume", values: sl.map((c) => Math.round(c.v)) }], unit: "usd" },
      ] : [] };
    }
    case "rh_wallet_trades": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 20));
      const tok = args.token ? await resolveRhAny(String(args.token)) : null;
      if (args.token && !tok) return { ...none, data: { error: "Unknown token filter on Robinhood Chain." } };
      if (tok) {
        const page = await tradesPage(tok.address, { wallet: w.toLowerCase(), limit });
        const rows = page.trades;
        const bought = rows.filter((r) => r.side === "buy"), sold = rows.filter((r) => r.side === "sell");
        const avg = (rs: DexTradeRow[]) => { const u = rs.reduce((s, r) => s + r.usd, 0), a = rs.reduce((s, r) => s + r.tokenAmt, 0); return a > 0 ? sig(u / a) : null; };
        return { ...none, data: { chain: RH, wallet: w, token: tok.symbol, trades: rows.map((r) => ({ side: r.side, usd: Math.round(r.usd), priceUsd: sig(r.priceUsd), tokens: r2(r.tokenAmt), minutesAgo: minsAgo(r.ts), dex: r.dex, tx: r.tx })), summary: { buys: bought.length, boughtUsd: Math.round(bought.reduce((s, r) => s + r.usd, 0)), avgBuyPriceUsd: avg(bought), sells: sold.length, soldUsd: Math.round(sold.reduce((s, r) => s + r.usd, 0)), avgSellPriceUsd: avg(sold), totalOnToken: page.total } }, addresses: [w, tok.address], citations: [walletCite(w), rhCite(tok)], viz: [vTable(`${shortAddr(w)} · trades on ${tok.symbol}`, ["When", "Side", "USD", "Price", "Tokens", "Venue"], rows.slice(0, 20).map((r) => [`${minsAgo(r.ts)}m ago`, r.side, Math.round(r.usd), sig(r.priceUsd), r2(r.tokenAmt), r.dex]), ["l", "l", "r", "r", "r", "l"])] };
      }
      const all = (await read<{ trades: PfTrade[] }>(`/v1/portfolio/${w.toLowerCase()}/trades?chain=${RH}`, 30_000, 25_000)).trades ?? [];
      const sorted = [...all].sort((a, b) => b.t - a.t);
      const byToken = new Map<string, { symbol: string; buys: number; sells: number; boughtUsd: number; soldUsd: number }>();
      for (const r of all) { const e = byToken.get(r.token) ?? { symbol: r.symbol, buys: 0, sells: 0, boughtUsd: 0, soldUsd: 0 }; if (r.side === "buy") { e.buys++; e.boughtUsd += r.usd; } else { e.sells++; e.soldUsd += r.usd; } byToken.set(r.token, e); }
      const tokens = [...byToken.entries()].map(([token, e]) => ({ token, ...e, boughtUsd: Math.round(e.boughtUsd), soldUsd: Math.round(e.soldUsd) })).sort((a, b) => (b.boughtUsd + b.soldUsd) - (a.boughtUsd + a.soldUsd)).slice(0, 12);
      return { ...none, data: { chain: RH, wallet: w, totalTrades: all.length, tokens, recent: sorted.slice(0, limit).map((r) => ({ side: r.side, usd: Math.round(r.usd), token: r.symbol, tokenAddress: r.token, tokens: r2(r.tokenAmt), minutesAgo: minsAgo(r.t), tx: r.tx })), ...(all.length ? {} : { note: EMPTY_WALLET_NOTE }) }, addresses: [w, ...tokens.map((x) => x.token)], citations: [walletCite(w)], viz: [vTable(`${shortAddr(w)} · Robinhood Chain by token`, ["Token", "Buys", "Bought", "Sells", "Sold"], tokens.map((x) => [x.symbol, x.buys, x.boughtUsd, x.sells, x.soldUsd]), ["l", "r", "r", "r", "r"])] };
    }
    case "rh_wallet_pnl_calendar": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const cal = await read<PnlCalendar>(`/v1/portfolio/${w.toLowerCase()}/pnl-calendar?chain=${RH}`, 60_000, 25_000);
      const rows = ((cal.days ?? []) as any[]).slice(-45);
      return { ...none, data: { chain: RH, wallet: w, firstDate: cal.firstDate, realizedTotalUsd: Math.round(cal.realizedTotal), days: rows.map((d: any) => ({ day: String(d.date ?? d.day ?? ""), realizedUsd: Math.round(d.realizedUsd ?? d.realized ?? 0) })), ...(rows.length ? {} : { note: EMPTY_WALLET_NOTE }) }, addresses: [w], citations: [walletCite(w)], viz: rows.length ? [{ kind: "bar", title: `${shortAddr(w)} · realized PnL by day · Robinhood Chain`, x: rows.map((d: any) => String(d.date ?? d.day ?? "")), series: [{ name: "Realized", values: rows.map((d: any) => Math.round(d.realizedUsd ?? d.realized ?? 0)) }], unit: "usd" }] : [] };
    }
    case "rh_top_wallets": {
      const window = (["24h", "7d", "30d"] as const).includes(args.window) ? String(args.window) : "7d";
      const limit = Math.max(1, Math.min(15, Number(args.limit) || 8));
      let ranked: SmWallet[];
      try {
        ranked = (await topWallets(window, RH, limit)).wallets.slice(0, limit);
      } catch (e) {
        // ask2049: Chord checks boardEnabled(RH) itself; the public route answers 503 CHAIN_NOT_ENABLED for the same switch.
        if (e instanceof ChordReadError && e.code === "CHAIN_NOT_ENABLED") return { ...none, data: { note: "The Robinhood Chain wallet board is not published on this deployment. Say so; rh_token_traders ranks traders on one token." } };
        throw e;
      }
      return {
        ...none,
        data: { chain: RH, wallets: ranked.map((w, i) => ({ rank: i + 1, wallet: w.wallet, pnlUsd: Math.round(w.pnlUsd), realizedUsd: Math.round(w.realizedUsd), volumeUsd: Math.round(w.volumeUsd), trades: w.trades, winRatePct: +(w.winRate * 100).toFixed(0), archetype: w.archetype, topToken: w.topToken?.symbol ?? null })) },
        addresses: ranked.map((w) => w.wallet),
        citations: [{ label: "Top wallets", href: "/smart-money" }],
        viz: [vTable(`Top wallets on Robinhood Chain · ${window}`, ["#", "Wallet", "PnL", "Realized", "Volume", "Trades", "Win rate", "Type", "Top token"], ranked.map((w, i) => [i + 1, shortAddr(w.wallet), Math.round(w.pnlUsd), Math.round(w.realizedUsd), Math.round(w.volumeUsd), w.trades, +(w.winRate * 100).toFixed(0), w.archetype, w.topToken?.symbol ?? "—"]), ["r", "l", "r", "r", "r", "r", "r", "l", "l"])],
      };
    }
    case "rh_compare": {
      const qs2 = (Array.isArray(args.tokens) ? args.tokens : []).map(String).slice(0, 6);
      if (qs2.length < 2) return { ...none, data: { error: "Give 2 to 6 tokens." } };
      const stocks = await rhStocks().catch(() => null);
      const rows = await Promise.all(qs2.map(async (q) => {
        const t = await resolveRhAny(q);
        if (!t) return { query: q, found: false as const };
        const row = await rhRowOf(t.address);
        const st = stocks?.stocks.find((x) => x.address.toLowerCase() === t.address) ?? null;
        // ask2049: a token outside the public 200-row board has no 24 h row here: its numbers are null, never a guessed 0.
        return { query: q, found: true as const, symbol: t.symbol, address: t.address, priceUsd: row?.priceUsd ?? null, change24hPct: row?.change24hPct == null ? null : r2(row.change24hPct), volume24hUsd: row ? Math.round(row.volume24h) : null, trades24h: row ? row.trades24h : null, traders: row ? row.traders : null, buySharePct: row && row.volume24h > 0 ? r2((row.buyVolume24h / row.volume24h) * 100) : null, liquidityUsd: row?.liquidityUsd == null ? null : Math.round(row.liquidityUsd), navUsd: st?.navUsd ?? null, basisPct: st?.basisPct == null ? null : r2(st.basisPct), offHoursSharePct: st?.offHours7d?.sharePct == null ? null : r2(st.offHours7d.sharePct) };
      }));
      const ok = rows.filter((r): r is Extract<typeof r, { found: true }> => r.found);
      return { ...none, data: { chain: RH, rows }, addresses: ok.map((r) => r.address), citations: ok.map((r) => rhCite(r)), viz: [vTable("Robinhood Chain · side by side", ["Token", "Price", "24h", "Volume", "Trades", "Traders", "Buy share", "Liquidity", "NAV", "vs NAV", "Off-hours"], ok.map((r) => [r.symbol, r.priceUsd, r.change24hPct, r.volume24hUsd, r.trades24h, r.traders, r.buySharePct, r.liquidityUsd, r.navUsd, r.basisPct, r.offHoursSharePct]), ["l", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r"])] };
    }
    case "rh_holders": {
      const t = await resolveRhAny(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No token on Robinhood Chain matches that." } };
      try {
        const h = await read<RhHolders>(`/v1/rh/token/${t.address}/holders?limit=${Math.max(1, Math.min(25, Number(args.limit) || 10))}`, 30_000, 15_000);
        return {
          ...none,
          data: { chain: RH, token: t.symbol, holders: h.holders, complete: h.complete, backfillPct: h.coverage.backfillPct, heldByWalletsPct: h.heldByWalletsPct, concentration: h.concentration, top: h.top.map((r) => ({ holder: r.holder, sharePct: r.sharePct, amount: r.amount, kind: r.kind })), note: h.complete ? undefined : "The ledger is still replaying this token's history (backfillPct of blocks done): counts and shares are PARTIAL — say so plainly." },
          addresses: [t.address, ...h.top.map((r) => r.holder)],
          citations: [rhCite(t)],
          viz: [vTable(`${t.symbol} · largest holders${h.complete ? "" : " (ledger still building)"}`, ["Holder", "Share", "Kind"], h.top.slice(0, 12).map((r) => [shortAddr(r.holder), r.sharePct == null ? "—" : `${r.sharePct}%`, r.kind]), ["l", "r", "l"])],
        };
      } catch (e) {
        // ask2049: Chord's RhHoldersNotTracked = the route's 503 HOLDERS_PENDING; its message says which (queued vs not enabled).
        if (e instanceof ChordReadError && e.code === "HOLDERS_PENDING") {
          const pinned = /being built/i.test(e.message);
          return { ...none, data: { chain: RH, token: t.symbol, note: pinned ? "This token was just queued into the holder ledger; its history is being replayed. Say it is not available yet; do not estimate." : "The Robinhood holder ledger is not switched on in this deployment. Say so; do not estimate." }, addresses: [t.address], citations: [rhCite(t)] };
        }
        throw e;
      }
    }
    default:
      return { ...none, data: { error: `no such tool ${name}` } };
  }
}

// ── Avalanche · Base · BNB Chain (Chord's services/ask/chainTools.ts) ────────────────────────────────────────────────

export const CHAIN_TOOL_CHAINS = [43114, 8453, 56] as const;
export type AskKeyedChain = (typeof CHAIN_TOOL_CHAINS)[number];
const NATIVE = "0x0000000000000000000000000000000000000000";

/** "avalanche" / "avax" / 43114 → 43114, etc. null = not one of the three. */
export function parseKeyedChain(v: unknown): AskKeyedChain | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["43114", "avalanche", "avax", "avalanche c-chain", "c-chain", "avalanche c chain"].includes(s)) return 43114;
  if (["8453", "base", "base chain", "base mainnet"].includes(s)) return 8453;
  if (["56", "bnb", "bsc", "bnb chain", "bnb smart chain", "binance smart chain", "binance", "bep20"].includes(s)) return 56;
  return null;
}

const empty = (data: unknown, addresses: string[] = []): ExtToolResult => ({ data, addresses, citations: [] });
const csig = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(5)));
const usdFmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const cshort = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// ask2049: Chord's @nullterminal/shared DEX_DISPLAY_NAMES (constants.ts, 2026-10-06), copied — this app has no shared package.
const DEX_DISPLAY_NAMES: Record<string, string> = {
  synthra_v3: "Synthra", sushi_v2: "SushiSwap V2", sushi_v3: "SushiSwap V3", dyorswap: "DYORSwap", slipstream_fork: "Aero",
  uniswap_v4: "Uniswap V4", uniswap_v3: "Uniswap V3", uniswap_v2: "Uniswap V2", pancake_v3: "PancakeSwap V3", capricorn: "Capricorn V3",
  octoswap: "OctoSwap V3", atlantis: "Atlantis", lfj: "LFJ (Trader Joe)", kuru: "Kuru", hanji: "Hanji", metric: "Metric", lfj_poe: "LFJ POE",
  nadfun_bc: "Nad.fun", nadfun_bc_v2: "Nad.fun", nadfun_dex: "Nad.fun DEX", pons_v2_curve: "Pons", balancer_v3: "Balancer V3", curve: "Curve",
  mento: "Mento", pangolin_v3: "Pangolin V3", monday_trade: "Monday Trade", blackhole_v2: "Blackhole", pancake_infinity_cl: "PancakeSwap Infinity",
};
/** Venue id → the name people use ("pharaoh_dlmm" → "Pharaoh DLMM"): the shared display map, else title case (V2 / V3 kept). */
export const venueLabel = (dex: string | null | undefined): string | null => {
  if (!dex) return null;
  const named = DEX_DISPLAY_NAMES[dex];
  if (named) return named;
  return dex.split(/[_\-\s]+/).filter(Boolean).map((w) => (/^v\d+$/i.test(w) ? w.toUpperCase() : /^(?:dlmm|lb|cl|amm|clmm)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
};

/** Where the person trades / reads it on getchord: the Ask Trade tab with the chain pinned. */
export const tradeHref = (chain: number, address: string, side?: "buy" | "sell") =>
  `/ask/trade/${address.toLowerCase()}?chain=${chain}${side ? `&side=${side}` : ""}`;
const chainCite = (m: ChainMeta): Citation => ({ label: `${m.name} on Chord`, href: `/chains/${m.key}` });
const tokenCite = (chain: number, t: { address: string; symbol: string | null }): Citation =>
  ({ label: `${t.symbol ?? cshort(t.address)} on ${chainMeta(chain)?.name ?? chain}`, href: tradeHref(chain, t.address) });

interface IngestFloor { minTradeUsd: number }
/** The floor line the model must repeat whenever it quotes volume or counts. */
const floorNote = (f: IngestFloor | undefined, chain: number) =>
  f && f.minTradeUsd > 0 ? `Chord's ${chainMeta(chain)?.name} index skips trades under $${f.minTradeUsd}: volumes and counts cover trades ≥ $${f.minTradeUsd} only — say so when you quote them.` : null;

interface ChainTokenRow {
  address: string; symbol: string | null; name: string | null; decimals: number | null; priceUsd: number | null; change24hPct: number | null;
  volume24h: number; buyVolume24h: number; trades24h: number; dominantDex: string | null; lastTradeTs: number;
}
interface ChainOverview {
  last24h: { volUsd: number; swaps: number; tokens: number; venues: number }; wallets: { today: number | null; yesterday: number | null };
  venues24h: { dex: string; volUsd: number; trades: number; sharePct: number }[];
  daily: { day: number; swaps: number; volUsd: number; tokens: number; wallets: number }[]; coverage: { stale: boolean }; ingestFloor: IngestFloor;
}
interface ChainTokens { total: number; tokens: ChainTokenRow[]; ingestFloor: IngestFloor }
interface ChainTokenPage {
  token: { address: string; symbol: string | null; name: string | null; decimals: number | null };
  stats24h: { volUsd: number; buyUsd: number; trades: number; buys: number; sells: number; lastTs: number; priceUsd: number | null; change24hPct: number | null };
  series: { hour: number; volUsd: number; priceLast: number | null }[]; byDex: { dex: string; volUsd: number; sharePct: number }[]; ingestFloor: IngestFloor;
}
interface ChainTokenTrades { trades: { tx: string; dex: string; side: "buy" | "sell"; tokenAmt: number; usd: number; priceUsd: number; ts: number; wallet: string | null }[]; ingestFloor: IngestFloor }
interface ChainWalletPnl {
  chain: number; window: { fromTs: number | null; toTs: number; days: number | null }; history?: "raw" | "raw+lake" | "raw (lake unavailable)";
  trades: number; truncated: boolean; realizedUsd: number; unrealizedUsd: number; totalUsd: number; volumeUsd: number; soldWithoutBasisUsd: number;
  tokens: { token: string; symbol: string | null; buys: number; sells: number; boughtUsd: number; soldUsd: number; realizedUsd: number; unrealizedUsd: number; holdsUsd: number; avgCostUsd: number | null; lastPriceUsd: number | null }[];
  recent: { side: string; usd: number; token: string; symbol: string | null; ts: number; dex: string; tx: string }[];
  ingestFloor: IngestFloor;
}
/** "May 3" style date of a unix second, for the window line the model repeats (Chord's services/chainWallet.windowLabel). */
const windowLabel = (p: Pick<ChainWalletPnl, "window" | "chain" | "history">): string => {
  const name = chainMeta(p.chain)?.name ?? `chain ${p.chain}`;
  if (p.window.fromTs == null) return `${name}: no trades indexed yet`;
  const src = p.history === "raw+lake" ? "raw tape + lake history" : p.history === "raw (lake unavailable)" ? "raw tape only — older history unavailable right now" : "raw tape";
  return `${name} trades since ${new Date(p.window.fromTs * 1000).toISOString().slice(0, 10)} (${p.window.days} day${p.window.days === 1 ? "" : "s"}, ${src})`;
};

const chainBoard = (chain: number, sort: string) => read<ChainTokens>(`/v1/chains/${chain}/tokens?limit=200&sort=${sort}`, 60_000);
const chainPage = (chain: number, a: string, hours: number) => read<ChainTokenPage>(`/v1/chains/${chain}/token/${a.toLowerCase()}?hours=${hours}`, 60_000);
interface Listed { address: string; symbol: string; name: string; decimals: number; logoURI?: string | null }
async function listedSet(chain: number): Promise<Listed[]> {
  return (await chordTokenList(chain).catch(() => [])) as unknown as Listed[];
}

export interface KeyedToken { address: string; symbol: string; name: string | null; decimals: number | null; listed: boolean; volume24hUsd: number }

/** Symbol / name / 0x → one token on the chain, plus the look-alikes that share its symbol. */
export async function resolveKeyedToken(chain: AskKeyedChain, q: string): Promise<{ token: KeyedToken; lookAlikes: KeyedToken[] } | null> {
  const m = chainMeta(chain)!;
  let s = q.trim().toLowerCase().replace(/^\$/, "");
  if (!s) return null;
  if (s === m.nativeSymbol.toLowerCase()) s = m.wrappedNative; // data lives under the wrapped twin
  const [list, board] = await Promise.all([listedSet(chain), chainBoard(chain, "volume").catch(() => null)]);
  const vol = new Map((board?.tokens ?? []).map((t) => [t.address, t] as const));
  const asTok = (a: string, sym: string | null, name: string | null, dec: number | null, listed: boolean): KeyedToken =>
    ({ address: a, symbol: sym ?? cshort(a), name, decimals: dec, listed, volume24hUsd: Math.round(vol.get(a)?.volume24h ?? 0) });
  if (ADDR_RE.test(s)) {
    const l = list.find((t) => t.address.toLowerCase() === s);
    if (l) return { token: asTok(s, l.symbol, l.name, l.decimals, true), lookAlikes: [] };
    const b = vol.get(s);
    // ask2049: Chord's chainTokenMeta (its token table) → the token page, which carries the same symbol / name / decimals
    // for any token the index has seen trade (404 = never traded on this chain).
    const meta = b ? null : (await chainPage(chain, s, 24).catch(() => null))?.token ?? null;
    const sym = b?.symbol ?? meta?.symbol ?? null;
    if (!b && !meta) return null;
    return { token: asTok(s, sym, b?.name ?? meta?.name ?? null, b?.decimals ?? meta?.decimals ?? null, false), lookAlikes: [] };
  }
  const cands = new Map<string, KeyedToken>();
  for (const t of list) if (t.symbol.toLowerCase() === s) cands.set(t.address.toLowerCase(), asTok(t.address.toLowerCase(), t.symbol, t.name, t.decimals, true));
  for (const t of board?.tokens ?? []) if ((t.symbol ?? "").toLowerCase() === s && !cands.has(t.address)) cands.set(t.address, asTok(t.address, t.symbol, t.name, t.decimals, false));
  if (!cands.size && s.length >= 3) {
    // A name ("pancakeswap", "aerodrome"): listed names first, one hit only.
    const byName = list.filter((t) => (t.name ?? "").toLowerCase().includes(s));
    if (byName.length === 1) { const t = byName[0]!; return { token: asTok(t.address.toLowerCase(), t.symbol, t.name, t.decimals, true), lookAlikes: [] }; }
  }
  const ranked = [...cands.values()].sort((a, b) => Number(b.listed) - Number(a.listed) || b.volume24hUsd - a.volume24hUsd);
  if (!ranked.length) return null;
  return { token: ranked[0]!, lookAlikes: ranked.slice(1, 6) };
}

const rowOut = (t: ChainTokenRow, listed: Set<string>) => ({
  symbol: t.symbol, name: t.name, address: t.address, listed: listed.has(t.address),
  priceUsd: csig(t.priceUsd), change24hPct: t.change24hPct == null ? null : r2(t.change24hPct),
  volume24hUsd: Math.round(t.volume24h), trades24h: t.trades24h,
  buySharePct: t.volume24h > 0 ? r2((t.buyVolume24h / t.volume24h) * 100) : null,
  topVenue: venueLabel(t.dominantDex), lastTradeMinutesAgo: minsAgo(t.lastTradeTs),
});

function notServed(chain: number): ExtToolResult {
  return empty({ error: `${chainMeta(chain)?.name ?? `Chain ${chain}`} data is not available on Chord right now. Say so; do not estimate.` });
}

/** The chain argument → one of the three, or the answer the model should give instead. */
function chainOf(args: Record<string, unknown>): { chain: AskKeyedChain; meta: ChainMeta } | ExtToolResult {
  const chain = parseKeyedChain(args.chain);
  if (!chain) return empty({ error: "chain must be one of avalanche, base, bnb (Arc and Robinhood Chain have their own arc_* / rh_* tools)." });
  // ask2049: Chord checks chainDataServed here; the public route answers 400 UNSUPPORTED_CHAIN for a dark chain (guarded()).
  return { chain, meta: chainMeta(chain)! };
}

async function guarded(fn: () => Promise<ExtToolResult>, chain: number): Promise<ExtToolResult> {
  try { return await fn(); } catch (e) {
    if (e instanceof ChordReadError && e.code === "NOT_READY") return empty({ error: `The ${chainMeta(chain)?.name} index is still building its first rollup. Say the data is not ready yet.` });
    if (e instanceof ChordReadError && e.status === 400 && e.code === "UNSUPPORTED_CHAIN") return notServed(chain);
    throw e;
  }
}

async function runChain(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  if (name === "chain_wallet") return chainWallet(args);
  const c = chainOf(args);
  if (!("chain" in c)) return c;
  const { chain, meta } = c;
  return guarded(async () => {
    switch (name) {
      case "chain_overview": {
        const d = await read<ChainOverview>(`/v1/chains/${chain}/overview`, 30_000);
        const daily = d.daily.slice(-14);
        return {
          data: {
            chain: meta.name, chainId: chain,
            last24h: { volumeUsd: Math.round(d.last24h.volUsd), swaps: d.last24h.swaps, tokensTraded: d.last24h.tokens, venues: d.last24h.venues },
            walletsToday: d.wallets.today, walletsYesterday: d.wallets.yesterday,
            venues24h: d.venues24h.slice(0, 8).map((v) => ({ dex: venueLabel(v.dex), volumeUsd: Math.round(v.volUsd), trades: v.trades, sharePct: r2(v.sharePct) })),
            daily: daily.map((x) => ({ day: new Date(x.day * 1000).toISOString().slice(0, 10), volumeUsd: Math.round(x.volUsd), swaps: x.swaps, wallets: x.wallets, tokens: x.tokens })),
            stale: d.coverage.stale,
            note: [floorNote(d.ingestFloor, chain), "Today's wallet count is a partial UTC day."].filter(Boolean).join(" "),
          },
          addresses: [], citations: [chainCite(meta)],
          viz: [
            { kind: "bar", title: `${meta.name} · daily volume`, x: daily.map((x) => new Date(x.day * 1000).toISOString().slice(5, 10)), series: [{ name: "Volume", values: daily.map((x) => Math.round(x.volUsd)) }], unit: "usd" },
            { kind: "donut", title: `${meta.name} · venues, 24h`, slices: d.venues24h.slice(0, 8).map((v) => ({ name: venueLabel(v.dex) ?? v.dex, value: Math.round(v.volUsd) })), unit: "usd" },
          ],
        };
      }
      case "chain_tokens": {
        const sort = (["volume", "trades", "change"] as const).find((x) => x === args.sort) ?? "volume";
        const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
        const q = String(args.query ?? "").trim().toLowerCase().replace(/^\$/, "");
        const [board, list] = await Promise.all([chainBoard(chain, sort), listedSet(chain)]);
        const listed = new Set(list.map((t) => t.address.toLowerCase()));
        // Gainers on a raw board are dust pools: a % move needs $10k of volume behind it to make the list.
        let rows = board.tokens.filter((t) => t.symbol && (sort !== "change" || t.volume24h >= 10_000));
        if (q) rows = rows.filter((t) => t.address === q || (t.symbol ?? "").toLowerCase().includes(q) || (t.name ?? "").toLowerCase().includes(q));
        const out = rows.slice(0, limit).map((t) => rowOut(t, listed));
        return {
          data: { chain: meta.name, chainId: chain, sort, tokensTraded24h: board.total, rows: out, note: [floorNote(board.ingestFloor, chain), "listed = on the chain's curated token list (has a logo); unlisted rows can be copycats — say so before naming one."].filter(Boolean).join(" ") },
          addresses: out.map((r) => r.address), citations: [chainCite(meta)],
          viz: [vTable(`${meta.name} · 24h by ${sort}`, ["Token", "Price", "24h", "Volume", "Trades"], out.map((r) => [r.symbol, r.priceUsd, r.change24hPct == null ? null : `${r.change24hPct}%`, usdFmt(r.volume24hUsd), r.trades24h]), ["l", "r", "r", "r", "r"])],
        };
      }
      case "chain_token": {
        const hit = await resolveKeyedToken(chain, String(args.token ?? ""));
        if (!hit) return empty({ found: false, note: `No token on ${meta.name} matches that in Chord's index. Say so; do not guess an address.` });
        const t = hit.token;
        const d = await chainPage(chain, t.address, 168).catch((e) => notFoundToNull<ChainTokenPage>(e));
        if (!d) return empty({ found: false, token: t.symbol, note: `${t.symbol} has no indexed trades on ${meta.name}.` }, [t.address]);
        const s = d.stats24h;
        const last48 = d.series.slice(-48);
        const prices = d.series.map((x) => x.priceLast).filter((p): p is number => p != null && p > 0);
        const last24 = d.series.slice(-24).map((x) => x.priceLast).filter((p): p is number => p != null && p > 0);
        const first7d = prices[0] ?? null;
        const days = new Map<string, number>();
        for (const h of d.series) { const k = new Date(h.hour * 1000).toISOString().slice(5, 10); days.set(k, (days.get(k) ?? 0) + h.volUsd); }
        return {
          data: {
            found: true, chain: meta.name, chainId: chain,
            token: { symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, listed: t.listed },
            priceUsd: csig(s.priceUsd), change24hPct: s.change24hPct == null ? null : r2(s.change24hPct),
            change7dPct: first7d && s.priceUsd ? r2((s.priceUsd / first7d - 1) * 100) : null,
            high24h: last24.length ? csig(Math.max(...last24)) : null, low24h: last24.length ? csig(Math.min(...last24)) : null,
            volume24hUsd: Math.round(s.volUsd), trades24h: s.trades, buys24h: s.buys, sells24h: s.sells,
            buySharePct: s.volUsd > 0 ? r2((s.buyUsd / s.volUsd) * 100) : null,
            lastTradeMinutesAgo: s.lastTs ? minsAgo(s.lastTs) : null,
            venues7d: d.byDex.slice(0, 6).map((v) => ({ dex: venueLabel(v.dex), volumeUsd: Math.round(v.volUsd), sharePct: r2(v.sharePct) })),
            volume7dByDay: [...days.entries()].map(([day, v]) => ({ day, volumeUsd: Math.round(v) })),
            ...(hit.lookAlikes.length ? { lookAlikes: hit.lookAlikes.map((x) => ({ symbol: x.symbol, address: x.address, listed: x.listed, volume24hUsd: x.volume24hUsd })) } : {}),
            note: [floorNote(d.ingestFloor, chain), hit.lookAlikes.length ? "Other tokens share this symbol (lookAlikes) — say which one you used." : null, `Trade it on the Ask Trade tab (${meta.name}); chain_quote gives the exact route.`].filter(Boolean).join(" "),
          },
          addresses: [t.address, ...hit.lookAlikes.map((x) => x.address)],
          citations: [tokenCite(chain, t)],
          viz: last48.length > 2 ? [{ kind: "line", title: `${t.symbol} on ${meta.name} · hourly close`, x: last48.map((x) => new Date(x.hour * 1000).toISOString().slice(11, 16)), series: [{ name: "Close", values: last48.map((x) => x.priceLast) }], unit: "price" }] : [],
        };
      }
      case "chain_token_trades": {
        const hit = await resolveKeyedToken(chain, String(args.token ?? ""));
        if (!hit) return empty({ found: false, note: `No token on ${meta.name} matches that.` });
        const t = hit.token;
        const side = args.side === "buy" || args.side === "sell" ? args.side : null;
        const minUsd = Math.max(0, Number(args.min_usd) || 0);
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
        const page = await read<ChainTokenTrades>(`/v1/chains/${chain}/token/${t.address.toLowerCase()}/trades?limit=200`, 5_000);
        const rows = page.trades.filter((x) => (!side || x.side === side) && x.usd >= minUsd).slice(0, limit);
        const trades = rows.map((x) => ({ side: x.side, usd: Math.round(x.usd), tokens: csig(x.tokenAmt), priceUsd: csig(x.priceUsd), wallet: x.wallet, dex: venueLabel(x.dex), minutesAgo: minsAgo(x.ts), tx: x.tx }));
        return {
          data: { chain: meta.name, chainId: chain, token: t.symbol, scanned: page.trades.length, trades, note: [`Filtered from the last ${page.trades.length} prints of ${t.symbol}.`, floorNote(page.ingestFloor, chain), "wallet null = a router or an unattributed signer."].filter(Boolean).join(" ") },
          addresses: [t.address, ...trades.map((x) => x.wallet).filter((w): w is string => !!w)],
          citations: [tokenCite(chain, t)],
          viz: [vTable(`${t.symbol} on ${meta.name} · recent trades`, ["Side", "USD", "Price", "Wallet", "Venue", "Ago"], trades.slice(0, 15).map((x) => [x.side, usdFmt(x.usd), x.priceUsd, x.wallet ? cshort(x.wallet) : "router", x.dex, `${x.minutesAgo}m`]), ["l", "r", "r", "l", "l", "r"])],
        };
      }
      default:
        return empty({ error: `unknown tool ${name}` });
    }
  }, chain);
}

async function chainWallet(args: Record<string, any>): Promise<ExtToolResult> {
  const w = String(args.wallet ?? "").trim();
  if (!ADDR_RE.test(w)) return empty({ error: "wallet must be a 0x address" });
  const asked = args.chain == null || args.chain === "" ? null : parseKeyedChain(args.chain);
  if (args.chain != null && args.chain !== "" && !asked) return empty({ error: "chain must be one of avalanche, base, bnb." });
  const chains = asked ? [asked] : [...CHAIN_TOOL_CHAINS];
  // ask2049: Chord filters the chains by chainDataServed first; here a dark chain is the route's 400 UNSUPPORTED_CHAIN.
  const results = await Promise.all(chains.map((c) => read<ChainWalletPnl>(`/v1/chains/${c}/wallet/${w.toLowerCase()}`, 30_000, 20_000)
    .then((p) => ({ p, dark: false }), (e) => ({ p: null, dark: e instanceof ChordReadError && e.status === 400 && e.code === "UNSUPPORTED_CHAIN" }))));
  if (results.every((r) => r.dark)) return asked ? notServed(asked) : empty({ error: "No Avalanche / Base / BNB data is public on Chord right now." });
  const per = results.map((r, i) => ({ chain: chains[i]!, p: r.p })).filter((x): x is { chain: AskKeyedChain; p: ChainWalletPnl } => !!x.p);
  if (!per.length) return empty({ error: "The index did not answer for this wallet. Say so; do not estimate." }, [w]);
  const addrs = new Set<string>([w.toLowerCase()]);
  const data = per.map(({ chain, p }) => {
    const top = p.tokens.slice(0, 12);
    for (const t of top) addrs.add(t.token);
    return {
      chain: chainMeta(chain)!.name, chainId: chain, window: windowLabel({ ...p, chain: p.chain ?? chain }), trades: p.trades, truncated: p.truncated,
      realizedUsd: Math.round(p.realizedUsd), unrealizedUsd: Math.round(p.unrealizedUsd), totalUsd: Math.round(p.totalUsd), volumeUsd: Math.round(p.volumeUsd),
      soldWithoutBasisUsd: Math.round(p.soldWithoutBasisUsd),
      tokens: top.map((t) => ({ symbol: t.symbol, token: t.token, buys: t.buys, sells: t.sells, boughtUsd: Math.round(t.boughtUsd), soldUsd: Math.round(t.soldUsd), realizedUsd: Math.round(t.realizedUsd), unrealizedUsd: Math.round(t.unrealizedUsd), holdsUsd: Math.round(t.holdsUsd), avgCostUsd: csig(t.avgCostUsd), lastPriceUsd: csig(t.lastPriceUsd) })),
      recent: p.recent.slice(0, 10).map((r) => ({ side: r.side, usd: Math.round(r.usd), token: r.symbol ?? cshort(r.token), minutesAgo: minsAgo(r.ts), dex: venueLabel(r.dex), tx: r.tx })),
      ingestFloorUsd: p.ingestFloor?.minTradeUsd ?? 0,
    };
  });
  const viz: Viz[] = per.filter((x) => x.p.tokens.length).map(({ chain, p }) => vTable(`${cshort(w)} · ${chainMeta(chain)!.name} · PnL by token`, ["Token", "Bought", "Sold", "Realized", "Unrealized", "Holds"], p.tokens.slice(0, 12).map((t) => [t.symbol ?? cshort(t.token), Math.round(t.boughtUsd), Math.round(t.soldUsd), Math.round(t.realizedUsd), Math.round(t.unrealizedUsd), Math.round(t.holdsUsd)]), ["l", "r", "r", "r", "r", "r"]));
  return {
    data: {
      wallet: w, chains: data,
      note: "PnL is average-cost over the swaps Chord's index holds for that chain — the window line says how far back (pg keeps the raw tape a few days; older days come from the lake when it answered). Sells of tokens bought before the window have no cost basis (soldWithoutBasisUsd) and are not counted as profit. 'holds' = bought minus sold in the window, not the on-chain balance. Always state the window when you give a number.",
    },
    addresses: [...addrs], citations: [{ label: `Wallet ${cshort(w)}`, href: `/ask/wallet` }], viz,
  };
}

// ── Chord's own Solana tape (Chord's services/ask/solTapeTools.ts) ───────────────────────────────────────────────────
// Swaps the Solana box decodes from the chain itself, read here through /v1/chains/solana/* (Chord's route over the same box).
// Different from solanaTools (Jupiter's index): these numbers are counted by Chord from on-chain swap events on the venues in
// SOL_TAPE_VENUES, since the tape was switched on. Every answer carries that coverage so the model can say what a figure covers.
// Token names and symbols are creator-chosen text: `untrusted`.

/** Chord's services/solTape constants (what the tape reads, for anyone presenting its numbers). */
export const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SOL_TAPE_VENUES = "PumpSwap, pump.fun, Meteora (DAMM v2, DLMM, DBC, dynamic pools), Raydium (CLMM, CPMM, v4, LaunchLab) and Orca";
export const SOL_TAPE_GAPS = "prop AMMs such as SolFi / HumidiFi and order books such as Phoenix are not read, so SOL/USDC-style majors are understated";
type SolBoardSort = "volume" | "trades" | "change" | "new";

// Shapes of /v1/chains/solana/* (Chord's schemas/sol.ts — the route passes the box's body through).
interface SolTokenRow { token: string; symbol: string | null; name: string | null; image: string | null; priceUsd: number | null; change24hPct: number | null; volume24hUsd: number; trades24h: number; buys24h: number; liquidityUsd: number | null; marketCapUsd: number | null; pool: string | null; dex: string | null; firstSeen: number | null }
interface SolOverview { volumeUsd: number; trades: number; tokensTraded: number; venues: { dex: string; volumeUsd: number; trades: number; share: number }[]; hourly: { hour: number; volumeUsd: number; trades: number }[]; coverageSince: number | null; coverageHours: number; buys?: number }
interface SolToken {
  token: string; symbol: string | null; name: string | null; image: string | null; decimals: number | null; priceUsd: number | null; change1hPct: number | null; change24hPct: number | null;
  marketCapUsd: number | null; liquidityUsd: number | null; volume24hUsd: number; trades24h: number; buys24h: number; sells24h: number;
  venues: { dex: string; volumeUsd: number; trades: number }[]; pools: { pool: string | null; dex: string; priceUsd: number | null; liquidityUsd: number | null; lastTrade?: number }[];
  firstSeen?: number | null; buyVolume24hUsd?: number; sellVolume24hUsd?: number;
}
interface SolTrade { ts: number; side: "buy" | "sell"; tokenAmount: number; usd: number | null; priceUsd: number | null; dex: string; wallet: string | null; tx: string }
interface SolPosition { token: string; symbol: string | null; boughtUsd: number; soldUsd: number; buys: number; sells: number; heldValueUsd: number | null; realizedPnlUsd: number | null; unrealizedPnlUsd: number | null; partial: boolean }
interface SolWallet { windowDays: number; tokens: number; trades: number; volumeUsd: number; realizedPnlUsd: number; unrealizedPnlUsd: number; heldValueUsd: number; winRate: number | null; partialTokens: number; likelyBot: boolean; positions: SolPosition[]; boughtUsd?: number; soldUsd?: number }
interface SolWalletTrade { ts: number; side: "buy" | "sell"; token: string; symbol: string | null; usd: number | null; priceUsd: number | null; dex: string; tx: string }
interface SolTrader { wallet: string | null; realizedPnlUsd: number; volumeUsd: number; trades: number; tokens: number; winRate: number | null }
interface SolTokenTrader { wallet: string | null; boughtUsd: number; soldUsd: number; netUsd: number; trades: number; realizedPnlUsd: number | null; partial: boolean; heldValueUsd?: number | null }

// ask2049: Chord's services/solTape getters (the box over WireGuard) → the public /v1/chains/solana/* routes, same timeouts.
const SOLP = "/v1/chains/solana";
const solOverview = () => read<SolOverview>(`${SOLP}/overview`, 30_000);
const solTokens = (sort: SolBoardSort, limit: number) => read<{ tokens: SolTokenRow[] }>(`${SOLP}/tokens?sort=${sort}&limit=${limit}`, 20_000);
const solToken = (mint: string, hours = 168) => read<SolToken>(`${SOLP}/token/${enc(mint)}?hours=${hours}`, 10_000);
const solTrades = (mint: string, limit: number) => read<{ trades: SolTrade[] }>(`${SOLP}/token/${enc(mint)}/trades?limit=${limit}`, 3_000);
const solCandles = (mint: string, tf: string, limit: number) => read<{ candles: { t: number; c: number }[] }>(`${SOLP}/token/${enc(mint)}/candles?tf=${enc(tf)}&limit=${limit}`, 20_000, 15_000);
const solSearch = (q: string) => read<{ tokens: { token: string | null; symbol: string | null }[] }>(`${SOLP}/search?q=${enc(q)}`, 20_000);
const solWallet = (addr: string, days = 7) => read<SolWallet>(`${SOLP}/wallet/${enc(addr)}?days=${days}`, 15_000, 12_000);
const solWalletTrades = (addr: string, limit: number) => read<{ trades: SolWalletTrade[] }>(`${SOLP}/wallet/${enc(addr)}/trades?limit=${limit}`, 5_000);
const solTraders = (sort: "pnl" | "volume", limit: number) => read<{ sort: string; botRule: string; traders: SolTrader[] }>(`${SOLP}/traders?sort=${sort}&limit=${limit}&days=1`, 60_000, 20_000);
const solTokenTraders = (mint: string, limit: number) => read<{ traders: SolTokenTrader[] }>(`${SOLP}/token/${enc(mint)}/traders?limit=${limit}&hours=24`, 30_000, 30_000);
/** Chord's SolTapeError(404) — the mint / wallet has never traded on the tape. */
const isSol404 = (e: unknown) => e instanceof ChordApiNotFound;

const SOURCE = "Chord Solana tape";
const r1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const sr2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const whole = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n));
const short = (m: string | null | undefined) => (!m ? "?" : m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString().slice(0, 16) + "Z" : null);
const usd = (n: number | null | undefined) => (n == null ? null : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(n >= 10 ? 0 : 2)}`);
const ago = (ts: number) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - ts)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };
const clampInt = (v: unknown, min: number, max: number, def: number) => { const n = Number(v); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def; };
const solscanTx = (sigB58: string) => `https://solscan.io/tx/${sigB58}`;
const WELL_KNOWN: Record<string, string> = { sol: SOL_MINT, wsol: SOL_MINT, usdc: USDC_MINT, usdt: USDT_MINT };

function coverageOf(ov: SolOverview | null) {
  const hours = ov ? r1(ov.coverageHours) : null;
  return {
    venues: SOL_TAPE_VENUES, notCovered: SOL_TAPE_GAPS, since: ov ? iso(ov.coverageSince) : null, hoursCovered: hours,
    note: hours != null && hours < 24
      ? `The tape has been running for ${hours} h: every "24 h" figure here covers only that long, and 24 h price changes are not available yet. Say so.`
      : "Figures are Chord's own count of on-chain swaps on the venues listed; they are lower than whole-market totals because of the venues not read. Say which venues they cover.",
  };
}
const bad = (error: string): ExtToolResult => ({ data: { error, note: "Fix the arguments or ask the person; do not guess." }, addresses: [], citations: [] });
const solFail = (e: unknown): ExtToolResult => {
  // Chord: a SolTapeError other than 503 (a bad argument, a mint never seen) is the caller's to fix.
  if (isSol404(e)) return bad("not found on Chord's Solana tape");
  if (e instanceof ChordReadError && e.status === 400 && e.code !== "UNSUPPORTED_CHAIN") return bad(e.message);
  return { data: extFailure(SOURCE, e), addresses: [], citations: [] };
};
const label = (r: { symbol?: string | null; name?: string | null; token: string }) => clean(r.symbol, 20) || clean(r.name, 24) || short(r.token);

/** An asset chip for a token of the tape (board #113): opens Ask's Solana view of the mint. Creator text cleaned, art https only. */
export function tapeChip(r: { token: string; symbol?: string | null; name?: string | null; image?: string | null; priceUsd: number | null; change24hPct: number | null; marketCapUsd?: number | null; volume24hUsd?: number | null; liquidityUsd?: number | null }): AssetChip {
  const logo = typeof r.image === "string" && /^https:\/\//.test(r.image) ? r.image : null;
  return {
    id: `sol:${r.token}`, symbol: clean(r.symbol, 24) || short(r.token), label: clean(r.name, 60) || clean(r.symbol, 24) || short(r.token), price: sig(r.priceUsd),
    change24hPct: sr2(r.change24hPct), hl: null, href: solAskHref(r.token), ...(logo ? { logo } : {}),
    marketCapUsd: whole(r.marketCapUsd), volume24hUsd: whole(r.volume24hUsd), liquidityUsd: whole(r.liquidityUsd), kind: "crypto", chainName: "Solana",
  };
}
/** Board rows that may become chips when the answer names them: a real market, not a dead launch. */
const tapeChipWorthy = (r: SolTokenRow) => (r.liquidityUsd ?? 0) >= 10_000 && r.volume24hUsd >= 1_000 && r.trades24h >= 10;

const boardRow = (r: SolTokenRow) => ({
  symbol: clean(r.symbol, 20) || null, name: clean(r.name, 40) || null, mint: r.token, priceUsd: sig(r.priceUsd), change24hPct: sr2(r.change24hPct),
  volumeUsd: whole(r.volume24hUsd), trades: r.trades24h, buySharePct: r.trades24h > 0 ? r1((r.buys24h / r.trades24h) * 100) : null,
  liquidityUsd: whole(r.liquidityUsd), marketCapUsd: whole(r.marketCapUsd), mainVenue: r.dex, firstSeenOnTape: iso(r.firstSeen),
});

const VIEWS: Record<string, SolBoardSort> = { volume: "volume", trades: "trades", gainers: "change", new: "new" };
async function solMarket(a: Record<string, any>): Promise<ExtToolResult> {
  const view = a.view === "overview" || a.view === "traders" || VIEWS[a.view] ? String(a.view) : "volume";
  const limit = clampInt(a.limit, 1, 25, 12);
  const ov = await solOverview();
  const coverage = coverageOf(ov);
  if (view === "traders") {
    const b = await solTraders(a.sort === "volume" ? "volume" : "pnl", limit);
    const rows = b.traders.map((t) => ({ wallet: t.wallet, realizedPnlUsd: whole(t.realizedPnlUsd), volumeUsd: whole(t.volumeUsd), trades: t.trades, tokens: t.tokens, winRatePct: t.winRate == null ? null : r1(t.winRate * 100) }));
    const viz: Viz[] = rows.length ? [{ kind: "table", title: `Solana wallets today by ${b.sort === "volume" ? "volume" : "realized PnL"} (Chord tape)`, columns: ["Wallet", "Realized PnL", "Volume", "Trades", "Tokens", "Win rate"], align: ["l", "r", "r", "r", "r", "r"],
      rows: rows.map((r) => [short(r.wallet), usd(r.realizedPnlUsd), usd(r.volumeUsd), r.trades, r.tokens, r.winRatePct == null ? null : `${r.winRatePct}%`]) }] : [];
    return { data: { source: SOURCE, board: "traders", sort: b.sort, window: "today (UTC day)", coverage, botRule: b.botRule, rows,
      note: "Realized PnL counts only tokens bought AND sold today on the venues the tape reads, at average cost; tokens still held are not in it. A wallet at the top of one day is not a track record. Say so." }, addresses: [], citations: [], viz };
  }
  if (view === "overview") {
    const venues = ov.venues.map((v) => ({ venue: v.dex, volumeUsd: whole(v.volumeUsd), sharePct: r1(v.share * 100), trades: v.trades }));
    const viz: Viz[] = venues.length ? [{ kind: "donut", title: "Solana volume by venue (Chord tape)", slices: venues.slice(0, 9).map((v) => ({ name: v.venue, value: v.volumeUsd ?? 0 })), unit: "usd" }] : [];
    return {
      data: { source: SOURCE, coverage, volumeUsd: whole(ov.volumeUsd), trades: ov.trades, buySharePct: ov.trades > 0 ? r1((Number(ov.buys) / ov.trades) * 100) : null, tokensTraded: ov.tokensTraded, venues,
        hourly: ov.hourly.slice(-24).map((h) => ({ hourUtc: iso(h.hour), volumeUsd: whole(h.volumeUsd), trades: h.trades })) },
      addresses: [], citations: [], viz,
    };
  }
  const b = await solTokens(VIEWS[view]!, limit);
  const rows = b.tokens.map(boardRow);
  if (!rows.length) {
    return { data: { source: SOURCE, board: view, coverage, rows: [], note: view === "gainers" ? "No 24 h price change yet: the tape needs a full day of history for this board. Say so; use the volume board instead." : "The board is empty right now. Say so." }, addresses: [], citations: [] };
  }
  const viz: Viz[] = [{
    kind: "table", title: `Solana tokens by ${view === "gainers" ? "24 h change" : view} (Chord tape)`,
    columns: ["Token", "Price", "24h %", "Volume", "Trades", "Liquidity", "Venue"], align: ["l", "r", "r", "r", "r", "r", "l"],
    rows: b.tokens.map((r) => [label(r), r.priceUsd == null ? null : `$${sig(r.priceUsd)}`, r.change24hPct == null ? null : `${sr2(r.change24hPct)}%`, usd(r.volume24hUsd), r.trades24h, usd(r.liquidityUsd), r.dex ?? null]),
  }];
  return { data: { source: SOURCE, board: view, coverage, rows }, addresses: b.tokens.map((r) => r.token), citations: [], viz, chipCandidates: b.tokens.filter(tapeChipWorthy).map(tapeChip) };
}

/** A mint, sol / usdc / usdt, or an exact symbol / name among the tokens the tape has seen (most traded first). */
async function resolveMint(q: unknown): Promise<{ mint: string; lookalikes: { symbol: string | null; mint: string }[] } | ExtToolResult> {
  const raw = String(q ?? "").trim().replace(/^\$/, "");
  if (!raw) return bad("token is required: a Solana mint address, or a symbol / name");
  if (WELL_KNOWN[raw.toLowerCase()]) return { mint: WELL_KNOWN[raw.toLowerCase()]!, lookalikes: [] };
  if (SOL_ADDR.test(raw)) return { mint: raw, lookalikes: [] };
  const s = await solSearch(raw.slice(0, 60));
  const hits = s.tokens.filter((t) => t.token);
  if (!hits.length) {
    return { data: { found: false, query: raw.slice(0, 40), source: SOURCE, note: "No token on Chord's Solana tape has exactly that symbol or name. Use sol_tokens (mode search) to find the mint, then call this tool with the mint. Do not guess a mint." }, addresses: [], citations: [] };
  }
  return { mint: hits[0]!.token!, lookalikes: hits.slice(1, 6).map((t) => ({ symbol: clean(t.symbol, 20) || null, mint: t.token! })) };
}
const isResult = (x: unknown): x is ExtToolResult => !!x && typeof x === "object" && "data" in (x as object);

function printRows(trades: SolTrade[]) {
  return trades.map((t) => ({ ago: ago(t.ts), timeUtc: iso(t.ts), side: t.side, usd: sr2(t.usd), tokens: sig(t.tokenAmount), priceUsd: sig(t.priceUsd), wallet: t.wallet, venue: t.dex, tx: t.tx }));
}
function printSummary(trades: SolTrade[]) {
  let buys = 0, sells = 0, buyUsd = 0, sellUsd = 0, largest = 0;
  const wallets = new Set<string>();
  for (const t of trades) {
    const u = t.usd ?? 0;
    if (t.side === "buy") { buys++; buyUsd += u; } else { sells++; sellUsd += u; }
    if (u > largest) largest = u;
    if (t.wallet) wallets.add(t.wallet);
  }
  const span = trades.length ? trades[0]!.ts - trades[trades.length - 1]!.ts : 0;
  return { prints: trades.length, spanSeconds: span, buys, sells, buyUsd: whole(buyUsd), sellUsd: whole(sellUsd), netBuyUsd: whole(buyUsd - sellUsd), largestUsd: whole(largest), uniqueWallets: wallets.size };
}

async function solTokenTool(a: Record<string, any>): Promise<ExtToolResult> {
  const r = await resolveMint(a.token);
  if (isResult(r)) return r;
  const nPrints = clampInt(a.prints, 0, 30, 8);
  let t: SolToken;
  try {
    t = await solToken(r.mint, 48);
  } catch (e) {
    if (isSol404(e)) {
      return { data: { found: false, mint: r.mint, source: SOURCE, coverage: coverageOf(null), note: "This mint has not traded on a venue Chord's tape reads since the tape was switched on. Say so; sol_tokens (Jupiter) may still know the token." }, addresses: [r.mint], citations: [] };
    }
    throw e;
  }
  const [ov, tr, cd, tt] = await Promise.all([
    solOverview().catch(() => null),
    nPrints > 0 ? solTrades(r.mint, 60).catch(() => null) : Promise.resolve(null),
    solCandles(r.mint, "1h", 48).catch(() => null),
    a.traders === false ? Promise.resolve(null) : solTokenTraders(r.mint, 8).catch(() => null),
  ]);
  const sym = label(t);
  const data = {
    source: SOURCE, coverage: coverageOf(ov),
    token: { symbol: clean(t.symbol, 20) || null, name: clean(t.name, 40) || null, mint: t.token, decimals: t.decimals, priceUsd: sig(t.priceUsd), change1hPct: sr2(t.change1hPct), change24hPct: sr2(t.change24hPct),
      marketCapUsd: whole(t.marketCapUsd), liquidityUsd: whole(t.liquidityUsd), firstSeenOnTape: iso(t.firstSeen) },
    last24h: { volumeUsd: whole(t.volume24hUsd), trades: t.trades24h, buys: t.buys24h, sells: t.sells24h, buyVolumeUsd: whole(t.buyVolume24hUsd), sellVolumeUsd: whole(t.sellVolume24hUsd),
      netBuyUsd: whole((t.buyVolume24hUsd ?? 0) - (t.sellVolume24hUsd ?? 0)) },
    venues: t.venues.slice(0, 6).map((v) => ({ venue: v.dex, volumeUsd: whole(v.volumeUsd), trades: v.trades })),
    pools: t.pools.slice(0, 5).map((p) => ({ pool: p.pool, venue: p.dex, priceUsd: sig(p.priceUsd), liquidityUsd: whole(p.liquidityUsd), lastTrade: p.lastTrade ? `${ago(p.lastTrade)} ago` : null })),
    recentPrints: tr ? { summary: printSummary(tr.trades), rows: printRows(tr.trades.slice(0, nPrints)) } : null,
    topTraders24h: tt ? tt.traders.map((x) => ({ wallet: x.wallet, boughtUsd: whole(x.boughtUsd), soldUsd: whole(x.soldUsd), netUsd: whole(x.netUsd), trades: x.trades, realizedPnlUsd: whole(x.realizedPnlUsd), stillHoldsUsd: whole(x.heldValueUsd), partial: x.partial || undefined })) : null,
    lookalikesOnTape: r.lookalikes.length ? r.lookalikes : undefined,
    note: "Symbol and name are whatever the token's creator typed: a familiar ticker on a tiny market cap is usually an imitation — say the mint and the market cap.",
  };
  const closes = cd?.candles ?? [];
  const viz: Viz[] = closes.length >= 3 ? [{ kind: "line", title: `${sym} price, hourly (Chord tape)`, x: closes.map((k) => (iso(k.t) ?? "").slice(5, 16)), series: [{ name: sym, values: closes.map((k) => sig(k.c)) }], unit: "price" }] : [];
  const citations: Citation[] = [{ label: `${sym} on Solscan`, href: solscanToken(t.token) }];
  return { data, addresses: [t.token], citations, viz, assets: [tapeChip(t)] };
}

async function solTradesTool(a: Record<string, any>): Promise<ExtToolResult> {
  const r = await resolveMint(a.token);
  if (isResult(r)) return r;
  const limit = clampInt(a.limit, 1, 100, 40);
  const minUsd = Number(a.min_usd) > 0 ? Number(a.min_usd) : 0;
  let tr: { trades: SolTrade[] };
  try {
    tr = await solTrades(r.mint, minUsd > 0 ? 200 : limit);
  } catch (e) {
    if (isSol404(e)) return { data: { found: false, mint: r.mint, source: SOURCE, note: "No prints for this mint on Chord's tape. Say so." }, addresses: [r.mint], citations: [] };
    throw e;
  }
  const all = tr.trades;
  const picked = (minUsd > 0 ? all.filter((t) => (t.usd ?? 0) >= minUsd) : all).slice(0, limit);
  if (!picked.length) {
    return { data: { source: SOURCE, mint: r.mint, rows: [], scanned: all.length, note: all.length ? `None of the last ${all.length} prints is at least $${minUsd}. Say so.` : "No prints in the last 48 h on the venues the tape reads. Say so." }, addresses: [r.mint], citations: [] };
  }
  const viz: Viz[] = [{
    kind: "table", title: `Latest Solana prints${minUsd ? ` ≥ $${minUsd}` : ""} (Chord tape)`, columns: ["Age", "Side", "USD", "Tokens", "Price", "Wallet", "Venue"], align: ["l", "l", "r", "r", "r", "l", "l"],
    rows: picked.map((t) => [ago(t.ts), t.side, t.usd == null ? null : usd(t.usd), sig(t.tokenAmount), t.priceUsd == null ? null : `$${sig(t.priceUsd)}`, short(t.wallet), t.dex]),
    links: picked.map((t) => solscanTx(t.tx)), linkCol: 0,
  }];
  return {
    data: { source: SOURCE, mint: r.mint, coverage: coverageOf(null), summary: printSummary(picked), scanned: all.length, rows: printRows(picked), lookalikesOnTape: r.lookalikes.length ? r.lookalikes : undefined },
    addresses: [r.mint], citations: [{ label: "Token on Solscan", href: solscanToken(r.mint) }], viz,
  };
}

async function solWalletTool(a: Record<string, any>): Promise<ExtToolResult> {
  const addr = String(a.wallet ?? "").trim();
  if (!SOL_ADDR.test(addr)) return bad("wallet must be a Solana address (base58, 32-44 characters, case-sensitive). EVM 0x wallets belong to the other wallet tools.");
  const days = clampInt(a.days, 1, 45, 7), nTrades = clampInt(a.trades, 0, 30, 10);
  const [w, tr, ov] = await Promise.all([solWallet(addr, days), nTrades > 0 ? solWalletTrades(addr, nTrades).catch(() => null) : Promise.resolve(null), solOverview().catch(() => null)]);
  if (!w.positions.length) {
    return { data: { found: false, wallet: addr, source: SOURCE, coverage: coverageOf(ov), note: `This wallet has no swap in the last ${days} days on the venues Chord's tape reads (or none since the tape was switched on). Say so; do not guess.` }, addresses: [], citations: [] };
  }
  const top = [...w.positions].slice(0, 12).map((p) => ({
    symbol: clean(p.symbol, 20) || null, mint: p.token, boughtUsd: whole(p.boughtUsd), soldUsd: whole(p.soldUsd), buys: p.buys, sells: p.sells,
    realizedPnlUsd: whole(p.realizedPnlUsd), unrealizedPnlUsd: whole(p.unrealizedPnlUsd), heldValueUsd: whole(p.heldValueUsd), partial: p.partial || undefined,
  }));
  const data = {
    source: SOURCE, coverage: coverageOf(ov), wallet: addr, windowDays: w.windowDays,
    totals: { tokens: w.tokens, trades: w.trades, volumeUsd: whole(w.volumeUsd), boughtUsd: whole(w.boughtUsd), soldUsd: whole(w.soldUsd), realizedPnlUsd: whole(w.realizedPnlUsd),
      unrealizedPnlUsd: whole(w.unrealizedPnlUsd), heldValueUsd: whole(w.heldValueUsd), winRatePct: w.winRate == null ? null : r1(w.winRate * 100), partialTokens: w.partialTokens, likelyBot: w.likelyBot },
    positions: top,
    recentTrades: tr ? tr.trades.map((t) => ({ ago: ago(t.ts), side: t.side, symbol: clean(t.symbol, 20) || short(t.token), mint: t.token, usd: sr2(t.usd), priceUsd: sig(t.priceUsd), venue: t.dex, tx: t.tx })) : null,
    note: "PnL is at average cost over the window and only for swaps on the venues the tape reads. `partial` = the wallet sold more of that token than it bought inside the window (bought earlier, or received by transfer): only the matched part is priced, so its real result differs. Transfers in or out are not seen. Say these limits when you give the numbers.",
  };
  const viz: Viz[] = [{ kind: "table", title: `Wallet ${short(addr)} on Solana, last ${w.windowDays} d (Chord tape)`, columns: ["Token", "Bought", "Sold", "Realized", "Unrealized", "Held"], align: ["l", "r", "r", "r", "r", "r"],
    rows: top.map((p) => [p.symbol ?? short(p.mint), usd(p.boughtUsd), usd(p.soldUsd), p.realizedPnlUsd == null ? null : usd(p.realizedPnlUsd), p.unrealizedPnlUsd == null ? null : usd(p.unrealizedPnlUsd), p.heldValueUsd == null ? null : usd(p.heldValueUsd)]) }];
  return { data, addresses: w.positions.slice(0, 12).map((p) => p.token), citations: [{ label: `Wallet ${short(addr)} on Solscan`, href: `https://solscan.io/account/${addr}` }], viz };
}

async function runSolTape(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  try {
    switch (name) {
      case "sol_tape_market": return await solMarket(args);
      case "sol_tape_token": return await solTokenTool(args);
      case "sol_tape_trades": return await solTradesTool(args);
      case "sol_tape_wallet": return await solWalletTool(args);
      default: return bad(`unknown tool ${name}`);
    }
  } catch (e) {
    return solFail(e);
  }
}

// ── Schemas + registry rows (verbatim from Chord's services/ask/schemas.ts, registry.ts and solTapeTools.ts) ──────────

const CHAIN_ENUM = { type: "string", enum: ["avalanche", "base", "bnb"], description: "avalanche = Avalanche C-Chain (AVAX), base = Base, bnb = BNB Chain (BSC)" };

export const RHCHAIN_TOOL_SCHEMAS = [
  // ── Monad (143) — the Chord mobile app's home chain (2026-09-21). Same tape (dex_trades), the
  // NullTerminal token registry + market map. Minimal set: list, one token, prints, top traders, wallet PnL, top wallets.
  {
    type: "function" as const,
    function: {
      name: "monad_tokens",
      description: "Tokens on Monad (chain 143) ranked by 24h volume from Chord's index: symbol, price, 24h change, volume, tags (meme/lst/stablecoin). Use for 'what is moving on Monad', 'top Monad tokens', or to resolve a Monad symbol like CHOG / WMON.",
      parameters: { type: "object", properties: { limit: { type: "number", description: "1..30, default 12" }, query: { type: "string", description: "optional symbol/name filter" } }, required: [] },
    },
  },
  // ── Robinhood Chain (chain 4663 — the Ask wallet's home chain; cash = USDG; tokenized stocks trade 24/7) ──
  {
    type: "function" as const,
    function: {
      name: "rh_stocks",
      description: "The tokenized-stock board on Robinhood Chain (chain 4663): price, 24h change, 24h volume, trades, traders, NAV and the premium/discount to it, and how much of the week traded outside US market hours. Use for 'which stocks are moving', 'what is trading on Robinhood Chain', 'is NVDA above NAV'.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["volume", "change", "trades", "traders"], description: "default volume" }, limit: { type: "integer", description: "default 15, max 50" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_tokens",
      description: "Every token traded on Robinhood Chain in the last 24h (stocks, USDG, WETH, memes): price, change, volume, trades, traders. Use for 'what is moving on Robinhood Chain' beyond stocks.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["volume", "change", "trades", "traders"] }, limit: { type: "integer", description: "default 15, max 50" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_token",
      description: "One token or tokenized stock on Robinhood Chain (NVDA, SPY, GLD, AAPL, USDG, WETH …): price, 5m/1h/6h/24h change + buy/sell volume + makers, liquidity, NAV and basis for stocks, the 7-day hourly volume profile and venue split, and the last 24 hourly candles. Use for any question about a specific stock or Robinhood Chain token.",
      parameters: { type: "object", properties: { token: { type: "string", description: "symbol (NVDA), company name, or 0x address on Robinhood Chain" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_token_trades",
      description: "Recent trades of a Robinhood Chain token or stock: side, USD size, price, wallet, venue, minutes ago. Use for 'who is buying NVDA', 'last big sells of SPY'.",
      parameters: { type: "object", properties: { token: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, min_usd: { type: "number" }, limit: { type: "integer", description: "default 20, max 50" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_wallet_pnl",
      description: "A wallet's PnL on Robinhood Chain: realized, unrealized, total and per-token rows (stocks and tokens). Use for 'my PnL on Robinhood Chain', 'how is wallet W doing on stocks' — the person's Ask wallet address works here.",
      parameters: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_overview",
      description: "Robinhood Chain (4663) in one read: 24h volume, swaps and tokens traded, venue split, the hourly curve for the last day and 30 days of daily volume / wallets. Use for 'how is Robinhood Chain doing', 'volume on Robinhood Chain today', 'how many wallets trade stocks'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_venues",
      description: "Venues (DEXs) on Robinhood Chain over N days: volume, trades, share, daily series. Use for 'which DEX does the stock volume', 'Uniswap share on Robinhood Chain'.",
      parameters: { type: "object", properties: { days: { type: "integer", description: "1..90, default 7" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_search",
      description: "Search Robinhood Chain tokens (stocks, ETFs, USDG, WETH, memes that traded in the last 24h) by symbol or company name. Use to resolve 'the Apple token', 'any SpaceX stock?', or when rh_token does not find a name.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_token_flow",
      description: "Order flow of a Robinhood Chain token: 5m / 1h / 6h / 24h change, buys vs sells in USD, buyers vs sellers, ATH and 24h range. Use for 'is NVDA being bought or sold', 'buy pressure on TSLA'.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_candles",
      description: "OHLCV candles of a Robinhood Chain token (5m, 15m, 1h, 4h, 1d) from Chord's index. Use for 'NVDA chart', 'price history of SPY this week'.",
      parameters: { type: "object", properties: { token: { type: "string" }, tf: { type: "string", enum: ["5m", "15m", "1h", "4h", "1d"] }, limit: { type: "integer", description: "1..120, default 48" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_wallet_trades",
      description: "A wallet's swaps on Robinhood Chain: per-token totals and the most recent trades, or every trade on one token. Use for 'what did W buy on Robinhood Chain', 'my stock trades', 'how did W trade NVDA'.",
      parameters: { type: "object", properties: { wallet: { type: "string" }, token: { type: "string", description: "optional token filter" }, limit: { type: "integer", description: "default 20, max 40" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_wallet_pnl_calendar",
      description: "A wallet's realized PnL by day on Robinhood Chain. Use for 'my daily PnL on stocks', 'W's best day'.",
      parameters: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_top_wallets",
      description: "The best-performing wallets on Robinhood Chain from the on-chain tape (routers and bots removed): PnL, volume, win rate, archetype, top token. Use for 'smart money on Robinhood Chain', 'top stock traders'.",
      parameters: { type: "object", properties: { window: { type: "string", enum: ["24h", "7d", "30d"] }, limit: { type: "integer", description: "1..15, default 8" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_compare",
      description: "Side by side for 2–6 Robinhood Chain tokens or stocks: price, 24h change, volume, trades, traders, buy share, liquidity, and for stocks NAV + premium/discount and off-hours share. Use for 'NVDA vs AMD', 'compare SPY QQQ'.",
      parameters: { type: "object", properties: { tokens: { type: "array", items: { type: "string" } } }, required: ["tokens"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rh_holders",
      description: "Who holds a Robinhood Chain token or stock, from Chord's holder ledger (every Transfer since the token's first block): holder count, the largest holders with their share of supply and whether each is a wallet or a pool, top-1/10/50 concentration, and how much of supply sits in wallets. Use for 'who holds NVDA on-chain', 'how concentrated is this meme', 'holders of X'. A token not yet in the ledger is queued; say it is being built and give the backfill progress when the tool reports it.",
      parameters: { type: "object", properties: { token: { type: "string" }, limit: { type: "integer", description: "1..25, default 10" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "monad_token",
      description: "One Monad token: price, 5m/1h/6h/24h change + buy/sell volume + makers, liquidity, ATH, 24h range, first trade, and the last 24 hourly candles. Use for any question about a specific Monad token (CHOG, WMON, cbBTC…).",
      parameters: { type: "object", properties: { token: { type: "string", description: "symbol or 0x address on Monad" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "monad_token_trades",
      description: "Recent prints of a Monad token: side, USD, tokens, price, wallet, minutes ago; filter by side / min USD. Use for 'who is buying/selling X on Monad right now'.",
      parameters: { type: "object", properties: { token: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, min_usd: { type: "number" }, limit: { type: "number", description: "1..50, default 20" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "monad_token_traders",
      description: "Top wallets by PnL on one Monad token (24h / 7d / all): bought, sold, realized, unrealized, still holding. Use for 'who made the most on X' on Monad.",
      parameters: { type: "object", properties: { token: { type: "string" }, window: { type: "string", enum: ["24h", "7d", "all"] }, limit: { type: "number", description: "1..25, default 10" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "monad_wallet_pnl",
      description: "Average-cost PnL of a wallet on Monad by token (realized, unrealized, still holds, ROI). Use for 'how much did W make on Monad' or the person's own Monad PnL.",
      parameters: { type: "object", properties: { wallet: { type: "string", description: "0x address" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "monad_top_wallets",
      description: "Best-performing wallets on Monad from the on-chain tape (routers and bots removed): PnL, volume, win rate, archetype. Use for 'smart money on Monad', 'top Monad traders'.",
      parameters: { type: "object", properties: { window: { type: "string", enum: ["24h", "7d", "30d"] }, limit: { type: "number", description: "1..15, default 8" } }, required: [] },
    },
  },
  // ── Avalanche (43114) · Base (8453) · BNB Chain (56) — one set, chain argument (services/ask/chainTools, 2026-10-02) ──
  {
    type: "function" as const,
    function: {
      name: "chain_overview",
      description: "Avalanche, Base or BNB Chain in one read from Chord's own index: 24h DEX volume, swaps, tokens traded, venue split, wallets today and 14 days of daily volume. Use for 'how is Base doing', 'volume on BNB Chain today', 'which DEX leads on Avalanche'.",
      parameters: { type: "object", properties: { chain: CHAIN_ENUM }, required: ["chain"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chain_tokens",
      description: "The 24h token board of Avalanche, Base or BNB Chain from Chord's index: price, 24h change, volume, trades, buy share, top venue, whether the token is on the chain's curated list. Sort volume / trades / change (gainers; dust under $10k volume left out). `query` filters by symbol or name — use it to find a token's address on that chain. Use for 'what is moving on Base', 'top BNB tokens', 'trending on Avalanche'.",
      parameters: { type: "object", properties: { chain: CHAIN_ENUM, sort: { type: "string", enum: ["volume", "trades", "change"] }, limit: { type: "integer", description: "1..30, default 12" }, query: { type: "string", description: "optional symbol / name filter" } }, required: ["chain"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chain_token",
      description: "One token on Avalanche, Base or BNB Chain (AVAX, JOE, AERO, BRETT, CAKE, a meme, or a 0x address): price, 24h and 7d change, 24h high/low, volume, trades and buy share, venues over 7 days, daily volume, look-alikes sharing the symbol, and the last 48 hourly closes. Use for any question about a specific token on those chains. The native coin (AVAX / ETH / BNB) reads as its wrapped token.",
      parameters: { type: "object", properties: { chain: CHAIN_ENUM, token: { type: "string", description: "symbol, name or 0x address on that chain" } }, required: ["chain", "token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chain_token_trades",
      description: "Recent trades of a token on Avalanche, Base or BNB Chain: side, USD size, price, wallet, venue, minutes ago (from the last 200 prints). Use for 'who is buying X on Base', 'last big sells of CAKE'.",
      parameters: { type: "object", properties: { chain: CHAIN_ENUM, token: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, min_usd: { type: "number" }, limit: { type: "integer", description: "default 20, max 50" } }, required: ["chain", "token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chain_wallet",
      description: "A wallet's swaps and PnL on Avalanche, Base or BNB Chain from Chord's index: realized, unrealized, per-token bought / sold / still held, recent trades. The index keeps only the last few days of raw trades on these chains (the answer states the window — repeat it). No chain = all three. Use for 'my PnL on Base', 'what is wallet W doing on BNB'.",
      parameters: { type: "object", properties: { wallet: { type: "string" }, chain: { type: "string", enum: ["avalanche", "base", "bnb"], description: "optional; omit to read all three" } }, required: ["wallet"] },
    },
  },
  // ── Chord's own Solana tape (services/ask/solTapeTools.ts) ──
  {
    type: "function" as const,
    function: {
      name: "sol_tape_market",
      description: "Solana right now from Chord's OWN tape (on-chain swaps Chord decodes itself on PumpSwap, pump.fun, Meteora, Raydium CLMM / CPMM / LaunchLab and Orca). view overview = 24 h volume, trades, share by venue, hourly buckets; volume / trades = the token board ranked that way; gainers = 24 h price change among the 400 most traded tokens with at least $5k volume; new = tokens first seen in the last 24 h; traders = today's wallets by realized PnL (or sort volume), bots left out. Token rows: price, 24 h change, volume, trades, buy share, liquidity, market cap, main venue, mint. Always repeat the coverage it returns (which venues, since when).",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: ["overview", "volume", "trades", "gainers", "new", "traders"], description: "default volume" },
          limit: { type: "integer", description: "rows on a board, 1..25 (default 12)" },
          sort: { type: "string", enum: ["pnl", "volume"], description: "traders view only; default pnl" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sol_tape_token",
      description: "One Solana token on Chord's own tape: price, 1 h / 24 h change, market cap, liquidity, 24 h volume with buys vs sells, volume by venue, its pools, the latest prints with wallets, and an hourly price line. token = the mint (preferred), or an exact symbol / name the tape has seen (the most traded match is used and look-alikes are listed). found false = the mint has not traded on a venue the tape reads; use sol_tokens (Jupiter) to find or check a mint.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "mint address (base58, case-sensitive) or an exact symbol / name" },
          prints: { type: "integer", description: "how many of the latest prints to list, 0..30 (default 8)" },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sol_tape_trades",
      description: "The latest swaps of one Solana token from Chord's own tape, newest first: age, side, USD size, tokens, price, wallet, venue, transaction. min_usd keeps only prints of at least that size (scans the last 200). Returns buy / sell counts and dollars, the largest print and the number of distinct wallets. Use it for who is buying or selling, whale prints, or flow in the last minutes.",
      parameters: {
        type: "object",
        properties: {
          token: { type: "string", description: "mint address (base58, case-sensitive) or an exact symbol / name" },
          limit: { type: "integer", description: "1..100 (default 40)" },
          min_usd: { type: "number", description: "only prints of at least this many dollars" },
        },
        required: ["token"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sol_tape_wallet",
      description: "One Solana wallet on Chord's own tape: per token what it bought and sold (USD, counts), realized PnL at average cost, what it still holds and the unrealized PnL at the current price, totals with win rate, whether it looks like a bot, and its latest swaps. Covers swaps on the venues the tape reads inside the window; transfers are not seen and `partial` marks tokens sold beyond what was bought in the window. wallet = a base58 Solana address.",
      parameters: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Solana address (base58, case-sensitive)" },
          days: { type: "integer", description: "window, 1..45 (default 7)" },
          trades: { type: "integer", description: "latest swaps to list, 0..30 (default 10)" },
        },
        required: ["wallet"],
      },
    },
  },
];

export const RHCHAIN_TOOL_META: Record<string, ToolMeta> = {
  monad_tokens: { group: "monad", label: "Reading Monad markets", market: true },
  rh_stocks: { group: "rh", label: "Reading the stock board", market: true },
  rh_tokens: { group: "rh", label: "Reading Robinhood Chain tokens", market: true },
  rh_token: { group: "rh", label: "Looking up the stock" },
  rh_token_trades: { group: "rh", label: "Reading recent prints", timeoutMs: 25_000 },
  rh_wallet_pnl: { group: "rh", label: "Computing Robinhood Chain PnL", timeoutMs: 30_000 },
  rh_overview: { group: "rh", label: "Reading the Robinhood Chain index", market: true },
  rh_venues: { group: "rh", label: "Reading venue volume", market: true },
  rh_search: { group: "rh", label: "Searching Robinhood Chain", market: true },
  rh_token_flow: { group: "rh", label: "Reading order flow" },
  rh_candles: { group: "rh", label: "Reading candles" },
  rh_wallet_trades: { group: "rh", label: "Reading the wallet's trades", timeoutMs: 25_000 },
  rh_wallet_pnl_calendar: { group: "rh", label: "Reading the wallet's daily PnL", timeoutMs: 30_000 },
  rh_top_wallets: { group: "rh", label: "Ranking wallets", market: true },
  rh_compare: { group: "rh", label: "Comparing tokens", market: true },
  rh_holders: { group: "rh", label: "Reading the holder ledger" },
  monad_token: { group: "monad", label: "Looking up the Monad token" },
  monad_token_trades: { group: "monad", label: "Reading Monad prints" },
  monad_token_traders: { group: "monad", label: "Ranking Monad traders" },
  monad_wallet_pnl: { group: "monad", label: "Computing Monad PnL", timeoutMs: 30_000 },
  monad_top_wallets: { group: "monad", label: "Ranking Monad wallets", market: true },
  chain_overview: { group: "chains", label: "Reading the chain's index", market: true },
  chain_tokens: { group: "chains", label: "Reading the token board", market: true },
  chain_token: { group: "chains", label: "Looking up the token" },
  chain_token_trades: { group: "chains", label: "Reading recent prints", timeoutMs: 20_000 },
  chain_wallet: { group: "chains", label: "Computing the wallet's PnL", timeoutMs: 25_000 },
  sol_tape_market: { group: "solana", label: "Reading Chord's Solana tape", market: true, untrusted: true, timeoutMs: 15_000 },
  sol_tape_token: { group: "solana", label: "Looking up the Solana token on the tape", untrusted: true, timeoutMs: 20_000 },
  sol_tape_trades: { group: "solana", label: "Reading Solana prints", untrusted: true, timeoutMs: 15_000 },
  sol_tape_wallet: { group: "solana", label: "Reading the Solana wallet on the tape", untrusted: true, timeoutMs: 25_000 },
};

export const RHCHAIN_TOOL_NAMES: string[] = RHCHAIN_TOOL_SCHEMAS.map((t) => t.function.name);
const NAMES = new Set(RHCHAIN_TOOL_NAMES);
const CHAIN_NAMES = new Set(["chain_overview", "chain_tokens", "chain_token", "chain_token_trades", "chain_wallet"]);
export const isRhChainTool = (name: string): boolean => NAMES.has(name);
/** Every tool here reads Chord's public API, keyless; Solana is public to anonymous callers since 2026-10-04. A chain Chord
 *  turns dark answers "not available" at call time instead. */
export const rhChainToolOffered = (name: string): boolean => isRhChainTool(name);

/** Runs one tool of this family; never throws — a source that cannot be read answers {error, note}. */
export async function runRhChainTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  if (!isRhChainTool(name)) return { data: { error: `unknown tool ${name}` }, addresses: [], citations: [] };
  const a = args ?? {};
  if (name.startsWith("sol_tape_")) return runSolTape(name, a);
  try {
    return await (CHAIN_NAMES.has(name) ? runChain(name, a) : runMonadRh(name, a));
  } catch (e) {
    const msg = e instanceof ChordReadError || e instanceof ChordApiNotFound ? e.message : String((e as Error)?.message ?? e);
    return { data: { error: msg.slice(0, 160), note: "Chord's index did not answer just now. Say the data is unavailable; do not guess numbers." }, addresses: [], citations: [] };
  }
}
