// askChains.ts — one token resolver + one price for the journal: Chord's services/askChains.ts, ported to ask2049 (2026-10-06).
// Ask covers Arc (5042) and Robinhood Chain (4663), and since 2026-10-02 the chain-keyed chains Avalanche (43114), Base (8453)
// and BNB Chain (56). A position carries its chain; an absent chain means Arc (everything Chord saved before 2026-09-24).
//
// Resolution without an explicit chain: a stock ticker or an exact Robinhood-listed symbol that is not also an Arc symbol goes
// to Robinhood; otherwise Arc first (memecoins), then Robinhood; only when neither has it and the caller allows it (journal),
// the three keyed chains (listed token first, then 24h volume).
//
// ask2049: Chord reads its own index (Postgres rollups, Redis boards). Here every read goes to Chord's PUBLIC API through
// services/chordApi.ts (cached GET; the last good answer is served when a refresh fails):
//   Arc             resolve  GET /v1/arc/tokens/search?q=&limit=8          (Chord: searchArcTokens, the same search)
//                   price    GET /v1/tokens/market?chain=5042              (the same 24h rollup's last price; see askPriceNow)
//   Robinhood Chain resolve  GET /v1/tokens?chain=4663 (listed set) + GET /v1/rh/tokens?limit=200&includeUnlisted=1 (24h board)
//                   price    the 24h board, then GET /v1/tokens/market?chain=4663
//   AVAX/Base/BNB   resolve  GET /v1/tokens?chain= (listed set) + GET /v1/chains/:chain/tokens?limit=200&sort=volume (24h board)
//                   price    GET /v1/candles (newest 1m candle of the last 2 h), then GET /v1/chains/:chain/token/:addr (24h price)
// Each place that differs from Chord is marked `// ask2049:`.
import { chainDataServed } from "../config/chains";
import { chainMeta } from "../shared";
import { chordGet } from "./chordApi";
import { getRhTokens } from "./rhTokens";
import { getRhMarketMap } from "./rhMarkets";
import { getArcMarketMap } from "./arcRollup";
import { chainToken } from "./chainRollup";
import { getChainTokens } from "./chainTokens";
import type { ChordMarketMap } from "./chordApi";

export const KEYED_ASK_CHAINS = [43114, 8453, 56] as const;
export type KeyedAskChain = (typeof KEYED_ASK_CHAINS)[number];
export type AskChain = 5042 | 4663 | KeyedAskChain;
export const ASK_CHAINS: AskChain[] = [5042, 4663, ...KEYED_ASK_CHAINS];
export const isAskChain = (n: unknown): n is AskChain => (ASK_CHAINS as unknown[]).includes(n);
export const isKeyedAskChain = (n: unknown): n is KeyedAskChain => n === 43114 || n === 8453 || n === 56;
/** The chain a stored position / rule / pick lives on: its own when it is an Ask chain, else Arc (pre-2026-09-24 rows). */
export const chainOf = (x: { chain?: number | null } | null | undefined): AskChain => {
  const c = Number(x?.chain);
  return isAskChain(c) ? c : 5042;
};
const NAMES: Record<AskChain, string> = { 5042: "Arc", 4663: "Robinhood Chain", 43114: "Avalanche", 8453: "Base", 56: "BNB Chain" };
export const chainName = (c: AskChain) => NAMES[c] ?? "Arc";
/** Short label for a table column. */
export const chainLabel = (c: AskChain) => (c === 4663 ? "Robinhood" : NAMES[c] ?? "Arc");

/** "avalanche" / "avax" / 43114 → 43114, etc. null = not one of the three. (ask2049: Chord's services/ask/chainTools.ts.) */
export function parseKeyedChain(v: unknown): KeyedAskChain | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (["43114", "avalanche", "avax", "avalanche c-chain", "c-chain", "avalanche c chain"].includes(s)) return 43114;
  if (["8453", "base", "base chain", "base mainnet"].includes(s)) return 8453;
  if (["56", "bnb", "bsc", "bnb chain", "bnb smart chain", "binance smart chain", "binance", "bep20"].includes(s)) return 56;
  return null;
}
/** "arc" / "robinhood" / "avalanche" / "base" / "bnb" (or the ids) → the chain; null = none of them. */
export function parseAskChain(v: unknown): AskChain | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "5042" || s === "arc") return 5042;
  if (s === "4663" || s === "robinhood" || s === "rh" || s === "robinhood chain") return 4663;
  return parseKeyedChain(s);
}
/** Written on a stored row: absent for Arc (the old shape), the id otherwise. */
export const chainFieldOf = (c: AskChain | null | undefined): { chain?: Exclude<AskChain, 5042> } => (c && c !== 5042 ? { chain: c } : {});

export interface AskTokenRef { chain: AskChain; address: string; symbol: string; name: string | null; priceUsd: number | null; decimals: number | null; logoURI: string | null; stock: boolean }

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const BOARD_TTL_MS = 60_000;

/** A price-map entry by address, whatever case the map's keys are in. */
function mapPrice(map: ChordMarketMap | null, a: string): number | null {
  if (!map) return null;
  const hit = map[a] ?? Object.entries(map).find(([k]) => k.toLowerCase() === a)?.[1];
  const p = hit?.priceUsd;
  return typeof p === "number" && p > 0 ? p : null;
}

// ── Robinhood Chain ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface RhBoardRow { address: string; symbol: string | null; name: string | null; priceUsd: number | null; decimals: number | null; logoURI: string | null; tags?: string[]; volume24h: number }
type RhBoardEntry = { symbol: string | null; name: string | null; priceUsd: number | null; decimals: number | null; logoURI: string | null; tags: string[]; volume24h: number };

/** Robinhood 24h board as a map (listed + unlisted). */
async function rhBoard(): Promise<Map<string, RhBoardEntry>> {
  // ask2049: Chord reads getRhTokens24h({ limit: 2_000, includeUnlisted: true }) in-process; the public route caps limit at 200,
  // so an unlisted meme outside the 200 busiest is not on this board.
  const r = await chordGet<{ tokens?: RhBoardRow[] }>("/v1/rh/tokens?limit=200&includeUnlisted=1", BOARD_TTL_MS).catch(() => null);
  const rows = Array.isArray(r?.tokens) ? r.tokens : [];
  return new Map(rows.map((t) => [t.address.toLowerCase(), { symbol: t.symbol ?? null, name: t.name ?? null, priceUsd: t.priceUsd ?? null, decimals: t.decimals ?? null, logoURI: t.logoURI ?? null, tags: Array.isArray(t.tags) ? t.tags : [], volume24h: Number(t.volume24h) || 0 }]));
}

async function resolveRh(q: string): Promise<AskTokenRef | null> {
  const s = q.trim().toLowerCase().replace(/^\$/, "");
  if (!s) return null;
  const [list, board] = await Promise.all([getRhTokens().catch(() => []), rhBoard()]);
  const clean = (n: string | null | undefined) => (n ?? "").replace(/\s*•\s*Robinhood Token$/i, "").trim();
  let t = list.find((x) => x.address.toLowerCase() === s) ?? list.find((x) => x.symbol.toLowerCase() === s);
  if (!t && s.length >= 3) {
    const byName = list.filter((x) => clean(x.name).toLowerCase().includes(s));
    t = byName.length === 1 ? byName[0] : byName.find((x) => x.tags?.includes("stock"));
  }
  if (t) {
    const b = board.get(t.address.toLowerCase());
    return { chain: 4663, address: t.address.toLowerCase(), symbol: t.symbol, name: clean(t.name) || null, priceUsd: b?.priceUsd ?? null, decimals: t.decimals, logoURI: t.logoURI ?? null, stock: !!t.tags?.includes("stock") };
  }
  // Unlisted but traded (memes): exact address or symbol on the 24h board, busiest first.
  const hits = [...board.entries()].filter(([a, b]) => a === s || (b.symbol ?? "").toLowerCase() === s).sort((x, y) => y[1].volume24h - x[1].volume24h);
  if (!hits.length) return null;
  const [addr, b] = hits[0];
  return { chain: 4663, address: addr, symbol: b.symbol ?? addr.slice(0, 8), name: b.name, priceUsd: b.priceUsd, decimals: b.decimals, logoURI: b.logoURI, stock: b.tags.includes("stock") };
}

// ── Arc ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface ArcSearchRow { address: string; symbol: string | null; name: string | null; decimals: number | null; logoURI: string | null; listed: boolean; priceUsd: number | null; volume24h: number }

async function resolveArc(q: string): Promise<AskTokenRef | null> {
  const s = q.trim().toLowerCase().replace(/^\$/, "");
  if (!s) return null;
  // ask2049: Chord calls searchArcTokens(s, 8) in-process; this is the same search behind the public route (q is 1..64 chars
  // there — a longer one answers 400 and resolves to nothing, as Chord's search would find nothing).
  const r = await chordGet<{ tokens?: ArcSearchRow[] }>(`/v1/arc/tokens/search?q=${encodeURIComponent(s)}&limit=8`, BOARD_TTL_MS).catch(() => null);
  const rows = (Array.isArray(r?.tokens) ? r.tokens : []).map((t) => ({ ...t, address: t.address.toLowerCase(), volume24h: Number(t.volume24h) || 0 }));
  const exact = rows.filter((t) => t.address === s || (t.symbol ?? "").toLowerCase() === s);
  const pool = exact.length ? exact : s.length >= 3 ? rows : [];
  const t = [...pool].sort((a, b) => Number(b.listed) - Number(a.listed) || b.volume24h - a.volume24h)[0];
  return t ? { chain: 5042, address: t.address, symbol: t.symbol ?? t.address.slice(0, 8), name: t.name ?? null, priceUsd: t.priceUsd ?? null, decimals: t.decimals ?? null, logoURI: t.logoURI ?? null, stock: false } : null;
}

// ── Avalanche / Base / BNB Chain ────────────────────────────────────────────────────────────────────────────────────────
/** Last price on a keyed chain: the newest 1-minute candle of the last 2 h (trusted pool), else the hourly rollup's 24h price. */
async function keyedPrice(chain: KeyedAskChain, token: string): Promise<number | null> {
  const a = token.toLowerCase();
  // ask2049: Chord reads getChainTokenCandles(chain, a, 60, now − 7200, now + 60) from Postgres; here the public candle route
  // over the same window, its end snapped to the next minute so reads within a minute share one cached answer.
  const to = (Math.floor(Date.now() / 60_000) + 1) * 60;
  const c = await chordGet<{ candles?: { t: number; c: number }[] }>(`/v1/candles?chain=${chain}&token=${a}&tf=1m&from=${to - 7_260}&to=${to}&limit=130`, 30_000)
    .then((j) => (Array.isArray(j?.candles) ? j.candles : [])).catch(() => []);
  const last = c.length ? Number(c[c.length - 1].c) : null;
  if (last != null && last > 0) return last;
  const p = (await chainToken(chain, a, { hours: 24 }).catch(() => null))?.stats24h?.priceUsd;
  return p != null && p > 0 ? p : null;
}

interface KeyedToken { address: string; symbol: string; name: string | null; decimals: number | null; listed: boolean; volume24hUsd: number }
interface KeyedBoardRow { address: string; symbol: string | null; name: string | null; decimals: number | null; volume24h: number }

/** Symbol / name / 0x → one token on the chain, plus the look-alikes that share its symbol. (ask2049: Chord's
 *  services/ask/chainTools.ts resolveKeyedToken.) */
async function resolveKeyedToken(chain: KeyedAskChain, q: string): Promise<{ token: KeyedToken; lookAlikes: KeyedToken[] } | null> {
  const m = chainMeta(chain)!;
  let s = q.trim().toLowerCase().replace(/^\$/, "");
  if (!s) return null;
  if (s === m.nativeSymbol.toLowerCase()) s = m.wrappedNative; // data lives under the wrapped twin
  const [list, board] = await Promise.all([
    getChainTokens(chain).catch(() => []),
    // Same path as services/chainRollup.chainTokens(chain, { limit: 200, sort: "volume" }), so both share one cached answer.
    chordGet<{ tokens?: KeyedBoardRow[] }>(`/v1/chains/${chain}/tokens?limit=200&sort=volume`, BOARD_TTL_MS).catch(() => null),
  ]);
  const boardRows = (Array.isArray(board?.tokens) ? board.tokens : []).map((t) => ({ ...t, address: t.address.toLowerCase() }));
  const vol = new Map(boardRows.map((t) => [t.address, t] as const));
  const asTok = (a: string, sym: string | null, name: string | null, dec: number | null, listed: boolean): KeyedToken =>
    ({ address: a, symbol: sym ?? short(a), name, decimals: dec, listed, volume24hUsd: Math.round(Number(vol.get(a)?.volume24h) || 0) });
  if (ADDR.test(s)) {
    const l = list.find((t) => t.address.toLowerCase() === s);
    if (l) return { token: asTok(s, l.symbol, l.name ?? null, l.decimals, true), lookAlikes: [] };
    const b = vol.get(s);
    // ask2049: Chord reads an unknown address's symbol / decimals on-chain (chainTokenMeta); no public route answers that, so an
    // address that is neither listed nor on the 24h board does not resolve.
    if (!b) return null;
    return { token: asTok(s, b.symbol ?? null, b.name ?? null, b.decimals ?? null, false), lookAlikes: [] };
  }
  const cands = new Map<string, KeyedToken>();
  for (const t of list) if (t.symbol.toLowerCase() === s) cands.set(t.address.toLowerCase(), asTok(t.address.toLowerCase(), t.symbol, t.name ?? null, t.decimals, true));
  for (const t of boardRows) if ((t.symbol ?? "").toLowerCase() === s && !cands.has(t.address)) cands.set(t.address, asTok(t.address, t.symbol, t.name ?? null, t.decimals ?? null, false));
  if (!cands.size && s.length >= 3) {
    // A name ("pancakeswap", "aerodrome"): listed names first, one hit only.
    const byName = list.filter((t) => (t.name ?? "").toLowerCase().includes(s));
    if (byName.length === 1) { const t = byName[0]; return { token: asTok(t.address.toLowerCase(), t.symbol, t.name ?? null, t.decimals, true), lookAlikes: [] }; }
  }
  const ranked = [...cands.values()].sort((a, b) => Number(b.listed) - Number(a.listed) || b.volume24hUsd - a.volume24hUsd);
  if (!ranked.length) return null;
  return { token: ranked[0], lookAlikes: ranked.slice(1, 6) };
}

async function resolveKeyedRanked(q: string, chain: KeyedAskChain): Promise<{ ref: AskTokenRef; listed: boolean; volume: number } | null> {
  if (!chainDataServed(chain, false)) return null;
  const r = await resolveKeyedToken(chain, q);
  if (!r) return null;
  const t = r.token;
  const [priceUsd, logoURI] = await Promise.all([
    keyedPrice(chain, t.address).catch(() => null),
    getChainTokens(chain).then((l) => l.find((x) => x.address.toLowerCase() === t.address)?.logoURI ?? null).catch(() => null),
  ]);
  return { ref: { chain, address: t.address, symbol: t.symbol, name: t.name, priceUsd, decimals: t.decimals, logoURI, stock: false }, listed: t.listed, volume: t.volume24hUsd };
}

/** Symbol / name / 0x → one token on an Ask chain. `chain` pins it; else see the header. Unpinned, the keyed chains
 *  are searched only with `opts.keyed` (journal, alerts) — reports and clips build Arc / Robinhood pages only. */
export async function resolveAskToken(q: string, chain?: AskChain | null, opts: { keyed?: boolean } = {}): Promise<AskTokenRef | null> {
  if (isKeyedAskChain(chain)) return (await resolveKeyedRanked(q, chain))?.ref ?? null;
  if (chain === 4663) return resolveRh(q);
  if (chain === 5042) return resolveArc(q);
  const [rh, arc] = await Promise.all([resolveRh(q).catch(() => null), resolveArc(q).catch(() => null)]);
  const s = q.trim().toLowerCase().replace(/^\$/, "");
  const arcExact = !!arc && (arc.address === s || arc.symbol.toLowerCase() === s);
  if (rh && (rh.stock || rh.address === s || !arcExact)) return rh;
  if (arc ?? rh) return arc ?? rh;
  if (!opts.keyed) return null;
  const keyed = (await Promise.all(KEYED_ASK_CHAINS.map((c) => resolveKeyedRanked(q, c).catch(() => null)))).filter((x): x is NonNullable<typeof x> => !!x);
  keyed.sort((a, b) => Number(b.listed) - Number(a.listed) || b.volume - a.volume);
  return keyed[0]?.ref ?? null;
}

/** The index price now (last trade) of a token on its chain; null when it has not traded lately. */
export async function askPriceNow(token: string, chain: AskChain): Promise<number | null> {
  const a = token.toLowerCase();
  if (isKeyedAskChain(chain)) return keyedPrice(chain, a);
  if (chain === 4663) {
    const p = (await rhBoard()).get(a)?.priceUsd;
    if (p != null && p > 0) return p;
    // ask2049: Chord's fallback is analyticsDb.getTokenStats (its raw tape); here the public Robinhood Chain market map (every
    // token with a print in the last 24 h, with Chord's live overlay).
    return mapPrice(await getRhMarketMap().catch(() => null), a);
  }
  // ask2049: Chord reads searchArcTokens(a, 1) — the 24h rollup's last price, with a live-print overlay. The public search route
  // counts every query as a "search" on Chord's attention board (askAttention), so a price read must not go through it; the
  // Arc market map is the same rollup's last price for every token priced in the last 24 h (without the live overlay).
  return mapPrice(await getArcMarketMap().catch(() => null), a);
}

/** Where a token lives on getchord: Arc token page, or the Ask Trade tab (Robinhood Chain; the keyed chains with ?chain=). */
export const askTokenPath = (address: string, chain: AskChain) =>
  chain === 4663 ? `/ask/trade/${address.toLowerCase()}` : isKeyedAskChain(chain) ? `/ask/trade/${address.toLowerCase()}?chain=${chain}` : `/arc/token/${address}`;
