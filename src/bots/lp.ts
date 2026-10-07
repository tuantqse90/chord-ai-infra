// LP agent analysis (ask2049-notes/bots-contract.md "## LP agent"): lpScan ranks Solana pools for providing liquidity,
// lpRange sizes a price range from realized volatility, lpBacktest replays hourly prices through a position with the bot's
// own rules. Every number says where it came from (lpData.ts); fee income is an estimate, IL is exact CL math (lpMath.ts).
import { isPubkey, KNOWN_MINTS } from "../solana/tokens";
import { BotInputError } from "./errors";
import {
  amountsAt, boundsPct, binsFor, FULL_RANGE, inRange, liquidityFor, presetLogWidth, PRESET_SIGMAS, rangeFromLogWidth, rangeFromPct, sigma,
  ticksFor, timeInRangeHistory, tokenShare, valueAt, type PriceRange,
} from "./lpMath";
import {
  isExodus, livePair, lpSince, poolHourly, poolInfo, pricePath, short, toPoolInfo, venueStats, EXODUS_MIN_USD, EXODUS_RATIO,
  type LpDeps, type PoolInfo, type PricePoint, type VenueStats,
} from "./lpData";
import { USDC_MINT } from "./market";
import { validateDays, validateLpParams, type LpRules } from "./validate";
import type { LpBacktest, LpFlag, LpPoolScan, LpPreset, LpRangeAnswer, LpRangePreset, LpScan, LpVolatility } from "./types";

export const HORIZON_HOURS = 24;            // presets (and the bot's ranges) are sized for a 24 h horizon
export const THIN_TVL_USD = 50_000;
export const NEW_POOL_HOURS = 72;
export const DEFAULT_SWAP_FEE_PCT = 0.25;   // stated estimate when the venue gives no fee rate
export const DEFAULT_IMPACT_PCT = 0.5;      // stated estimate when Jupiter gives no quote
const HISTORY_HOURS = 168;

const cents = (n: number) => Math.round(n * 100) / 100;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sig = (n: number) => Number(n.toPrecision(6));
export const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString("en-US") : Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const pctText = (n: number) => `${Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(Math.abs(n) >= 10 ? 1 : 2)}%`;
export const priceText = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : Number(n.toPrecision(4)).toString());
const hoursText = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)} h` : `${Math.round(h * 60)} min`);
const isMajor = (mint: string) => !!KNOWN_MINTS[mint];

export function volatilityOf(points: PricePoint[]): LpVolatility | null {
  const s = sigma(points.map((x) => x.p));
  return s == null ? null : { hourlyPct: r2(s * 100), dailyPct: r2(s * Math.sqrt(24) * 100), points: points.length };
}

/** The bot's range at price p: the venue's full range, a custom ±rangePct, or a preset k σ √24 h in log space. */
export function rangeFor(p: number, rules: Pick<LpRules, "preset" | "rangePct">, sigmaHourly: number | null, full: boolean): { r: PriceRange; logWidth: number | null } {
  if (full) return { r: FULL_RANGE, logWidth: null };
  if (rules.rangePct != null) return { r: rangeFromPct(p, rules.rangePct), logWidth: null };
  if (sigmaHourly == null) throw new BotInputError("not enough price history on Chord's tape to size a preset range for this pool; pass rangePct instead");
  const w = presetLogWidth(sigmaHourly, HORIZON_HOURS, PRESET_SIGMAS[rules.preset ?? "balanced"]);
  return { r: rangeFromLogWidth(p, w), logWidth: w };
}
/** The same width, recentered on p (a rebalance). */
export const recenter = (p: number, logWidth: number | null, rangePct: number | null): PriceRange =>
  logWidth != null ? rangeFromLogWidth(p, logWidth) : rangePct != null ? rangeFromPct(p, rangePct) : FULL_RANGE;

/** Share of a fresh position's value that must be swapped to move from the current mix to the new range's mix. */
export function swapShare(L: number, p: number, from: PriceRange, to: PriceRange): number {
  return Math.abs(tokenShare(L, p, from) - tokenShare(liquidityFor(1, p, to), p, to));
}

// ── scan ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const LP_SCAN_SORTS = ["fees", "deposits", "withdrawals", "net", "lps", "tvl"] as const;
export type LpScanSort = (typeof LP_SCAN_SORTS)[number];
export interface LpScanOpts { limit?: number; sort?: LpScanSort; dex?: string; minTvlUsd?: number }

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

function scoreOf(r: Omit<LpPoolScan, "score">): number {
  const lg = (x: number, full: number) => Math.min(1, Math.log10(1 + Math.max(0, x)) / Math.log10(1 + full));
  const flow = r.deposits24hUsd + r.withdrawals24hUsd > 0 ? (1 + r.netFlow24hUsd / (r.deposits24hUsd + r.withdrawals24hUsd)) / 2 : 0.5;
  const calm = r.volatility ? 1 - Math.min(1, r.volatility.dailyPct / 50) : 0.5;
  const raw = 0.45 * lg(r.feeAprPct ?? 0, 1000) + 0.2 * lg(r.volumeTvl ?? 0, 20) + 0.15 * lg(r.lps24h, 200) + 0.1 * flow + 0.1 * calm;
  const penalty = r.flags.reduce((a, f) => a + (f.code === "no_tvl" || f.code === "no_fee_apr" || f.code === "short_history" ? 8 : 15), 0);
  return Math.max(0, Math.round(raw * 100 - penalty));
}

/** Rank Chord's most active LP pools of the last 24 h for providing liquidity. Every flag is listed on its row; `best` is
 *  the top pool with NO flag (null when every candidate carries one). */
export async function lpScan(opts: LpScanOpts = {}, d: LpDeps): Promise<LpScan> {
  const limit = Math.max(1, Math.min(20, Math.floor(Number(opts.limit ?? 10)) || 10));
  const sort = (opts.sort ?? "fees") as LpScanSort;
  if (!LP_SCAN_SORTS.includes(sort)) throw new BotInputError(`sort must be one of ${LP_SCAN_SORTS.join(", ")}`);
  if (opts.dex != null && !(opts.dex in { meteora_dlmm: 1, meteora_damm_v2: 1, raydium_clmm: 1, pumpswap: 1 })) throw new BotInputError("dex must be meteora_dlmm, meteora_damm_v2, raydium_clmm or pumpswap");
  const minTvl = opts.minTvlUsd != null ? Number(opts.minTvlUsd) : 0;
  if (!(minTvl >= 0)) throw new BotInputError("minTvlUsd must be a number of 0 or more");
  // the candidate list: up to 20 s (Chord answered it in 12-56 s while the shared box was throttled, 07/10), one more try
  const listPath = `/v1/chains/solana/lp/pools?sort=${sort}&limit=${opts.dex || minTvl > 0 ? 100 : limit}&hours=24`;
  const list = await d.chord<any>(listPath, 60_000, 20_000).catch(() => d.chord<any>(listPath, 60_000, 20_000));
  if (!Array.isArray(list?.rows)) throw new Error("Chord's LP pool list answered without rows");
  // A TVL floor is applied after the venues answer (DLMM / CLMM rows carry none on Chord), so twice the candidates are read.
  const rows = (list.rows as any[])
    .filter((r) => r && typeof r.pool === "string" && (!opts.dex || r.dex === opts.dex) && !(minTvl > 0 && typeof r.tvlUsd === "number" && r.tvlUsd < minTvl))
    .slice(0, minTvl > 0 ? Math.min(30, limit * 2) : limit);
  const since = await lpSince(d);
  const nowS = Math.floor(d.now() / 1000);
  const notes: string[] = [], poolNotes: string[] = [];

  const scanned = await mapLimit(rows, 4, async (row): Promise<LpPoolScan> => {
    let info: PoolInfo;
    let lastHour: LpPoolScan["lastHour"] = null;
    try { info = await poolInfo(d, row.pool); lastHour = info.lastHour; }
    catch (e) {
      info = toPoolInfo(row.pool, row);
      poolNotes.push(`${info.pair}: the last hour's LP flows could not be read on Chord (${String((e as Error)?.message ?? e).slice(0, 100)}), so its LP exodus was not checked.`);
    }
    const [venue, path, safety] = await Promise.all([
      venueStats(d, info.dex, info.pool, info.token),
      pricePath(d, info, HISTORY_HOURS).catch((e) => ({ points: [] as PricePoint[], notes: [], error: String((e as Error)?.message ?? e).slice(0, 120) })),
      isMajor(info.token) ? Promise.resolve(undefined) : d.tokenInfo(info.token).catch(() => null),
    ]);
    const v = venue.v;
    const flags: LpFlag[] = [];
    const sym = info.tokenSymbol ?? short(info.token);
    const tvl = v?.tvlUsd ?? info.tvlUsd ?? (typeof row.tvlUsd === "number" ? row.tvlUsd : null);
    const tvlSource = v?.tvlUsd != null ? v.source : tvl != null ? "Chord (pool reserves)" : null;
    const vol = v?.volume24hUsd ?? (typeof row.swapVolumeUsd === "number" ? row.swapVolumeUsd : null);
    const volumeSource = v?.volume24hUsd != null ? v.source : vol != null ? "Chord's tape (24 h)" : null;
    if (tvl == null) flags.push({ code: "no_tvl", msg: `TVL unknown: ${venue.err ?? "the venue gave none"} and Chord has none for ${info.venue} pools` });
    else if (tvl < THIN_TVL_USD) flags.push({ code: "thin_tvl", msg: `TVL ${money(tvl)} is under ${money(THIN_TVL_USD)}: fees and price swing hard, and a deposit is a large share of the pool` });
    if (v?.feeAprPct == null) flags.push({ code: "no_fee_apr", msg: `no fee APR source (${venue.err ?? "the venue gave none"}): fee income cannot be estimated` });

    // age: the venue's creation time, else the first time Chord's tape saw the pool (LP event or hourly candle)
    let ageHours: number | null = null, ageSource: string;
    if (v?.createdAt) { ageHours = (d.now() - v.createdAt) / 3_600_000; ageSource = `${v.source} created_at`; }
    else {
      const firstCandle = path.points[0]?.t ?? null;
      const seen = [info.firstLpEvent, firstCandle].filter((x): x is number => x != null);
      const first = seen.length ? Math.min(...seen) : null;
      const floor = Math.max(since ?? 0, nowS - HISTORY_HOURS * 3600);
      if (first != null && first > floor + 2 * 3600) { ageHours = (nowS - first) / 3600; ageSource = "first seen on Chord's tape"; }
      else ageSource = `older than Chord's coverage (since ${new Date(floor * 1000).toISOString().slice(0, 10)})`;
    }
    if (ageHours != null && ageHours < NEW_POOL_HOURS) flags.push({ code: "new_pool", msg: `pool is ${hoursText(ageHours)} old (${ageSource}): no track record, launch-time fees do not last` });
    if (lastHour && isExodus(lastHour.depositsUsd, lastHour.withdrawalsUsd, tvl)) {
      flags.push({ code: "lp_exodus", msg: `LP exodus: ${money(lastHour.withdrawalsUsd)} withdrawn vs ${money(lastHour.depositsUsd)} deposited in the last hour (more than ${EXODUS_RATIO}× and over 10 % of the pool)` });
    }
    let safe: LpPoolScan["safety"] = null;
    const auth = (b: boolean | null | undefined) => (b === true ? "renounced" : b === false ? "live" : "unknown") as "renounced" | "live" | "unknown";
    if (safety !== undefined) {
      const freeze = safety?.freezeAuthorityDisabled ?? v?.freezeAuthorityDisabled ?? null;
      safe = { mintAuthority: auth(safety?.mintAuthorityDisabled), freezeAuthority: auth(freeze), liquidityUsd: safety?.liquidityUsd ?? null };
      if (safe.mintAuthority === "live") flags.push({ code: "mint_authority", msg: `${sym} has a live mint authority: more can be minted` });
      if (safe.freezeAuthority === "live") flags.push({ code: "freeze_authority", msg: `${sym} has a live freeze authority: holders can be frozen` });
      if (!safety) flags.push({ code: "safety_unknown", msg: `Jupiter has no safety facts for ${sym} (mint / freeze authority unchecked)` });
    }
    const volatility = volatilityOf(path.points);
    const pathErr = "error" in path ? path.error : null;
    if (pathErr) flags.push({ code: "short_history", msg: `the hourly price history could not be read on Chord (${pathErr}): no volatility, ranges unknown` });
    else if (!volatility || volatility.points < 24) flags.push({ code: "short_history", msg: `${volatility ? `${volatility.points} h of hourly price history` : "no hourly price history"} on Chord's tape: volatility and ranges are rough` });

    const base: Omit<LpPoolScan, "score"> = {
      pool: info.pool, dex: info.dex, venue: info.venue, pair: info.pair, token: info.token, tokenSymbol: info.tokenSymbol, quote: info.quote, quoteSymbol: info.quoteSymbol,
      priceUsd: typeof row.priceUsd === "number" ? row.priceUsd : info.priceUsd,
      tvlUsd: tvl != null ? cents(tvl) : null, tvlSource, volume24hUsd: vol != null ? cents(vol) : null, volumeSource, volumeTvl: tvl && vol != null ? r2(vol / tvl) : null,
      fees24hUsd: v?.fees24hUsd != null ? cents(v.fees24hUsd) : null, feeAprPct: v?.feeAprPct != null ? r2(v.feeAprPct) : null,
      feeAprSource: v?.feeAprPct != null ? `${v.source}: ${v.feeAprHow}` : null, feeRatePct: v?.feeRatePct != null ? sig(v.feeRatePct) : null,
      feesClaimed24hUsd: cents(Number(row.feesClaimedUsd) || 0), deposits24hUsd: cents(Number(row.depositsUsd) || 0), withdrawals24hUsd: cents(Number(row.withdrawalsUsd) || 0),
      netFlow24hUsd: cents(Number(row.netFlowUsd) || 0), lps24h: Number(row.lps) || 0, openPositions: typeof row.openPositions === "number" ? row.openPositions : null,
      lastHour, ageHours: ageHours != null ? r2(ageHours) : null, ageSource, volatility, safety: safe, binStep: v?.binStep ?? null, tickSpacing: v?.tickSpacing ?? null, flags,
    };
    return { ...base, score: scoreOf(base) };
  });

  const kept = scanned.filter((r) => !(minTvl > 0) || (r.tvlUsd != null && r.tvlUsd >= minTvl)).sort((a, b) => b.score - a.score).slice(0, limit);
  const best = kept.find((r) => !r.flags.length)?.pool ?? null;
  notes.push("Candidates: Chord's Solana LP tape, the pools with the most liquidity activity over the last 24 h (Meteora DLMM / DAMM v2, Raydium CLMM, PumpSwap).");
  notes.push("Fee APR, TVL, volume and 24 h fees come from each venue's public pool API (named on each row); PumpSwap has none, so its fee APR is unknown and its TVL is Chord's.");
  notes.push(`Score (0–100) blends fee APR, volume / TVL, LP count, net LP flow and calm prices, minus every flag; a ranking aid, not a forecast. LP exodus = last hour's withdrawals over ${EXODUS_RATIO}× its deposits (and at least ${money(EXODUS_MIN_USD)}).`);
  if (!best) notes.push("Every pool in this scan carries at least one flag: read them before choosing one.");
  return { rows: kept, best, windowHours: 24, notes: [...notes, ...poolNotes], at: d.now() };
}

// ── range ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function venueShape(info: PoolInfo, v: VenueStats | null): string {
  if (info.dex === "meteora_dlmm") return `Meteora DLMM bins${v?.binStep ? ` (bin step ${v.binStep} bps)` : ""}: the "Spot" shape spreads liquidity evenly over the bins, which is what this model assumes; "Curve" piles it near the price (more fees, more IL), "Bid-Ask" at the edges.`;
  if (info.dex === "raydium_clmm") return `Raydium CLMM ticks${v?.tickSpacing ? ` (tick spacing ${v.tickSpacing})` : ""}: bounds round to the nearest initializable tick; liquidity is uniform inside the range.`;
  if (info.dex === "pumpswap") return "PumpSwap is a constant-product (x·y = k) pool: liquidity covers every price, there is no range to choose.";
  return "Meteora DAMM v2: every LP shares the pool's own price range, modeled here as full range.";
}

/** Three ranges for a pool from the token's realized volatility (σ of hourly returns over 7 days on Chord's tape):
 *  tight = 1σ√h, balanced = 2σ√h, wide = 3σ√h around the price, with the share of time each would have kept the price
 *  inside over `horizonHours` in that history. */
export async function lpRange(poolAddr: string, horizonHours: number = HORIZON_HOURS, d: LpDeps): Promise<LpRangeAnswer> {
  const pool = typeof poolAddr === "string" ? poolAddr.trim() : "";
  if (!isPubkey(pool)) throw new BotInputError("pool must be a Solana pool address (base58, case-sensitive)");
  const h = Math.round(Number(horizonHours ?? HORIZON_HOURS));
  if (!(h >= 1 && h <= 168)) throw new BotInputError("horizonHours must be between 1 and 168");
  const info = await poolInfo(d, pool);
  const [venue, path, px] = await Promise.all([
    venueStats(d, info.dex, info.pool, info.token),
    pricePath(d, info, HISTORY_HOURS),
    d.prices([info.token, info.quote]).catch(() => new Map<string, number>()),
  ]);
  const notes = [...path.notes];
  const last = path.points[path.points.length - 1];
  const live = livePair(px, info);
  const tokenUsd = live?.tokenUsd ?? last?.tokenUsd, quoteUsd = live?.quoteUsd ?? last?.quoteUsd;
  if (tokenUsd == null || quoteUsd == null) throw new Error(`no price for ${info.pair}: Jupiter has none and Chord's tape has no candles`);
  const price = tokenUsd / quoteUsd;
  const prices = path.points.map((x) => x.p);
  const vol = volatilityOf(path.points);
  const s = sigma(prices);
  const presets: LpRangePreset[] = [];
  if (!info.fullRange && s != null) {
    for (const preset of ["tight", "balanced", "wide"] as LpPreset[]) {
      const k = PRESET_SIGMAS[preset];
      const w = presetLogWidth(s, h, k);
      const r = rangeFromLogWidth(price, w);
      const b = boundsPct(price, r);
      const tir = timeInRangeHistory(prices, Math.exp(-w), Math.exp(w), h);
      presets.push({
        preset, sigmas: k, lower: sig(r.lower), upper: sig(r.upper), lowerUsd: sig(r.lower * quoteUsd), upperUsd: sig(r.upper * quoteUsd), downPct: r2(b.downPct), upPct: r2(b.upPct),
        expectedTimeInRangePct: tir != null ? Math.round(tir) : null, bins: info.dex === "meteora_dlmm" && venue.v?.binStep ? binsFor(r, venue.v.binStep) : null,
        ticks: info.dex === "raydium_clmm" ? ticksFor(r, venue.v?.tickSpacing ?? null) : null,
      });
    }
  }
  if (info.fullRange) notes.push(`${info.venue} positions are full range: no range to set; impermanent loss is the classic x·y = k loss.`);
  else if (s == null) notes.push("Not enough hourly price history on Chord's tape to measure volatility: no presets; pass a custom rangePct.");
  else {
    notes.push(`Width = k × σ(hourly returns) × √${h} h around the price, in log terms (tight k=1, balanced k=2, wide k=3), clamped to ±0.5 % … ×20.`);
    notes.push(`Expected time in range = the share of hours, over the last ${vol!.points} h of Chord's hourly closes, that a range set at each hour kept the price inside during the next ${h} h (windows near the end are shorter). Past volatility, not a forecast.`);
    if (vol!.points < 48) notes.push(`Only ${vol!.points} h of history: σ is rough.`);
  }
  const big = presets.find((p) => p.bins != null && p.bins > 69);
  if (big) notes.push(`The ${big.preset} range spans ${big.bins} bins; a standard Meteora DLMM position holds up to 70 bins, so a wider range needs more than one position.`);
  return {
    pool: info.pool, dex: info.dex, pair: info.pair, token: info.token, quote: info.quote, price: sig(price), priceUsd: sig(tokenUsd), quoteUsd: sig(quoteUsd),
    priceSource: live?.source ?? "Chord's last hourly close", horizonHours: h, volatility: vol && s != null ? { ...vol, horizonPct: r2(s * Math.sqrt(h) * 100) } : null,
    fullRange: info.fullRange, presets, venueShape: venueShape(info, venue.v), notes,
  };
}

// ── backtest ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Replay the last 1 / 3 / 7 days of hourly prices through an LP position run by the bot's rules: fees (estimate), exact
 *  CL impermanent loss, rebalances and their cost, LP exodus / token-drop exits, LP vs HODL vs 100 % quote. */
export async function lpBacktest(input: unknown, d: LpDeps): Promise<LpBacktest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BotInputError("lp backtest needs { pool, amountUsd, preset | rangePct, rebalance?, exits?, days }");
  const { days: rawDays, ...rest } = input as Record<string, unknown>;
  const days = validateDays(rawDays);
  const p = validateLpParams(rest);
  const HOURS = days * 24;
  const info = await poolInfo(d, p.pool);
  const nowS = Math.floor(d.now() / 1000);
  const startT = Math.floor(nowS / 3600) * 3600 - HOURS * 3600;
  const wantsQuote = !info.fullRange && p.rebalance.maxPerDay > 0;
  const [path, venue, hourly, q] = await Promise.all([
    pricePath(d, info, Math.min(1000, HOURS + HISTORY_HOURS)),
    venueStats(d, info.dex, info.pool, info.token),
    p.exits.lpExodus ? poolHourly(d, info.pool, HOURS).catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 120) })) : Promise.resolve(null),
    wantsQuote ? d.quote(USDC_MINT, info.token, p.amountUsd / 2, 100).catch(() => null) : Promise.resolve(null),
  ]);
  const notes = [...path.notes];
  const pre = path.points.filter((x) => x.t < startT);
  const replay = path.points.filter((x) => x.t >= startT);
  if (replay.length < 3) throw new Error(`only ${replay.length} hourly price${replay.length === 1 ? "" : "s"} for ${info.pair} on Chord's tape in the last ${days} day${days > 1 ? "s" : ""}: nothing to replay`);
  if (replay[0].t > startT + 2 * 3600) notes.push(`Price history starts ${new Date(replay[0].t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC: ${replay.length - 1} h replayed instead of ${HOURS} h.`);
  let s = pre.length >= 25 ? sigma(pre.map((x) => x.p)) : null;
  if (s == null && p.preset && !info.fullRange) {
    s = sigma(replay.map((x) => x.p));
    if (s != null) notes.push("Too little history before the replay window: the preset width uses volatility measured inside the window it replays (look-ahead).");
  }
  const { r: r0, logWidth } = rangeFor(replay[0].p, p, s, info.fullRange);
  const v = venue.v;
  const apr = v?.feeAprPct ?? null;
  const feePct = v?.feeRatePct ?? DEFAULT_SWAP_FEE_PCT;
  const impactPct = q?.priceImpactPct != null && q.priceImpactPct >= 0 ? q.priceImpactPct : DEFAULT_IMPACT_PCT;
  const costPct = feePct + impactPct;
  const costSource = `swap fee ${pctText(feePct)} (${v?.feeRatePct != null ? `${v.source}, ${v.feeRateHow}` : "stated estimate: the venue gave none"}) + price impact ${pctText(impactPct)} (${q?.priceImpactPct != null ? `Jupiter quote now for ${money(p.amountUsd / 2)}` : "stated estimate: no Jupiter quote"}) on the swapped share`;
  const flows = hourly && "byHour" in hourly ? hourly : null;

  const t0 = replay[0];
  let r = r0;
  let L = liquidityFor(p.amountUsd / t0.quoteUsd, t0.p, r);
  const a0 = amountsAt(L, t0.p, r);
  let leg = { cost: p.amountUsd, token: a0.token, quote: a0.quote, fees: 0 };
  const fills: LpBacktest["fills"] = [{ ts: t0.t * 1000, kind: "open", usd: cents(p.amountUsd), price: sig(t0.p), pnlUsd: null, reason: `Opened ${info.fullRange ? "full range" : `${priceText(r.lower)}–${priceText(r.upper)}`} at ${priceText(t0.p)} ${info.quoteSymbol ?? "quote"} per ${info.tokenSymbol ?? "token"}` }];
  const equity: LpBacktest["equity"] = [{ ts: t0.t * 1000, usd: cents(p.amountUsd), hodlUsd: cents(p.amountUsd), quoteOnlyUsd: cents(p.amountUsd), price: sig(t0.p), lower: info.fullRange ? null : sig(r.lower), upper: info.fullRange ? null : sig(r.upper), inRange: true }];
  let fees = 0, inHours = 0, openHours = 0, outH = 0, rebalances = 0, costTotal = 0, rebDay = -1, rebN = 0, peak = p.amountUsd, maxDd = 0;
  let exited: LpBacktest["exited"] = null, frozen = 0, lastIl = 0, cappedWarned = false;
  const legIl = (pt: PricePoint) => valueAt(L, pt.p, r) * pt.quoteUsd - (leg.token * pt.tokenUsd + leg.quote * pt.quoteUsd);

  for (let i = 1; i < replay.length; i++) {
    const pt = replay[i], prev = replay[i - 1];
    if (!exited) {
      const credit = ((inRange(prev.p, r) ? 1 : 0) + (inRange(pt.p, r) ? 1 : 0)) / 2;
      const valueUsd = valueAt(L, pt.p, r) * pt.quoteUsd;
      const f = apr != null ? valueUsd * (apr / 100) / 8760 * credit : 0;
      leg.fees += f; fees += f; inHours += credit; openHours++;
      lastIl = legIl(pt);
      const fl = flows?.byHour.get(pt.t);
      const exitWhy = fl && isExodus(fl.depositsUsd, fl.withdrawalsUsd, venue.v?.tvlUsd ?? info.tvlUsd) ? `LP exodus: ${money(fl.withdrawalsUsd)} withdrawn vs ${money(fl.depositsUsd)} deposited that hour`
        : p.exits.tokenDropPct != null && pt.tokenUsd <= t0.tokenUsd * (1 - p.exits.tokenDropPct / 100) ? `token drop: ${info.tokenSymbol ?? "the token"} fell ${pctText((1 - pt.tokenUsd / t0.tokenUsd) * 100)} from the open (stop at ${p.exits.tokenDropPct}%)`
        : null;
      if (exitWhy) {
        const closeVal = valueUsd + leg.fees;
        exited = { ts: pt.t * 1000, reason: exitWhy };
        frozen = closeVal;
        fills.push({ ts: pt.t * 1000, kind: "close", usd: cents(closeVal), price: sig(pt.p), pnlUsd: cents(closeVal - leg.cost), reason: `Exit, ${exitWhy}` });
      } else {
        outH = inRange(pt.p, r) ? 0 : outH + 1;
        if (outH > 0 && outH * 60 >= p.rebalance.outOfRangeMinutes && p.rebalance.maxPerDay > 0 && !info.fullRange) {
          const day = Math.floor(pt.t / 86_400);
          if (day !== rebDay) { rebDay = day; rebN = 0; cappedWarned = false; }
          if (rebN < p.rebalance.maxPerDay) {
            const legValue = valueUsd + leg.fees;
            const nr = recenter(pt.p, logWidth, p.rangePct);
            const swapUsd = swapShare(L, pt.p, r, nr) * legValue;
            const cost = swapUsd * costPct / 100;
            const basis = legValue - cost;
            fills.push({ ts: pt.t * 1000, kind: "rebalance", usd: cents(legValue), price: sig(pt.p), pnlUsd: cents(basis - leg.cost),
              reason: `Out of range ${outH} h (${pt.p < r.lower ? "below" : "above"} ${priceText(pt.p < r.lower ? r.lower : r.upper)}): recentered on ${priceText(pt.p)}, swapped ${money(swapUsd)} for ${money(cost)}` });
            r = nr;
            L = liquidityFor(basis / pt.quoteUsd, pt.p, r);
            const a = amountsAt(L, pt.p, r);
            leg = { cost: basis, token: a.token, quote: a.quote, fees: 0 };
            rebN++; rebalances++; costTotal += cost; outH = 0; lastIl = 0;
          } else if (!cappedWarned) {
            cappedWarned = true;
            notes.push(`${new Date(pt.t * 1000).toISOString().slice(0, 10)}: the ${p.rebalance.maxPerDay} rebalances of the day were used; the position waited out of range.`);
          }
        }
      }
    }
    const eq = exited ? frozen : valueAt(L, pt.p, r) * pt.quoteUsd + leg.fees;
    peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
    equity.push({ ts: pt.t * 1000, usd: cents(eq), hodlUsd: cents(a0.token * pt.tokenUsd + a0.quote * pt.quoteUsd), quoteOnlyUsd: cents(p.amountUsd / t0.quoteUsd * pt.quoteUsd),
      price: sig(pt.p), lower: info.fullRange ? null : sig(r.lower), upper: info.fullRange ? null : sig(r.upper), inRange: !exited && inRange(pt.p, r) });
  }
  const last = equity[equity.length - 1];
  const b = boundsPct(t0.p, r0);

  notes.push(apr != null
    ? `Fees are an ESTIMATE: today's pool fee APR ${pctText(apr)} (${v!.source}: ${v!.feeAprHow}) applied to the position's value for every hour the price spent in range (half an hour when it crossed a bound). A range tighter than the pool's average liquidity earns more per dollar, a wider one less; launch-day APRs fade.`
    : `No fee APR source (${venue.err ?? "the venue gave none"}): fees are counted as $0, so the result is IL and costs only.`);
  notes.push(`IL is exact concentrated-liquidity math on Chord's hourly closes (Uniswap-v3 formula${info.dex === "meteora_dlmm" ? "; DLMM bins treated as uniform Spot liquidity over the same range" : ""}); moves inside an hour are not seen.`);
  if (!info.fullRange) notes.push(`Rebalance rule: out of range for ${p.rebalance.outOfRangeMinutes} min, at most ${p.rebalance.maxPerDay} a day (UTC); on hourly data the first check is the next close. Each rebalance recenters the same width on the price and swaps the share needed (half the position when fully out of range); cost = ${costSource}. Fees go into the new range.`);
  if (p.exits.lpExodus) notes.push(flows ? `LP exodus exit replayed from Chord's hourly LP flows${flows.since && flows.since > startT + 3600 ? ` (only from ${new Date(flows.since * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC, Chord's LP coverage)` : ""}.` : `LP exodus could not be replayed (${(hourly as any)?.error ?? "no hourly flows"}).`);
  notes.push("Opening assumes the token and the quote are already held in the ratio the range needs (buying them from USDC adds one swap); an exit values what is withdrawn at the market, with no swap. The daily loss stop is not replayed.");
  notes.push(`HODL = keep the tokens deposited at the open; 100 % quote = put the whole ${money(p.amountUsd)} in ${info.quoteSymbol ?? "the quote token"} at the open.`);

  return {
    pool: info.pool, dex: info.dex, pair: info.pair, days, amountUsd: p.amountUsd, preset: p.preset, rangePct: p.rangePct, rebalance: p.rebalance,
    exits: { lpExodus: p.exits.lpExodus, tokenDropPct: p.exits.tokenDropPct },
    range: info.fullRange ? null : { lower: sig(r0.lower), upper: sig(r0.upper), downPct: r2(b.downPct), upPct: r2(b.upPct) }, fullRange: info.fullRange,
    hours: replay.length - 1, timeInRangePct: openHours ? Math.round((inHours / openHours) * 1000) / 10 : 0,
    feeAprPct: apr != null ? r2(apr) : null, feeAprSource: apr != null ? `${v!.source}: ${v!.feeAprHow}` : null, feesUsd: cents(fees),
    ilUsd: cents(lastIl), rebalances, rebalanceCostUsd: cents(costTotal), costSource, exited,
    finalUsd: last.usd, hodlUsd: last.hodlUsd, quoteOnlyUsd: last.quoteOnlyUsd, lpVsHodlUsd: cents(last.usd - last.hodlUsd), pnlUsd: cents(last.usd - p.amountUsd),
    maxDrawdownUsd: cents(maxDd), equity, fills, notes,
  };
}
