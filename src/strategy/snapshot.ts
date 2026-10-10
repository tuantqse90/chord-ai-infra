// One token snapshot for the filters on Monad, from Chord's API: the token's stats (liquidity, 24 h volume, first trade, price
// changes over 5 min / 1 h / 24 h, the last hour's buy and sell volume), its list facts (Chord's verified mark and tax probe),
// and Chord's Monad feed over the last hour (which smart traders bought it). Safety on an EVM token: `verified` = on Chord's
// curated Monad list with its verified mark; `not_flagged` = no transfer tax AND a $10 round trip (buy then sell straight back
// through the router) returns at least 90 %. Only the sources the filters need are read; each answer is cached 60 s per token
// (failures 20 s). A field no source can give stays null and its filter FAILS CLOSED with the reason "unknown <field>".
import { http, paperQuote, tokenInfo, USDC_MINT } from "../bots/market";
import { smartTraders } from "../bots/tape";
import type { Trader } from "../bots/types";
import { tokenTraders, tokenView, type Fetch, type TokenTrader, type TokenView } from "./chord";
import { fieldValue, FIELD_LABEL, SAFETY_LABEL } from "./explain";
import { isFieldFilter, type Filter, type FilterField, type SafetyCheck } from "./schema";

export type SnapshotSource = "chordList" | "chordToken" | "chordTraders";
export interface TokenSnapshot {
  mint: string; symbol: string | null; at: number; priceUsd: number | null;
  liquidityUsd: number | null; marketCapUsd: number | null; fdvUsd: number | null; volume24hUsd: number | null; ageMin: number | null;
  holders: number | null; top10Pct: number | null; priceChange5mPct: number | null; priceChange1hPct: number | null; priceChange24hPct: number | null;
  organicScore: number | null; buyShare1hPct: number | null; smartBuyers1h: number | null;
  /** true / false as the source says; null = unknown */
  safety: { mintAuthorityDisabled: boolean | null; freezeAuthorityDisabled: boolean | null; verified: boolean | null; flagged: boolean | null };
  /** where each known field came from */
  from: Partial<Record<FilterField | "safety", string>>;
  errors: string[];
}

export interface SnapshotDeps {
  fetch: Fetch;
  now: () => number;
  /** the smart-traders board (Chord, cached 60 s) */
  smart: (days: 1 | 3 | 7, limit: number) => Promise<Trader[]>;
}
const defaults = (): SnapshotDeps => ({ fetch: http, now: () => Date.now(), smart: smartTraders });

const TTL = 60_000;
const ERR_TTL = 20_000;
const cache = new Map<string, { at: number; v?: unknown; err?: string }>();
const inflight = new Map<string, Promise<unknown>>();
export function _resetSnapshots(): void { cache.clear(); inflight.clear(); smartSet = null; }

async function cached<T>(key: string, now: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < (hit.err ? ERR_TTL : TTL)) { if (hit.err) throw new Error(hit.err); return hit.v as T; }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => { cache.set(key, { at: now, v }); return v; }, (e) => {
    const err = String((e as Error)?.message ?? e).slice(0, 160);
    cache.set(key, { at: now, err });
    throw new Error(err);
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  if (cache.size > 5_000) for (const [k, x] of cache) if (now - x.at > TTL) cache.delete(k);
  return p;
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
export const ROUND_TRIP_USD = 10;
export const ROUND_TRIP_MIN = 0.9;

/** The token's list facts and the safety verdicts: verified (Chord's curated list), taxed, and the $10 round trip. */
async function listFacts(mint: string): Promise<{ symbol: string | null; liquidityUsd: number | null; priceUsd: number | null; verified: boolean; taxPct: number | null; roundTrip: number | null; roundTripErr: string | null } | null> {
  const info = await tokenInfo(mint);
  if (!info) return null;
  let roundTrip: number | null = null, roundTripErr: string | null = null;
  try {
    const buy = await paperQuote(USDC_MINT, mint, ROUND_TRIP_USD, 100);
    const back = buy.amountOut > 0 ? await paperQuote(mint, USDC_MINT, buy.amountOut, 100) : null;
    roundTrip = back ? back.amountOut / ROUND_TRIP_USD : 0;
  } catch (e) { roundTripErr = String((e as Error)?.message ?? e).slice(0, 120); roundTrip = 0; }
  return { symbol: info.symbol, liquidityUsd: info.liquidityUsd, priceUsd: info.usdPrice, verified: info.verified === true, taxPct: info.taxPct, roundTrip, roundTripErr };
}

/** Which source gives each field first, and which one stands in when it cannot. */
const PRIMARY: Record<FilterField, SnapshotSource> = {
  liquidityUsd: "chordToken", marketCapUsd: "chordToken", fdvUsd: "chordToken", volume24hUsd: "chordToken", ageMin: "chordToken", holders: "chordToken", top10Pct: "chordToken",
  priceChange5mPct: "chordToken", priceChange1hPct: "chordToken", priceChange24hPct: "chordToken", organicScore: "chordToken", buyShare1hPct: "chordToken", smartBuyers1h: "chordTraders",
};
const FALLBACK: Partial<Record<FilterField, SnapshotSource>> = { liquidityUsd: "chordList", buyShare1hPct: "chordTraders" };

/** The fields the filters read (safety checks read the list facts and the round trip). */
export function fieldsOf(filters: Filter[]): { fields: Set<FilterField>; safety: boolean } {
  const fields = new Set<FilterField>();
  let safety = false;
  for (const f of filters) { if (isFieldFilter(f)) fields.add(f.field); else safety = true; }
  return { fields, safety };
}

const SMART_SET_TTL = 60_000;
let smartSet: { at: number; set: Set<string> } | null = null;
/** Chord's smart traders: the 1-, 3- and 7-day boards together (each up to 100 wallets). */
async function smartWallets(d: SnapshotDeps): Promise<Set<string>> {
  const now = d.now();
  if (smartSet && now - smartSet.at < SMART_SET_TTL) return smartSet.set;
  const boards = await Promise.allSettled(([1, 3, 7] as const).map((days) => d.smart(days, 100)));
  const ok = boards.filter((x): x is PromiseFulfilledResult<Trader[]> => x.status === "fulfilled");
  if (!ok.length) throw new Error("Chord's smart-traders board could not be read");
  const set = new Set(ok.flatMap((x) => x.value.map((t) => t.wallet)));
  smartSet = { at: now, set };
  return set;
}

/** One token's snapshot. `need` = the filters' fields (default: every field). */
export async function buildSnapshot(mint: string, opts: { filters?: Filter[]; deps?: Partial<SnapshotDeps> } = {}): Promise<TokenSnapshot> {
  const d = { ...defaults(), ...opts.deps };
  const now = d.now();
  const want = opts.filters ? fieldsOf(opts.filters) : { fields: new Set(Object.keys(PRIMARY) as FilterField[]), safety: true };
  const snap: TokenSnapshot = {
    mint, symbol: null, at: now, priceUsd: null, liquidityUsd: null, marketCapUsd: null, fdvUsd: null, volume24hUsd: null, ageMin: null, holders: null, top10Pct: null,
    priceChange5mPct: null, priceChange1hPct: null, priceChange24hPct: null, organicScore: null, buyShare1hPct: null, smartBuyers1h: null,
    safety: { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, verified: null, flagged: null }, from: {}, errors: [],
  };
  const got = new Map<SnapshotSource, Promise<unknown>>();
  const read = (s: SnapshotSource): Promise<unknown> => {
    let p = got.get(s);
    if (!p) {
      p = (s === "chordList" ? cached(`list:${mint}`, now, () => listFacts(mint))
        : s === "chordToken" ? cached(`tok:${mint}`, now, () => tokenView(mint, 2, d.fetch))
          : cached(`trd:${mint}`, now, () => tradersHour(mint, d))).catch((e) => {
        snap.errors.push(`${s === "chordList" ? "Chord's token list" : s === "chordToken" ? "Chord's token stats" : "Chord's Monad feed"}: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
        return undefined;
      });
      got.set(s, p);
    }
    return p;
  };
  const value = async (field: FilterField, s: SnapshotSource): Promise<number | null> => {
    const v = await read(s);
    if (v == null) return null;
    return s === "chordList" ? fromList(field, v as any) : s === "chordToken" ? fromChordToken(field, v as TokenView, now) : fromTraders(field, v as TraderHour);
  };

  await Promise.all([...want.fields].map(async (field) => {
    let v = await value(field, PRIMARY[field]);
    let src: SnapshotSource = PRIMARY[field];
    if (v == null && FALLBACK[field]) { v = await value(field, FALLBACK[field]!); src = FALLBACK[field]!; }
    if (v != null) { snap[field] = v; snap.from[field] = src; }
  }));
  if (want.safety) {
    const j = (await read("chordList")) as Awaited<ReturnType<typeof listFacts>> | undefined;
    if (j) {
      // mint / freeze authority are Solana fields (the schema refuses them on Monad): they stay unknown here
      snap.safety = { mintAuthorityDisabled: null, freezeAuthorityDisabled: null, verified: j.verified, flagged: (j.taxPct ?? 0) > 0 || (j.roundTrip ?? 0) < ROUND_TRIP_MIN };
      snap.from.safety = "chordList";
      if (j.roundTripErr) snap.errors.push(`round trip: ${j.roundTripErr}`);
    }
  }
  for (const s of ["chordList", "chordToken"] as const) {
    if (!got.has(s)) continue;
    const v = (await got.get(s)) as any;
    if (!v) continue;
    snap.symbol ??= typeof v.symbol === "string" ? v.symbol : null;
    snap.priceUsd ??= n(v.priceUsd);
  }
  return snap;
}

function fromList(field: FilterField, v: { liquidityUsd: number | null } | null): number | null {
  return field === "liquidityUsd" ? v?.liquidityUsd ?? null : null;
}
function fromChordToken(field: FilterField, v: TokenView, now: number): number | null {
  switch (field) {
    case "liquidityUsd": return v.liquidityUsd;
    case "marketCapUsd": return v.marketCapUsd;
    case "volume24hUsd": return v.volume24hUsd;
    case "ageMin": return v.firstSeen != null ? Math.max(0, (now - v.firstSeen * 1000) / 60_000) : null;
    case "priceChange5mPct": return v.change5mPct ?? null;
    case "priceChange1hPct": return v.change1hPct;
    case "priceChange24hPct": return v.change24hPct;
    case "buyShare1hPct": { const x = v.buyVol1h ?? null, y = v.sellVol1h ?? null; return x != null && y != null && x + y > 0 ? (x / (x + y)) * 100 : null; }
    default: return null;
  }
}

interface TraderHour { traders: TokenTrader[]; smart: Set<string> | null; cut: number }
/** The tape's traders of the token over the last hour, and which of them are smart traders. */
async function tradersHour(mint: string, d: SnapshotDeps): Promise<TraderHour | null> {
  const [t, smart] = await Promise.all([tokenTraders(mint, 1, d.fetch), smartWallets(d).catch(() => null)]);
  if (!t) return null;
  return { traders: t.traders, smart, cut: Math.floor(d.now() / 1000) - 3600 };
}
function fromTraders(field: FilterField, v: TraderHour): number | null {
  if (field === "buyShare1hPct") {
    const bought = v.traders.reduce((a, t) => a + t.boughtUsd, 0), sold = v.traders.reduce((a, t) => a + t.soldUsd, 0);
    return bought + sold > 0 ? (bought / (bought + sold)) * 100 : null;
  }
  if (field === "smartBuyers1h") {
    if (!v.smart) return null;
    return v.traders.filter((t) => t.boughtUsd > 0 && v.smart!.has(t.wallet) && (t.lastTrade == null || t.lastTrade >= v.cut)).length;
  }
  return null;
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export type FilterVerdict = { pass: true } | { pass: false; filter: Filter; field: string; value: number | boolean | null; reason: string };

const SAFETY_READ: Record<SafetyCheck, (s: TokenSnapshot["safety"]) => boolean | null> = {
  no_mint_authority: (s) => s.mintAuthorityDisabled,
  no_freeze_authority: (s) => s.freezeAuthorityDisabled,
  verified: (s) => s.verified,
  not_flagged: (s) => (s.flagged == null ? null : !s.flagged),
};
const SAFETY_FAIL: Record<SafetyCheck, string> = {
  no_mint_authority: "not a Monad check", no_freeze_authority: "not a Monad check",
  verified: "it is not", not_flagged: "a transfer tax, or a $10 buy sold straight back returns less than 90 %",
};
const OP_TEXT: Record<string, string> = { ">": "above", ">=": "at least", "<": "below", "<=": "at most" };

/** The first filter that says no (in the strategy's order), with the value it saw; a value no source gave fails closed. */
export function evaluateFilters(filters: Filter[], snap: TokenSnapshot): FilterVerdict {
  for (const f of filters) {
    if (!isFieldFilter(f)) {
      const ok = SAFETY_READ[f.safety](snap.safety);
      if (ok === null) return { pass: false, filter: f, field: f.safety, value: null, reason: `unknown ${f.safety}` };
      if (!ok) return { pass: false, filter: f, field: f.safety, value: false, reason: `${SAFETY_LABEL[f.safety]}: ${SAFETY_FAIL[f.safety]}` };
      continue;
    }
    const v = snap[f.field];
    if (v == null) return { pass: false, filter: f, field: f.field, value: null, reason: `unknown ${f.field}` };
    let ok: boolean, want: string;
    if (f.op === "between") {
      const [lo, hi] = f.value as [number, number];
      ok = v >= lo && v <= hi;
      want = `between ${fieldValue(f.field, lo)} and ${fieldValue(f.field, hi)}`;
    } else {
      const x = f.value as number;
      ok = f.op === ">" ? v > x : f.op === ">=" ? v >= x : f.op === "<" ? v < x : v <= x;
      want = `${OP_TEXT[f.op]} ${fieldValue(f.field, x)}`;
    }
    if (!ok) return { pass: false, filter: f, field: f.field, value: v, reason: `${FIELD_LABEL[f.field]} ${fieldValue(f.field, v)} (needs ${want})` };
  }
  return { pass: true };
}
