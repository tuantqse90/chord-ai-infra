// Nansen's labelled smart money on Monad as an Ask tool (owner 2026-10-12): a second opinion beside Chord's own index
// (monad_top_wallets, monad_token_traders), named as Nansen wherever a number of theirs is quoted.
//   holdings  POST /api/v1/smart-money/holdings    the tokens Nansen's smart-money wallets hold on Monad now
//   trades    POST /api/v1/smart-money/dex-trades  their DEX trades of the last day
// Measured 2026-10-12 with the owner's key: both answer for chain "monad" (9 tokens held; netflow answers an empty list, so it
// is not offered). The key is on Nansen's free tier: 10 credits a day and a smart-money call costs 5 (response headers
// x-nansen-credits-cost / -remaining). So every answer is kept in SQLite (table vendor_cache, survives a deploy) for
// NANSEN_HOLDINGS_TTL_HOURS (24) / NANSEN_TRADES_TTL_HOURS (12), and when Nansen refuses (credits gone, 4xx, 5xx, timeout) the
// last copy is served with its age. Unset NANSEN_API_KEY = the tool is not offered.
import { trustDb } from "./trust/registry";
import { ToolInputError, type Source, type Tool, type ToolResult } from "./types";

const API = "https://api.nansen.ai/api/v1";
const CHAIN = "monad";
const VIEWS = { holdings: { path: "smart-money/holdings", ttlEnv: "NANSEN_HOLDINGS_TTL_HOURS", ttlH: 24 }, trades: { path: "smart-money/dex-trades", ttlEnv: "NANSEN_TRADES_TTL_HOURS", ttlH: 12 } } as const;
type View = keyof typeof VIEWS;
const SOURCE: Source = { kind: "web", id: "nansen-smart-money", label: "Nansen · Smart money on Monad", url: "https://app.nansen.ai/smart-money" };
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function cache() {
  const d = trustDb();
  d.run("CREATE TABLE IF NOT EXISTS vendor_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)");
  return d;
}
const readCache = (key: string) => cache().query("SELECT at, body FROM vendor_cache WHERE key = ?").get(key) as { at: number; body: string } | null;
const ttlMs = (v: View) => { const n = Number(process.env[VIEWS[v].ttlEnv]); return (Number.isFinite(n) && n > 0 ? n : VIEWS[v].ttlH) * 3_600_000; };
const inflight = new Map<View, Promise<{ rows: any[]; at: number; stale: boolean }>>();
let credits: { remaining: number | null; at: number } = { remaining: null, at: 0 };
/** What the last answer said is left on the key (null before the first call of this process). */
export const nansenCredits = () => credits;

/** The rows of a view: the saved copy while it is fresh; else one call to Nansen, saved; else the saved copy, marked stale. */
export async function nansenRows(view: View, fetcher: Fetcher = fetch, now = Date.now()): Promise<{ rows: any[]; at: number; stale: boolean }> {
  const key = `nansen:${CHAIN}:${view}`, hit = readCache(key);
  if (hit && now - hit.at < ttlMs(view)) return { rows: JSON.parse(hit.body), at: hit.at, stale: false };
  const running = inflight.get(view);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await fetcher(`${API}/${VIEWS[view].path}`, { method: "POST", headers: { apiKey: process.env.NANSEN_API_KEY ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ chains: [CHAIN], pagination: { page: 1, per_page: 100 } }), signal: AbortSignal.timeout(20_000) });
      const left = Number(res.headers.get("x-nansen-credits-remaining"));
      if (res.headers.has("x-nansen-credits-remaining") && Number.isFinite(left)) credits = { remaining: left, at: now };
      if (!res.ok) throw new Error(`Nansen answered ${res.status}`);
      const rows = ((await res.json()) as { data?: unknown }).data;
      if (!Array.isArray(rows)) throw new Error("Nansen answered without rows");
      cache().run("INSERT INTO vendor_cache (key, at, body) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at, body = excluded.body", [key, now, JSON.stringify(rows)]);
      return { rows, at: now, stale: false };
    } catch (e) {
      if (hit) return { rows: JSON.parse(hit.body), at: hit.at, stale: true };
      throw new ToolInputError(`Nansen's smart-money data is not available right now (${(e as Error).message}). Answer from Chord's own index (monad_top_wallets, monad_token_traders) and say Nansen could not be read.`);
    }
  })().finally(() => inflight.delete(view));
  inflight.set(view, p);
  return p;
}

const r2 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const lower = (s: unknown) => String(s ?? "").toLowerCase();
/** `token`: a symbol or a 0x address; rows where it is held, bought or sold. */
function matches(row: any, token: string, view: View): boolean {
  const t = token.toLowerCase().replace(/^\$/, "");
  const fields = view === "holdings" ? [row.token_symbol, row.token_address] : [row.token_bought_symbol, row.token_sold_symbol, row.token_bought_address, row.token_sold_address];
  return fields.some((f) => lower(f) === t);
}

async function run(args: Record<string, any>, fetcher?: Fetcher): Promise<ToolResult> {
  const view: View = args.view === "trades" ? "trades" : "holdings";
  const token = typeof args.token === "string" && args.token.trim() ? args.token.trim() : null;
  const { rows, at, stale } = await nansenRows(view, fetcher);
  const picked = token ? rows.filter((r) => matches(r, token, view)) : rows;
  const head = { source: "Nansen", chain: "Monad", view, asOf: new Date(at).toISOString(), ...(stale ? { note: "Nansen could not be read just now: this is the last saved copy, say its time." } : {}), ...(token ? { token, matched: picked.length, ofRows: rows.length } : {}) };
  if (view === "holdings") {
    const out = picked.map((r) => ({ symbol: r.token_symbol, token: r.token_address, smartMoneyValueUsd: r2(r.value_usd), smartMoneyHolders: r.holders_count ?? null, balanceChange24hPct: r2(r.balance_24h_percent_change), marketCapUsd: r2(r.market_cap_usd), tokenAgeDays: r.token_age_days ?? null }))
      .sort((a, b) => (b.smartMoneyValueUsd ?? 0) - (a.smartMoneyValueUsd ?? 0));
    return { data: { ...head, what: "Tokens held on Monad by the wallets Nansen labels smart money. smartMoneyHolders counts those wallets, not all holders.", tokens: out,
      ...(token && !out.length ? { none: `No wallet Nansen labels smart money holds ${token} on Monad.` } : {}) },
      sources: [SOURCE], summary: token ? `Nansen: ${out.length ? `${out[0]!.smartMoneyHolders} smart-money holders of ${out[0]!.symbol}` : `no smart-money holder of ${token}`}` : `Nansen: ${out.length} tokens held by smart money on Monad`,
      addresses: out.map((o) => o.token).filter(Boolean) };
  }
  const out = picked.slice(0, 40).map((r) => ({ time: r.block_timestamp, trader: r.trader_address, label: r.trader_address_label ?? null, bought: { symbol: r.token_bought_symbol, token: r.token_bought_address, amount: r2(r.token_bought_amount) },
    sold: { symbol: r.token_sold_symbol, token: r.token_sold_address, amount: r2(r.token_sold_amount) }, valueUsd: r2(r.trade_value_usd), tx: r.transaction_hash }));
  return { data: { ...head, what: "DEX trades on Monad in the last day by the wallets Nansen labels smart money, newest first.", trades: out, ...(token && !out.length ? { none: `No smart-money wallet traded ${token} on Monad in the last day, by Nansen's labels.` } : {}) },
    sources: [SOURCE], summary: `Nansen: ${out.length} smart-money trade${out.length === 1 ? "" : "s"}${token ? ` of ${token}` : ""} on Monad`,
    addresses: out.flatMap((o) => [o.trader, o.bought.token, o.sold.token, o.tx]).filter(Boolean) };
}

/** The tool, only when a key is set. `fetcher` is for tests. */
export function nansenTools(fetcher?: Fetcher): Tool[] {
  if (!process.env.NANSEN_API_KEY) return [];
  return [{
    name: "nansen_smart_money", via: "ext", provider: "Nansen", label: "Reading Nansen smart money on Monad", group: "monad", timeoutMs: 25_000,
    description: "Nansen's labelled smart money on Monad (the wallets Nansen tags as funds and smart traders). view=holdings: the tokens they hold now, with USD value and how many smart-money wallets hold each. view=trades: their DEX trades of the last day (who, bought, sold, USD, tx). token (symbol or 0x address) narrows either view to one token. Use it for 'what is smart money buying / holding on Monad' and 'is smart money in <token>', next to Chord's own index (monad_top_wallets, monad_token_traders); the two label wallets differently, so name the source of each number. Refreshed about twice a day: quote asOf.",
    parameters: { type: "object", properties: { view: { type: "string", enum: ["holdings", "trades"], description: "default holdings" }, token: { type: "string", description: "optional: a symbol such as CHOG or a 0x token address" } } },
    run: (args) => run(args, fetcher),
  }];
}
