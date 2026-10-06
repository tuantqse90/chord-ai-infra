// Ask tools for two Minara "discover" surfaces Chord did not cover (docs/prompts/ask-minara-skills-2026-10.md, section A):
//   stock_movers · btc_network
//
// stock_movers — US stock market movers from Nasdaq's public API (`/api/marketmovers`, the same source and browser
// User-Agent as services/marketData.ts uses for quotes and earnings): top gainers, top losers, most active by share volume,
// most traded by dollar value, and the biggest Nasdaq-100 moves. One call answers every list (Nasdaq caps each list at 20
// rows, the Nasdaq-100 table at `limit`). Measured live in after-hours 2026-10-02 20:13 UTC: `exchangestatus=currentMarket |
// preMarket | afterHours` return the SAME lists, stamped "4:09 PM ET" with NVDA at its 4:00 PM close while its own quote read
// an after-hours $234.10 at 4:15 PM, and nasdaq.com's pre-market / after-hours pages now redirect to /market-activity. So the
// lists are regular-session lists: the session argument is still sent (cheap if Nasdaq brings them back) but the answer
// derives the session from Nasdaq's stamp (`dataSession`) and says so when someone asked for pre / after. Every row is matched against the
// tokenized-stock set of Robinhood Chain (rhRollup.getRhStocks, the code behind `rh_stocks`, never a hardcoded ticker list):
// a match carries the token's address and its own on-chain price, because the token is a separate asset that trades 24/7 and
// can sit away from the stock, most of all outside US hours. The answer echoes Nasdaq's "Data as of" stamp.
//
// btc_network — Bitcoin network health from mempool.space's public REST API (https://mempool.space/docs/api/rest): tip height
// and the time since the last block (/api/v1/blocks), hashrate now vs a month ago (/api/v1/mining/hashrate/1m), difficulty and
// the next retarget (/api/v1/difficulty-adjustment), recommended fees (/api/v1/fees/recommended), mempool size (/api/mempool),
// the dollar cost of a typical transaction (/api/v1/prices). Halving distance, block subsidy and issued supply are computed
// from the height with the exact issuance schedule (pure functions below, tested). A section whose call failed is left out
// and named in `unavailable`; with no section at all the tool answers extFailure.
import { extFailure, extJson, num, type ExtToolResult } from "./extHttp";
import type { ToolMeta } from "./registry";
import type { AssetChip, Viz } from "../askAgent";

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────
const r2 = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const sig5 = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(5)));
/** A stock price: cents at $1 and above, five significant digits below (a $0.1261 penny stock keeps its digits). */
const px = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Math.abs(n) >= 1 ? r2(n) : sig5(n));
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });
const fmtUsd = (n: number | null) => (n == null ? "" : `$${n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1 ? 2 : 6 })}`);
const fmtPct = (n: number | null) => (n == null ? "" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);

// ═════════════════════════════════════════ stock_movers ═════════════════════════════════════════
const NASDAQ_API = "https://api.nasdaq.com/api";
/** Same browser UA as services/marketData.ts: Nasdaq's API answers a bot UA with a hang or a 403. */
const NASDAQ_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

export type UsSession = "pre" | "regular" | "after" | "closed";
const NY_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Which US equity session is live at `ms` (New York wall clock, DST handled by the time zone): pre-market 04:00–09:30,
 *  regular 09:30–16:00, after-hours 16:00–20:00, Monday to Friday. Exchange holidays are not modelled (Nasdaq's "as of"
 *  stamp in the answer shows the real last print). */
export function usSessionAt(ms: number): UsSession {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "closed";
  const mins = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  if (mins >= 240 && mins < 570) return "pre";
  if (mins >= 570 && mins < 960) return "regular";
  if (mins >= 960 && mins < 1200) return "after";
  return "closed";
}

/** The session argument ("pre", "premarket", "after-hours" …) or, when absent, the one live now; regular when closed. */
export function pickSession(arg: unknown, nowMs: number): Exclude<UsSession, "closed"> {
  const s = String(arg ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["pre", "premarket", "pm", "early", "beforeopen"].includes(s)) return "pre";
  if (["after", "afterhours", "ah", "post", "postmarket", "afterclose"].includes(s)) return "after";
  if (["regular", "current", "currentmarket", "day", "open", "rth"].includes(s)) return "regular";
  const live = usSessionAt(nowMs);
  return live === "closed" ? "regular" : live;
}
const EXCHANGE_STATUS: Record<Exclude<UsSession, "closed">, string> = { regular: "currentMarket", pre: "preMarket", after: "afterHours" };
const SESSION_LABEL: Record<UsSession, string> = { regular: "regular session", pre: "pre-market", after: "after-hours", closed: "closed" };

export type MoverList = "gainers" | "losers" | "most_active" | "most_active_dollar" | "nasdaq100";
const LIST_TABLE: Record<MoverList, string> = { gainers: "MostAdvanced", losers: "MostDeclined", most_active: "MostActiveByShareVolume", most_active_dollar: "MostActiveByDollarVolume", nasdaq100: "Nasdaq100Movers" };
const LIST_LABEL: Record<MoverList, string> = { gainers: "top gainers", losers: "top losers", most_active: "most active by share volume", most_active_dollar: "most traded by dollar volume", nasdaq100: "biggest Nasdaq-100 moves" };

/** "gainers" / "top losers" / "volume" / "ndx" → one of the lists; default most_active. */
export function parseMoverList(arg: unknown): MoverList {
  const s = String(arg ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(top_)?(gainers?|advancers?|advanced|up|winners?)$/.test(s)) return "gainers";
  if (/^(top_)?(losers?|decliners?|declined|down)$/.test(s)) return "losers";
  if (/dollar/.test(s) || s === "value" || s === "turnover") return "most_active_dollar";
  if (/^(nasdaq_?100|ndx|nq|nasdaq100_movers)$/.test(s)) return "nasdaq100";
  return "most_active";
}

/** A Nasdaq table cell → number: "$3.48", "+0.0251", "-2.2500", "294,778,806.70", "+197.4359%" ; "UNCH" = 0; "N/A", "" = null. */
export function parseNasdaqNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (!s || /^(n\/?a|--?|null)$/i.test(s)) return null;
  if (/^unch/i.test(s)) return 0;
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const cleanCompany = (n: unknown): string =>
  String(n ?? "").replace(/\s+/g, " ").trim()
    .replace(/\s+(Class [A-Z]\s+)?(Common Stock|Ordinary Shares|Common Shares|Subordinate Voting Shares)$/i, "")
    .slice(0, 80);

export interface MoverRow { symbol: string; name: string; lastPrice: number | null; change: number | null; changePct: number | null; shareVolume?: number | null }

/** One Nasdaq marketmovers table → rows. The meaning of the `change` column comes from the table's own header
 *  ("Share Volume" on the most-active list, "% Change" elsewhere — including the dollar-volume list, which ranks by dollars
 *  but does not print them). A missing % is derived from last and change: prev close = last − change. */
export function normalizeMoverTable(table: { headers?: Record<string, string> | null; rows?: unknown[] | null } | null | undefined): MoverRow[] {
  const head = String(table?.headers?.change ?? "");
  const volumeCol = /share\s*volume/i.test(head);
  const pctCol = /%/.test(head);
  const out: MoverRow[] = [];
  for (const raw of table?.rows ?? []) {
    const r = raw as Record<string, unknown>;
    const symbol = String(r.symbol ?? "").trim().toUpperCase();
    if (!symbol || symbol.length > 12) continue;
    const last = parseNasdaqNumber(r.lastSalePrice);
    const change = parseNasdaqNumber(r.lastSaleChange);
    let changePct = pctCol ? parseNasdaqNumber(r.change) : null;
    if (changePct == null && last != null && change != null && last - change > 0) changePct = (change / (last - change)) * 100;
    const row: MoverRow = { symbol, name: cleanCompany(r.name), lastPrice: px(last), change: px(change), changePct: r2(changePct) };
    if (volumeCol) { const v = parseNasdaqNumber(r.change); row.shareVolume = v == null ? null : Math.round(v); }
    out.push(row);
  }
  return out;
}

/** "Data as of Oct 2, 2026 3:59 PM ET" → "Oct 2, 2026 3:59 PM ET". */
export const nasdaqAsOf = (s: unknown): string | null => {
  const t = String(s ?? "").replace(/^\s*data as of\s*/i, "").trim();
  return t ? t.slice(0, 40) : null;
};

/** The session a Nasdaq stamp ("Oct 2, 2026 4:09 PM ET") falls in. The closing cross and late reports print until ~4:10 PM,
 *  so up to 16:15 still counts as the regular session. null = no readable time. */
export function stampSession(asOf: string | null): Exclude<UsSession, "closed"> | null {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(asOf ?? "");
  if (!m) return null;
  const mins = ((Number(m[1]) % 12) + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(m[2]);
  return mins < 570 ? "pre" : mins <= 975 ? "regular" : "after";
}

/** A tokenized stock on Robinhood Chain, keyed by its ticker. */
export interface RhStockRef { symbol: string; address: string; priceUsd: number | null; change24hPct: number | null; volume24hUsd: number | null }
const tickerKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function rhIndex(rows: readonly { symbol: string | null; address: string; priceUsd: number | null; change24hPct: number | null; volume24h?: number | null }[]): Map<string, RhStockRef> {
  const m = new Map<string, RhStockRef>();
  for (const r of rows) {
    if (!r.symbol || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) continue;
    const k = tickerKey(r.symbol);
    if (!k || m.has(k)) continue; // the stock board is sorted by volume: the first row per ticker is the traded one
    m.set(k, { symbol: r.symbol.toUpperCase(), address: r.address.toLowerCase(), priceUsd: r.priceUsd, change24hPct: r.change24hPct, volume24hUsd: r.volume24h == null ? null : Math.round(r.volume24h) });
  }
  return m;
}
export const rhTradeHref = (address: string) => `/ask/trade/${address.toLowerCase()}`;

export interface StockMoversOpts { list: MoverList; session: Exclude<UsSession, "closed">; liveNow: UsSession; minPrice: number; limit: number; rh: Map<string, RhStockRef> | null; ageS: number }

/** Nasdaq's marketmovers answer → the tool's result (pure: the runner feeds it the fetched JSON and the Robinhood index). */
export function stockMoversResult(resp: any, o: StockMoversOpts): ExtToolResult {
  const t = resp?.data?.STOCKS?.[LIST_TABLE[o.list]];
  if (!t?.table) return { data: { error: "Nasdaq returned no market movers table just now.", note: "Say the US movers list is unavailable right now; do not guess names or numbers." }, addresses: [], citations: [] };
  let rows = normalizeMoverTable(t.table);
  if (o.list === "nasdaq100") rows = rows.sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  const before = rows.length;
  if (o.minPrice > 0) rows = rows.filter((r) => r.lastPrice != null && r.lastPrice >= o.minPrice);
  const dropped = before - rows.length;
  rows = rows.slice(0, o.limit);
  const out = rows.map((r) => {
    const tok = o.rh?.get(tickerKey(r.symbol)) ?? null;
    return {
      ...r,
      onRobinhoodChain: !!tok,
      ...(tok ? { rhToken: { address: tok.address, priceUsd: sig5(tok.priceUsd), change24hPct: r2(tok.change24hPct), volume24hUsd: tok.volume24hUsd, href: rhTradeHref(tok.address) } } : {}),
    };
  });
  const asOf = nasdaqAsOf(t.dataAsOf) ?? nasdaqAsOf(t.lastTradeTimestamp);
  const dataSession = stampSession(asOf) ?? "regular";
  const onRh = out.filter((r) => r.onRobinhoodChain);
  const offHoursAsk = dataSession === "regular" && (o.session !== "regular" || o.liveNow === "pre" || o.liveNow === "after");
  const notes = [
    `Nasdaq, ${LIST_LABEL[o.list]}, data as of ${asOf ?? "an unstated time"}: always say that time.`,
    o.liveNow === "closed" ? "The US market is closed right now: these are the last session's numbers, not live moves." : o.liveNow !== "regular" ? `It is ${SESSION_LABEL[o.liveNow]} in New York right now.` : null,
    offHoursAsk ? `Nasdaq publishes these lists for regular-session trading only, not ${o.session !== "regular" ? SESSION_LABEL[o.session] : SESSION_LABEL[o.liveNow]}: say so. For moves outside the regular session, the Robinhood Chain token price (24/7, rhToken.priceUsd) or market_levels (trade.xyz perp) is live.` : null,
    "US hours (New York time): pre-market 04:00-09:30, regular 09:30-16:00, after-hours 16:00-20:00, Monday to Friday.",
    o.minPrice > 0 && dropped > 0 ? `${dropped} stock${dropped === 1 ? "" : "s"} under $${o.minPrice} left out (min_price).` : null,
    o.list === "most_active_dollar" ? "This list is ranked by dollar volume, but Nasdaq does not publish the dollar figure: do not state one." : null,
    o.list === "gainers" || o.list === "losers" ? "Big % moves here are often small caps, warrants or units with thin trading: say so before naming one." : null,
    o.rh == null ? "The Robinhood Chain match is unavailable right now (onRobinhoodChain is unknown, not false)." : onRh.length
      ? "onRobinhoodChain = a tokenized version trades on Robinhood Chain 24/7 (rhToken.href opens it on the Ask Trade tab). It is a separate on-chain token with its own price (rhToken.priceUsd, last on-chain trade), which can differ from the stock, most of all outside US hours: never mix the two prices."
      : "None of these stocks has a token on Robinhood Chain.",
    onRh.some((r) => (r.rhToken?.volume24hUsd ?? 0) < 10_000) ? "A token with rhToken.volume24hUsd under $10k is a thin on-chain market: its price and 24h change can lag the stock; say so if you name it." : null,
  ].filter(Boolean).join(" ");
  const volCol = o.list === "most_active";
  const viz = out.length ? [vTable(`US stocks · ${LIST_LABEL[o.list]} · ${SESSION_LABEL[dataSession]}`,
    ["Symbol", "Company", "Last", "Change", ...(volCol ? ["Volume"] : []), "On Robinhood Chain"],
    out.map((r) => [r.symbol, r.name.length > 40 ? `${r.name.slice(0, 39)}…` : r.name, fmtUsd(r.lastPrice), fmtPct(r.changePct), ...(volCol ? [r.shareVolume == null ? "" : r.shareVolume.toLocaleString("en-US")] : []), r.onRobinhoodChain ? "yes" : ""]),
    ["l", "l", "r", "r", ...(volCol ? ["r" as const] : []), "l"])] : [];
  const chips: AssetChip[] = onRh.filter((r) => r.rhToken?.priceUsd != null).map((r) => ({
    id: `4663:${r.rhToken!.address}`, symbol: r.symbol, label: r.name || r.symbol, price: r.rhToken!.priceUsd, change24hPct: r.rhToken!.change24hPct,
    hl: null, href: r.rhToken!.href, chain: 4663, address: r.rhToken!.address, volume24hUsd: r.rhToken!.volume24hUsd, kind: "stock", chainName: "Robinhood Chain",
  }));
  return {
    data: {
      source: "Nasdaq", ...(o.ageS > 0 ? { dataAgeS: o.ageS } : {}),
      list: o.list, sessionAsked: o.session, dataSession, usMarketNow: SESSION_LABEL[o.liveNow], asOf, minPriceUsd: o.minPrice,
      rows: out, onRobinhoodChainCount: o.rh == null ? null : onRh.length,
      note: notes,
    },
    addresses: onRh.map((r) => r.rhToken!.address),
    citations: [o.list === "nasdaq100"
      ? { label: "Nasdaq-100 on Nasdaq", href: "https://www.nasdaq.com/market-activity/quotes/nasdaq-ndx-index" }
      : { label: "Nasdaq market activity", href: "https://www.nasdaq.com/market-activity/most-active" }],
    viz,
    ...(chips.length ? { chipCandidates: chips } : {}),
  };
}

async function stockMovers(args: Record<string, any>): Promise<ExtToolResult> {
  const now = Date.now();
  const list = parseMoverList(args.list);
  const session = pickSession(args.session, now);
  const liveNow = usSessionAt(now);
  const mp = args.min_price == null || args.min_price === "" ? 1 : Number(args.min_price);
  const minPrice = Number.isFinite(mp) && mp >= 0 ? mp : 1;
  const limit = Math.max(1, Math.min(25, Math.floor(Number(args.limit)) || 10));
  // One call holds every list (each capped at 20 rows by Nasdaq; `limit` sizes only the Nasdaq-100 table). The lists move
  // every minute in the regular session, settle a few minutes after the close, and do not move at all overnight.
  const url = `${NASDAQ_API}/marketmovers?assetclass=stocks&exchangestatus=${EXCHANGE_STATUS[session]}&limit=100`;
  const ttlS = liveNow === "regular" ? 60 : liveNow === "closed" ? 900 : 300;
  const [mv, rh] = await Promise.all([
    extJson("nasdaq", url, { ttlS, headers: { "User-Agent": NASDAQ_UA, Accept: "application/json" }, timeoutMs: 9000 }).then((r) => ({ ok: true as const, ...r }), (e) => ({ ok: false as const, e })),
    import("../rhRollup").then((m) => m.getRhStocks()).then((s) => rhIndex(s.stocks), () => null),
  ]);
  if (!mv.ok) return { data: extFailure("Nasdaq", mv.e), addresses: [], citations: [] };
  return stockMoversResult(mv.data, { list, session, liveNow, minPrice, limit, rh, ageS: mv.ageS });
}

// ═════════════════════════════════════════ btc_network ══════════════════════════════════════════
const MEMPOOL = "https://mempool.space/api";
const HALVING_INTERVAL = 210_000;
const COIN = 100_000_000;
/** One input, two outputs, native SegWit (P2WPKH): the usual "send bitcoin" transaction, ~141 vB. */
export const TYPICAL_TX_VB = 141;

/** Block subsidy in satoshis at `height`: 50 BTC halved every 210,000 blocks (integer division, as Bitcoin Core's
 *  `nSubsidy >>= halvings`), zero from the 64th halving. */
export function btcSubsidySats(height: number): number {
  if (!Number.isInteger(height) || height < 0) return 0;
  const halvings = Math.floor(height / HALVING_INTERVAL);
  return halvings >= 64 ? 0 : Math.floor((50 * COIN) / 2 ** halvings);
}

/** Satoshis issued by the schedule in blocks 0..height inclusive (the genesis block's 50 BTC included, although it can never
 *  be spent; a few early blocks claimed less than their subsidy, so the spendable figure is a little lower). Exact in a
 *  double: the total stays under 2.1e15 < 2^53. */
export function btcIssuedSats(height: number): number {
  if (!Number.isInteger(height) || height < 0) return 0;
  let sats = 0;
  for (let era = 0; era < 64; era++) {
    const start = era * HALVING_INTERVAL;
    if (start > height) break;
    const end = Math.min(height, start + HALVING_INTERVAL - 1);
    sats += (end - start + 1) * Math.floor((50 * COIN) / 2 ** era);
  }
  return sats;
}

export interface HalvingInfo { height: number; halvingsSoFar: number; subsidyBtc: number; nextHalvingHeight: number; blocksToHalving: number; subsidyAfterHalvingBtc: number; issuedBtc: number; issuedPctOf21M: number }
/** Halving distance, subsidy and issued supply at the tip `height` (the next halving is the next multiple of 210,000 above it). */
export function halvingInfo(height: number): HalvingInfo {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  const next = (halvings + 1) * HALVING_INTERVAL;
  const issued = btcIssuedSats(height);
  return {
    height, halvingsSoFar: halvings, subsidyBtc: btcSubsidySats(height) / COIN, nextHalvingHeight: next, blocksToHalving: next - height,
    subsidyAfterHalvingBtc: btcSubsidySats(next) / COIN, issuedBtc: issued / COIN, issuedPctOf21M: Math.round((issued / (21e6 * COIN)) * 1e4) / 100,
  };
}

/** Hashes per second → exahashes per second (1 EH/s = 1e18 H/s), 2 decimals. */
export const toEhs = (hs: unknown): number | null => { const n = num(hs); return n == null || n < 0 ? null : Math.round((n / 1e18) * 100) / 100; };
/** Difficulty → trillions ("T"), 2 decimals. */
export const toTera = (d: unknown): number | null => { const n = num(d); return n == null ? null : Math.round((n / 1e12) * 100) / 100; };

export interface HashrateSummary { nowEhs: number | null; avg3dEhs: number | null; monthAgoEhs: number | null; monthAgoDate: string | null; change1mPct: number | null; daily: { date: string; ehs: number }[] }
/** /api/v1/mining/hashrate/1m → now (mempool.space's current estimate), the 3-day average, the 3-day average at the start
 *  of the 30-day window, and the change between the two averages (daily estimates swing with block luck). */
export function summarizeHashrate(resp: any): HashrateSummary {
  const daily = (Array.isArray(resp?.hashrates) ? resp.hashrates : [])
    .map((h: any) => ({ t: num(h?.timestamp), ehs: toEhs(h?.avgHashrate) }))
    .filter((h: { t: number | null; ehs: number | null }) => h.t != null && h.ehs != null && h.ehs > 0)
    .sort((a: { t: number }, b: { t: number }) => a.t - b.t) as { t: number; ehs: number }[];
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const last3 = mean(daily.slice(-3).map((d) => d.ehs));
  const first3 = daily.length >= 6 ? mean(daily.slice(0, 3).map((d) => d.ehs)) : null;
  return {
    nowEhs: toEhs(resp?.currentHashrate), avg3dEhs: r2(last3), monthAgoEhs: r2(first3),
    monthAgoDate: daily.length >= 6 ? new Date(daily[0].t * 1000).toISOString().slice(0, 10) : null,
    change1mPct: last3 != null && first3 ? r2((last3 / first3 - 1) * 100) : null,
    daily: daily.map((d) => ({ date: new Date(d.t * 1000).toISOString().slice(0, 10), ehs: d.ehs })),
  };
}

export interface BtcParts { blocks?: any; hashrate?: any; difficulty?: any; fees?: any; mempool?: any; prices?: any }
const iso = (ms: number | null) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC");

/** The fetched mempool.space answers → the tool's result (pure; `nowS` = unix seconds). */
export function btcNetworkResult(p: BtcParts, nowS: number, o: { chart: boolean; ageS: number; unavailable: string[] }): ExtToolResult {
  const blocks = Array.isArray(p.blocks) ? p.blocks.filter((b: any) => num(b?.height) != null && num(b?.timestamp) != null) : [];
  const d = p.difficulty ?? null;
  // Tip height: the newest block, else the retarget maths (next retarget height − blocks left).
  const tip = blocks.length ? num(blocks[0].height)! : d && num(d.nextRetargetHeight) != null && num(d.remainingBlocks) != null ? num(d.nextRetargetHeight)! - num(d.remainingBlocks)! : null;
  const epochAvgS = d && num(d.timeAvg) ? num(d.timeAvg)! / 1000 : null;

  let lastBlock: Record<string, unknown> | null = null;
  let recentBlocks: { count: number; avgIntervalMinutes: number | null } | null = null;
  if (blocks.length) {
    const b = blocks[0];
    const fees = num(b?.extras?.totalFees);
    lastBlock = {
      height: num(b.height), minedAt: iso(num(b.timestamp)! * 1000), minutesAgo: r2(Math.max(0, nowS - num(b.timestamp)!) / 60),
      txCount: num(b.tx_count), pool: typeof b?.extras?.pool?.name === "string" ? String(b.extras.pool.name).slice(0, 40) : null,
      medianFeeSatVb: r2(num(b?.extras?.medianFee)), feesBtc: fees == null ? null : Math.round(fees) / COIN,
    };
    if (blocks.length > 1) recentBlocks = { count: blocks.length, avgIntervalMinutes: r2((num(b.timestamp)! - num(blocks[blocks.length - 1].timestamp)!) / (blocks.length - 1) / 60) };
  }

  const h = p.hashrate ? summarizeHashrate(p.hashrate) : null;
  const difficulty = d || p.hashrate?.currentDifficulty != null ? {
    currentT: toTera(p.hashrate?.currentDifficulty),
    ...(d ? {
      nextAdjustment: {
        estimatedChangePct: r2(num(d.difficultyChange)), blocksLeft: num(d.remainingBlocks), nextRetargetHeight: num(d.nextRetargetHeight),
        eta: iso(num(d.estimatedRetargetDate)), hoursLeft: num(d.remainingTime) == null ? null : r2(num(d.remainingTime)! / 3_600_000),
        epochProgressPct: r2(num(d.progressPercent)),
      },
      previousAdjustmentPct: r2(num(d.previousRetarget)), epochAvgBlockMinutes: epochAvgS == null ? null : r2(epochAvgS / 60),
    } : {}),
  } : null;

  const f = p.fees ?? null;
  const usd = num(p.prices?.USD);
  const txUsd = (rate: number | null) => (rate == null || usd == null ? null : r2((rate * TYPICAL_TX_VB / COIN) * usd));
  const fees = f ? {
    nextBlockSatVb: num(f.fastestFee), halfHourSatVb: num(f.halfHourFee), hourSatVb: num(f.hourFee), economySatVb: num(f.economyFee), minimumSatVb: num(f.minimumFee),
    ...(usd != null ? { typicalTxUsd: { nextBlock: txUsd(num(f.fastestFee)), halfHour: txUsd(num(f.halfHourFee)), hour: txUsd(num(f.hourFee)), economy: txUsd(num(f.economyFee)) }, btcUsdRef: Math.round(usd) } : {}),
  } : null;

  const m = p.mempool ?? null;
  const mempool = m ? { txCount: num(m.count), vMB: num(m.vsize) == null ? null : r2(num(m.vsize)! / 1e6), pendingFeesBtc: num(m.total_fee) == null ? null : Math.round(num(m.total_fee)!) / COIN } : null;

  const hv = tip != null ? halvingInfo(tip) : null;
  const blockS = epochAvgS ?? 600;
  const halving = hv ? {
    nextHalvingHeight: hv.nextHalvingHeight, blocksLeft: hv.blocksToHalving, subsidyNowBtc: hv.subsidyBtc, subsidyAfterBtc: hv.subsidyAfterHalvingBtc,
    etaDate: new Date((nowS + hv.blocksToHalving * blockS) * 1000).toISOString().slice(0, 10), daysLeft: Math.round((hv.blocksToHalving * blockS) / 86_400),
  } : null;
  const supply = hv ? { issuedBtc: hv.issuedBtc, pctOf21M: hv.issuedPctOf21M, leftToMineBtc: Math.round((21e6 - hv.issuedBtc) * 1e4) / 1e4 } : null;

  if (tip == null && !h && !fees && !mempool) return { data: extFailure("mempool.space", "no data"), addresses: [], citations: [] };

  const note = [
    "Source: mempool.space public API.",
    h ? "Hashrate is estimated from block times, so a single day swings with luck: nowEhs is mempool.space's current estimate, change1mPct compares the 3-day average now with the 3-day average 30 days ago." : null,
    difficulty?.nextAdjustment ? "The next difficulty change is an estimate that moves with every block until the retarget." : null,
    fees ? `Fees are sat/vB for the next block, ~30 min, ~1 hour, and economy; typicalTxUsd prices a ${TYPICAL_TX_VB} vB transaction (one input, two outputs, native SegWit) at mempool.space's BTC/USD reference.` : null,
    halving ? `Halving ETA assumes ${epochAvgS ? "this epoch's average block time" : "10-minute blocks"}: an estimate, give it as a date range, not a day.` : null,
    supply ? "issuedBtc is computed from the block height with the issuance schedule (includes the unspendable genesis 50 BTC; lost coins are not subtracted)." : null,
    o.unavailable.length ? `Not available right now: ${o.unavailable.join(", ")}. Do not guess those numbers.` : null,
  ].filter(Boolean).join(" ");

  const viz: Viz[] = o.chart && h && h.daily.length > 2
    ? [{ kind: "line", title: "Bitcoin hashrate · daily average, EH/s", x: h.daily.map((x) => x.date.slice(5)), series: [{ name: "Hashrate (EH/s)", values: h.daily.map((x) => x.ehs) }], unit: "n" }]
    : [];
  return {
    data: {
      source: "mempool.space", ...(o.ageS > 0 ? { dataAgeS: o.ageS } : {}),
      tipHeight: tip, lastBlock, recentBlocks,
      hashrate: h ? { nowEhs: h.nowEhs, avg3dEhs: h.avg3dEhs, monthAgoEhs: h.monthAgoEhs, monthAgoDate: h.monthAgoDate, change1mPct: h.change1mPct } : null,
      difficulty, fees, mempool, halving, supply,
      ...(o.unavailable.length ? { unavailable: o.unavailable } : {}),
      note,
    },
    addresses: [],
    citations: [{ label: "mempool.space", href: "https://mempool.space/" }, ...(h ? [{ label: "Hashrate and difficulty on mempool.space", href: "https://mempool.space/graphs/mining/hashrate-difficulty" }] : [])],
    viz,
  };
}

async function btcNetwork(args: Record<string, any>): Promise<ExtToolResult> {
  const inc = Array.isArray(args.include) ? args.include.map(String) : args.include ? [String(args.include)] : [];
  const chart = inc.some((x: string) => /hash|chart/i.test(x));
  const get = (path: string, ttlS: number) => extJson("mempool", `${MEMPOOL}${path}`, { ttlS, timeoutMs: 8000 });
  const calls = {
    blocks: get("/v1/blocks", 30), fees: get("/v1/fees/recommended", 30), mempool: get("/mempool", 30),
    difficulty: get("/v1/difficulty-adjustment", 300), hashrate: get("/v1/mining/hashrate/1m", 1800), prices: get("/v1/prices", 60),
  };
  const keys = Object.keys(calls) as (keyof typeof calls)[];
  const settled = await Promise.allSettled(keys.map((k) => calls[k]));
  const parts: BtcParts = {};
  const unavailable: string[] = [];
  let ageS = 0;
  settled.forEach((s, i) => {
    const k = keys[i];
    if (s.status === "fulfilled") { parts[k] = s.value.data; if (k === "blocks" || k === "fees" || k === "mempool") ageS = Math.max(ageS, s.value.ageS); }
    else if (k !== "prices") unavailable.push({ blocks: "last block", fees: "fees", mempool: "mempool size", difficulty: "difficulty adjustment", hashrate: "hashrate" }[k]);
  });
  // The mempool size answer carries a 270-row fee histogram the model never reads.
  if (parts.mempool && typeof parts.mempool === "object") parts.mempool = { count: parts.mempool.count, vsize: parts.mempool.vsize, total_fee: parts.mempool.total_fee };
  return btcNetworkResult(parts, Math.floor(Date.now() / 1000), { chart, ageS, unavailable });
}

// ═════════════════════════════════════════ exports ══════════════════════════════════════════════
export const MARKET_EXTRA_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "stock_movers",
      description: "US stock market movers from Nasdaq (regular session): the day's top gainers, top losers, most active by share volume, most traded by dollar value, or the biggest Nasdaq-100 moves. Each row: ticker, company, last price, change, change %, share volume (most_active), and whether a tokenized version trades on Robinhood Chain (its token address, Trade tab link and its own on-chain price). Echoes Nasdaq's 'data as of' time. Stocks under $1 are left out unless min_price is 0. Use for 'top gainers today', 'which US stocks are moving', 'most active stocks', 'what moved on Wall Street today', 'biggest losers', 'which of today's movers can I trade on Robinhood Chain'. For one stock's levels use market_levels; for the on-chain stock tokens' own board (NAV gap, 24/7 volume) use rh_stocks.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", enum: ["gainers", "losers", "most_active", "most_active_dollar", "nasdaq100"], description: "default most_active (by share volume, many small caps); most_active_dollar = ranked by dollar value traded (the large names; Nasdaq gives no dollar figure); nasdaq100 = largest % moves inside the Nasdaq-100" },
          session: { type: "string", enum: ["regular", "pre", "after"], description: "default: the session live now in New York, else regular. Nasdaq currently publishes regular-session lists only; asking for pre / after returns them with a note saying so" },
          min_price: { type: "number", description: "drop stocks priced under this many dollars, default 1; 0 keeps penny stocks" },
          limit: { type: "integer", description: "rows, default 10, max 25 (Nasdaq lists hold at most 20)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "btc_network",
      description: "Bitcoin network health from mempool.space: block height and minutes since the last block (and its miner), hashrate now vs a month ago (EH/s, % change), difficulty and the next adjustment (estimated % change, blocks left, ETA), recommended fees in sat/vB (next block, ~30 min, ~1 hour, economy) with the dollar cost of a typical transaction, mempool size (transactions, vMB), blocks and estimated date to the next halving, the block subsidy, and the supply issued so far computed from the height. Use for 'BTC hashrate', 'bitcoin fees now', 'when is the next halving', 'next difficulty adjustment', 'how many bitcoin have been mined', 'is the mempool congested'. Not for BTC price or levels (market_levels).",
      parameters: {
        type: "object",
        properties: { include: { type: "array", items: { type: "string", enum: ["hashrate_chart"] }, description: "optional: hashrate_chart adds a 30-day daily hashrate line" } },
        required: [],
      },
    },
  },
];

export const MARKET_EXTRA_TOOL_META: Record<string, ToolMeta> = {
  stock_movers: { group: "stocks", label: "Reading US stock movers", market: true },
  btc_network: { group: "btc", label: "Reading the Bitcoin network" },
};

export const MARKET_EXTRA_TOOL_NAMES = ["stock_movers", "btc_network"] as const;
export const isMarketExtraTool = (name: string): boolean => (MARKET_EXTRA_TOOL_NAMES as readonly string[]).includes(name);

/** Runs one tool of this module. Never throws: a source failure answers extFailure. */
export async function runMarketExtraTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  try {
    if (name === "stock_movers") return await stockMovers(args ?? {});
    if (name === "btc_network") return await btcNetwork(args ?? {});
    return { data: { error: `unknown tool ${name}` }, addresses: [], citations: [] };
  } catch (e) {
    return { data: extFailure(name === "stock_movers" ? "Nasdaq" : "mempool.space", e), addresses: [], citations: [] };
  }
}
