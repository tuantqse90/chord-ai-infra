// Arc tools for Ask, moved out of Chord's askAgent.ts `runTool` switch (ask2049 port, 2026-10-06): the Arc market / token /
// wallet reads, the LP agent's pool and position reads, the router depth probes, StableFX settlements, Chord facts and points.
// Same contract as marketTools.ts (schemas, registry rows, is* / run* / offered*). Chord's case bodies read its own services
// (Postgres, Redis); here every read goes to the PUBLIC REST API those services serve (api.getchord.xyz via services/chordApi.ts):
//   arc_overview /v1/arc/overview · arc_trending /v1/arc/trending · arc_tokens /v1/arc/tokens · arc_search + every token name
//   /v1/arc/tokens/search · arc_token, arc_token_pools /v1/arc/token/:a (+ /pools) · arc_holders /v1/arc/token/:a/holders ·
//   arc_new_launches /v1/arc/graduated · arc_launchers /v1/arc/launchers · arc_venues /v1/arc/venues · arc_index_status
//   /v1/arc/status · arc_attention /v1/arc/attention · arc_market_breadth overview + tokens + graduated ·
//   arc_token_flow /v1/tokens/stats/:a · arc_token_trades /v1/tokens/trades/:a · arc_candles /v1/tokens/chart/:a ·
//   arc_price_analysis, arc_compare chart (5m + 1h) + stats + trades ≥ $300 + holders, then Chord's priceAnalysis ·
//   arc_wallet_trades /v1/tokens/trades/:a?wallet= or /v1/portfolio/:w/trades · arc_wallet_pnl /v1/portfolio/:w/pnl ·
//   arc_wallet_pnl_calendar /v1/portfolio/:w/pnl-calendar · arc_wallet_profile portfolio trades + /v1/smart-money/top ·
//   arc_top_wallets /v1/smart-money/top · arc_picks /v1/ask/picks (+ 1h candles for the move since each pick) ·
//   arc_depth, arc_execution_plan /v1/quote?chain=5042 · arc_fx /v1/arc/fx + /v1/arc/fx/trades ·
//   lp_pools /v1/lp/pools · lp_pool /v1/lp/pools/:pool · lp_suggest_range /v1/tokens/chart/:a (1h) + Chord's rangeProfiles ·
//   lp_plan /v1/lp/plan · lp_token_pools /v1/lp/token/:a/pools · lp_overview /v1/lp/overview · lp_wallet_positions
//   /v1/lp/positions · lp_position /v1/lp/position/5042/:m/:id · lp_top_wallets /v1/lp/leaderboard · lp_flow /v1/lp/token/:a
//   or /v1/lp/events · chord_points /v1/points/* · chord_facts Chord's static table.
// Output fields, notes, citations, addresses and viz are Chord's, line for line (the model prompts and skills read those notes);
// a change is marked `// ask2049:`. Chord's `artifact` / `walletArtifact` (its side panel) have no counterpart here and are
// dropped. Not ported, because no public route serves what the case reads: arc_token_traders (/v1/tokens/traders is guarded to
// the Monad list and has no chain), arc_largest_trades, arc_cotraders, arc_buyer_quality, arc_holder_trend, arc_tx, arc_sql,
// token_performance (SQL over Chord's tape / snapshot tables), arc_token_risk (the report builder's risk flags).
import type { ToolMeta } from "./registry";
import type { Citation, Viz } from "../askAgent";
import type { ExtToolResult } from "./extHttp";
import { config, chordHeaders } from "../../../config";
import { ChordApiNotFound, chordGet } from "../chordApi";

const CHAIN = 5042;
const USDC = "0x3600000000000000000000000000000000000000"; // predeploy, 6 decimals — the only quote leg the API takes on Arc
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── Chord's public API: the reads Chord's services answer in-process ────────────────────────────────────────────────
// chordGet (services/chordApi.ts) caches each path for its TTL and serves the last good answer when a refresh fails.
// chordRaw is for the few reads where the status or the error code is the answer (a 503 HOLDERS_PENDING is "being built",
// not "unavailable"; a quote must never be served stale), uncached, with the same browser User-Agent.
const UA = "Mozilla/5.0 (compatible; ask2049)";
async function chordRaw(path: string, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
  const r = await fetch(`${config.chordApi() || "https://api.getchord.xyz"}${path}`, { headers: chordHeaders({ "User-Agent": UA }), signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
/** Query string; undefined / null / "" dropped. */
const qs = (params: Record<string, string | number | undefined | null>): string => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};
const TTL = { board: 60_000, search: 60_000, symbol: 10 * 60_000, token: 60_000, stats: 30_000, trades: 15_000, chart: 60_000, wallet: 60_000, lp: 30_000 };

/** One row of Chord's Arc boards (services/arcRollup ArcTokenRow). */
export interface ArcTokenRow {
  address: string; symbol: string | null; name: string | null; decimals: number | null; logoURI: string | null; tags: string[]; listed: boolean;
  priceUsd: number | null; change24hPct: number | null; volume24h: number; buyVolume24h: number; sellVolume24h: number; trades24h: number; buys24h: number; sells24h: number;
  traders: number; lastTradeTs: number; totalSupply: number | null; marketCapUsd: number | null; pools: { v3: number; v2: number; v4: number; byDex: Record<string, number> }; routable: boolean;
  flags?: ("wash" | "impostor")[];
}
type ArcTokenSort = "volume" | "trades" | "traders" | "change" | "mcap";
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
type PfTrade = { t: number; side: "buy" | "sell"; usd: number; tokenAmt: number; token: string; symbol: string; tx: string };

const searchArcTokens = (query: string, limit: number) => chordGet<{ tokens: ArcTokenRow[] }>(`/v1/arc/tokens/search${qs({ q: query, limit })}`, TTL.search);
const getArcOverview = () => chordGet<any>("/v1/arc/overview", TTL.board);
const getArcTrending = (limit: number) => chordGet<{ tokens: (ArcTokenRow & { volNow: number; tradesNow: number; change1hPct: number | null; momentum: number | null })[] }>(`/v1/arc/trending${qs({ limit })}`, TTL.board);
const getArcTokens24h = (o: { limit: number; sort: ArcTokenSort; includeUnlisted: true }) => chordGet<{ total: number; tokens: ArcTokenRow[] }>(`/v1/arc/tokens${qs({ limit: o.limit, sort: o.sort, includeUnlisted: 1 })}`, TTL.board);
const getArcTokenHourly = (a: string, hours: number) => chordGet<{ series: { hour: number; volUsd: number; trades: number; priceLast: number | null }[]; byDex: unknown[] }>(`/v1/arc/token/${a}${qs({ hours })}`, TTL.token);
const getArcTokenPools = (a: string) => chordGet<{ pools: { pool: string; dex: string; kind: string; fee: number | null; hooks?: string }[] }>(`/v1/arc/token/${a}/pools`, TTL.token);
const getArcGraduated = (o: { hours: number; limit: number }) => chordGet<{ hours: number; total: number; screened: Record<string, number>; tokens: (ArcTokenRow & { ageSec: number; launcher: string; creator: string })[] }>(`/v1/arc/graduated${qs(o)}`, TTL.board);
const getLaunchers = (hours: number) => chordGet<{ launchers: any[] }>(`/v1/arc/launchers${qs({ hours })}`, TTL.board);
const getArcVenues = (days: number) => chordGet<any>(`/v1/arc/venues${qs({ days })}`, TTL.board);
const getAttention = async (days: number, limit: number) => (await chordGet<{ rows?: { token: string; score: number; ask: number; search: number; view: number; watch: number }[] }>(`/v1/arc/attention${qs({ days, limit })}`, TTL.board)).rows ?? [];
const getTokenStats = (a: string) => chordGet<any>(`/v1/tokens/stats/${a.toLowerCase()}`, TTL.stats);
// ask2049: Chord's getTokenTradesPage also takes `since` (Ask's big-print scans stop at 24 h); the route has no such parameter,
// so arc_token_trades filters the newest rows by time instead (same rows: the page is newest first).
const getTokenTradesPage = (a: string, o: { side?: string; minUsd?: number; wallet?: string; limit: number }) =>
  chordGet<{ trades: any[]; total: number; stats24h: unknown }>(`/v1/tokens/trades/${a.toLowerCase()}${qs({ side: o.side, min: o.minUsd || undefined, wallet: o.wallet, limit: o.limit })}`, TTL.trades);
const getDbChart = async (a: string, tf: string, chain?: number): Promise<Candle[]> =>
  (await chordGet<{ candles?: Candle[] }>(`/v1/tokens/chart/${a.toLowerCase()}${qs({ tf, chain })}`, TTL.chart)).candles ?? [];
const getArcTokenHolders = (a: string, limit: number) => chordGet<any>(`/v1/arc/token/${a}/holders${qs({ limit })}`, TTL.token);
// ask2049: the /v1/portfolio routes answer an EMPTY payload when their read fails (routes/portfolio.ts catch-all), so an empty
// answer here is "nothing found or could not read" — the tools say so instead of stating the wallet never traded.
const getWalletTapeTrades = async (w: string): Promise<PfTrade[]> => (await chordGet<{ trades?: PfTrade[] }>(`/v1/portfolio/${w}/trades${qs({ chain: CHAIN })}`, TTL.wallet)).trades ?? [];
const getWalletPnl = (w: string) => chordGet<{ tokens: any[]; realized: number; unrealized: number; total: number }>(`/v1/portfolio/${w}/pnl${qs({ chain: CHAIN })}`, TTL.wallet);
const getWalletPnlCalendar = (w: string) => chordGet<{ days: any[]; firstDate: string | null; realizedTotal: number }>(`/v1/portfolio/${w}/pnl-calendar${qs({ chain: CHAIN })}`, TTL.wallet);
const EMPTY_READ_NOTE = "Chord's public API returns this same empty answer when its read fails — if the person expects activity here, say the history could not be confirmed right now; do not state the wallet never traded.";

/** Symbol / name / address → one Arc token (exact symbol wins, then listed, then volume). USDC is the predeploy. */
export async function resolveArcToken(q: string): Promise<ArcTokenRow | null> {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  if (s === "usdc" || s === USDC) {
    return { address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, logoURI: null, tags: ["stable"], listed: true, priceUsd: 1, change24hPct: 0, volume24h: 0, buyVolume24h: 0, sellVolume24h: 0, trades24h: 0, buys24h: 0, sells24h: 0, traders: 0, lastTradeTs: 0, totalSupply: null, marketCapUsd: null, pools: { v3: 0, v2: 0, v4: 0, byDex: {} }, routable: true };
  }
  if (s.length > 64) return null; // ask2049: the search route takes 1..64 characters
  const r = await searchArcTokens(s, 8);
  const exact = r.tokens.filter((t) => (t.symbol ?? "").toLowerCase() === s);
  const pick = (exact.length ? exact : r.tokens).sort((a, b) => Number(b.listed) - Number(a.listed) || b.volume24h - a.volume24h)[0];
  return pick ?? null;
}

/** Symbols for a set of addresses (largest-trades rows carry only the address). */
async function searchArcTokensMany(addrs: string[]): Promise<Map<string, { symbol: string | null }>> {
  const out = new Map<string, { symbol: string | null }>();
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].slice(0, 30);
  // ask2049: one public search per address (Chord searches in-process), cached 10 minutes — a symbol does not change.
  await Promise.all(uniq.map(async (a) => { try { const r = await chordGet<{ tokens: ArcTokenRow[] }>(`/v1/arc/tokens/search${qs({ q: a, limit: 1 })}`, TTL.symbol); out.set(a, { symbol: r.tokens[0]?.symbol ?? null }); } catch { out.set(a, { symbol: null }); } }));
  return out;
}

// ── helpers copied from Chord's askAgent.ts (module-level there) ──────────────────────────────────────────────────────
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });
const slimRow = (t: ArcTokenRow) => ({
  address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, listed: t.listed, routable: t.routable,
  priceUsd: t.priceUsd, change24hPct: t.change24hPct, volume24hUsd: Math.round(t.volume24h),
  buySharePct: t.volume24h > 0 ? +((t.buyVolume24h / t.volume24h) * 100).toFixed(1) : null,
  trades24h: t.trades24h, traders: t.traders, marketCapUsd: t.marketCapUsd, pools: t.pools,
});
const tokenCite = (t: { address: string; symbol: string | null }): Citation => ({ label: `${t.symbol ?? t.address.slice(0, 8)} on Arc`, href: `/arc/token/${t.address}` });
const minsAgo = (ts: number) => Math.round((Date.now() / 1000 - ts) / 60);
const walletCite = (w: string): Citation => ({ label: `Wallet ${w.slice(0, 6)}…${w.slice(-4)}`, href: `/portfolio?address=${w}` });
/** Dollars for tool output: whole dollars above $100, cents below — a $0.47 position must not read "$0". */
const usdN = (x: number | null | undefined): number | null => (x == null || !Number.isFinite(x) ? null : Math.abs(x) >= 100 ? Math.round(x) : +x.toFixed(2));
const r2 = (n: number) => Math.round(n * 100) / 100;
const sig = (x: number) => Number(x.toPrecision(5));

/** Addresses that are plumbing, not a person (Chord's services/arcAddresses ARC_ADDRESS_GROUPS, 2026-10-06: periphery,
 *  relayers, launchers, V4 hooks, bot contracts). A static registry in Chord too — re-copy when Chord adds one. */
const ARC_NON_USER_SET: ReadonlySet<string> = new Set([
  // periphery
  "0x1b1fee89a381e595fe6536b99ba91f3e16e9601a", "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77", "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1", "0x919c548ea8a779e0e551ef35f6aba65565b140a7",
  "0x7dfd4f31be6814d2906bde155c3e1b146eac1468", "0x39654a85a4c05127f5fd6ed22caec077a0fb1377", "0x8366a39cc670b4001a1121b8f6a443a643e40951", "0x465143146049aede3f120714e57c2a0c48967384",
  "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b", "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", "0x8dc178efb8111bb0973dd9d722ebeff267c98f94", "0x000000000022d473030f116ddee9f6b43ac78ba3",
  "0xca11bde05977b3631167028862be2a173976ca11", "0x0000000071727de22e5e9d8baf0edac6f37da032", "0x0000000000000000000000000000000000000000",
  // relayers
  "0xf70da97812cb96acdf810712aa562db8dfa3dbef",
  // launchers
  "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0", "0xee3e862efde6dcd6df5648af0e2731b9d1df4605", "0x7e5aeacff30dabedc729a0456f99f3f80aa2217c", "0x74bcd3ec24a313f2d6d07b8c3e7fc6be38adb983",
  // V4 hooks
  "0x20eead6db6b3d0a4491e9073119dd0ebff166acc", "0xf73a3f56c533f7f1146fbc97806f07efa66ce0cc", "0x6b27d63f529370d6bb5972bfca762360d28e3ff0",
  // bot contracts
  "0x333d54566d423a7c0243c8c6ec81a3264c4d5333", "0x38a006cc0c8c9eb4669280145e40cade99e1b3db", "0xa130577e3fcd1775e6ae51c89aa5d0d4c586484c", "0x3dd1afd32665edccbe750663e0a5150a990be9f3",
  "0x00000000e91fc5bad977c0cc4ad60557c06886a2", "0xa34db93f4e47c589919b42cbfa7b9c2da6449f72", "0x495d77302a8c488ebaa0a4c7e7b6c6c940cfb155", "0x1fe7fabfe9f1d35c2ecd9427b93ae0a781b4fb87",
  "0x114d574247342eafea95b7a9234e62984d48cd9e", "0x4aebbbf1ab3522f39920da950882aba7726a3ac4", "0xfea2a3bea7ecb406031ea6679d8f58e9db4edaee", "0x0cf929afcfe846feea4b4487c4d44d4c36abb498",
  "0x23cca1f8858a9a1c625386a47993066bf9758c92", "0x2d5059d60b146c792d14e7e599045f4ffea64edf", "0xbada501d409630068d73ab4365dd57624a20f862",
]);
/** True when `addr` (any case) is plumbing, not a person. */
export function isArcNonUser(addr: string | null | undefined): boolean {
  return !!addr && ARC_NON_USER_SET.has(addr.toLowerCase());
}

// ── Chord facts (askAgent.ts CHORD_FACTS, verbatim) ───────────────────────────────────────────────────────────────────
// Curated facts — the product answers, in the product's words. Kept next to the tool so a change
// in fees or custody lands here in the same commit (CLAUDE.md: doc what code cannot say).
const CHORD_FACTS: { keys: string[]; text: string }[] = [
  { keys: ["chain", "arc", "network", "gas", "usdc"], text: "Chord trades on Arc (chain id 5042), Circle's stablecoin L1 where gas is paid in USDC. Chord also indexes Robinhood Chain (4663) for tokenized stocks. Every Arc figure on the site comes from Chord's own index of on-chain trades, not a third-party feed." },
  { keys: ["custody", "wallet", "keys", "sign", "safe", "secure", "non-custodial"], text: "Chord is non-custodial. You trade from your own wallet and sign every transaction yourself. Chord never holds your keys or funds, and the assistant cannot execute, approve or move anything — it can only show you a quote to open on the token page." },
  { keys: ["fee", "fees", "cost", "price", "bps"], text: "Chord charges a protocol fee on the output token of a swap: 0 bps on USDC and EURC, 5 bps on every other token (shown on every quote as feeBps). Gas on Arc is paid in USDC by the wallet." },
  { keys: ["bridge", "deposit", "fund", "move"], text: "Bridge USDC to Arc from Base, Ethereum, Arbitrum, Monad and 60+ chains on the Bridge page (LI.FI) or USDC-only in seconds on Circle's rails at /bridge2." },
  // Ask wallet, perps and plans (2026-09-26 self-test: "How do I deposit USDC to trade stocks?" searched every chain for
  // lack of these). Sources: web CLAUDE.md (Ask wallet P3 CashSweep, Perp Funds), api askCredits.
  { keys: ["cash", "usdg", "stock", "stocks", "ask wallet", "deposit", "fund", "nạp", "withdraw", "rút"], text: "The Ask wallet (sign in on /ask) is one address on every chain it supports: Robinhood Chain, Arc, Monad, Avalanche, Base and BNB Chain, plus Arbitrum, Optimism, Polygon and Ethereum for deposits. Whatever you send stays exactly as you sent it, on that chain: USDC on Base stays USDC on Base, ETH stays ETH. Nothing is converted unless you ask. Tokenized US stocks trade 24/7 against USDG on Robinhood Chain (/ask/trade, buys and sells gasless): to get USDG there, use Convert on /ask/wallet, which shows the Relay quote and runs only after you confirm. The trade card pays from the tokens your wallet holds on that chain. Withdraw any token from the same wallet page." },
  { keys: ["perp", "perps", "hyperliquid", "leverage", "margin", "long", "short"], text: "Perps trade on Hyperliquid from the Perp tab (/ask/perp). The Ask wallet funds Hyperliquid from USDC or USDG it holds on any supported chain, with one signature; your own wallet can deposit USDC from Arbitrum instead. Orders go from your browser straight to Hyperliquid — Chord never holds the funds, and the trading key kept in the browser can place and cancel orders but never withdraw." },
  { keys: ["plan", "plans", "credit", "credits", "pro", "premium", "max", "subscription", "limit", "quota", "spin", "streak", "reward", "rewards"], text: "Ask plans: Free 300 credits a month, Pro $15 for 3,000, Max $80 for 20,000; without an account, 10 questions a day. One answer costs 1 credit (reports, backtests, SQL and clips cost a few more). Trading on Chord earns credits: +10 per $100 of volume, and $5k in a month counts as Pro, $25k as Max. Rewards for signed-in accounts: 3 daily spins (1 to 100 credits) and a daily login streak that grows over 28 days — reward credits are used after the month's allowance and do not expire." },
  { keys: ["token", "airdrop", "presale", "points", "chord token", "$chord"], text: "There is no Chord token to buy today, and no airdrop or presale. Anything claiming to sell one is not Chord." },
  { keys: ["api", "agent", "data", "developer", "mcp"], text: "The same data behind this site is a public REST API (api.getchord.xyz, free tier without a key) plus an MCP tool server for agents — see the Docs page." },
  { keys: ["route", "routing", "router", "venue", "v4", "uniswap"], text: "Chord's router quotes every Uniswap V3, V2 and allow-listed V4 launchpad pool on Arc, splits across venues when it improves the output, and executes in one transaction through the Chord router contract." },
  // Meta-aggregator (board #114, 2026-10-04): routes/meta + services/meta. Policy lives in services/meta/policy.ts.
  { keys: ["meta", "aggregator", "fallback", "kyberswap", "kyber", "monorail", "lifi", "li.fi", "relay", "no route", "best price", "agent"], text: "Chord's meta-aggregator (GET /v1/meta/quote, POST /v1/meta/swap) gives an agent one quote and one unsigned transaction on Monad, Robinhood Chain, Arc, Avalanche, Base and BNB. Chord's own router always answers first; a third-party aggregator (KyberSwap, Monorail on Monad, LI.FI, Relay) is used only when Chord's router fails or has no route, never just for a better price. Every answer names the provider that quoted it, and a fallback transaction is returned only if its router is on Chord's allowlist and it passed a simulation as the taker. Chord never signs. The quote tools here fall back the same way and say which provider answered; the trade card executes Chord's own routes only." },
  { keys: ["assistant", "ask", "chat", "ai", "you"], text: "This assistant answers only from Chord's live index and router. It never states a number or an address it did not just look up, never predicts prices, and never gives financial advice." },
];
// ask2049: Chord adds its Solana fact only where its Solana tape tools run (solEnabled); they do not run here.
function findFacts(topic: string): string[] {
  const t = topic.toLowerCase();
  const hits = CHORD_FACTS.filter((f) => f.keys.some((k) => t.includes(k)));
  return (hits.length ? hits : CHORD_FACTS.slice(0, 3)).map((f) => f.text);
}

// ── price structure from the tape (askAgent.ts priceAnalysis / analysisForModel / keyLevelsTable, verbatim) ───────────
export function priceAnalysis(input: { c5: Candle[]; c1h: Candle[]; stats: any; whales: any[]; holders: any; stock?: boolean; navUsd?: number | null }) {
  const { c5, c1h, stats, whales, holders } = input;
  // A tokenized stock tracks its underlying (owner 2026-09-24: the meme rule put NVDA's stop 10 % under
  // the lowest tranche — $198 at $222). Stock mode keeps anchors within 8 % of price, adds NAV as an
  // anchor, and sets the stop from the token's own hourly range (1.5 × ATR, at least 1 %, at most 5 %).
  const stock = !!input.stock;
  const nav = input.navUsd != null && input.navUsd > 0 ? input.navUsd : null;
  const series = c1h.length >= 12 ? c1h : c5;
  if (series.length < 12) return null;
  const now = Math.floor(Date.now() / 1000);
  const last = series[series.length - 1];
  const price = Number(stats?.priceUsd) || last.c;
  if (!(price > 0)) return null;
  // Window range from VOLUME-WEIGHTED percentiles of typical price (2nd–98th), not raw wicks: one
  // dust print at 1/15 of the market (Minara 2026-09-17: a $0.0000199 wick) otherwise becomes the
  // window low, stretches every profile bucket and lands the "support" 92% below price.
  const tps = series.map((c) => ({ p: (c.h + c.l + c.c) / 3, v: c.v })).filter((x) => x.p > 0 && x.v > 0).sort((x, y) => x.p - y.p);
  if (tps.length < 8) return null;
  const totV = tps.reduce((s, x) => s + x.v, 0);
  const pctl = (q: number) => { let acc = 0; for (const x of tps) { acc += x.v; if (acc >= totV * q) return x.p; } return tps[tps.length - 1].p; };
  const lo7 = pctl(0.02), hi7 = pctl(0.98);
  const rawHi = Math.max(...series.map((c) => c.h)), rawLo = Math.min(...series.map((c) => c.l).filter((x) => x > 0));
  const day = (c5.length ? c5 : series).filter((c) => c.t >= now - 86_400);
  const vw = (cs: Candle[]) => { let pv = 0, v = 0; for (const c of cs) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.v; v += c.v; } return v > 0 ? pv / v : null; };
  const vwap24h = vw(day), vwapAll = vw(series);
  // Volume profile: 24 log-spaced buckets over the window range; each candle's USD goes to its typical price.
  const N = 24; const lnLo = Math.log(lo7), lnHi = Math.log(hi7 * 1.0001); const step = (lnHi - lnLo) / N || 1;
  const buckets = Array.from({ length: N }, (_, i) => ({ lo: Math.exp(lnLo + i * step), hi: Math.exp(lnLo + (i + 1) * step), usd: 0, up: 0 }));
  let total = 0;
  for (const c of series) { const tp = (c.h + c.l + c.c) / 3; if (!(tp > 0) || tp < lo7 || tp > hi7) continue; const i = Math.min(N - 1, Math.max(0, Math.floor((Math.log(tp) - lnLo) / step))); buckets[i].usd += c.v; if (c.c >= c.o) buckets[i].up += c.v; total += c.v; }
  const zones = buckets.filter((b) => b.usd > 0).map((b) => ({ lo: sig(b.lo), hi: sig(b.hi), mid: sig(Math.sqrt(b.lo * b.hi)), usd: Math.round(b.usd), sharePct: total > 0 ? +((b.usd / total) * 100).toFixed(1) : 0, upCandleSharePct: b.usd > 0 ? +((b.up / b.usd) * 100).toFixed(0) : 0 })).sort((x, y) => y.usd - x.usd);
  const poc = zones[0] ?? null;
  // A zone counts only with ≥3 % of the window's USD — a bucket holding one stray hour is not a shelf.
  const MIN_SHARE = 3;
  const support = zones.filter((z) => z.hi <= price && z.sharePct >= MIN_SHARE).slice(0, 3).sort((x, y) => y.mid - x.mid);
  const resistance = zones.filter((z) => z.lo >= price && z.sharePct >= MIN_SHARE).slice(0, 3).sort((x, y) => x.mid - y.mid);
  const noShelfBelow = support.length === 0;
  // Swing points (window 3) on BOTH series — the hourly gives structure, the 5-minute gives the
  // last day's actual pullback lows. Wicks outside the percentile range are ignored (dust prints).
  const swingsHi: number[] = [], swingsLo: number[] = [];
  const inRange = (x: number) => x >= lo7 * 0.8 && x <= hi7 * 1.25;
  for (const ser of [series, ...(series !== c5 && c5.length >= 12 ? [c5] : [])]) {
    for (let i = 3; i < ser.length - 3; i++) {
      const w = ser.slice(i - 3, i + 4); const c = ser[i];
      if (c.h === Math.max(...w.map((x) => x.h)) && inRange(c.h)) swingsHi.push(c.h);
      if (c.l > 0 && c.l === Math.min(...w.map((x) => x.l).filter((x) => x > 0)) && inRange(c.l)) swingsLo.push(c.l);
    }
  }
  const near = (arr: number[], below: boolean) => [...new Set(arr.map(sig))].filter((x) => (below ? x < price : x > price)).sort((x, y) => (below ? y - x : x - y)).slice(0, 3);
  const swingLowsBelow = near(swingsLo, true), swingHighsAbove = near(swingsHi, false);
  // Momentum: last full hour vs the prior 6, and the day's busiest hour.
  const hourly = c1h.length ? c1h : [];
  const lastH = hourly.length >= 2 ? hourly[hourly.length - 2] : null;
  const prior6 = hourly.slice(-8, -2);
  const avg6 = prior6.length ? prior6.reduce((s, c) => s + c.v, 0) / prior6.length : null;
  const peakH = hourly.filter((c) => c.t >= now - 86_400).reduce((m, c) => (c.v > (m?.v ?? 0) ? c : m), null as Candle | null);
  const w = stats?.windows ?? {};
  const share = (x: any) => (x && x.buyVol + x.sellVol > 0 ? +((x.buyVol / (x.buyVol + x.sellVol)) * 100).toFixed(0) : null);
  // Ladder: up to 3 tranches, nearest first, heavier lower. Anchors = volume shelves below price,
  // swing lows below price, the 24h low and the 24h VWAP when they sit under price. Nothing further
  // than 60 % below price unless it is a real shelf (≥10 % of USD) — a tranche at -92 % is not a plan.
  const anchors: { p: number; why: string }[] = [
    ...support.map((z) => ({ p: z.mid, why: `volume shelf ${z.sharePct}%` })),
    ...swingLowsBelow.map((p) => ({ p, why: "swing low" })),
    ...(stats?.range24h?.low && stats.range24h.low < price ? [{ p: stats.range24h.low, why: "24h low" }] : []),
    ...(vwap24h && vwap24h < price ? [{ p: vwap24h, why: "24h VWAP" }] : []),
    ...(stock && nav && nav < price ? [{ p: nav, why: "NAV (underlying price)" }] : []),
  ].filter((a) => a.p > 0 && a.p < price * (stock ? 0.998 : 0.99) && (stock ? a.p >= price * 0.92 : a.p >= price * 0.4 || /shelf (1\d|[2-9]\d)/.test(a.why))).sort((x, y) => y.p - x.p);
  const picked: { p: number; why: string }[] = [];
  const minGap = stock ? 0.004 : 0.03; // tranches 0.4 % apart on a stock, 3 % on a meme
  for (const a of anchors) { if (picked.every((q) => Math.abs(q.p - a.p) / q.p > minGap)) picked.push(a); if (picked.length === 3) break; }
  const weights = picked.length === 3 ? [25, 35, 40] : picked.length === 2 ? [40, 60] : picked.length === 1 ? [100] : [];
  const floor = picked.length ? Math.min(...picked.map((q) => q.p)) : lo7;
  const ladder = picked.map((q, i) => ({ zone: sig(q.p), belowNowPct: +(((price - q.p) / price) * 100).toFixed(1), weightPct: weights[i], anchor: q.why }));
  const lastDay = (c1h.length ? c1h : series).slice(-24);
  const atr = lastDay.length ? lastDay.reduce((s, c) => s + Math.max(0, c.h - c.l), 0) / lastDay.length : 0;
  const invalidation = !picked.length ? null
    : stock ? sig(Math.max(floor * 0.95, floor - Math.max(1.5 * atr, price * 0.01)))
    : sig(floor * 0.9);
  const targets = [...resistance.map((z) => z.mid), ...swingHighsAbove].filter((x) => x > price).sort((x, y) => x - y).filter((x, i, arr) => i === 0 || x / arr[i - 1] > 1.03).slice(0, 3).map((x) => ({ level: sig(x), aboveNowPct: +(((x - price) / price) * 100).toFixed(1) }));
  const ath = stats?.ath?.priceUsd ? { priceUsd: sig(stats.ath.priceUsd), drawdownPct: +(((price - stats.ath.priceUsd) / stats.ath.priceUsd) * 100).toFixed(1), hoursAgo: Math.round((now - stats.ath.ts) / 3600) } : null;
  const top = (holders?.top ?? []) as { holder: string; sharePct: number | null; kind: string }[];
  return {
    priceUsd: sig(price),
    window: { candles: series.length, tf: series === c1h ? "1h" : "5m", hours: Math.round((series[series.length - 1].t - series[0].t) / 3600), high: sig(hi7), low: sig(lo7), rawWickHigh: sig(rawHi), rawWickLow: sig(rawLo), note: "high/low = volume-weighted 2nd–98th percentile of traded price; raw wicks listed separately (often dust prints)" },
    range24h: stats?.range24h ? { high: sig(stats.range24h.high), low: sig(stats.range24h.low) } : null,
    ath,
    vwap: { h24: vwap24h ? sig(vwap24h) : null, window: vwapAll ? sig(vwapAll) : null, priceVsVwap24hPct: vwap24h ? +(((price - vwap24h) / vwap24h) * 100).toFixed(1) : null },
    volumeProfile: { pointOfControl: poc, supportZones: support, resistanceZones: resistance, noShelfBelowPrice: noShelfBelow, allZones: [...zones].sort((x, y) => x.mid - y.mid).map((z) => ({ lo: z.lo, hi: z.hi, mid: z.mid, usd: z.usd, sharePct: z.sharePct })), note: "zones need ≥3% of window USD; upCandleSharePct = share of that zone's USD that traded in up-candles (buy-pressure proxy). noShelfBelowPrice = the tape has no volume shelf under the current price — say so; the ladder then leans on swing lows / 24h low." },
    swings: { lowsBelow: swingLowsBelow, highsAbove: swingHighsAbove },
    momentum: {
      lastHourUsd: lastH ? Math.round(lastH.v) : null, priorSixHourAvgUsd: avg6 != null ? Math.round(avg6) : null,
      lastHourVsPriorPct: lastH && avg6 ? +(((lastH.v - avg6) / avg6) * 100).toFixed(0) : null,
      peakHour24h: peakH ? { usd: Math.round(peakH.v), hoursAgo: Math.round((now - peakH.t) / 3600) } : null,
      buySharePct: { m5: share(w.m5), h1: share(w.h1), h6: share(w.h6), h24: share(w.h24) },
      trades: { h1: w.h1?.txns ?? null, h24: w.h24?.txns ?? null },
      changePct: { m5: w.m5?.change ?? null, h1: w.h1?.change ?? null, h6: w.h6?.change ?? null, h24: w.h24?.change ?? null },
      wallets24h: w.h24?.makers ?? null,
    },
    whales: whales.slice(0, 8).map((x) => ({ side: x.side, usd: Math.round(x.usd), priceUsd: sig(x.priceUsd), minutesAgo: Math.round((now - x.ts) / 60), wallet: x.wallet ?? null })),
    holders: holders ? { count: holders.holders, top10Pct: holders.concentration?.top10 ?? null, top1Pct: holders.concentration?.top1 ?? null, largestKind: top[0]?.kind ?? null, complete: holders.complete } : null,
    plan: {
      ladder, invalidation, targets,
      thinTape: !!(lastH && peakH && lastH.v < peakH.v * 0.05),
      ...(stock ? { mode: "stock", atr1hUsd: sig(atr), navUsd: nav } : {}),
      note: stock
        ? "Stock mode: tranches on anchors within 8% of price (volume shelf / swing low / 24h low / VWAP / NAV), heavier lower; invalidation = 1.5 × the average hourly range (ATR, last 24 hours) under the lowest tranche, at least 1% and at most 5%. The token follows the underlying stock, so a gap at the US open or a NAV gap moves it more than on-chain levels. Present it as a starting plan, state what invalidates it, and size it to what the person can lose."
        : "Mechanical: tranches on the nearest anchors below price (volume shelf / swing low / 24h low / VWAP), heavier lower, none deeper than 60% under price unless a real shelf sits there; invalidation = 10% under the lowest tranche. Present it as a starting plan with the anchor of each tranche, state what invalidates it, and size it to what the person can lose. If the ladder is empty, say the tape gives no anchor below price yet.",
    },
  };
}

/** What leaves the harness (owner 2026-09-27: "chỉ phân tích thôi, không đưa ra SL TP"): the tape's structure, never a
 *  plan. The ladder / invalidation / targets stay inside (Picks ranks with them) — the model, the panel and the note get none. */
export function analysisForModel(a: NonNullable<ReturnType<typeof priceAnalysis>>) {
  const { ladder: _l, invalidation: _i, targets: _t, note: _n, ...rest } = a.plan;
  return { ...a, plan: rest };
}

/** Support / resistance / VWAP from the tape as one table — where volume traded, not where to trade. */
function keyLevelsTable(sym: string, a: NonNullable<ReturnType<typeof priceAnalysis>>): Viz {
  const vs = (x: number) => +(((x - a.priceUsd) / a.priceUsd) * 100).toFixed(1);
  const rows: (string | number | null)[][] = [
    ...a.volumeProfile.resistanceZones.slice(0, 3).map((z) => ["Resistance", z.mid, vs(z.mid), `${z.sharePct}% of volume traded here`]).reverse(),
    ["Price", a.priceUsd, 0, "now"],
    ...(a.vwap.h24 ? [["VWAP 24h", a.vwap.h24, vs(a.vwap.h24), "average price paid today"]] : []),
    ...a.volumeProfile.supportZones.slice(0, 3).map((z) => ["Support", z.mid, vs(z.mid), `${z.sharePct}% of volume traded here`]),
  ];
  return vTable(`${sym} · key levels on the tape`, ["Level", "Price", "vs now %", "Why"], rows, ["l", "r", "r", "l"]);
}

export interface DepthRung { usdc: number; buy: { tokensOut: number; effectivePriceUsd: number; impactPct: number; venues: string[] } | { ok: false; reason: string }; sellBack?: { usdcOut: number; roundTripLossPct: number; impactPct: number } | { error: string } }
/** Buy each USDC size and sell the tokens straight back: impact both ways and the round-trip loss.
 *  Shared by arc_depth and arc_execution_plan. */
export async function depthLadder(t: { address: string; decimals: number | null }, sizes: number[] = [100, 1000, 10000]): Promise<DepthRung[]> {
  if (t.decimals == null) return [];
  const anchor = USDC; // 6 decimals
  const q = async (inAddr: string, outAddr: string, raw: bigint) => {
    try {
      // ask2049: Chord's public quote route (the one its own tool self-fetches), never cached — a quote is the live book.
      const r = await chordRaw(`/v1/quote${qs({ inputMint: inAddr, outputMint: outAddr, amount: raw.toString(), chain: CHAIN, slippageBps: 100 })}`, 8000);
      const j: any = r.body ?? {};
      if (r.status < 200 || r.status >= 300 || !j?.routePlan?.length || j.outputAmount === "0") return { ok: false as const, reason: j?.noRouteReason ?? "NO_ROUTE" };
      return { ok: true as const, out: j.outputAmount as string, impactPct: Number(j.priceImpactPct) || 0, venues: [...new Set((j.routePlan as any[]).map((x) => x.swapInfo?.dex).filter(Boolean))] as string[] };
    } catch { return { ok: false as const, reason: "ROUTER_DOWN" }; }
  };
  return Promise.all(sizes.map(async (usdc) => {
    const b = await q(anchor, t.address, BigInt(Math.round(usdc * 1e6)));
    if (!b.ok) return { usdc, buy: b };
    const tokensOut = Number(b.out) / 10 ** t.decimals!;
    const sell = await q(t.address, anchor, BigInt(b.out));
    return { usdc, buy: { tokensOut: sig(tokensOut), effectivePriceUsd: sig(usdc / tokensOut), impactPct: b.impactPct, venues: b.venues }, sellBack: sell.ok ? { usdcOut: sig(Number(sell.out) / 1e6), roundTripLossPct: +(((usdc - Number(sell.out) / 1e6) / usdc) * 100).toFixed(2), impactPct: sell.impactPct } : { error: sell.reason } };
  }));
}

/** Candles + stats + whale prints + holders for one token, and the analysis over them. Shared by arc_price_analysis and
 *  arc_compare. */
export async function gatherAnalysis(t: { address: string }): Promise<{ analysis: TokenAnalysis | null; c5: Candle[]; c1h: Candle[]; stats: any; holders: any | null }> {
  const a = t.address.toLowerCase();
  const [c5, c1h, stats, whalesPage, holders] = await Promise.all([
    getDbChart(a, "5m").catch(() => [] as Candle[]),
    getDbChart(a, "1h").catch(() => [] as Candle[]),
    getTokenStats(a).catch(() => null),
    getTokenTradesPage(a, { minUsd: 300, limit: 60 }).catch(() => null),
    getArcTokenHolders(a, 10).catch(() => null),
  ]);
  return { analysis: priceAnalysis({ c5, c1h, stats, whales: (whalesPage?.trades ?? []) as any[], holders }), c5, c1h, stats, holders };
}
export type TokenAnalysis = NonNullable<ReturnType<typeof priceAnalysis>>;

// ── LP range bands (Chord services/lpPlan.ts rangeProfiles, verbatim; its own 4-significant-digit rounding) ─────────────
const lpSig = (n: number) => (n >= 1000 ? +n.toFixed(2) : n >= 1 ? +n.toFixed(4) : +n.toPrecision(4));
export interface RangeProfile { profile: "tight" | "balanced" | "wide"; horizonHours: number; lower: number; upper: number; widthPct: number; last7dInsidePct: number }
export interface RangeBands { priceUsd: number; hourlyVolPct: number; dailyVolPct: number; candles: number; /** under two days of candles: bands are a launch's noise */ young: boolean; profiles: RangeProfile[]; histogram: { lo: number; hi: number; hours: number }[] }
export async function rangeProfiles(token: string, horizonHours = 72): Promise<RangeBands | null> {
  // ask2049: getDbChart = the public chart route (Chord reads the same candles in-process, { shallowOk: true }).
  const cs = await getDbChart(token, "1h").catch(() => [] as Candle[]);
  const closes = cs.slice(-24 * 7).map((c) => c.c).filter((x) => x > 0);
  if (closes.length < 24) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sigmaH = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const last = closes[closes.length - 1];
  const horizon = Math.max(1, Math.min(24 * 30, horizonHours));
  const profiles: RangeProfile[] = ([{ profile: "tight", k: 1, hours: Math.min(horizon, 24) }, { profile: "balanced", k: 1.5, hours: horizon }, { profile: "wide", k: 2.5, hours: Math.max(horizon, 168) }] as const).map((p) => {
    const w = Math.min(Math.log(20), p.k * sigmaH * Math.sqrt(p.hours)); // never wider than ×20 / ÷20: past that a "range" is a full-range position with extra steps
    const lower = last * Math.exp(-w), upper = last * Math.exp(w);
    const inside = closes.filter((c) => c >= lower && c <= upper).length / closes.length;
    return { profile: p.profile, horizonHours: p.hours, lower: lpSig(lower), upper: lpSig(upper), widthPct: +((Math.exp(w) - 1) * 100).toFixed(1), last7dInsidePct: +(inside * 100).toFixed(0) };
  });
  // where the price spent its hours (16 log buckets over the 7-day range) — the range picker's backdrop
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const n = 16, ratio = hi > lo ? (hi / lo) ** (1 / n) : 1;
  const histogram = Array.from({ length: n }, (_, i) => ({ lo: lpSig(lo * ratio ** i), hi: lpSig(lo * ratio ** (i + 1)), hours: 0 }));
  for (const c of closes) { const i = ratio > 1 ? Math.min(n - 1, Math.floor(Math.log(c / lo) / Math.log(ratio))) : 0; histogram[i].hours++; }
  return { priceUsd: lpSig(last), hourlyVolPct: +(sigmaH * 100).toFixed(2), dailyVolPct: +(sigmaH * Math.sqrt(24) * 100).toFixed(1), candles: closes.length, young: cs.length < 48, profiles, histogram };
}

// ── Ask Picks: the move since each pick (Chord services/askPicks.ts gradePick, the movePct part) ─────────────────────
const PICK_CHAINS = [8453, 56, 43114] as const;
const isPickChain = (c: unknown): boolean => (PICK_CHAINS as readonly number[]).includes(Number(c));
const HORIZON_SEC = 48 * 3600;
function pickChainName(chain: number | undefined): string {
  return chain === 4663 ? "Robinhood Chain" : chain === 8453 ? "Base" : chain === 56 ? "BNB Chain" : chain === 43114 ? "Avalanche" : "Arc";
}
// ask2049: the public board leaves out target / invalidation, so only the move is graded here (Chord's tool reads only movePct).
async function pickMovePct(p: { token: string; chain?: number; ts: number; priceUsd: number }): Promise<number | null> {
  const cs = await getDbChart(p.token, "1h", isPickChain(p.chain) ? Number(p.chain) : undefined).catch(() => [] as Candle[]);
  const after = cs.filter((c) => c.t >= p.ts && c.t <= p.ts + HORIZON_SEC);
  if (!after.length) return null;
  const last = after[after.length - 1].c;
  return +(((last - p.priceUsd) / p.priceUsd) * 100).toFixed(1);
}

// ── schemas (Chord services/ask/schemas.ts, these tools' entries verbatim) ────────────────────────────────────────────
export const ARC_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "chord_facts",
      description: "What Chord is: chains, custody, fees, bridge, token status, how a trade is signed. ALWAYS call this for questions about Chord itself; never answer those from memory.",
      parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_overview",
      description: "Arc (chain 5042) in the last 24h from Chord's own index: volume in USDC, swaps, tokens traded, venue shares, coverage. Use first to orient on 'how is Arc doing'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_trending",
      description: "Movers of the last two hours on Arc: symbol, 1h change, volume now, trades, and momentum versus the token's usual pace. Use for 'what is trending / pumping / hot right now'.",
      parameters: { type: "object", properties: { limit: { type: "number", description: "1..20, default 10" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_tokens",
      description: "The 24h token board on Arc sorted by volume, trades, traders, change or mcap. Use for 'top tokens by volume', 'biggest gainers', 'most traded'.",
      parameters: { type: "object", properties: { limit: { type: "number", description: "1..25, default 10" }, sort: { type: "string", enum: ["volume", "trades", "traders", "change", "mcap"] } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_token",
      description: "One Arc token in depth by symbol, name or 0x address: identity, price, 24h figures, market cap, the last 24 hourly volume/price points, venue split and indexed pools. Use for any question about a specific token.",
      parameters: { type: "object", properties: { token: { type: "string", description: "Symbol like ARGUS, a name, or a 0x address" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_holders",
      description: "Holder ledger for one Arc token: holder count, top holders with share, concentration (top 1/5/10), share held by wallets vs pools. Use for 'who holds', 'is it concentrated', 'top holders'.",
      parameters: { type: "object", properties: { token: { type: "string" }, limit: { type: "number", description: "1..25, default 10" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_price_analysis",
      description: "Price structure for one Arc token, computed from the tape: current price, 24h/7d range, ATH, VWAP, the volume profile (price zones where most USD traded, split buys vs sells), support and resistance zones, swing highs/lows, momentum (volume trend, buy share per window), whale trades in the last 24h and holder concentration. Analysis only — no entries, stops or targets. Call it for 'support/resistance', 'where is it in its range', 'is it overextended', 'what does the tape say', and when someone asks where to buy or take profit (answer with the structure, not trade levels).",
      parameters: { type: "object", properties: { token: { type: "string", description: "Symbol or 0x address" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_wallet_trades",
      description: "A wallet's trades on Arc, newest first: side, USD, price, token, minutes ago, tx. Optional token filter. Use to reconstruct how a wallet traded a token (entries, exits, average price) or what it is doing right now.",
      parameters: { type: "object", properties: { wallet: { type: "string", description: "0x address" }, token: { type: "string", description: "Optional symbol or address to filter" }, limit: { type: "number", description: "1..40, default 20" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_wallet_pnl",
      description: "A wallet's PnL on Arc from the tape: realized, unrealized, total, and per-token rows (bought, sold, cost remaining, current value, ROI). Use for 'how much did wallet X make', 'what is it holding'.",
      parameters: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_wallet_profile",
      description: "Who a wallet is on Arc: trades, tokens, volume, first/last seen, whether it is a router/relayer (not a person), bot flags (burst, roundtrip, sniper, nonce rate), rank on the 7d wallet board. Use before trusting a wallet as 'smart money'.",
      parameters: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_token_trades",
      description: "Recent prints on one token, newest first, with optional side and minimum USD: who bought/sold, at what price, when. Use for 'who is buying right now', 'last big sells', 'is someone dumping'.",
      parameters: { type: "object", properties: { token: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, min_usd: { type: "number", description: "default 0" }, limit: { type: "number", description: "1..40, default 20" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_token_flow",
      description: "Order flow for one token per window (5m, 1h, 6h, 24h): buys vs sells (count and USD), buyers vs sellers, price change, plus ATH, first trade, total trades and the pools it trades in. Use for 'is it being accumulated or distributed', 'how fresh is the momentum'.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_new_launches",
      description: "Tokens launched on Arc in the last N hours (≤168) that passed the scam screen (impostor symbols, no-sell tokens, launch farms, too few traders): symbol, launcher, age, volume, traders, routable. Use for 'new tokens', 'fresh launches', 'what just graduated'.",
      parameters: { type: "object", properties: { hours: { type: "number", description: "default 24" }, limit: { type: "number", description: "1..30, default 15" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_launchers",
      description: "Launchpads on Arc ranked by pools created, creators, 24h swaps/volume/wallets. Use for 'which launchpad is hot', 'where do tokens come from'.",
      parameters: { type: "object", properties: { hours: { type: "number", description: "default 24" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_venues",
      description: "Per-venue daily volume and share on Arc over N days (Uniswap V3/V2/V4, launchpad forks). Use for 'where does the volume trade'.",
      parameters: { type: "object", properties: { days: { type: "number", description: "1..30, default 7" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_search",
      description: "Search Arc tokens by symbol, name or address — up to 8 matches with listed/routable flags and 24h figures. Use when a name is ambiguous or the person pastes a ticker you do not know.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_token_pools",
      description: "Every indexed pool of a token (V3/V2 address or V4 poolId, venue, fee, hooks) with the 24h volume split per venue. Use for 'which pool is real', 'is there a hook', 'where is liquidity'.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_pools",
      description: "Pools on Arc ranked for a LIQUIDITY PROVIDER: TVL, volume (1h/6h/24h), fees earned by LPs (volume × fee tier), fee/TVL yield per window and its annualised APR, 24h LP adds/removes, providers, whether a V4 hook can gate adds. Use for 'where to LP', 'best pools to farm', 'highest fee APR', 'is X pool worth providing to'. Suspect pools (turnover > 50× TVL per day, or dust TVL with big volume) are flagged — never recommend one.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["fee_tvl", "vol_24h", "tvl", "fees_24h", "first_seen", "lp_net_24h"], description: "default fee_tvl" }, interval: { type: "string", enum: ["1h", "6h", "24h"], description: "window for the fee/TVL sort, default 24h" }, min_tvl: { type: "number", description: "USD, default 1000" }, quote: { type: "string", description: "restrict to pools quoted in this token (address or symbol, e.g. USDC)" }, token: { type: "string", description: "restrict to pools of this token (address or symbol)" }, limit: { type: "number", description: "1..25, default 10" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_pool",
      description: "One pool for a liquidity provider: fee tier, TVL, volume and fees by window, fee/TVL and APR, hook access, 7-day hourly volume, and the top providers of the last 7 days (wallet, added, removed, net). Use for 'tell me about pool X', 'who is LPing X', 'is the yield on X stable'.",
      parameters: { type: "object", properties: { pool: { type: "string", description: "pool address (V2/V3) or 32-byte V4 pool id" } }, required: ["pool"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_suggest_range",
      description: "Suggest concentrated-liquidity price ranges for a token from its realised volatility on Chord's own candles: three profiles (tight / balanced / wide) with lower/upper price, the width in percent, the horizon the range is built for and the share of the last 7 days the price would have stayed inside it. Use for 'what range should I LP', 'set a range for X', 'how wide'. It is a volatility band, not a forecast — say so.",
      parameters: { type: "object", properties: { token: { type: "string" }, horizon_hours: { type: "number", description: "how long the position should stay in range, default 72" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_plan",
      description: "LP vs HOLD backtest for a token: three ranges (tight / balanced / wide) each simulated over the last N days on Chord's own candles and the pool's hourly volume — hours in range, fees earned, impermanent loss, net vs holding, total return, fee APR. Use for 'should I LP this', 'what would I have made', 'is the fee worth the IL'. It is a backtest, say so.",
      parameters: { type: "object", properties: { token: { type: "string" }, amount_usd: { type: "number", description: "default 1000" }, days: { type: "number", description: "1..30, default 7" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_token_pools",
      description: "A token's pools ranked by a 0–100 health score for LPs (traders, TVL, sane fee/TVL, LP flow, age; penalties for wash, impostor, hooks, launcher-held liquidity) with launch facts on Arc: launcher, hook, share of liquidity the launcher holds, when the launcher last removed. Use for 'which pool of X is safe to LP', 'is the launcher still in', 'can outsiders LP this'.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_overview",
      description: "The LP market on Arc right now: pools with volume, TVL, 24h volume, fees paid to LPs, liquidity added and removed, providers, the best real fee/TVL yield, the six hottest pools by fees and the pools liquidity is flowing into. Use for 'how is LPing on Arc', 'where are fees being made', 'is liquidity leaving'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_wallet_positions",
      description: "A wallet's liquidity positions on Arc from Chord's LP ledger (Uniswap V3/V4 position NFTs): per position the pool, venue, fee tier, range, whether it is IN RANGE now and how far the price is from the edge, dollars in/out, value now, fees earned and uncollected, PnL vs what went in, age; plus a summary (open/closed, win rate, realized PnL, fees). Use for 'my LP positions', 'what is wallet W providing', 'am I in range', 'how much fees did I earn'. Positions opened and closed within a minute are JIT tricks and say so.",
      parameters: { type: "object", properties: { wallet: { type: "string", description: "0x address; the connected wallet for 'my'" }, status: { type: "string", enum: ["open", "closed", "all"], description: "default open" }, token: { type: "string", description: "restrict to one token (symbol or address)" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_position",
      description: "One liquidity position in detail: the pool and range vs the current price, every add / remove / collect with dollars and fees, value now vs simply holding the same tokens (LP vs hold), fees earned and uncollected. Use after lp_wallet_positions when the person asks about one position ('the COOL one', 'position #41942').",
      parameters: { type: "object", properties: { manager: { type: "string", description: "position manager address (from lp_wallet_positions)" }, token_id: { type: "string", description: "NFT id" } }, required: ["manager", "token_id"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_top_wallets",
      description: "Leaderboard of liquidity providers on Arc from the position ledger (LP Agent style): profit (7d / 30d / all), win rate, fees, positions, pools, average age and size, what they provide to. Filters like LP Agent's panel: min positions, min age, min win rate. JIT and wash clusters are excluded. Use for 'best LPs', 'who makes money providing liquidity', 'LP wallets to copy'.",
      parameters: { type: "object", properties: { sort: { type: "string", enum: ["profit", "win_rate", "fees", "monthly_profit", "ev", "avg_age", "positions", "last_activity"], description: "default profit" }, limit: { type: "number", description: "1..25, default 10" }, min_positions: { type: "number" }, min_age_hours: { type: "number" }, min_win_rate_pct: { type: "number" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lp_flow",
      description: "Liquidity adds and removes: for a TOKEN the last N hours in one view (adds/removes count and USD, net, providers, JIT txs, the top providers by net and the pools the liquidity moved in); for a POOL or a WALLET the recent events one by one (add / remove / collect, USD, range, time). Use for 'is liquidity being pulled from X', 'did the dev remove liquidity', 'who added liquidity to X today', 'what did wallet W do with its LP'.",
      parameters: { type: "object", properties: { token: { type: "string" }, pool: { type: "string" }, wallet: { type: "string" }, hours: { type: "number", description: "1..720, default 24" }, min_usd: { type: "number", description: "events smaller than this are skipped (pool/wallet mode)" }, limit: { type: "number", description: "1..40 events, default 20" } } },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_wallet_pnl_calendar",
      description: "A wallet's realized PnL on Arc day by day (UTC), with the first trading day and the running total. Use for 'how consistent is this wallet', 'best/worst day', 'is it still winning this week'.",
      parameters: { type: "object", properties: { wallet: { type: "string" }, days: { type: "number", description: "last N days, default 14, max 60" } }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_index_status",
      description: "How fresh Chord's Arc data is right now: last rollup time, whether the tape is stale, pool index cursor, holder ledger coverage. Call when a number looks off or the person asks how current the data is.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chord_points",
      description: "Chord points (trade-to-earn on Arc): this week's or the season's leaderboard, or one wallet's points, streak and tier. Use for 'points', 'leaderboard', 'season', 'how many points do I have'.",
      parameters: { type: "object", properties: { scope: { type: "string", enum: ["week", "season"] }, wallet: { type: "string", description: "0x address for one wallet's points" }, limit: { type: "number", description: "1..25, default 10" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_depth",
      description: "How deep the market is for a token: the router's output and price impact for buying it with 100, 1,000 and 10,000 USDC (and selling the equivalent back). Use for 'how much can I buy without moving the price', 'is the liquidity real', 'what size fits'.",
      parameters: { type: "object", properties: { token: { type: "string" }, sizes_usdc: { type: "array", items: { type: "number" }, description: "optional custom USDC sizes, max 4" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_compare",
      description: "Side-by-side table for 2–6 tokens: price, 24h change, volume, trades, traders, buy share, market cap, holders, top10 concentration, momentum (last hour vs prior 6h), VWAP gap, routable. Use for 'X vs Y', 'which of these', 'compare'.",
      parameters: { type: "object", properties: { tokens: { type: "array", items: { type: "string" }, description: "2..6 symbols or addresses" } }, required: ["tokens"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_candles",
      description: "OHLCV candles for a token at 5m/15m/1h/4h/1d, up to 120 rows, newest last — for 'what happened at 14:00', 'how did it move after the launch', 'high of the day', hour-by-hour narration.",
      parameters: { type: "object", properties: { token: { type: "string" }, tf: { type: "string", enum: ["5m", "15m", "1h", "4h", "1d"] }, limit: { type: "number", description: "1..120, default 48" } }, required: ["token"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_market_breadth",
      description: "The whole Arc market right now: 24h volume vs the previous day, swaps, active tokens, gainers vs losers count among the top 200 by volume, median 24h change, share of volume in the top 10 tokens, venue split, launches today. Use for 'how is the market', 'risk-on or off', 'is volume drying up'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_execution_plan",
      description: "How to execute a USDC size on a token without moving the price: probes the router at 1/1, 1/2, 1/4, 1/8 of the size, picks the largest clip with impact under the cap (default 1%), returns clips, count, expected round-trip cost and a pacing suggestion. Use for 'how should I buy $5k of X', 'split my order'.",
      parameters: { type: "object", properties: { token: { type: "string" }, total_usdc: { type: "number" }, max_impact_pct: { type: "number", description: "default 1" } }, required: ["token", "total_usdc"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_attention",
      description: "What people on Chord are looking at: tokens ranked by attention over the last N days (questions asked in Ask, searches, token-page views, watchlist adds). Chord's own mindshare signal — there is no X data on Arc. Use for 'what is everyone looking at', 'most searched'.",
      parameters: { type: "object", properties: { days: { type: "number", description: "1..7, default 1" }, limit: { type: "number", description: "default 15" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_picks",
      description: "Ask Picks: the current bullish / bearish board over the 40 busiest Arc tokens, the 20 busiest on-chain-priced Robinhood Chain tokens (memes — stocks follow their underlying and are not scored) and up to 20 per chain on Base, BNB Chain and Avalanche (majors, stables, tokenized stocks and wash / bot tapes screened out; each must round-trip through Chord), scored every 4 h from momentum, buy share, real-buyer share, holder dispersion, VWAP distance and risk penalties — each with the numbers behind it and the strongest facts against it — plus the board's own track record (how many picks moved their way 48 h later, average move, last 7 days). No entries, stops or targets. Use for 'what looks good today', 'picks', 'best setups', 'how accurate are your picks'.",
      parameters: { type: "object", properties: { side: { type: "string", enum: ["bullish", "bearish", "both"] }, limit: { type: "number", description: "default 8" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_top_wallets",
      description: "The best-performing wallets on Arc from the on-chain tape (routers and bots removed): PnL, volume, win rate, archetype. Use for 'smart money', 'top traders', 'who is winning'.",
      parameters: { type: "object", properties: { window: { type: "string", enum: ["24h", "7d", "30d"] }, limit: { type: "number", description: "1..15, default 8" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "arc_fx",
      description: "Circle StableFX on Arc — Circle's institutional stablecoin FX engine (RFQ off-chain, settlement through one escrow on Arc). Returns settled volume per pair (EURC/USDC, MXNB/USDC…), trade count, VWAP and last rate (USDC per unit), distinct takers/makers, trades still open, and the latest settlements. Use for 'StableFX volume', 'what rate did EURC settle at on Arc', 'is there FX flow on Arc', 'compare Arc's EURC rate with EUR/USD'. Only permissioned firms trade on StableFX; Chord users cannot route through it.",
      parameters: { type: "object", properties: { hours: { type: "integer", description: "window, default 24, max 2160" }, pair: { type: "string", description: "e.g. EURC/USDC — optional" }, limit: { type: "integer", description: "latest trades to list, default 10, max 30" } } },
    },
  },
];

// ── registry rows (Chord services/ask/registry.ts, verbatim) ──────────────────────────────────────────────────────────
export const ARC_TOOL_META: Record<string, ToolMeta> = {
  chord_facts: { group: "chord", label: "Reading Chord facts" },
  arc_overview: { group: "arc_market", label: "Reading the Arc index", market: true },
  arc_trending: { group: "arc_market", label: "Scanning trending tokens", market: true },
  arc_tokens: { group: "arc_market", label: "Reading the token board", market: true },
  arc_token: { group: "arc_token", label: "Looking up the token" },
  arc_holders: { group: "arc_token", label: "Reading the holder ledger" },
  arc_price_analysis: { group: "arc_token", label: "Building the price structure from the tape", dyor: true, timeoutMs: 20_000 },
  arc_wallet_trades: { group: "arc_wallet", label: "Reading the wallet's trades", timeoutMs: 25_000 },
  arc_wallet_pnl: { group: "arc_wallet", label: "Computing the wallet's PnL", timeoutMs: 30_000 },
  arc_wallet_profile: { group: "arc_wallet", label: "Profiling the wallet", timeoutMs: 30_000 },
  arc_token_trades: { group: "arc_token", label: "Reading recent prints" },
  arc_token_flow: { group: "arc_token", label: "Reading order flow" },
  arc_new_launches: { group: "arc_market", label: "Listing new launches", market: true },
  arc_launchers: { group: "arc_market", label: "Ranking launchpads", market: true },
  arc_venues: { group: "arc_market", label: "Reading venue volume", market: true },
  arc_search: { group: "arc_token", label: "Searching tokens" },
  arc_token_pools: { group: "arc_token", label: "Listing pools" },
  lp_pools: { group: "lp", label: "Ranking pools for LPs", market: true },
  lp_pool: { group: "lp", label: "Reading the pool" },
  lp_suggest_range: { group: "lp", label: "Building range bands", dyor: true, timeoutMs: 20_000 },
  lp_plan: { group: "lp", label: "Backtesting LP vs hold", dyor: true, timeoutMs: 25_000 },
  lp_token_pools: { group: "lp", label: "Scoring the token's pools" },
  lp_overview: { group: "lp", label: "Reading LP activity", market: true, timeoutMs: 20_000 },
  lp_wallet_positions: { group: "lp", label: "Reading the wallet's LP positions", timeoutMs: 25_000 },
  lp_position: { group: "lp", label: "Reading the position" },
  lp_top_wallets: { group: "lp", label: "Ranking LP wallets", market: true },
  lp_flow: { group: "lp", label: "Reading liquidity adds and removals" },
  arc_wallet_pnl_calendar: { group: "arc_wallet", label: "Reading the wallet's daily PnL", timeoutMs: 30_000 },
  arc_index_status: { group: "arc_market", label: "Checking data freshness" },
  chord_points: { group: "chord", label: "Reading Chord points" },
  arc_depth: { group: "trade", label: "Probing the book at three sizes", dyor: true, timeoutMs: 15_000 },
  arc_compare: { group: "arc_market", label: "Comparing tokens", market: true },
  arc_candles: { group: "arc_token", label: "Reading candles" },
  arc_market_breadth: { group: "arc_market", label: "Reading market breadth", market: true },
  arc_execution_plan: { group: "trade", label: "Planning the execution", dyor: true, timeoutMs: 15_000 },
  arc_attention: { group: "arc_market", label: "Reading attention on Chord", market: true },
  arc_picks: { group: "arc_market", label: "Reading the picks board", market: true, dyor: true },
  arc_top_wallets: { group: "arc_wallet", label: "Ranking wallets", market: true },
  arc_fx: { group: "markets", label: "Reading StableFX settlements on Arc", market: true },
};

export const ARC_TOOL_NAMES: string[] = ARC_TOOL_SCHEMAS.map((t) => t.function.name);
const NAMES = new Set(ARC_TOOL_NAMES);
export const isArcTool = (name: string): boolean => NAMES.has(name);
/** Every tool here reads Chord's public API with no key: all are offered. */
export const arcToolOffered = (name: string): boolean => isArcTool(name);

/** Runs one tool of this module; a thrown error becomes an answer the model can repeat instead of a broken turn (as runExtTool). */
export async function runArcTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  if (!isArcTool(name)) return { data: { error: `unknown tool ${name}` }, addresses: [], citations: [] };
  try {
    return await runCase(name, args ?? {});
  } catch (e) {
    return { data: { error: String((e as Error)?.message ?? e).slice(0, 160), note: "The source did not answer just now. Say the data is unavailable; do not guess numbers." }, addresses: [], citations: [] };
  }
}

async function runCase(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  const none: ExtToolResult = { data: null, addresses: [], citations: [] };
  switch (name) {
    case "chord_facts":
      return { ...none, data: findFacts(String(args.topic ?? "")), citations: [{ label: "Docs", href: "/docs" }] };
    case "arc_overview": {
      const d = await getArcOverview();
      return {
        ...none,
        data: { last24h: d.last24h, venues24h: d.venues24h.map((v: any) => ({ dex: v.dex, volUsd: Math.round(v.volUsd), trades: v.trades, sharePct: +Number(v.sharePct).toFixed(1) })), stale: d.coverage.stale, updatedAt: d.updatedAt },
        citations: [{ label: "Arc data", href: "/data" }],
      };
    }
    case "arc_trending": {
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
      const d = await getArcTrending(limit);
      return {
        ...none,
        data: d.tokens.map((t) => ({ symbol: t.symbol, address: t.address, priceUsd: t.priceUsd, change1hPct: t.change1hPct, volNowUsd: Math.round(t.volNow), tradesNow: t.tradesNow, momentumX: t.momentum == null ? null : +t.momentum.toFixed(1), routable: t.routable })),
        addresses: d.tokens.map((t) => t.address),
        citations: [{ label: "Markets · Trending", href: "/markets" }],
        viz: [vTable("Trending on Arc · last 2h", ["Token", "Price", "1h", "Volume now", "Trades", "Pace"], d.tokens.slice(0, 10).map((t) => [t.symbol ?? shortAddr(t.address), t.priceUsd, t.change1hPct == null ? null : +t.change1hPct.toFixed(1), Math.round(t.volNow), t.tradesNow, t.momentum == null ? "new" : `${t.momentum.toFixed(1)}×`]), ["l", "r", "r", "r", "r", "r"])],
      };
    }
    case "arc_tokens": {
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
      const sort = (["volume", "trades", "traders", "change", "mcap"] as ArcTokenSort[]).includes(args.sort) ? (args.sort as ArcTokenSort) : "volume";
      const d = await getArcTokens24h({ limit, sort, includeUnlisted: true });
      return { ...none, data: { total: d.total, sort, rows: d.tokens.map(slimRow) }, addresses: d.tokens.map((t) => t.address), citations: [{ label: "Markets", href: "/markets" }], viz: [vTable(`Arc · 24h board by ${sort}`, ["Token", "Price", "24h", "Volume", "Buy share", "Trades", "Traders", "Mkt cap"], d.tokens.slice(0, 12).map((t) => [t.symbol ?? shortAddr(t.address), t.priceUsd, t.change24hPct == null ? null : +t.change24hPct.toFixed(1), Math.round(t.volume24h), t.volume24h > 0 ? +((t.buyVolume24h / t.volume24h) * 100).toFixed(0) : null, t.trades24h, t.traders, t.marketCapUsd == null ? null : Math.round(t.marketCapUsd)]), ["l", "r", "r", "r", "r", "r", "r", "r"])] };
    }
    case "arc_token": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No token on Arc matches that. Say so; do not guess an address." } };
      const [h, p] = await Promise.all([getArcTokenHourly(t.address, 24).catch(() => null), getArcTokenPools(t.address).catch(() => null)]);
      return {
        ...none,
        data: {
          found: true, token: slimRow(t),
          last24hHourly: (h?.series ?? []).slice(-24).map((s) => ({ hour: s.hour, volUsd: Math.round(s.volUsd), trades: s.trades, priceLast: s.priceLast })),
          byDex: h?.byDex ?? [],
          pools: (p?.pools ?? []).slice(0, 8).map((x) => ({ dex: x.dex, kind: x.kind, fee: x.fee, hooks: x.hooks ?? null })),
        },
        addresses: [t.address],
        citations: [tokenCite(t)],
      };
    }
    case "arc_holders": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      // ask2049: Chord catches ArcHoldersNotTracked in-process; the route answers it as 503 HOLDERS_PENDING.
      const r = await chordRaw(`/v1/arc/token/${t.address}/holders${qs({ limit: Math.max(1, Math.min(25, Number(args.limit) || 10)) })}`);
      if (r.status === 503 && r.body?.error === "HOLDERS_PENDING") return { ...none, data: { token: t.symbol, note: "The holder ledger for this token is still being built. Say it is not available yet; do not estimate." }, addresses: [t.address], citations: [tokenCite(t)] };
      if (r.status !== 200 || !r.body) throw new Error(`Chord API /v1/arc/token/holders answered ${r.status}`);
      const h = r.body;
      return {
        ...none,
        data: { token: t.symbol, holders: h.holders, complete: h.complete, heldByWalletsPct: h.heldByWalletsPct, concentration: h.concentration, top: (h.top as any[]).map((x) => ({ holder: x.holder, sharePct: x.sharePct, kind: x.kind })) },
        addresses: [t.address, ...(h.top as any[]).map((x) => x.holder)],
        citations: [tokenCite(t)],
      };
    }
    case "arc_price_analysis": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false, note: "No token on Arc matches that. Say so; do not guess." } };
      const { analysis } = await gatherAnalysis(t);
      if (!analysis) return { ...none, data: { found: true, token: t.symbol, note: "Not enough candles in the index for this token yet — say the tape is too short for levels and give only what stats show." }, addresses: [t.address], citations: [tokenCite(t)] };
      const whaleAddrs = analysis.whales.map((w) => w.wallet).filter((w): w is string => !!w);
      const zones = analysis.volumeProfile.allZones;
      return { ...none, data: { found: true, token: slimRow(t), ...analysisForModel(analysis) }, addresses: [t.address, ...whaleAddrs], citations: [tokenCite(t)], viz: [
        { kind: "bar", title: `${t.symbol} · where the money traded (${analysis.window.hours}h)`, x: zones.map((z) => String(z.lo)), series: [{ name: "USD traded", values: zones.map((z) => z.usd) }], unit: "usd" },
        keyLevelsTable(t.symbol ?? t.address.slice(0, 8), analysis),
      ] };
    }
    case "arc_wallet_trades": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 20));
      const tok = args.token ? await resolveArcToken(String(args.token)) : null;
      if (args.token && !tok) return { ...none, data: { error: "Unknown token filter." } };
      if (tok) {
        const page = await getTokenTradesPage(tok.address, { wallet: w.toLowerCase(), limit });
        const rows = page.trades as any[];
        const bought = rows.filter((r) => r.side === "buy"), sold = rows.filter((r) => r.side === "sell");
        const avg = (rs: any[]) => { const u = rs.reduce((s, r) => s + r.usd, 0), a = rs.reduce((s, r) => s + r.tokenAmt, 0); return a > 0 ? sig(u / a) : null; };
        return { ...none, data: { wallet: w, token: tok.symbol, trades: rows.map((r) => ({ side: r.side, usd: Math.round(r.usd), priceUsd: sig(r.priceUsd), tokens: Math.round(r.tokenAmt), minutesAgo: minsAgo(r.ts), dex: r.dex, tx: r.tx })), summary: { buys: bought.length, boughtUsd: Math.round(bought.reduce((s, r) => s + r.usd, 0)), avgBuyPriceUsd: avg(bought), sells: sold.length, soldUsd: Math.round(sold.reduce((s, r) => s + r.usd, 0)), avgSellPriceUsd: avg(sold), totalOnToken: page.total } }, addresses: [w, tok.address], citations: [walletCite(w), tokenCite(tok)], viz: [vTable(`${shortAddr(w)} · trades on ${tok.symbol}`, ["When", "Side", "USD", "Price", "Tokens", "Venue"], rows.slice(0, 20).map((r) => [`${minsAgo(r.ts)}m ago`, r.side, Math.round(r.usd), sig(r.priceUsd), Math.round(r.tokenAmt), r.dex]), ["l", "l", "r", "r", "r", "l"])] };
      }
      const all = await getWalletTapeTrades(w);
      const sorted = [...all].sort((a, b) => b.t - a.t);
      const byToken = new Map<string, { symbol: string; buys: number; sells: number; boughtUsd: number; soldUsd: number }>();
      for (const r of all) { const e = byToken.get(r.token) ?? { symbol: r.symbol, buys: 0, sells: 0, boughtUsd: 0, soldUsd: 0 }; if (r.side === "buy") { e.buys++; e.boughtUsd += r.usd; } else { e.sells++; e.soldUsd += r.usd; } byToken.set(r.token, e); }
      const tokens = [...byToken.entries()].map(([token, e]) => ({ token, ...e, boughtUsd: Math.round(e.boughtUsd), soldUsd: Math.round(e.soldUsd) })).sort((a, b) => (b.boughtUsd + b.soldUsd) - (a.boughtUsd + a.soldUsd)).slice(0, 12);
      return { ...none, data: { wallet: w, totalTrades: all.length, tokens, recent: sorted.slice(0, limit).map((r) => ({ side: r.side, usd: Math.round(r.usd), token: r.symbol, tokenAddress: r.token, tokens: Math.round(r.tokenAmt), minutesAgo: minsAgo(r.t), tx: r.tx })), ...(all.length ? {} : { note: EMPTY_READ_NOTE }) }, addresses: [w, ...tokens.map((x) => x.token)], citations: [walletCite(w)], viz: [vTable(`${shortAddr(w)} · by token`, ["Token", "Buys", "Bought", "Sells", "Sold"], tokens.map((x) => [x.symbol, x.buys, x.boughtUsd, x.sells, x.soldUsd]), ["l", "r", "r", "r", "r"])] };
    }
    case "arc_wallet_pnl": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const p = await getWalletPnl(w);
      const rows = [...(p.tokens ?? [])].sort((a, b) => Math.abs(b.totalUsd) - Math.abs(a.totalUsd)).slice(0, 15);
      const empty = !(p.tokens ?? []).length && !p.realized; // ask2049: see EMPTY_READ_NOTE
      return { ...none, data: { wallet: w, realizedUsd: Math.round(p.realized), unrealizedUsd: Math.round(p.unrealized), totalUsd: Math.round(p.total), tokens: rows.map((t) => ({ symbol: t.symbol, token: t.token, realizedUsd: Math.round(t.realizedUsd), unrealizedUsd: Math.round(t.unrealizedUsd), totalUsd: Math.round(t.totalUsd), stillHoldsUsd: Math.round(t.curValue), avgCostUsd: sig(t.avgCost || 0), roiPct: t.roiPct == null ? null : +t.roiPct.toFixed(1), untrackedValueUsd: Math.round(t.untrackedValue) })), note: `Average-cost PnL from swaps in the tape; tokens that arrived by transfer have no cost basis (untracked).${empty ? ` ${EMPTY_READ_NOTE}` : ""}` }, addresses: [w, ...rows.map((t) => t.token)], citations: [walletCite(w)], viz: [vTable(`${shortAddr(w)} · PnL by token`, ["Token", "Realized", "Unrealized", "Total", "Still holds", "ROI"], rows.map((t) => [t.symbol, Math.round(t.realizedUsd), Math.round(t.unrealizedUsd), Math.round(t.totalUsd), Math.round(t.curValue), t.roiPct == null ? null : +t.roiPct.toFixed(0)]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "arc_wallet_profile": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      // ask2049: Chord also reads its behaviour-bot flags (services/arcBotFilter, Redis) — no public route serves them — and ranks
      // the wallet among the 7d board's top 500; the public board answers at most 100 rows.
      const [all, lb] = await Promise.all([
        getWalletTapeTrades(w).catch(() => [] as PfTrade[]),
        chordGet<{ wallets?: any[] }>(`/v1/smart-money/top${qs({ chain: CHAIN, source: "onchain", window: "7d", limit: 100 })}`, TTL.board).catch(() => null),
      ]);
      const ranked = lb?.wallets ?? [];
      const rank = ranked.findIndex((x) => x.wallet.toLowerCase() === w.toLowerCase());
      const ts = all.map((r) => r.t);
      const tokens = new Set(all.map((r) => r.token));
      const vol = all.reduce((s, r) => s + r.usd, 0);
      return { ...none, data: { wallet: w, notAPerson: isArcNonUser(w), botFlags: null, trades: all.length, tokensTraded: tokens.size, volumeUsd: Math.round(vol), firstSeenMinutesAgo: ts.length ? minsAgo(Math.min(...ts)) : null, lastSeenMinutesAgo: ts.length ? minsAgo(Math.max(...ts)) : null, boardRank7d: rank >= 0 ? rank + 1 : null, boardRow: rank >= 0 ? { pnlUsd: Math.round(ranked[rank].pnlUsd), winRatePct: Math.round(ranked[rank].winRate * 100), archetype: ranked[rank].archetype } : null,
        note: `Bot-behaviour flags (burst, roundtrip, sniper, nonce rate) are not published by Chord's public API, so botFlags is null — do not call the wallet a bot or not a bot from this read. boardRank7d covers the top 100 of the 7d board only (null = not in it, or the board is not published).${all.length ? "" : ` ${EMPTY_READ_NOTE}`}` }, addresses: [w], citations: [walletCite(w), ...(rank >= 0 ? [{ label: "Top wallets", href: "/smart-money" }] : [])] };
    }
    case "arc_token_trades": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const side = args.side === "buy" || args.side === "sell" ? args.side : undefined;
      const minUsdA = Math.max(0, Number(args.min_usd) || 0);
      // Big prints = the last 24 h (a rare min_usd over a busy token walked its whole history and timed out, 2026-09-26).
      const page = await getTokenTradesPage(t.address, { side, minUsd: minUsdA, limit: Math.max(1, Math.min(40, Number(args.limit) || 20)) });
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const rows = (page.trades as any[]).filter((r) => minUsdA < 1000 || r.ts >= since); // ask2049: the 24 h bound, read side
      return { ...none, data: { token: t.symbol, ...(minUsdA >= 1000 ? { window: "last 24 h (prints of that size over longer periods are not scanned here)" } : {}), stats24h: page.stats24h, trades: rows.map((r) => ({ side: r.side, usd: Math.round(r.usd), priceUsd: sig(r.priceUsd), tokens: Math.round(r.tokenAmt), wallet: r.wallet ?? null, minutesAgo: minsAgo(r.ts), dex: r.dex, tx: r.tx })) }, addresses: [t.address, ...rows.map((r) => r.wallet).filter(Boolean)], citations: [tokenCite(t)], viz: [vTable(`${t.symbol} · recent prints`, ["When", "Side", "USD", "Price", "Wallet", "Venue"], rows.slice(0, 20).map((r) => [`${minsAgo(r.ts)}m ago`, r.side, Math.round(r.usd), sig(r.priceUsd), r.wallet ? shortAddr(r.wallet) : "—", r.dex]), ["l", "l", "r", "r", "l", "l"])] };
    }
    case "arc_token_flow": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const st = await getTokenStats(t.address);
      const w = (x: any) => ({ changePct: x.change, trades: x.txns, buys: x.buys, sells: x.sells, buyUsd: Math.round(x.buyVol), sellUsd: Math.round(x.sellVol), buyers: x.buyers, sellers: x.sellers, wallets: x.makers });
      const W = [["5m", st.windows.m5], ["1h", st.windows.h1], ["6h", st.windows.h6], ["24h", st.windows.h24]] as const;
      return { ...none, data: { token: t.symbol, priceUsd: st.priceUsd, windows: { m5: w(st.windows.m5), h1: w(st.windows.h1), h6: w(st.windows.h6), h24: w(st.windows.h24) }, ath: st.ath, range24h: st.range24h, firstTradeMinutesAgo: st.firstTradeTs ? minsAgo(st.firstTradeTs) : null, totalTrades: st.totalTxns, markets: (st.markets ?? []).slice(0, 6) }, addresses: [t.address], citations: [tokenCite(t)], viz: [
        { kind: "bar", title: `${t.symbol} · buy vs sell USD by window`, x: W.map((x) => x[0]), series: [{ name: "Bought", values: W.map((x) => Math.round(x[1].buyVol)) }, { name: "Sold", values: W.map((x) => Math.round(x[1].sellVol)) }], unit: "usd" },
        vTable(`${t.symbol} · order flow`, ["Window", "Change", "Buys", "Sells", "Buyers", "Sellers"], W.map((x) => [x[0], x[1].change == null ? null : +x[1].change.toFixed(1), x[1].buys, x[1].sells, x[1].buyers ?? null, x[1].sellers ?? null]), ["l", "r", "r", "r", "r", "r"]),
      ] };
    }
    case "arc_new_launches": {
      const r = await getArcGraduated({ hours: Math.max(1, Math.min(168, Number(args.hours) || 24)), limit: Math.max(1, Math.min(30, Number(args.limit) || 15)) });
      return { ...none, data: { hours: r.hours, total: r.total, screenedOut: r.screened, tokens: r.tokens.map((t) => ({ ...slimRow(t), ageMinutes: Math.round(t.ageSec / 60), launcher: t.launcher, creator: t.creator })) }, addresses: r.tokens.flatMap((t) => [t.address, t.launcher, t.creator]), citations: [{ label: "Markets · Graduated", href: "/markets" }] };
    }
    case "arc_launchers": {
      const r = await getLaunchers(Math.max(1, Math.min(168, Number(args.hours) || 24)));
      return { ...none, data: r.launchers.slice(0, 15).map((l) => ({ launcher: l.launcher, name: l.name, site: l.site, pools24h: l.pools24h, creators24h: l.creators24h, swaps24h: l.swaps24h, volume24hUsd: l.volume24h == null ? null : Math.round(l.volume24h), wallets24h: l.wallets24h })), addresses: r.launchers.slice(0, 15).map((l) => l.launcher), citations: [{ label: "Arc data", href: "/data" }] };
    }
    case "arc_venues": {
      const d = await getArcVenues(Math.max(1, Math.min(30, Number(args.days) || 7)));
      const vs = (d.venues ?? []).map((v: any) => ({ dex: v.dex, volUsd: Math.round(v.volUsd), trades: v.trades, sharePct: +Number(v.sharePct).toFixed(1) }));
      return { ...none, data: { days: d.days, totals: d.totals, venues: vs }, citations: [{ label: "Arc data", href: "/data" }], viz: [{ kind: "donut", title: `Arc venues · ${d.days}d volume share`, slices: vs.slice(0, 8).map((v: any) => ({ name: v.dex, value: v.volUsd })), unit: "usd" }] };
    }
    case "arc_search": {
      const query = String(args.query ?? "").trim();
      if (!query || query.length > 64) return { ...none, data: { matches: [] } }; // ask2049: the route takes 1..64 characters
      const r = await searchArcTokens(query, 8);
      return { ...none, data: { matches: r.tokens.map(slimRow) }, addresses: r.tokens.map((t) => t.address), citations: [{ label: "Markets", href: "/markets" }] };
    }
    case "arc_token_pools": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const [p, h] = await Promise.all([getArcTokenPools(t.address).catch(() => null), getArcTokenHourly(t.address, 24).catch(() => null)]);
      return { ...none, data: { token: t.symbol, byDex24h: h?.byDex ?? [], pools: (p?.pools ?? []).slice(0, 20) }, addresses: [t.address], citations: [tokenCite(t)] };
    }
    case "arc_wallet_pnl_calendar": {
      const w = String(args.wallet ?? "").trim();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      const days = Math.max(1, Math.min(60, Number(args.days) || 14));
      const cal = await getWalletPnlCalendar(w);
      const rows = ((cal.days ?? []) as any[]).slice(-days);
      return { ...none, data: { wallet: w, firstDate: cal.firstDate, realizedTotalUsd: Math.round(cal.realizedTotal), days: rows.map((d: any) => ({ ...d, realizedUsd: Math.round(d.realizedUsd ?? d.realized ?? 0) })), ...(rows.length || cal.firstDate ? {} : { note: EMPTY_READ_NOTE }) }, addresses: [w], citations: [walletCite(w)], viz: rows.length ? [{ kind: "bar", title: `${shortAddr(w)} · realized PnL by day`, x: rows.map((d: any) => String(d.date ?? d.day ?? "")), series: [{ name: "Realized", values: rows.map((d: any) => Math.round(d.realizedUsd ?? d.realized ?? 0)) }], unit: "usd" }] : [] };
    }
    case "lp_pools": {
      let quote = args.quote ? String(args.quote) : undefined;
      if (quote && !ADDR_RE.test(quote)) { const t = await resolveArcToken(quote); if (t) quote = t.address; }
      let tokenFilter: string | undefined;
      if (args.token) { const t = await resolveArcToken(String(args.token)); if (!t) return { ...none, data: { found: false } }; tokenFilter = t.address; }
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
      // ask2049: Chord hands sort / interval to listPools as given; the route rejects values outside its lists, so those fall back to its defaults.
      const SORTS = ["fee_tvl", "vol_24h", "vol_1h", "tvl", "fees_24h", "first_seen", "lp_net_24h", "trades_24h", "score"];
      const minTvl = args.min_tvl != null && Number.isFinite(Number(args.min_tvl)) && Number(args.min_tvl) >= 0 ? Number(args.min_tvl) : undefined;
      const r = await chordGet<{ total: number; pools: any[] }>(`/v1/lp/pools${qs({ chain: CHAIN, sort: SORTS.includes(args.sort) ? args.sort : undefined, interval: ["1h", "6h", "24h"].includes(args.interval) ? args.interval : undefined, minTvl, quote: tokenFilter ?? quote, limit: tokenFilter ? 25 : limit * 2, offset: 0 })}`, TTL.lp);
      const all = r.pools ?? [];
      const rows = all.filter((p) => !p.suspect).slice(0, limit);
      const suspects = all.filter((p) => p.suspect).length;
      const slim = rows.map((p) => ({ pool: p.pool, pair: `${p.token0.symbol ?? p.token0.address.slice(0, 8)}/${p.token1.symbol ?? p.token1.address.slice(0, 8)}`, venue: p.dex, feeBps: p.feeBps, tvlUsd: p.tvlUsd == null ? null : Math.round(p.tvlUsd), vol24hUsd: Math.round(p.vol.h24), fees24hUsd: p.fees.h24 == null ? null : Math.round(p.fees.h24), feeTvl24hPct: p.feeTvlPct.h24 == null ? null : +p.feeTvlPct.h24.toFixed(3), aprPct: p.aprPct == null ? null : +p.aprPct.toFixed(1), lpAdd24hUsd: Math.round(p.lpAdd24h), lpRemove24hUsd: Math.round(p.lpRemove24h), providers24h: p.providers24h, lpAccess: p.lpAccess, turnover24h: p.turnover24h == null ? null : +p.turnover24h.toFixed(1) }));
      return { ...none, data: { sort: all.length ? (args.sort || "fee_tvl") : "fee_tvl", totalPools: r.total, suspectHidden: suspects, pools: slim, note: "APR = 24h fees ÷ TVL × 365 at today's volume, for a full-range position; a concentrated position earns more while in range and nothing outside it." }, addresses: rows.flatMap((p) => [p.token0.address, p.token1.address]), citations: [{ label: "Pools", href: "/pools" }], viz: [vTable("Pools for LPs · " + ((args.sort as string) || "fee/TVL 24h"), ["Pair", "Venue", "Fee", "TVL", "Vol 24h", "Fees 24h", "APR"], slim.map((p) => [p.pair, p.venue, p.feeBps == null ? "?" : `${p.feeBps} bps`, p.tvlUsd, p.vol24hUsd, p.fees24hUsd, p.aprPct == null ? null : `${p.aprPct}%`]), ["l", "l", "r", "r", "r", "r", "r"])] };
    }
    case "lp_pool": {
      const id = String(args.pool ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(id)) return { ...none, data: { error: "pool must be a 0x address or a 32-byte V4 pool id" } };
      const d = await chordGet<any>(`/v1/lp/pools/${id}${qs({ chain: CHAIN })}`, TTL.lp).catch((e) => { if (e instanceof ChordApiNotFound) return null; throw e; });
      if (!d) return { ...none, data: { found: false } };
      const daily = new Map<string, number>();
      for (const h of d.hourly) { const k = new Date(h.hour * 1000).toISOString().slice(5, 10); daily.set(k, (daily.get(k) ?? 0) + h.vol); }
      return { ...none, data: { pool: d.pool, pair: `${d.token0.symbol}/${d.token1.symbol}`, venue: d.dex, kind: d.kind, feeBps: d.feeBps, hooks: d.hooks, lpAccess: d.lpAccess, tvlUsd: d.tvlUsd == null ? null : Math.round(d.tvlUsd), tvlSource: d.tvlSrc, vol: { h1: Math.round(d.vol.h1), h6: Math.round(d.vol.h6), h24: Math.round(d.vol.h24), d7: Math.round(d.vol.d7) }, fees24hUsd: d.fees.h24 == null ? null : Math.round(d.fees.h24), feeTvl24hPct: d.feeTvlPct.h24 == null ? null : +d.feeTvlPct.h24.toFixed(3), aprPct: d.aprPct == null ? null : +d.aprPct.toFixed(1), turnover24h: d.turnover24h == null ? null : +d.turnover24h.toFixed(1), suspect: d.suspect, lpAdd24hUsd: Math.round(d.lpAdd24h), lpRemove24hUsd: Math.round(d.lpRemove24h), providers24h: d.providers24h, firstSeen: new Date(d.firstSeenTs * 1000).toISOString().slice(0, 16), topProviders7d: (d.topLps as any[]).map((t) => ({ wallet: t.wallet, addedUsd: Math.round(t.addUsd), removedUsd: Math.round(t.removeUsd), netUsd: Math.round(t.netUsd), events: t.events })) }, addresses: [d.token0.address, d.token1.address, ...(d.topLps as any[]).map((t) => t.wallet)], citations: [{ label: "Pools", href: "/pools" }], viz: [{ kind: "bar", title: `${d.token0.symbol}/${d.token1.symbol} · volume per day (7d)`, x: [...daily.keys()], series: [{ name: "Volume", values: [...daily.values()].map((v) => Math.round(v)) }], unit: "usd" }] };
    }
    case "lp_suggest_range": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const b = await rangeProfiles(t.address, Math.max(1, Math.min(24 * 30, Number(args.horizon_hours) || 72)));
      if (!b) return { ...none, data: { found: true, token: t.symbol, error: "fewer than 24 hourly candles — not enough history for a volatility band" }, addresses: [t.address], citations: [tokenCite(t)] };
      return { ...none, data: { token: t.symbol, ...b, histogram: undefined, note: "Bands = last price × exp(±k·σ·√hours) from the token's own hourly closes; a range is a bet the price stays inside it for the horizon, and a concentrated position earns nothing once outside." }, addresses: [t.address], citations: [tokenCite(t)], viz: [vTable(`${t.symbol} · LP range profiles`, ["Profile", "Horizon", "Lower", "Upper", "Width", "Inside 7d"], b.profiles.map((p) => [p.profile, `${p.horizonHours}h`, p.lower, p.upper, `±${p.widthPct}%`, `${p.last7dInsidePct}%`]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "lp_plan": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const amount = Math.max(1, Number(args.amount_usd) || 1000), days = Math.max(1, Math.min(30, Number(args.days) || 7));
      // ask2049: the route answers planLp's null (no history / no anchored pool) as 404 NOT_ENOUGH_HISTORY.
      const r = await chordGet<any>(`/v1/lp/plan${qs({ chain: CHAIN, token: t.address.toLowerCase(), amountUsd: amount, days })}`, TTL.lp).catch((e) => { if (e instanceof ChordApiNotFound) return null; throw e; });
      if (!r) return { ...none, data: { found: true, token: t.symbol, error: "not enough history or no anchored pool to simulate" }, addresses: [t.address], citations: [tokenCite(t)] };
      const rows = (r.sims as any[]).map((x) => ({ profile: x.profile, lower: x.lower, upper: x.upper, ...(x.sim ? { pool: x.sim.pool, feeBps: x.sim.feeBps, inRangePct: x.sim.inRangePct, exits: x.sim.exits, feesUsd: x.sim.feesUsd, ilUsd: x.sim.ilUsd, netVsHoldUsd: x.sim.netVsHoldUsd, totalReturnUsd: x.sim.totalReturnUsd, totalReturnPct: x.sim.totalReturnPct, feeAprPct: x.sim.feeAprPct } : { note: "no simulation" }) }));
      return { ...none, data: { token: t.symbol, amountUsd: amount, days, priceUsd: r.bands.priceUsd, dailyVolPct: r.bands.dailyVolPct, profiles: rows, note: r.sims[0]?.sim?.note ?? "" }, addresses: [t.address], citations: [{ label: "Pools", href: "/pools" }, tokenCite(t)], viz: [vTable(`${t.symbol} · LP vs hold, $${amount} over ${days}d`, ["Profile", "Range", "In range", "Fees", "IL", "vs hold", "Return", "Fee APR"], rows.map((x: any) => [x.profile, `${x.lower}–${x.upper}`, x.inRangePct == null ? "—" : `${x.inRangePct}%`, x.feesUsd ?? null, x.ilUsd ?? null, x.netVsHoldUsd ?? null, x.totalReturnPct == null ? "—" : `${x.totalReturnPct}%`, x.feeAprPct == null ? "—" : `${x.feeAprPct}%`]), ["l", "l", "r", "r", "r", "r", "r", "r"])] };
    }
    case "lp_token_pools": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const pools = (await chordGet<{ pools: any[] }>(`/v1/lp/token/${t.address.toLowerCase()}/pools${qs({ chain: CHAIN })}`, TTL.lp)).pools ?? [];
      return { ...none, data: { token: t.symbol, pools: pools.map((p) => ({ pool: p.pool, venue: p.dex, feeBps: p.feeBps, tvlUsd: p.tvlUsd == null ? null : Math.round(p.tvlUsd), vol24hUsd: Math.round(p.vol24h), aprPct: p.aprPct == null ? null : +p.aprPct.toFixed(1), score: p.score, reasons: p.reasons, launcher: p.launch?.launcherName ?? p.launch?.launcher ?? null, hook: p.launch?.hooks ?? null, launcherSharePct: p.launch?.launcherSharePct == null ? null : +p.launch.launcherSharePct.toFixed(0), launcherLastRemove: p.launch?.launcherLastRemoveTs ? new Date(p.launch.launcherLastRemoveTs * 1000).toISOString().slice(0, 16) : null })), note: "Score 0–100: traders, TVL, a sane fee/TVL, LP flow, age, minus wash / impostor / hook / launcher-held penalties." }, addresses: [t.address], citations: [{ label: "Pools", href: "/pools" }, tokenCite(t)], viz: [vTable(`${t.symbol} · pools by health`, ["Venue", "Fee", "TVL", "Vol 24h", "APR", "Score", "Launcher"], pools.map((p) => [p.dex, p.feeBps == null ? "?" : `${p.feeBps} bps`, p.tvlUsd == null ? null : Math.round(p.tvlUsd), Math.round(p.vol24h), p.aprPct == null ? "—" : `${p.aprPct.toFixed(0)}%`, p.score, p.launch?.launcherName ?? "—"]), ["l", "r", "r", "r", "r", "r", "l"])] };
    }
    case "lp_overview": {
      const o = await chordGet<any>(`/v1/lp/overview${qs({ chain: CHAIN })}`, TTL.lp);
      const hot = (o.hot as any[]).map((h) => ({ pool: h.pool, pair: h.pair, venue: h.dex, feeBps: h.feeBps, fees24hUsd: Math.round(h.fees24hUsd), feeTvlPct: h.feeTvlPct == null ? null : +h.feeTvlPct.toFixed(2), tvlUsd: h.tvlUsd == null ? null : Math.round(h.tvlUsd), vol24hUsd: Math.round(h.vol24hUsd), wallets24h: h.wallets24h }));
      const inflow = (o.inflow as any[]).map((h) => ({ pool: h.pool, pair: h.pair, venue: h.dex, netUsd: Math.round(h.netUsd), tvlUsd: h.tvlUsd == null ? null : Math.round(h.tvlUsd) }));
      return { ...none, data: { pools24h: o.pools24h, tvlUsd: Math.round(o.tvlUsd), vol24hUsd: Math.round(o.vol24hUsd), fees24hUsd: Math.round(o.fees24hUsd), feesPoolsCounted: o.feesPoolsCounted, lpAdd24hUsd: Math.round(o.lpAdd24hUsd), lpRemove24hUsd: Math.round(o.lpRemove24hUsd), lpNet24hUsd: Math.round(o.lpAdd24hUsd - o.lpRemove24hUsd), providers24h: o.providers24h, best: o.best ? { pool: o.best.pool, pair: o.best.pair, venue: o.best.dex, feeTvlPct: +o.best.feeTvlPct.toFixed(2), aprPct: o.best.aprPct == null ? null : +o.best.aprPct.toFixed(0), tvlUsd: o.best.tvlUsd == null ? null : Math.round(o.best.tvlUsd) } : null, hot, inflow, note: "Fees = volume × fee tier, paid to whoever is in range; APR = 24h fees ÷ TVL × 365 at today's volume." }, addresses: [...hot.map((h) => h.pool), ...inflow.map((h) => h.pool)], citations: [{ label: "Pools", href: "/pools" }], viz: [vTable("Arc · hottest pools by fees (24h)", ["Pool", "Venue", "Fee", "Fees 24h", "Fee/TVL", "TVL", "Volume", "Wallets"], hot.map((h) => [h.pair, h.venue, h.feeBps == null ? "?" : `${h.feeBps} bps`, h.fees24hUsd, h.feeTvlPct == null ? "—" : `${h.feeTvlPct}%`, h.tvlUsd, h.vol24hUsd, h.wallets24h]), ["l", "l", "r", "r", "r", "r", "r", "r"]), ...(inflow.length ? [vTable("Arc · liquidity flowing in (24h)", ["Pool", "Venue", "Net", "TVL"], inflow.map((h) => [h.pair, h.venue, h.netUsd, h.tvlUsd]), ["l", "l", "r", "r"])] : [])] };
    }
    case "lp_wallet_positions": {
      const w = String(args.wallet ?? "").trim().toLowerCase();
      if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
      let token: string | undefined;
      if (args.token) { const t = await resolveArcToken(String(args.token)); if (t) token = t.address.toLowerCase(); }
      const status = args.status === "closed" || args.status === "all" ? args.status : "open";
      const all = ((await chordGet<{ positions?: any[] }>(`/v1/lp/positions${qs({ chain: CHAIN, owner: w, status, limit: 60, token })}`, TTL.lp)).positions ?? []) as any[];
      const closed = all.filter((p) => p.status === "closed"), open = all.filter((p) => p.status === "open");
      const wins = closed.filter((p) => (p.pnlUsd ?? 0) > 0).length;
      const rows = all.slice(0, 30);
      const slim = rows.map((p) => ({ manager: p.manager, tokenId: p.tokenId, pool: p.pool, pair: `${p.symbol ?? (p.token ? p.token.slice(0, 6) : "?")}/${p.anchorSymbol ?? "?"}`, venue: p.dex, kind: p.kind, status: p.status, inRange: p.inRange, edgePct: p.edgePct == null ? null : +p.edgePct.toFixed(1), inUsd: usdN(p.inUsd), outUsd: usdN(p.outUsd), valueUsd: usdN(p.valueUsd), feesUsd: usdN(p.feesUsd), uncollectedUsd: usdN(p.uncollectedUsd), pnlUsd: usdN(p.pnlUsd), pnlPct: p.pnlPct == null ? null : +p.pnlPct.toFixed(1), ageHours: p.ageHours == null ? null : Math.round(p.ageHours), opened: p.openedTs ? new Date(p.openedTs * 1000).toISOString().slice(0, 16) : null, closed: p.closedTs ? new Date(p.closedTs * 1000).toISOString().slice(0, 16) : null, jit: p.jit, unreconciled: p.unreconciled, href: `/lp/position/${CHAIN}/${p.manager}/${p.tokenId}` }));
      return { ...none, data: { wallet: w, status, summary: { open: open.length, closed: closed.length, wins, winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(0) : null, realizedPnlUsd: usdN(closed.reduce((s, p) => s + (p.pnlUsd ?? 0), 0)), openValueUsd: usdN(open.reduce((s, p) => s + (p.valueUsd ?? 0), 0)), feesUsd: usdN(all.reduce((s, p) => s + p.feesUsd, 0)), uncollectedUsd: usdN(open.reduce((s, p) => s + (p.uncollectedUsd ?? 0), 0)), outOfRange: open.filter((p) => p.inRange === false).length }, positions: slim, note: all.length ? "Value now = the liquidity at the current price + uncollected fees; PnL = value + dollars out − dollars in. A position out of range earns nothing until the price comes back." : "No liquidity positions for this wallet in Chord's Arc ledger (Uniswap V3 / V4 position NFTs since the index started)." }, addresses: [w, ...rows.map((p) => p.manager), ...rows.map((p) => p.pool ?? "").filter(Boolean)], citations: [{ label: "Liquidity", href: `/portfolio?address=${w}` }, { label: "Pools", href: "/pools" }], viz: slim.length ? [vTable(`${shortAddr(w)} · liquidity positions (${status})`, ["Pool", "Venue", "Status", "In range", "In", "Value now", "Fees", "PnL", "Age"], slim.map((p) => [p.pair, p.venue ?? "?", p.jit ? "JIT" : p.status, p.status !== "open" ? "—" : p.inRange == null ? "?" : p.inRange ? `yes · ${p.edgePct == null ? "" : p.edgePct + "% to edge"}` : "NO", p.inUsd, p.valueUsd, p.feesUsd, p.pnlUsd, p.ageHours == null ? "—" : `${p.ageHours}h`]), ["l", "l", "l", "l", "r", "r", "r", "r", "r"])] : [] };
    }
    case "lp_position": {
      const m = String(args.manager ?? "").trim().toLowerCase(), id = String(args.token_id ?? "").trim();
      if (!ADDR_RE.test(m) || !/^\d{1,30}$/.test(id)) return { ...none, data: { error: "manager must be a 0x address and token_id a number" } };
      const d = await chordGet<any>(`/v1/lp/position/${CHAIN}/${m}/${id}`, TTL.lp).catch((e) => { if (e instanceof ChordApiNotFound) return null; throw e; });
      if (!d) return { ...none, data: { found: false } };
      const p = d.position;
      return { ...none, data: { position: { manager: p.manager, tokenId: p.tokenId, pool: p.pool, pair: `${p.symbol ?? "?"}/${p.anchorSymbol ?? "?"}`, venue: p.dex, kind: p.kind, owner: p.owner, status: p.status, inRange: p.inRange, edgePct: p.edgePct, tickLower: p.tickLower, tickUpper: p.tickUpper, inUsd: usdN(p.inUsd), outUsd: usdN(p.outUsd), valueUsd: usdN(p.valueUsd), feesUsd: usdN(p.feesUsd), uncollectedUsd: usdN(p.uncollectedUsd), pnlUsd: usdN(p.pnlUsd), pnlPct: p.pnlPct, ageHours: p.ageHours == null ? null : Math.round(p.ageHours), jit: p.jit }, hold: d.hold, events: (d.events as any[]).slice(0, 20).map((e) => ({ kind: e.kind, usd: usdN(e.usd), feeUsd: usdN(e.feeUsd), at: new Date(e.ts * 1000).toISOString().slice(0, 16), tx: e.tx })), href: `/lp/position/${CHAIN}/${p.manager}/${p.tokenId}` }, addresses: [p.manager, ...(p.owner ? [p.owner] : []), ...(p.pool ? [p.pool] : [])], citations: [{ label: `Position #${p.tokenId}`, href: `/lp/position/${CHAIN}/${p.manager}/${p.tokenId}` }], viz: [vTable(`Position #${p.tokenId} · events`, ["When", "Kind", "USD", "Fees"], (d.events as any[]).slice(0, 12).map((e) => [new Date(e.ts * 1000).toISOString().slice(5, 16).replace("T", " "), e.kind, usdN(e.usd), usdN(e.feeUsd)]), ["l", "l", "r", "r"])] };
    }
    case "lp_top_wallets": {
      const sorts = ["profit", "win_rate", "fees", "monthly_profit", "ev", "avg_age", "positions", "last_activity"] as const;
      const sort = (sorts as readonly string[]).includes(String(args.sort)) ? (args.sort as (typeof sorts)[number]) : "profit";
      const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
      const filters = { minPositions: args.min_positions != null ? Number(args.min_positions) : 3, minAgeHours: args.min_age_hours != null ? Number(args.min_age_hours) : 1, minWinRatePct: args.min_win_rate_pct != null ? Number(args.min_win_rate_pct) : undefined };
      const rows = ((await chordGet<{ rows?: any[] }>(`/v1/lp/leaderboard${qs({ chain: CHAIN, sort, limit, minPositions: filters.minPositions, minAgeHours: filters.minAgeHours, minWinRate: filters.minWinRatePct })}`, TTL.lp)).rows ?? []) as any[];
      const slim = rows.map((r, i) => ({ rank: i + 1, wallet: r.wallet, profit7dUsd: Math.round(r.windows.d7.profitUsd), profit30dUsd: Math.round(r.windows.d30.profitUsd), profitAllUsd: Math.round(r.windows.all.profitUsd), winRatePct: r.winRatePct == null ? null : +r.winRatePct.toFixed(0), feesUsd: Math.round(r.feesUsd), positions: r.windows.all.positions, open: r.open, pools: r.pools, avgAgeHours: r.avgAgeHours == null ? null : Math.round(r.avgAgeHours), avgInvestedUsd: r.avgInvestedUsd == null ? null : Math.round(r.avgInvestedUsd), tokens: (r.tokens as any[]).slice(0, 4).map((t) => t.symbol ?? t.address.slice(0, 6)), lastActive: new Date(r.lastTs * 1000).toISOString().slice(0, 16) }));
      return { ...none, data: { sort, filters, wallets: slim, note: "From the position ledger: profit = value out + fees − value in on closed positions; JIT (<60 s) positions, unreconciled ones and same-operator clusters are excluded." }, addresses: slim.map((r) => r.wallet), citations: [{ label: "LP wallets", href: "/pools?view=wallets" }], viz: [vTable(`Arc · top liquidity providers by ${sort}`, ["#", "Wallet", "Profit 7d", "Profit all", "Win rate", "Fees", "Positions", "Avg age", "Provides to"], slim.map((r) => [r.rank, shortAddr(r.wallet), r.profit7dUsd, r.profitAllUsd, r.winRatePct == null ? "—" : `${r.winRatePct}%`, r.feesUsd, r.positions, r.avgAgeHours == null ? "—" : `${r.avgAgeHours}h`, r.tokens.join(", ")]), ["r", "l", "r", "r", "r", "r", "r", "r", "l"])] };
    }
    case "lp_flow": {
      const hours = Math.max(1, Math.min(720, Number(args.hours) || 24));
      const limit = Math.max(1, Math.min(40, Number(args.limit) || 20));
      const minUsd = Math.max(0, Number(args.min_usd) || 0);
      if (args.token && !args.pool && !args.wallet) {
        const t = await resolveArcToken(String(args.token));
        if (!t) return { ...none, data: { found: false } };
        const r = await chordRaw(`/v1/lp/token/${t.address.toLowerCase()}${qs({ chain: CHAIN, hours })}`, 15_000).then((x) => x.body).catch(() => null) as any;
        if (!r || r.error) return { ...none, data: { found: true, token: t.symbol, error: r?.message ?? "LP summary unavailable" }, addresses: [t.address], citations: [tokenCite(t)] };
        const top = (r.top ?? []).map((x: any) => ({ wallet: x.wallet, netUsd: Math.round(x.netUsd), addedUsd: Math.round(x.addedUsd), removedUsd: Math.round(x.removedUsd), events: x.events, lastActive: new Date(x.lastTs * 1000).toISOString().slice(0, 16) }));
        const pools = (r.pools ?? []).map((x: any) => ({ pool: x.pool, venue: x.dex, netUsd: Math.round(x.netUsd), events: x.events }));
        return { ...none, data: { token: t.symbol, hours, adds: r.adds, addUsd: Math.round(r.addUsd), removes: r.removes, removeUsd: Math.round(r.removeUsd), netUsd: Math.round(r.netUsd), providers: r.providers, jitTxs: r.jitTxs, jitUsd: Math.round(r.jitUsd), tokenOnlyAdds: r.tokenOnlyAdds, topProviders: top, pools, note: "USD = dollars that entered or left the pool (both sides); one-sided launch seeds are counted, not valued. JIT = the same tx adds and removes (a swap trick, not a provider)." }, addresses: [t.address, ...top.map((x: any) => x.wallet), ...pools.map((x: any) => x.pool)], citations: [tokenCite(t), { label: "Pools", href: "/pools" }], viz: [vTable(`${t.symbol} · liquidity providers, last ${hours}h`, ["Wallet", "Net", "Added", "Removed", "Events", "Last"], top.map((x: any) => [shortAddr(x.wallet), x.netUsd, x.addedUsd, x.removedUsd, x.events, x.lastActive.slice(5)]), ["l", "r", "r", "r", "r", "l"])] };
      }
      const pool = args.pool ? String(args.pool).trim().toLowerCase() : "", wallet = args.wallet ? String(args.wallet).trim().toLowerCase() : "";
      if (pool && !/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/.test(pool)) return { ...none, data: { error: "pool must be a 0x address or a 32-byte V4 pool id" } };
      if (wallet && !ADDR_RE.test(wallet)) return { ...none, data: { error: "wallet must be a 0x address" } };
      if (!pool && !wallet) return { ...none, data: { error: "give a token, a pool or a wallet" } };
      const r = await chordRaw(`/v1/lp/events${qs({ chain: CHAIN, limit, minUsd, ...(pool ? { pool } : {}), ...(wallet ? { wallet } : {}) })}`, 15_000).then((x) => x.body).catch(() => null) as any;
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      const events = ((r?.events ?? []) as any[]).filter((e) => e.ts >= since);
      // ask2049: Chord names the tokens with lpPools.tokenLiteFor (its token meta); here with the public token search.
      const lite = await searchArcTokensMany([...new Set(events.flatMap((e) => [e.token, e.anchor]))]).catch(() => new Map<string, { symbol: string | null }>());
      const sym = (x: string) => lite.get(x)?.symbol ?? x.slice(0, 6);
      const slim = events.map((e) => ({ at: new Date(e.ts * 1000).toISOString().slice(0, 16), kind: e.kind, pair: `${sym(e.token)}/${sym(e.anchor)}`, venue: e.dex, wallet: e.wallet, usd: Math.round(e.usd), priced: e.priced, pool: e.pool, tx: e.tx }));
      return { ...none, data: { scope: pool ? { pool } : { wallet }, hours, events: slim, totals: { adds: slim.filter((e) => e.kind === "add").length, addUsd: Math.round(slim.filter((e) => e.kind === "add").reduce((s, e) => s + e.usd, 0)), removes: slim.filter((e) => e.kind === "remove").length, removeUsd: Math.round(slim.filter((e) => e.kind === "remove").reduce((s, e) => s + e.usd, 0)) } }, addresses: [...(pool ? [pool] : []), ...(wallet ? [wallet] : []), ...slim.map((e) => e.wallet ?? "").filter(Boolean)], citations: [{ label: "Pools", href: "/pools" }], viz: slim.length ? [vTable(`Liquidity events · last ${hours}h`, ["When", "Kind", "Pool", "Venue", "Wallet", "USD"], slim.slice(0, 20).map((e) => [e.at.slice(5).replace("T", " "), e.kind, e.pair, e.venue, e.wallet ? shortAddr(e.wallet) : "—", e.usd]), ["l", "l", "l", "l", "l", "r"])] : [] };
    }
    case "arc_index_status": {
      // ask2049: one public read (/v1/arc/status) carries the three parts Chord reads separately; a failed read leaves the error
      // in `rollup` the way Chord's own catch does.
      const s = await chordGet<any>("/v1/arc/status", 30_000).catch((e) => ({ error: String(e) }));
      const { chain: _c, index, holders, updatedAt: _u, ...rollup } = s as any;
      return { ...none, data: { rollup, poolIndex: index ?? null, holders: holders ?? null, now: Math.floor(Date.now() / 1000) }, citations: [{ label: "Arc data", href: "/data" }] };
    }
    case "chord_points": {
      const w = String(args.wallet ?? "").trim();
      // ask2049: the routes answer 503 NOT_ENABLED while the program is off; their message goes back as the error.
      const read = async (path: string) => { const r = await chordRaw(path); if (r.status !== 200 || !r.body || r.body.error) throw new Error(r.body?.message ?? `Chord API ${path.split("?")[0]} answered ${r.status}`); return r.body; };
      if (w) {
        if (!ADDR_RE.test(w)) return { ...none, data: { error: "wallet must be a 0x address" } };
        const p = await read(`/v1/points/wallet/${w.toLowerCase()}`);
        return { ...none, data: p, addresses: [w], citations: [{ label: "Points", href: "/points" }] };
      }
      const scope = args.scope === "season" ? "season" : "week";
      const lb = await read(`/v1/points/leaderboard${qs({ scope, limit: Math.max(1, Math.min(25, Number(args.limit) || 10)) })}`);
      const rows = ((lb as any).rows ?? (lb as any).wallets ?? (lb as any).leaderboard ?? []) as any[];
      return { ...none, data: lb, addresses: rows.map((r) => r.wallet).filter((x): x is string => typeof x === "string"), citations: [{ label: "Points", href: "/points" }] };
    }
    case "arc_depth": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t || t.decimals == null) return { ...none, data: { found: false, note: "Unknown token or unreadable decimals." } };
      const sizes = (Array.isArray(args.sizes_usdc) && args.sizes_usdc.length ? args.sizes_usdc.map(Number).filter((x: number) => x > 0) : [100, 1000, 10000]).slice(0, 4);
      const ladder = await depthLadder(t, sizes);
      return { ...none, data: { token: t.symbol, spotPriceUsd: t.priceUsd, ladder, note: "Round-trip loss = fee both ways + impact; a size whose round trip loses more than a few percent is too big for this book." }, addresses: [t.address, USDC], citations: [tokenCite(t)], viz: [vTable(`${t.symbol} · depth`, ["USDC in", "Tokens out", "Buy impact", "Sell-back impact", "Round-trip loss"], ladder.map((r) => ["impactPct" in r.buy ? [r.usdc, r.buy.tokensOut, +r.buy.impactPct.toFixed(2), r.sellBack && "impactPct" in r.sellBack ? +r.sellBack.impactPct.toFixed(2) : null, r.sellBack && "roundTripLossPct" in r.sellBack ? r.sellBack.roundTripLossPct : null] : [r.usdc, "no route", null, null, null]] as any).map((x: any) => x[0]), ["r", "r", "r", "r", "r"])] };
    }
    case "arc_compare": {
      const qs_ = (Array.isArray(args.tokens) ? args.tokens : []).map(String).slice(0, 6);
      if (qs_.length < 2) return { ...none, data: { error: "Give 2 to 6 tokens." } };
      const rows = await Promise.all(qs_.map(async (q: string) => { const t = await resolveArcToken(q); if (!t) return { query: q, found: false }; const g = await gatherAnalysis(t); const a = g.analysis; return { query: q, found: true, ...slimRow(t), holders: g.holders?.holders ?? null, top10Pct: g.holders?.concentration?.top10 ?? null, lastHourVsPriorPct: a?.momentum.lastHourVsPriorPct ?? null, priceVsVwap24hPct: a?.vwap.priceVsVwap24hPct ?? null, fromAthPct: a?.ath?.drawdownPct ?? null, buyShare1hPct: a?.momentum.buySharePct.h1 ?? null, noShelfBelowPrice: a?.volumeProfile.noShelfBelowPrice ?? null }; }));
      const ok = rows.filter((r: any) => r.found) as any[];
      return { ...none, data: { rows }, addresses: rows.map((r: any) => r.address).filter(Boolean), citations: ok.map((r: any) => tokenCite(r)), viz: [vTable("Side by side", ["Token", "Price", "24h", "Volume", "Trades", "Traders", "Buy share", "Mkt cap", "Holders", "Top10", "Last hour", "vs VWAP", "From ATH", "Routable"], ok.map((r: any) => [r.symbol, r.priceUsd, r.change24hPct == null ? null : +r.change24hPct.toFixed(1), r.volume24hUsd, r.trades24h, r.traders, r.buySharePct, r.marketCapUsd == null ? null : Math.round(r.marketCapUsd), r.holders, r.top10Pct, r.lastHourVsPriorPct, r.priceVsVwap24hPct, r.fromAthPct, r.routable ? "yes" : "no"]), ["l", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r", "l"])] };
    }
    case "arc_candles": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t) return { ...none, data: { found: false } };
      const tf = (["5m", "15m", "1h", "4h", "1d"] as const).includes(args.tf) ? (args.tf as "5m" | "15m" | "1h" | "4h" | "1d") : "1h";
      const limit = Math.max(1, Math.min(120, Number(args.limit) || 48));
      const cs = await getDbChart(t.address, tf).catch(() => [] as Candle[]);
      const sl = cs.slice(-limit);
      const lab = (c: Candle) => { const d = new Date(c.t * 1000); return tf === "1d" ? d.toISOString().slice(5, 10) : `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`; };
      return { ...none, data: { token: t.symbol, tf, candles: sl.map((c) => ({ timeUtc: new Date(c.t * 1000).toISOString().slice(0, 16).replace("T", " "), o: sig(c.o), h: sig(c.h), l: sig(c.l), c: sig(c.c), volUsd: Math.round(c.v) })) }, addresses: [t.address], citations: [tokenCite(t)], viz: [
        { kind: "line", title: `${t.symbol} · close, ${tf} candles`, x: sl.map(lab), series: [{ name: "Close", values: sl.map((c) => sig(c.c)) }], unit: "price", chart: { chain: 5042, address: t.address, tf } },
        { kind: "bar", title: `${t.symbol} · volume per ${tf} candle`, x: sl.map(lab), series: [{ name: "Volume", values: sl.map((c) => Math.round(c.v)) }], unit: "usd" },
      ] };
    }
    case "arc_market_breadth": {
      const [ov, board, launches] = await Promise.all([getArcOverview(), getArcTokens24h({ limit: 200, sort: "volume", includeUnlisted: true }), getArcGraduated({ hours: 24, limit: 200 }).catch(() => null)]);
      const rows = board.tokens;
      const chg = rows.map((r) => r.change24hPct).filter((x): x is number => x != null).sort((a, b) => a - b);
      const median = chg.length ? chg[Math.floor(chg.length / 2)] : null;
      const vol = rows.reduce((s, r) => s + r.volume24h, 0);
      const top10 = rows.slice(0, 10).reduce((s, r) => s + r.volume24h, 0);
      const daily = ov.daily ?? [];
      const yesterday = daily.length >= 2 ? daily[daily.length - 2] : null;
      return { ...none, data: { last24h: ov.last24h, previousDay: yesterday ? { volUsd: Math.round(yesterday.volUsd), swaps: yesterday.swaps, tokens: yesterday.tokens, wallets: yesterday.wallets } : null, volumeVsPrevDayPct: yesterday && yesterday.volUsd > 0 ? +(((ov.last24h.volUsd - yesterday.volUsd) / yesterday.volUsd) * 100).toFixed(1) : null, top200: { gainers: chg.filter((x) => x > 0).length, losers: chg.filter((x) => x < 0).length, median24hChangePct: median == null ? null : +median.toFixed(1), top10VolumeSharePct: vol > 0 ? +((top10 / vol) * 100).toFixed(1) : null, up50pctPlus: chg.filter((x) => x >= 50).length, down50pctPlus: chg.filter((x) => x <= -50).length }, venues24h: ov.venues24h.map((v: any) => ({ dex: v.dex, sharePct: +Number(v.sharePct).toFixed(1) })), launchesLast24h: launches ? { passedScreen: launches.total, screenedOut: launches.screened } : null, stale: ov.coverage.stale }, citations: [{ label: "Arc data", href: "/data" }, { label: "Markets", href: "/markets" }], viz: [
        { kind: "bar", title: "Arc · daily volume", x: daily.slice(-14).map((d: any) => new Date(d.day * 1000).toISOString().slice(5, 10)), series: [{ name: "Volume", values: daily.slice(-14).map((d: any) => Math.round(d.volUsd)) }], unit: "usd" },
        vTable("Arc · breadth, top 200 by volume", ["Gainers", "Losers", "Median 24h", "≥ +50%", "≤ −50%", "Top-10 share"], [[chg.filter((x) => x > 0).length, chg.filter((x) => x < 0).length, median == null ? null : +median.toFixed(1), chg.filter((x) => x >= 50).length, chg.filter((x) => x <= -50).length, vol > 0 ? +((top10 / vol) * 100).toFixed(1) : null]], ["r", "r", "r", "r", "r", "r"]),
      ] };
    }
    case "arc_execution_plan": {
      const t = await resolveArcToken(String(args.token ?? ""));
      if (!t || t.decimals == null) return { ...none, data: { found: false } };
      const total = Number(args.total_usdc);
      if (!(total > 0)) return { ...none, data: { error: "total_usdc required" } };
      const cap = Math.max(0.1, Number(args.max_impact_pct) || 1);
      const sizes = [total, total / 2, total / 4, total / 8].map((x) => Math.max(5, Math.round(x)));
      const ladder = await depthLadder(t, [...new Set(sizes)]);
      const ok = ladder.filter((r) => "impactPct" in r.buy && r.buy.impactPct <= cap).sort((a, b) => b.usdc - a.usdc);
      const clip = ok[0]?.usdc ?? null;
      const n = clip ? Math.ceil(total / clip) : null;
      return { ...none, data: { token: t.symbol, totalUsdc: total, maxImpactPct: cap, probes: ladder.map((r) => ({ usdc: r.usdc, impactPct: "impactPct" in r.buy ? r.buy.impactPct : null, roundTripLossPct: r.sellBack && "roundTripLossPct" in r.sellBack ? r.sellBack.roundTripLossPct : null })), plan: clip ? { clipUsdc: clip, clips: n, pacing: n! > 1 ? `one clip every ${Math.max(1, Math.min(10, Math.round(30 / n!)))} minutes, or on each pullback to a ladder level` : "one clip is fine", expectedRoundTripLossPct: ok[0]?.sellBack && "roundTripLossPct" in ok[0].sellBack ? ok[0].sellBack.roundTripLossPct : null } : { note: `Even ${sizes[sizes.length - 1]} USDC exceeds ${cap}% impact — the book is too thin for this size today.` } }, addresses: [t.address], citations: [tokenCite(t)], viz: [vTable(`${t.symbol} · execution probes`, ["USDC clip", "Impact", "Round-trip loss"], ladder.map((r) => [r.usdc, "impactPct" in r.buy ? +r.buy.impactPct.toFixed(2) : null, r.sellBack && "roundTripLossPct" in r.sellBack ? r.sellBack.roundTripLossPct : null]), ["r", "r", "r"])] };
    }
    case "arc_attention": {
      const rows = await getAttention(Math.max(1, Math.min(7, Number(args.days) || 1)), Math.max(1, Math.min(50, Number(args.limit) || 15)));
      const metas = await searchArcTokensMany(rows.map((r) => r.token));
      return { ...none, data: { rows: rows.map((r) => ({ token: metas.get(r.token)?.symbol ?? r.token, tokenAddress: r.token, score: r.score, asks: r.ask, searches: r.search, views: r.view, watchlistAdds: r.watch })), note: "Attention on Chord only (Ask questions ×3, searches, page views, watchlist adds ×5). Not X." }, addresses: rows.map((r) => r.token), citations: [{ label: "Markets", href: "/markets" }], viz: [vTable("Attention on Chord", ["Token", "Score", "Asks", "Searches", "Views", "Watchlist"], rows.map((r) => [metas.get(r.token)?.symbol ?? shortAddr(r.token), r.score, r.ask, r.search, r.view, r.watch]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "arc_picks": {
      // ask2049: GET /v1/ask/picks = Chord's getLatestPicks + withMarketCaps + publicPick and publicRecord(getTrackRecord(7)).
      const board = await chordGet<{ computedAt: number | null; picks?: any[]; trackRecord7d: unknown }>("/v1/ask/picks", TTL.board);
      const record = board.trackRecord7d ?? null;
      if (board.computedAt == null) return { ...none, data: { picks: [], note: "The picks board has not been computed on this deployment yet (runs every 4 h).", trackRecord7d: record } };
      const side = args.side === "bullish" || args.side === "bearish" ? args.side : "both";
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 8));
      const picks = (board.picks ?? []).filter((p) => side === "both" || p.side === side).slice(0, limit);
      const graded = await Promise.all(picks.map((p) => pickMovePct(p).then((movePct) => ({ movePct })).catch(() => null)));
      return { ...none, data: { computedMinutesAgo: minsAgo(board.computedAt), picks: picks.map((p, i) => ({ ...p, chain: pickChainName(p.chain), sinceMovePct: graded[i]?.movePct ?? null })), trackRecord7d: record, note: "Scores are descriptive statistics of the tape, refreshed every 4 h; tokens with under $2k or 15 trades in the last hour are not scored. A pick with facts.minTradeUsd (BNB Chain: 100) counts only trades of at least that size — Chord's index skips smaller ones; say so when quoting its buy share or trade count. `against` lists the strongest facts that disagree with the call — mention them. The track record says how many picks moved their way 48 h later and the average move. Present picks as bullish / bearish reads with their reasons — never with an entry, a stop, a target or a size." }, addresses: picks.map((p) => p.token), citations: [{ label: "Markets", href: "/markets" }], viz: [vTable(`Ask Picks · ${side} · computed ${minsAgo(board.computedAt)}m ago`, ["Token", "Chain", "Side", "Score", "Confidence", "Price", "Buy share 1h", "Real buyers", "Since pick"], picks.map((p, i) => [p.symbol, pickChainName(p.chain).replace(" Chain", ""), p.side, p.score, p.confidence, p.priceUsd, p.facts?.buyShare1h ?? null, p.facts?.realBuyerPct ?? null, graded[i]?.movePct ?? null]), ["l", "l", "l", "r", "l", "r", "r", "r", "r"])] };
    }
    case "arc_top_wallets": {
      const window = (["24h", "7d", "30d"] as const).includes(args.window) ? (args.window as "24h" | "7d" | "30d") : "7d";
      const limit = Math.max(1, Math.min(15, Number(args.limit) || 8));
      // ask2049: Chord checks boardEnabled(5042) in-process; the route answers 503 CHAIN_NOT_ENABLED while the board is dark.
      const r = await chordRaw(`/v1/smart-money/top${qs({ chain: CHAIN, source: "onchain", window, limit })}`, 15_000);
      if (r.status === 503 && r.body?.error === "CHAIN_NOT_ENABLED") return { ...none, data: { note: "The Arc wallet board is not published on this deployment yet." } };
      if (r.status !== 200 || !Array.isArray(r.body?.wallets)) throw new Error(r.body?.message ?? `Chord API /v1/smart-money/top answered ${r.status}`);
      const ranked = r.body.wallets as any[];
      return {
        ...none,
        data: ranked.map((w, i) => ({ rank: i + 1, wallet: w.wallet, pnlUsd: Math.round(w.pnlUsd), realizedUsd: Math.round(w.realizedUsd), volumeUsd: Math.round(w.volumeUsd), trades: w.trades, winRatePct: +(w.winRate * 100).toFixed(0), archetype: w.archetype, topToken: w.topToken?.symbol ?? null })),
        addresses: ranked.map((w) => w.wallet),
        citations: [{ label: "Top wallets", href: "/smart-money" }],
        viz: [vTable(`Top wallets on Arc · ${window}`, ["#", "Wallet", "PnL", "Realized", "Volume", "Trades", "Win rate", "Type", "Top token"], ranked.map((w, i) => [i + 1, shortAddr(w.wallet), Math.round(w.pnlUsd), Math.round(w.realizedUsd), Math.round(w.volumeUsd), w.trades, +(w.winRate * 100).toFixed(0), w.archetype, w.topToken?.symbol ?? "—"]), ["r", "l", "r", "r", "r", "r", "r", "l", "l"])],
      };
    }
    case "arc_fx": {
      const FX_ESCROW = "0xe2e5f173576b513d994073ccbdacbe027d43dfe6"; // Chord services/arcFx.ts
      const hours = Math.max(1, Math.min(2160, Number(args.hours) || 24));
      const pair = args.pair ? String(args.pair).toUpperCase().replace(/[^A-Z/]/g, "").slice(0, 20) : undefined;
      const [sum, tr] = await Promise.all([
        chordGet<any>(`/v1/arc/fx${qs({ hours })}`, TTL.board),
        chordGet<{ trades?: any[] }>(`/v1/arc/fx/trades${qs({ pair, limit: Math.max(1, Math.min(30, Number(args.limit) || 10)), hours })}`, TTL.board),
      ]);
      const trades = (tr.trades ?? []) as any[];
      const rows = trades.map((t) => ({ at: t.settledTs ? new Date(t.settledTs).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null, pair: t.pair, usd: t.usd == null ? null : r2(t.usd), rate: t.rate == null ? null : Number(t.rate.toPrecision(6)), taker: t.taker, maker: t.maker, takerGot: t.takerReceived ? `${r2(t.takerReceived.amount)} ${t.takerReceived.symbol}` : null, makerGot: t.makerReceived ? `${r2(t.makerReceived.amount)} ${t.makerReceived.symbol}` : null, tx: t.settledTx }));
      return { ...none, data: { venue: "Circle StableFX (Arc escrow " + FX_ESCROW + ")", hours, pairs: (sum.pairs as any[]).map((p) => ({ ...p, usd: r2(p.usd), vwap: p.vwap == null ? null : Number(p.vwap.toPrecision(6)), last: p.last == null ? null : Number(p.last.toPrecision(6)) })), openTrades: sum.open, allTime: { trades: sum.totalTrades, usd: r2(sum.totalUsd), since: sum.firstTs ? new Date(sum.firstTs).toISOString().slice(0, 10) : null }, latest: rows, note: "Rates are USDC per unit of the other stablecoin (EURC ≈ EUR/USD). Amounts are the escrow's payouts in the settle tx. Takers and makers are Circle-vetted firms, not retail." },
        addresses: [FX_ESCROW, ...trades.flatMap((t) => [t.taker, t.maker].filter((x): x is string => !!x))], citations: [{ label: "Circle StableFX", href: "https://www.circle.com/stablefx" }],
        viz: (sum.pairs as any[]).length ? [vTable(`StableFX on Arc · last ${hours}h`, ["Pair", "Trades", "USD", "VWAP", "Last", "Takers", "Makers"], (sum.pairs as any[]).map((p) => [p.pair, p.trades, Math.round(p.usd), p.vwap == null ? "—" : p.vwap.toPrecision(6), p.last == null ? "—" : p.last.toPrecision(6), p.takers, p.makers]), ["l", "r", "r", "r", "r", "r", "r"])] : [] };
    }
    default:
      return { ...none, data: { error: `unknown tool ${name}` } };
  }
}
