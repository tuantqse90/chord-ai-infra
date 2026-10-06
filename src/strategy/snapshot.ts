// One token snapshot for the filters: what Jupiter knows (liquidity, market cap / FDV, holders, top-10 share, price changes,
// organic score, mint / freeze authority, verified, flagged) plus Chord's tape (its own 24 h volume / liquidity / changes as a
// fallback, and over the last hour: the buy share and the smart traders buying). Only the sources the filters need are read;
// each answer is cached 60 s per mint (failures 20 s). A field no source can give stays null and its filter FAILS CLOSED with
// the reason "unknown <field>".
import { http } from "../bots/market";
import { smartTraders } from "../bots/tape";
import type { Trader } from "../bots/types";
import { tokenTraders, tokenView, type Fetch, type TokenTrader, type TokenView } from "./chord";
import { fieldValue, FIELD_LABEL, SAFETY_LABEL } from "./explain";
import { isFieldFilter, type Filter, type FilterField, type SafetyCheck } from "./schema";

export type SnapshotSource = "jupiter" | "chordToken" | "chordTraders";
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

// ── Jupiter (Tokens v2 search: one call for every Jupiter field) ─────────────────────────────────────────────────────
const jupRoot = () => {
  const v = (process.env.JUPITER_API_URL ?? "").trim().replace(/\/$/, "");
  return v ? v.replace(/\/swap\/v1$/, "") : "https://lite-api.jup.ag";
};
const jupHeaders = (): Record<string, string> => {
  const k = (process.env.JUPITER_API_KEY ?? "").trim();
  return k ? { "x-api-key": k } : {};
};
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const b = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Jupiter's token record (null = Jupiter does not list the mint). */
export async function jupiterToken(mint: string, f: Fetch = http): Promise<any | null> {
  const r = await f(`${jupRoot()}/tokens/v2/search?query=${encodeURIComponent(mint)}`, { headers: jupHeaders(), signal: AbortSignal.timeout(8_000) });
  if (r.status === 429) throw new Error("Jupiter is rate-limiting (429)");
  if (!r.ok) throw new Error(`Jupiter tokens answered ${r.status}`);
  const list = await r.json();
  return Array.isArray(list) ? list.find((x: any) => x?.id === mint) ?? null : null;
}

/** Which source gives each field first, and which one stands in when it cannot. */
const PRIMARY: Record<FilterField, SnapshotSource> = {
  liquidityUsd: "jupiter", marketCapUsd: "jupiter", fdvUsd: "jupiter", volume24hUsd: "jupiter", ageMin: "jupiter", holders: "jupiter", top10Pct: "jupiter",
  priceChange5mPct: "jupiter", priceChange1hPct: "jupiter", priceChange24hPct: "jupiter", organicScore: "jupiter", buyShare1hPct: "chordTraders", smartBuyers1h: "chordTraders",
};
const FALLBACK: Partial<Record<FilterField, SnapshotSource>> = {
  liquidityUsd: "chordToken", marketCapUsd: "chordToken", volume24hUsd: "chordToken", ageMin: "chordToken", priceChange1hPct: "chordToken", priceChange24hPct: "chordToken", buyShare1hPct: "jupiter",
};

/** The fields the filters read (safety checks read Jupiter). */
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
      p = (s === "jupiter" ? cached(`jup:${mint}`, now, () => jupiterToken(mint, d.fetch))
        : s === "chordToken" ? cached(`tok:${mint}`, now, () => tokenView(mint, 2, d.fetch))
          : cached(`trd:${mint}`, now, () => tradersHour(mint, d))).catch((e) => {
        snap.errors.push(`${s === "jupiter" ? "Jupiter" : "Chord's tape"}: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
        return undefined;
      });
      got.set(s, p);
    }
    return p;
  };
  const value = async (field: FilterField, s: SnapshotSource): Promise<number | null> => {
    const v = await read(s);
    if (v == null) return null;
    return s === "jupiter" ? fromJupiter(field, v, now) : s === "chordToken" ? fromChordToken(field, v as TokenView, now) : fromTraders(field, v as TraderHour);
  };

  await Promise.all([...want.fields].map(async (field) => {
    let v = await value(field, PRIMARY[field]);
    let src: SnapshotSource = PRIMARY[field];
    if (v == null && FALLBACK[field]) { v = await value(field, FALLBACK[field]!); src = FALLBACK[field]!; }
    if (v != null) { snap[field] = v; snap.from[field] = src; }
  }));
  if (want.safety) {
    const j = (await read("jupiter")) as any;
    if (j) {
      snap.safety = {
        mintAuthorityDisabled: b(j.audit?.mintAuthorityDisabled), freezeAuthorityDisabled: b(j.audit?.freezeAuthorityDisabled),
        // Jupiter marks verified tokens (isVerified / the "verified" tag) and suspicious ones (audit.isSus); absent = not
        verified: j.isVerified === true || (Array.isArray(j.tags) && j.tags.includes("verified")),
        flagged: j.audit?.isSus === true,
      };
      snap.from.safety = "jupiter";
    }
  }
  for (const s of ["jupiter", "chordToken"] as const) {
    if (!got.has(s)) continue;
    const v = (await got.get(s)) as any;
    if (!v) continue;
    snap.symbol ??= typeof v.symbol === "string" ? v.symbol : null;
    snap.priceUsd ??= n(s === "jupiter" ? v.usdPrice : v.priceUsd);
  }
  return snap;
}

function fromJupiter(field: FilterField, j: any, now: number): number | null {
  switch (field) {
    case "liquidityUsd": return n(j.liquidity);
    case "marketCapUsd": return n(j.mcap);
    case "fdvUsd": return n(j.fdv);
    case "volume24hUsd": { const x = n(j.stats24h?.buyVolume), y = n(j.stats24h?.sellVolume); return x == null && y == null ? null : (x ?? 0) + (y ?? 0); }
    case "ageMin": {
      const t = Date.parse(String(j.firstPool?.createdAt ?? j.createdAt ?? ""));
      return Number.isFinite(t) ? Math.max(0, (now - t) / 60_000) : null;
    }
    case "holders": return n(j.holderCount);
    case "top10Pct": return n(j.audit?.topHoldersPercentage);
    case "priceChange5mPct": return n(j.stats5m?.priceChange);
    case "priceChange1hPct": return n(j.stats1h?.priceChange);
    case "priceChange24hPct": return n(j.stats24h?.priceChange);
    case "organicScore": return n(j.organicScore);
    case "buyShare1hPct": {
      const x = n(j.stats1h?.buyVolume), y = n(j.stats1h?.sellVolume);
      return x != null && y != null && x + y > 0 ? (x / (x + y)) * 100 : null;
    }
    default: return null;
  }
}
function fromChordToken(field: FilterField, v: TokenView, now: number): number | null {
  switch (field) {
    case "liquidityUsd": return v.liquidityUsd;
    case "marketCapUsd": return v.marketCapUsd;
    case "volume24hUsd": return v.volume24hUsd;
    case "ageMin": return v.firstSeen != null ? Math.max(0, (now - v.firstSeen * 1000) / 60_000) : null;
    case "priceChange1hPct": return v.change1hPct;
    case "priceChange24hPct": return v.change24hPct;
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
  no_mint_authority: "the mint authority is live (more can be minted)", no_freeze_authority: "the freeze authority is live (holders can be frozen)",
  verified: "not verified on Jupiter", not_flagged: "flagged as suspicious on Jupiter",
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
