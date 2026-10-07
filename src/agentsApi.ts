// /v1/agents: the public face of agents-as-a-service (ask2049-notes/PROMPT-agents-wow.md). Everything here is computed from the
// bot engine's own records (src/bots) and Chord's Solana tape; nothing is invented. Owners and webhooks never leave the server.
//   GET  /stats       live agents, trades / skips / PnL in 24 h, best agent today, fastest reaction (cached 10 s)
//   GET  /feed        SSE: every public agent's fill / skip / event as it happens (50-event backlog on connect)
//   GET  /smart-now   tokens Solana smart traders bought in the last 15 min (cached 30 s)
//   GET  /board       leaderboard with equity sparkline, copies, windows today | 7d | all
//   GET  /templates   the strategy templates with their own 3-day backtest headline and how many agents run each
//   POST /:id/copy    fork a public agent into the caller's agents (paper); a priced listing answers 402 (x402) until paid
// Marketplace (src/marketplace.ts, PROMPT-agents-marketplace.md B):
//   GET    /market?sort=pnl|copies|new   public listings: live stats, sparkline, backtest headline, copies, paper earnings
//   GET    /:id/listing                  { listing | null } for one agent (mine: true for its owner)
//   POST   /:id/listing                  list / update { title, pitch, priceUsdc, profitSharePct, payoutWallet }, owner only
//   DELETE /:id/listing                  unlist
//   POST   /:id/copy/pay-tx { wallet }   the page's USDC transfer for the wallet to sign (NOWNodes blockhash)
//   POST   /:id/copy/pay-send { transaction }  relay that signed transfer through NOWNodes
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config } from "./config";
import { createBot, getBot, leaderboard, MAX_BOTS_PER_OWNER, smartTraders, subscribe, type Bot, type Fill } from "./bots";
import { emit } from "./bots/bus";
import { walletTrades } from "./bots/tape";
import { prices } from "./bots/market";
import { resolveKey } from "./devkeys";
import { nownodesReady } from "./nownodes";
import { allBots, countOf, fillCountsSince, filledSince } from "./bots/store";
import { _resetSwr, keepFresh, swr } from "./swr";
import { templatesWithHeadline } from "./strategyRoutes";
import {
  buildPaymentTx, earningsOf, forSale, listingOf, listings, MarketError, parsePaymentHeader, paymentRequired, publishListing, recordCopy, releasePayment,
  reservePayment, salesOf, sendPaymentTx, settlePayment, unlistAgent, verifyCopyPayment, type Listing,
} from "./marketplace";

const DAY = 86_400_000;
const now = () => Date.now();

// ── copies count (who forked what) ───────────────────────────────────────────────────────────────────────────────────
let db: Database | null = null;
function store(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS agent_copies (source TEXT NOT NULL, copy TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (source, copy))");
  return db;
}
/** Copies that still exist (a deleted copy no longer counts; the bots table lives in the same database file). */
const copiesOf = (id: string): number => (store().query("SELECT COUNT(*) AS n FROM agent_copies c JOIN bots b ON b.id = c.copy WHERE c.source = ?").get(id) as any).n;

// ── public shapes ────────────────────────────────────────────────────────────────────────────────────────────────────
type Spark = number[];
/** Equity points from the agent's fills: running realized PnL at each close, the open PnL as the last point. */
function sparkOf(fills: Fill[], bot: Bot, since = 0): Spark {
  const closes = fills.filter((f) => f.status === "filled" && f.pnlUsd != null && f.ts >= since).sort((a, b) => a.ts - b.ts);
  let run = 0;
  const pts = [0, ...closes.map((f) => (run += f.pnlUsd ?? 0))];
  pts.push(run + (bot.stats.unrealizedUsd ?? 0));
  return pts.slice(-40).map((v) => Math.round(v * 100) / 100);
}
function windowPnl(fills: Fill[], bot: Bot, since: number): number {
  const realized = fills.filter((f) => f.status === "filled" && f.pnlUsd != null && f.ts >= since).reduce((a, f) => a + (f.pnlUsd ?? 0), 0);
  return realized + (bot.stats.unrealizedUsd ?? 0);
}
/** Public shape: no webhook; a priced listing shows its kind, not its recipe (src/marketplace.ts forSale). */
const publicBot = (b: Bot) => forSale({ ...b, params: { ...(b.params as any), webhook: undefined } });
type Row = ReturnType<typeof publicBot> & { pnl: number; pnlAll: number; spark: Spark; copies: number; reactionS: number | null; template: string | null;
  listing: { priceUsdc: number; profitSharePct: number } | null };
const templateOf = (b: Bot): string | null => (b.params as any)?.strategy?.name ?? (b.type === "copy" ? "Copy trader" : b.type === "lp" ? "LP agent" : b.type === "alert" ? "Alert" : null);

/** Every agent the public sees: the engine's trading board (copy + trading custom agents) plus LP agents, never an owner. */
function publicAgents(): Bot[] {
  const lp = allBots("all").filter((b) => b.type === "lp").map(({ owner: _o, ...b }) => b as Bot);
  return [...leaderboard(200), ...lp];
}
function rows(window: "today" | "7d" | "all"): Row[] {
  const since = window === "today" ? now() - DAY : window === "7d" ? now() - 7 * DAY : 0;
  const listed = new Map(listings().map((l) => [l.agent, { priceUsdc: l.priceUsdc, profitSharePct: l.profitSharePct }]));
  return publicAgents().map((b) => {
    // every filled fill in the window (not the last 200 rows, which are mostly skips on a busy agent: QA 07/10 saw +$203.60 shown as −$2.20)
    const fills = filledSince(b.id, Math.min(since, now() - DAY));
    const lags = fills.filter((f) => f.ts >= now() - DAY && f.source?.ts && f.source.via !== "strategy" && (f.source.via !== "lp" || f.source.wallet !== f.mint)).map((f) => (f.ts - f.source.ts) / 1000).filter((s) => s >= 0 && s < 600);
    const pnlAll = (b.stats.realizedUsd ?? 0) + (b.stats.unrealizedUsd ?? 0);
    return { ...publicBot(b), pnl: window === "all" ? pnlAll : windowPnl(fills, b, since), pnlAll, spark: sparkOf(fills, b, since), copies: copiesOf(b.id), reactionS: lags.length ? Math.min(...lags) : null, template: templateOf(b), listing: listed.get(b.id) ?? null };
  }).sort((a, b) => b.pnl - a.pnl);
}

let statsCache: { at: number; v: unknown } | null = null;
function stats() {
  if (statsCache && now() - statsCache.at < 10_000) return statsCache.v;
  const all = rows("today");
  let trades = 0, skips = 0, pnl = 0;
  for (const r of all) {
    const n = fillCountsSince(r.id, now() - DAY);
    trades += n.filled; skips += n.skipped; pnl += r.pnl;
  }
  const best = all.find((r) => r.stats.trades > 0) ?? null;
  const reactions = all.map((r) => r.reactionS).filter((s): s is number => s != null);
  const v = {
    live: all.filter((r) => r.status === "running").length, agents: all.length, trades24h: trades, skips24h: skips, pnl24hUsd: Math.round(pnl * 100) / 100,
    best: best ? { id: best.id, name: best.name, pnlUsd: Math.round(best.pnl * 100) / 100, investedUsd: best.stats.investedUsd } : null,
    fastestReactionS: reactions.length ? Math.round(Math.min(...reactions) * 10) / 10 : null, updatedAt: now(),
  };
  statsCache = { at: now(), v };
  return v;
}

// ── live feed: one subscription per public agent, refreshed as agents come and go ──────────────────────────────────────
type FeedItem = { at: number; agent: { id: string; name: string; type: string; mode?: string | null } /* mode: an LP agent's "copy" (the avatar glances sideways) */; kind: "fill" | "skip" | "event"; side?: string; symbol?: string | null; mint?: string; usd?: number; pnlUsd?: number | null; reason?: string | null; trigger?: string | null; reactionS?: number | null; level?: string; msg?: string };
const backlog: FeedItem[] = [];
const listeners = new Set<(i: FeedItem) => void>();
const subs = new Map<string, () => void>();
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
function push(i: FeedItem) { backlog.unshift(i); if (backlog.length > 50) backlog.length = 50; for (const fn of listeners) fn(i); }
function feedItem(f: Fill, agent: FeedItem["agent"]): FeedItem {
  const src = f.source;
  // LP agent moves carry the pool as their "wallet": say what the agent did instead
  const copiedLp = src?.via === "lp" && src.wallet !== f.mint; // an LP copy agent's move: its source is the copied wallet's event
  const lpWords = src?.via === "lp" && !copiedLp ? (f.kind === "open" ? `opened a paper LP range in ${src.symbol ?? "the pool"}` : f.kind === "rebalance" ? "price left the range: rebalanced around it" : "closed the LP position on an exit rule") : null;
  const trigger = lpWords ?? src?.detail ?? (src?.wallet ? `followed wallet ${short(src.wallet)} ${src.side === "sell" ? "sold" : "bought"}${src.usd ? ` $${Math.round(src.usd).toLocaleString("en-US")}` : ""}` : null);
  const reacted = src?.ts && src.via !== "strategy" && (src.via !== "lp" || copiedLp) ? Math.round(((f.ts - src.ts) / 1000) * 10) / 10 : null;
  return { at: f.ts, agent, kind: f.status === "filled" ? "fill" : "skip", side: f.side, symbol: f.symbol, mint: f.mint, usd: f.usd, pnlUsd: f.pnlUsd, reason: f.reason, trigger, reactionS: reacted };
}
/** After a restart the in-memory backlog is empty: seed it with the public agents' newest fills (same shape as live items). */
function seedBacklog() {
  if (backlog.length) return;
  const items: FeedItem[] = [];
  for (const b of publicAgents()) for (const f of getBot(null, b.id)?.fills.slice(0, 20) ?? []) items.push(feedItem(f, { id: b.id, name: b.name, type: b.type, mode: (b.params as any)?.mode ?? null }));
  backlog.push(...items.sort((a, b) => b.at - a.at).slice(0, 50));
}
function syncFeed() {
  const agentsNow = publicAgents();
  const live = new Set(agentsNow.map((b) => b.id));
  for (const [id, off] of subs) if (!live.has(id)) { off(); subs.delete(id); }
  for (const b of agentsNow) {
    if (subs.has(b.id)) continue;
    const agent = { id: b.id, name: b.name, type: b.type, mode: (b.params as any)?.mode ?? null };
    subs.set(b.id, subscribe(b.id, (e: any) => {
      if (e.type === "fill" && e.fill) {
        push(feedItem(e.fill, agent));
      } else if (e.type === "event" && e.event && e.event.level !== "info" && !/^Could not read\b/i.test(e.event.msg)) push({ at: e.event.ts, agent, kind: "event", level: e.event.level, msg: e.event.msg });
    }));
  }
}
let feedTimer: ReturnType<typeof setInterval> | null = null;
function ensureFeed() { if (feedTimer) return; seedBacklog(); syncFeed(); feedTimer = setInterval(syncFeed, 20_000); (feedTimer as any).unref?.(); }

// ── smart money right now ─────────────────────────────────────────────────────────────────────────────────────────────
/** Smart money right now: the last good answer at once, refreshed in the background every minute (30 wallets' trades on Chord). */
const smartNow = () => swr("smartnow", 60_000, computeSmartNow);
async function computeSmartNow() {
  const traders = await smartTraders(1, 30);
  const since = now() - 15 * 60_000;
  const by = new Map<string, { mint: string; symbol: string | null; wallets: Set<string>; usd: number; firstPrice: number | null; firstAt: number }>();
  const lists = await Promise.all(traders.map((t) => walletTrades(t.wallet, 30).then((r) => r.map((x) => ({ ...x, wallet: t.wallet }))).catch(() => [])));
  for (const list of lists) for (const t of list as any[]) {
    const at = t.ts > 1e12 ? t.ts : t.ts * 1000;
    if (t.side !== "buy" || at < since) continue;
    const k = t.token;
    const row = by.get(k) ?? { mint: k, symbol: t.symbol ?? null, wallets: new Set<string>(), usd: 0, firstPrice: null as number | null, firstAt: at };
    row.wallets.add(t.wallet); row.usd += t.usd ?? 0;
    if (at <= row.firstAt || row.firstPrice == null) { row.firstAt = Math.min(row.firstAt, at); row.firstPrice = t.priceUsd ?? row.firstPrice; }
    by.set(k, row);
  }
  const top = [...by.values()].sort((a, b) => b.wallets.size - a.wallets.size || b.usd - a.usd).slice(0, 12);
  const px = await prices(top.map((t) => t.mint)).catch(() => new Map<string, number>());
  const v = { windowMin: 15, tokens: top.map((t) => { const p = px.get(t.mint) ?? null; return { mint: t.mint, symbol: t.symbol, wallets: t.wallets.size, usdIn: Math.round(t.usd), firstBuyAt: t.firstAt, priceUsd: p, movePct: p != null && t.firstPrice ? Math.round((p / t.firstPrice - 1) * 1000) / 10 : null, logo: `https://api.getchord.xyz/v1/logo/solana/${t.mint}` }; }), updatedAt: now() };
  return v;
}

// ── marketplace: listings as the public sees them (never an owner, never a webhook) ───────────────────────────────────────
const MARKET_SORTS = ["pnl", "copies", "new"] as const;
type MarketSort = (typeof MARKET_SORTS)[number];
const cents = (n: number) => Math.round(n * 100) / 100;
function marketRow(l: Listing) {
  const d = getBot(null, l.agent);
  if (!d) return null;
  const b = d.bot;
  return {
    id: l.agent, title: l.title, pitch: l.pitch, priceUsdc: l.priceUsdc, profitSharePct: l.profitSharePct, payTo: l.payTo, creator: short(l.payTo),
    agent: { id: b.id, name: b.name, type: b.type, mode: b.mode, status: b.status, createdAt: b.createdAt, template: templateOf(b), stats: b.stats },
    pnlUsd: cents((b.stats.realizedUsd ?? 0) + (b.stats.unrealizedUsd ?? 0)), spark: sparkOf(d.fills, b), copies: copiesOf(b.id),
    headline: l.headline, earnings: { ...earningsOf(l.agent), paper: true }, sales: salesOf(l.agent), listedAt: l.createdAt, updatedAt: l.updatedAt,
  };
}
type MarketRow = NonNullable<ReturnType<typeof marketRow>>;
let marketCache: { at: number; items: { owner: string; row: MarketRow }[] } | null = null;
/** The caller's own listings say mine: true (the owner itself never leaves the server). Cached 5 s. */
function market(sort: MarketSort, caller: string | null): (MarketRow & { mine?: true })[] {
  if (!marketCache || now() - marketCache.at > 5_000) {
    const items: { owner: string; row: MarketRow }[] = [];
    for (const l of listings()) { const row = marketRow(l); if (row) items.push({ owner: l.owner, row }); }
    marketCache = { at: now(), items };
  }
  const by = sort === "new" ? (a: MarketRow, b: MarketRow) => b.listedAt - a.listedAt
    : sort === "copies" ? (a: MarketRow, b: MarketRow) => b.copies - a.copies || b.pnlUsd - a.pnlUsd
    : (a: MarketRow, b: MarketRow) => b.pnlUsd - a.pnlUsd || b.listedAt - a.listedAt;
  return [...marketCache.items].sort((a, b) => by(a.row, b.row)).map(({ owner, row }) => (caller && owner === caller ? { ...row, mine: true as const } : row));
}

// Payment routes call NOWNodes: a small budget per caller keeps one page (or script) from looping them.
const PAY_PER_MIN = 30;
const payHits = new Map<string, number[]>();
function allowPay(who: string): boolean {
  const t = now(), list = (payHits.get(who) ?? []).filter((x) => t - x < 60_000);
  if (list.length >= PAY_PER_MIN) { payHits.set(who, list); return false; }
  list.push(t); payHits.set(who, list);
  if (payHits.size > 5_000) for (const [k, v] of payHits) if (!v.some((x) => t - x < 60_000)) payHits.delete(k);
  return true;
}
/** The x402 resource: this copy route on the public origin (https except on a local server). */
function resourceOf(c: any): string {
  const u = new URL(c.req.url);
  const origin = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host) ? u.origin : u.origin.replace(/^http:/, "https:");
  return `${origin}/v1/agents/${encodeURIComponent(c.req.param("id"))}/copy`;
}
/** A copy through the copy route: the engine bot (paper, webhook never copied), counted on the board, and, through a listing,
 *  the terms it was made under (its profit share starts accruing). */
function makeCopy(owner: string, src: Bot, name: unknown, l: Listing | null, sig: string | null): Bot {
  const params: any = { ...(src.params as any) };
  delete params.webhook;
  const copy = createBot(owner, { name: String(name ?? `Copy of ${src.name}`).slice(0, 48), type: src.type, params, mode: "paper" });
  store().run("INSERT OR IGNORE INTO agent_copies (source, copy, owner, at) VALUES (?, ?, ?, ?)", [src.id, copy.id, owner, now()]);
  if (l) recordCopy({ copy: copy.id, listing: l.agent, owner, priceUsdc: sig ? l.priceUsdc : 0, sharePct: l.profitSharePct, sig });
  marketCache = null;
  return copy;
}
function marketFail(c: any, e: unknown): Response {
  if (e instanceof MarketError) return c.json({ error: e.code, message: e.message }, e.status as 400);
  const err = e as Error & { status?: number; code?: string };
  if (err?.code === "nownodes_off") return c.json({ error: "nownodes_off", message: err.message }, 503);
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  return c.json({ error: err?.code ?? "market_error", message: String(err?.message ?? e).slice(0, 200) }, status as 502);
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const SESSION_RE = /^[A-Za-z0-9:_-]{8,120}$/;
function ownerOf(c: any): string | null {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? "";
  if (bearer.startsWith("ak_")) { const k = resolveKey(bearer); return k ? `key:${k.id}` : null; }
  const s = c.req.header("x-session");
  return s && SESSION_RE.test(s) ? s : null;
}

export const agents = new Hono();
agents.get("/stats", (c) => { keepWarm(); return c.json(stats()); });
agents.get("/templates", (c) => {
  const counts = new Map<string, number>();
  for (const b of allBots("running")) { const t = (b.params as any)?.templateId; if (typeof t === "string") counts.set(t, (counts.get(t) ?? 0) + 1); }
  return c.json({ templates: templatesWithHeadline((id) => counts.get(id) ?? 0) });
});
// The board reads every public agent's fills: 10 s per window, kept warm in the background so a request never builds it
// (measured 07/10: stats 8 s and board 2-3 s cold under load).
const boardCache = new Map<string, { at: number; v: unknown }>();
function board(window: "today" | "7d" | "all") {
  const hit = boardCache.get(window);
  if (hit && now() - hit.at < 10_000) return hit.v;
  const v = { window, agents: rows(window).slice(0, 50) };
  boardCache.set(window, { at: now(), v });
  return v;
}
let warmTimer: ReturnType<typeof setInterval> | null = null;
function keepWarm() {
  if (warmTimer || process.env.NODE_ENV === "test") return;
  warmTimer = setInterval(() => {
    try { statsCache = null; stats(); boardCache.delete("today"); board("today"); } catch { /* the next request builds it */ }
  }, 9_000);
  (warmTimer as any).unref?.();
}
agents.get("/board", (c) => {
  keepWarm();
  const w = c.req.query("window");
  return c.json(board(w === "7d" || w === "all" ? w : "today"));
});
agents.get("/smart-now", async (c) => { try { return c.json(await smartNow()); } catch (e) { return c.json({ error: "unavailable", message: String((e as Error).message).slice(0, 120) }, 502); } });
agents.get("/feed", (c) => {
  ensureFeed();
  return streamSSE(c, async (stream) => {
    let open = true;
    await stream.writeSSE({ event: "backlog", data: JSON.stringify(backlog) });
    let sent = 0, windowStart = now();
    const fn = (i: FeedItem) => {
      if (!open) return;
      if (now() - windowStart > 1000) { windowStart = now(); sent = 0; }
      if (++sent > 20) return;
      stream.writeSSE({ event: "item", data: JSON.stringify(i) }).catch(() => { open = false; });
    };
    listeners.add(fn);
    stream.onAbort(() => { open = false; listeners.delete(fn); });
    for (let i = 0; open && i < 90; i++) { await stream.sleep(20_000); if (open) await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => { open = false; }); }
    listeners.delete(fn);
  });
});
agents.post("/:id/copy", async (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  const src = getBot(null, c.req.param("id"));
  if (!src) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const l = listingOf(src.bot.id);
  const listing = l && l.owner !== owner ? l : null; // the creator copies their own agent for free, outside the market
  try {
    if (!listing || listing.priceUsdc <= 0) return c.json(makeCopy(owner, src.bot, b.name, listing, null), 201);
    // x402: nobody pays for a copy they could not receive, then 402 with the terms, then the payment read through NOWNodes
    if (countOf(owner) >= MAX_BOTS_PER_OWNER) return c.json({ error: "too_many_bots", message: `At most ${MAX_BOTS_PER_OWNER} agents per account: delete one before paying for a copy.` }, 409);
    const resource = resourceOf(c);
    const header = c.req.header("x-payment");
    if (!header) return c.json(paymentRequired(listing, resource, owner), 402);
    const sig = parsePaymentHeader(header);
    if (!sig) return c.json({ error: "bad_payment", message: "X-PAYMENT must be solana:<transaction signature>" }, 400);
    if (!allowPay(owner)) return c.json({ error: "rate_limited", message: `${PAY_PER_MIN} payment checks a minute` }, 429);
    const v = await verifyCopyPayment(sig, listing, owner);
    if (!v.ok) return v.status === 402 ? c.json(paymentRequired(listing, resource, owner, v.message, v.code), 402) : c.json({ error: v.code, message: v.message }, v.status as 409);
    if (!reservePayment(sig, listing.agent, owner, v.payer, v.paidUsdc)) return c.json({ error: "payment_used", message: "This payment already bought a copy. One payment buys one copy." }, 409);
    let copy: Bot;
    try { copy = makeCopy(owner, src.bot, b.name ?? `Copy of ${listing.title}`, listing, sig); } catch (e) { releasePayment(sig); throw e; }
    settlePayment(sig, copy.id);
    c.header("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, transaction: sig, network: "solana", payer: v.payer })).toString("base64"));
    return c.json({ ...copy, payment: { signature: sig, paidUsdc: v.paidUsdc, payer: v.payer, payTo: listing.payTo, verifiedBy: "NOWNodes" } }, 201);
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    return c.json({ error: err.code ?? "copy_failed", message: err.message }, (err.status ?? 400) as 400);
  }
});

// marketplace
agents.get("/market", (c) => {
  const q = c.req.query("sort");
  const sort: MarketSort = (MARKET_SORTS as readonly string[]).includes(q ?? "") ? (q as MarketSort) : "pnl";
  return c.json({ sort, listings: market(sort, ownerOf(c)), nownodes: { ready: nownodesReady() }, updatedAt: now() });
});
agents.get("/:id/listing", (c) => {
  const id = c.req.param("id");
  if (!getBot(null, id)) return c.json({ error: "not_found" }, 404);
  const l = listingOf(id), row = l ? marketRow(l) : null;
  return c.json({ listing: row ? (l!.owner === ownerOf(c) ? { ...row, mine: true } : row) : null });
});
agents.post("/:id/listing", async (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  const body = await c.req.json().catch(() => null);
  try {
    const l = await publishListing(owner, c.req.param("id"), body);
    marketCache = null;
    return c.json({ listing: { ...marketRow(l)!, mine: true } });
  } catch (e) { return marketFail(c, e); }
});
agents.delete("/:id/listing", (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  if (!unlistAgent(owner, c.req.param("id"))) return c.json({ error: "not_found", message: "This agent has no listing of yours." }, 404);
  marketCache = null;
  return c.json({ ok: true });
});
/** The priced listing a payment route is about, or the answer that says why there is none. */
function payable(c: any, owner: string): Listing | Response {
  const l = listingOf(c.req.param("id"));
  if (!l || l.priceUsdc <= 0) return c.json({ error: "not_priced", message: "This agent has no priced listing." }, 404);
  if (l.owner === owner) return c.json({ error: "own_listing", message: "Your own agent copies for free." }, 400);
  if (!allowPay(owner)) return c.json({ error: "rate_limited", message: `${PAY_PER_MIN} payment calls a minute` }, 429);
  return l;
}
agents.post("/:id/copy/pay-tx", async (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  const l = payable(c, owner);
  if (l instanceof Response) return l;
  if (countOf(owner) >= MAX_BOTS_PER_OWNER) return c.json({ error: "too_many_bots", message: `At most ${MAX_BOTS_PER_OWNER} agents per account: delete one before paying for a copy.` }, 409);
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(await buildPaymentTx(l, String(b.wallet ?? ""), owner)); } catch (e) { return marketFail(c, e); }
});
agents.post("/:id/copy/pay-send", async (c) => {
  const owner = ownerOf(c);
  if (!owner) return c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401);
  const l = payable(c, owner);
  if (l instanceof Response) return l;
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(await sendPaymentTx(l, String(b.transaction ?? ""))); } catch (e) { return marketFail(c, e); }
});
/** On boot: hero stats + today's board rebuilt every 9 s and smart money every minute, so no first visitor waits. */
export function startAgentsWarm(): void {
  keepWarm();
  keepFresh("smartnow", 60_000, computeSmartNow);
}
export const _agentsTest = {
  sparkOf, windowPnl, syncFeed, backlog, emit,
  reset() { boardCache.clear(); if (warmTimer) clearInterval(warmTimer); warmTimer = null; for (const off of subs.values()) off(); subs.clear(); backlog.length = 0; statsCache = null; _resetSwr(); marketCache = null; payHits.clear(); if (feedTimer) clearInterval(feedTimer); feedTimer = null; db?.close(); db = null; },
};
