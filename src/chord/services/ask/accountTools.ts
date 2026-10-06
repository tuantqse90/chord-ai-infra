// Account-side Ask tools, moved out of Chord's askAgent.ts `runTool` switch (ask2049 port, 2026-10-06). Same contract as the
// other families in services/ask (schemas, registry rows, a runner answering {data, addresses, citations, viz}), with one
// addition: these tools read or write per-person state, so the runner takes the person — ctx { session }, the X-Session id the
// server already has (Chord: the signed-in account's id).
//   memory     remember · forget                           ← services/askProfile (SQLite table ask_profiles, one row per session)
//   journal    journal_open · journal_list · journal_close ← services/askProfile + services/askChains (token and live price from
//                                                            Chord's public API: Arc, Robinhood Chain, Avalanche, Base, BNB Chain)
//   clarify    ask_user                                    ← services/askClarify (Chord's file, unchanged)
//   arc_market arc_picks · arc_attention                   ← Chord's public GET /v1/ask/picks and GET /v1/arc/attention
// Not ported: alert_create / alert_list / alert_delete. Chord delivers an alert to the person's Ask inbox (/ask/alerts) and to
// Telegram from a worker; this app has neither, so a saved rule would reach no one.
//
// The case bodies are Chord's (output fields, notes, math, tables). Changes are marked `// ask2049:` — mostly citations of
// getchord.xyz pages that show a Chord ACCOUNT's own state (/ask/journal, /ask#profile): the adapter turns a relative link into
// a getchord.xyz link, and those pages would show another journal (or none), so they are dropped. Token pages stay.
//
// Wiring in the caller's loop (as Chord's askAgent.ts does it):
//   · system prompt = base + "\n\n" + CLARIFY_RULES + profileLine(session);
//   · ask_user ENDS the turn: runAccountTool answers { data: { clarify: AskClarify } } — show the card (question, options, "type
//     your own"), run none of that round's other calls and no further model round; replay that assistant turn in history as
//     clarifyHistoryText(leadIn, card) so the next message is read as the answer. Chord charges nothing for such a turn.
import type { ToolMeta } from "./registry";
import type { Viz } from "../askAgent";
import type { ExtToolResult } from "./extHttp";
import { config } from "../../../config";
import { ASK_USER_TOOL, ASK_USER_TOOL_DEF, CLARIFY_RULES, clarifyHistoryText, normalizeClarify, type AskClarify } from "../askClarify";
import { addMemory, clearProfile, closePosition, deleteMemory, deletePosition, getProfile, openPosition, profilePrompt } from "../askProfile";
import { askPriceNow, askTokenPath, chainFieldOf, chainLabel, chainName, chainOf, parseAskChain, resolveAskToken } from "../askChains";
import { getPicksBoard, gradePick, pickChainName, publicPick } from "../askPicks";
import { arcSymbols, getAttention } from "../askAttention";

export { ASK_USER_TOOL, CLARIFY_RULES, clarifyHistoryText, normalizeClarify, type AskClarify };

// ── helpers copied from Chord's askAgent.ts (module-level there) ──────────────────────────────────────────────────────
const minsAgo = (ts: number) => Math.round((Date.now() / 1000 - ts) / 60);
const sig = (x: number) => Number(x.toPrecision(5));
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });

// ── schemas (Chord services/ask/schemas.ts, these tools' entries verbatim; ask_user = askClarify.ASK_USER_TOOL_DEF) ─────
export const ACCOUNT_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "remember",
      description: "Save a durable fact about THIS PERSON to their profile (their preferences, sizing, timeframe, tokens they hold or watch, how they want answers). Use when they say 'remember…', 'from now on…', 'I usually…', 'my wallet is…'. Never store token prices or numbers that go stale.",
      parameters: { type: "object", properties: { fact: { type: "string", description: "One short third-person sentence, ≤140 chars" } }, required: ["fact"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "forget",
      description: "Delete one memory from the person's profile by its id (ids are listed in ABOUT THIS PERSON when memories exist), or everything when they ask to forget all.",
      parameters: { type: "object", properties: { id: { type: "string" }, all: { type: "boolean" } }, required: [] },
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
      name: "journal_open",
      description: "Record a position in the person's journal (real or paper) on Arc, Robinhood Chain (stocks), Avalanche, Base or BNB Chain: token, entry price (default: price now), size in USD, optional stop and targets. Use when they say 'I bought X at…', 'log this', 'paper trade X', 'paper-buy $500 of NVDA', 'I bought CAKE on BNB'. Live PnL is computed when listed. Pin chain whenever the person names it (on Base / on BNB / on Avalanche); unpinned, Arc and Robinhood Chain are searched first.",
      parameters: { type: "object", properties: { token: { type: "string" }, chain: { type: "string", enum: ["arc", "robinhood", "avalanche", "base", "bnb"], description: "optional; a stock ticker resolves to Robinhood Chain by itself; set it when the person names the chain" }, entry: { type: "number" }, size_usd: { type: "number" }, stop: { type: "number" }, targets: { type: "array", items: { type: "number" } }, paper: { type: "boolean", description: "true = simulated position" }, note: { type: "string" } }, required: ["token", "size_usd"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "journal_list",
      description: "The person's journal with live PnL per position (price now vs entry, distance to stop/targets), open and recently closed, real and paper. Use for 'my positions', 'how am I doing', 'journal'.",
      parameters: { type: "object", properties: { include_closed: { type: "boolean" } }, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "journal_close",
      description: "Close a journal position by id at a price (default: current price). Use for 'I sold X', 'close the ARGUS position'.",
      parameters: { type: "object", properties: { id: { type: "string" }, exit_price: { type: "number" }, delete: { type: "boolean", description: "true = remove the entry instead of closing it" } }, required: ["id"] },
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
  ASK_USER_TOOL_DEF,
];

// ── registry rows (Chord services/ask/registry.ts TOOL_META, these tools' rows verbatim) ──────────────────────────────
export const ACCOUNT_TOOL_META: Record<string, ToolMeta> = {
  remember: { group: "memory", label: "Saving to your profile" },
  forget: { group: "memory", label: "Updating your profile" },
  arc_attention: { group: "arc_market", label: "Reading attention on Chord", market: true },
  journal_open: { group: "journal", label: "Logging the position" },
  journal_list: { group: "journal", label: "Pricing your journal" },
  journal_close: { group: "journal", label: "Closing the position" },
  arc_picks: { group: "arc_market", label: "Reading the picks board", market: true, dyor: true },
  ask_user: { group: "clarify", label: "Asking you back" },
};

export const ACCOUNT_TOOL_NAMES: string[] = ACCOUNT_TOOL_SCHEMAS.map((t) => t.function.name);
const NAMES = new Set(ACCOUNT_TOOL_NAMES);
export const isAccountTool = (name: string): boolean => NAMES.has(name);

/** The person a runner acts for: the session id (X-Session). An empty one gets Chord's "no profile for this session". */
export interface AccountCtx { session: string }
const subOf = (ctx: AccountCtx | null | undefined): string => {
  const s = typeof ctx?.session === "string" ? ctx.session.trim() : "";
  return s.length > 0 && s.length <= 200 ? s : "";
};

/** Whether the model may be offered the tool. Memory, journal and ask_user always; the two boards are Chord's public routes and
 *  go with CHORD_API=off. */
export function accountToolOffered(name: string): boolean {
  if (!isAccountTool(name)) return false;
  if (name === "arc_picks" || name === "arc_attention") return !!config.chordApi();
  return true;
}

/** The person's part of the system prompt: Chord's profilePrompt (memories, open journal positions) plus the memory ids line
 *  askAgent.ts adds so `forget` can name one. "" when there is nothing to say. */
export function profileLine(session: string): string {
  const sub = subOf({ session });
  if (!sub) return "";
  try {
    const profile = getProfile(sub);
    return profilePrompt(profile) + (profile.memories.length ? `\nMemory ids: ${profile.memories.slice(0, 20).map((m) => `${m.id}=${m.text.slice(0, 30)}…`).join(" | ")}` : "");
  } catch {
    return "";
  }
}

/** Runs one tool of this module for one person; a thrown error becomes an answer the model can repeat instead of a broken turn. */
export async function runAccountTool(name: string, args: Record<string, any>, ctx: AccountCtx): Promise<ExtToolResult> {
  if (!isAccountTool(name)) return { data: { error: `unknown tool ${name}` }, addresses: [], citations: [] };
  try {
    return await runCase(name, args && typeof args === "object" ? args : {}, subOf(ctx));
  } catch (e) {
    return { data: { error: String((e as Error)?.message ?? e).slice(0, 160), note: "The source did not answer just now. Say the data is unavailable; do not guess numbers." }, addresses: [], citations: [] };
  }
}

async function runCase(name: string, args: Record<string, any>, userId: string): Promise<ExtToolResult> {
  const none: ExtToolResult = { data: null, addresses: [], citations: [] };
  switch (name) {
    case "remember": {
      if (!userId) return { ...none, data: { error: "no profile for this session" } };
      const m = addMemory(userId, String(args.fact ?? ""), "user");
      // ask2049: Chord cites its settings page ("Personalization", /ask#profile), a Chord account's page — not this session's.
      return { ...none, data: m ? { saved: m.text, id: m.id } : { saved: false, note: "Nothing saved — empty, too short, or already remembered." } };
    }
    case "forget": {
      if (!userId) return { ...none, data: { error: "no profile for this session" } };
      // Chord's `all` deletes the whole profile — memories and the journal with them (one Redis key holds both).
      if (args.all) { clearProfile(userId); return { ...none, data: { cleared: true } }; }
      const ok = deleteMemory(userId, String(args.id ?? ""));
      return { ...none, data: { deleted: ok } };
    }
    case "arc_attention": {
      const rows = await getAttention(Math.max(1, Math.min(7, Number(args.days) || 1)), Math.max(1, Math.min(50, Number(args.limit) || 15)));
      const metas = await arcSymbols(rows.map((r) => r.token));
      return { ...none, data: { rows: rows.map((r) => ({ token: metas.get(r.token)?.symbol ?? r.token, tokenAddress: r.token, score: r.score, asks: r.ask, searches: r.search, views: r.view, watchlistAdds: r.watch })), note: "Attention on Chord only (Ask questions ×3, searches, page views, watchlist adds ×5). Not X." }, addresses: rows.map((r) => r.token), citations: [{ label: "Markets", href: "/markets" }], viz: [vTable("Attention on Chord", ["Token", "Score", "Asks", "Searches", "Views", "Watchlist"], rows.map((r) => [metas.get(r.token)?.symbol ?? shortAddr(r.token), r.score, r.ask, r.search, r.view, r.watch]), ["l", "r", "r", "r", "r", "r"])] };
    }
    case "journal_open": {
      if (!userId) return { ...none, data: { error: "no profile for this session" } };
      const pin = parseAskChain(args.chain);
      const t = await resolveAskToken(String(args.token ?? ""), pin, { keyed: true });
      if (!t) return { ...none, data: { found: false, note: pin ? `No token on ${chainName(pin)} matches that.` : "No token on Arc, Robinhood Chain, Avalanche, Base or BNB Chain matches that." } };
      const entry = Number(args.entry) > 0 ? Number(args.entry) : t.priceUsd ?? NaN, size = Number(args.size_usd);
      if (!(entry > 0) || !(size > 0)) return { ...none, data: { error: "entry and size_usd must be positive" } };
      const pos = openPosition(userId, { token: t.address, symbol: t.symbol, ...chainFieldOf(t.chain), entry, sizeUsd: size, tokens: size / entry, stop: Number(args.stop) > 0 ? Number(args.stop) : null, targets: (Array.isArray(args.targets) ? args.targets.map(Number).filter((x: number) => x > 0) : []).slice(0, 4), paper: !!args.paper, note: args.note ? String(args.note).slice(0, 200) : null });
      // ask2049: Chord also attaches the token's panel (artifact — no such panel here) and cites its /ask/journal page (a Chord
      // account's journal, not this session's).
      return { ...none, data: { saved: pos, chain: chainName(t.chain), note: "Logged. journal_list shows live PnL." }, addresses: [t.address], citations: [{ label: `${t.symbol} on ${chainName(t.chain)}`, href: askTokenPath(t.address, t.chain) }] };
    }
    case "journal_list": {
      if (!userId) return { ...none, data: { error: "no profile for this session" } };
      const prof = getProfile(userId);
      const rows = prof.positions.filter((x) => args.include_closed || !x.closedAt).slice(0, 30);
      if (!rows.length) return { ...none, data: { positions: [], note: "The journal is empty. Say 'I bought X at … with … USDC' to log one." } };
      const priced = await Promise.all(rows.map(async (x) => { const now = x.closedAt ? x.exitPrice ?? x.entry : await askPriceNow(x.token, chainOf(x)).catch(() => null); const pnl = now == null ? null : Math.round((now - x.entry) * x.tokens); return { id: x.id, symbol: x.symbol, chain: chainName(chainOf(x)), paper: x.paper, entry: sig(x.entry), now: now == null ? null : sig(now), sizeUsd: Math.round(x.sizeUsd), tokens: sig(x.tokens), pnlUsd: pnl, pnlPct: now == null ? null : +(((now - x.entry) / x.entry) * 100).toFixed(1), stop: x.stop, toStopPct: x.stop && now ? +(((x.stop - now) / now) * 100).toFixed(1) : null, targets: x.targets, nextTargetPct: x.targets[0] && now ? +(((x.targets[0] - now) / now) * 100).toFixed(1) : null, openedMinutesAgo: minsAgo(x.openedAt), closed: !!x.closedAt, note: x.note }; }));
      const openRows = priced.filter((x) => !x.closed);
      const totalPnl = openRows.reduce((s, x) => s + (x.pnlUsd ?? 0), 0);
      // ask2049: Chord cites its settings page ("Personalization", /ask#profile) — dropped, see the header.
      return { ...none, data: { positions: priced, openPnlUsd: Math.round(totalPnl), openCount: openRows.length, note: "PnL at the index's last price; stops and targets are not executed by Chord." }, addresses: rows.map((x) => x.token), viz: [vTable("Journal", ["Token", "Chain", "Kind", "Entry", "Now", "Size", "PnL", "PnL %", "To stop", "Next target", "Id"], priced.map((x, i) => [x.symbol, chainLabel(chainOf(rows[i])), x.paper ? "paper" : "real", x.entry, x.now, x.sizeUsd, x.pnlUsd, x.pnlPct, x.toStopPct, x.nextTargetPct, x.id]), ["l", "l", "l", "r", "r", "r", "r", "r", "r", "r", "l"])] };
    }
    case "journal_close": {
      if (!userId) return { ...none, data: { error: "no profile for this session" } };
      const id = String(args.id ?? "");
      if (args.delete) return { ...none, data: { deleted: deletePosition(userId, id) } };
      const prof = getProfile(userId);
      const pos = prof.positions.find((x) => x.id === id);
      if (!pos) return { ...none, data: { error: "no such position id" } };
      let exit = Number(args.exit_price);
      if (!(exit > 0)) exit = (await askPriceNow(pos.token, chainOf(pos)).catch(() => null)) ?? pos.entry;
      const closed = closePosition(userId, id, exit);
      return { ...none, data: closed ? { closed, realizedUsd: Math.round((exit - closed.entry) * closed.tokens), realizedPct: +(((exit - closed.entry) / closed.entry) * 100).toFixed(1) } : { error: "already closed" } };
    }
    case "arc_picks": {
      // ask2049: Chord reads getLatestPicks() + getTrackRecord(7) from its Redis and adds market caps (withMarketCaps); here one
      // public read that carries all three, the record already in its public shape (publicRecord).
      const { latest, record } = await getPicksBoard();
      if (!latest) return { ...none, data: { picks: [], note: "The picks board has not been computed on this deployment yet (runs every 4 h).", trackRecord7d: record } };
      const side = args.side === "bullish" || args.side === "bearish" ? args.side : "both";
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 8));
      const picks = latest.picks.filter((p) => side === "both" || p.side === side).slice(0, limit);
      const graded = await Promise.all(picks.map((p) => gradePick(p).catch(() => null)));
      return { ...none, data: { computedMinutesAgo: minsAgo(latest.ts), picks: picks.map((p, i) => ({ ...publicPick(p), chain: pickChainName(p.chain), sinceMovePct: graded[i]?.movePct ?? null })), trackRecord7d: record, note: "Scores are descriptive statistics of the tape, refreshed every 4 h; tokens with under $2k or 15 trades in the last hour are not scored. A pick with facts.minTradeUsd (BNB Chain: 100) counts only trades of at least that size — Chord's index skips smaller ones; say so when quoting its buy share or trade count. `against` lists the strongest facts that disagree with the call — mention them. The track record says how many picks moved their way 48 h later and the average move. Present picks as bullish / bearish reads with their reasons — never with an entry, a stop, a target or a size." }, addresses: picks.map((p) => p.token), citations: [{ label: "Markets", href: "/markets" }], viz: [vTable(`Ask Picks · ${side} · computed ${minsAgo(latest.ts)}m ago`, ["Token", "Chain", "Side", "Score", "Confidence", "Price", "Buy share 1h", "Real buyers", "Since pick"], picks.map((p, i) => [p.symbol, pickChainName(p.chain).replace(" Chain", ""), p.side, p.score, p.confidence, p.priceUsd, p.facts.buyShare1h, p.facts.realBuyerPct, graded[i]?.movePct ?? null]), ["l", "l", "l", "r", "l", "r", "r", "r", "r"])] };
    }
    case ASK_USER_TOOL: {
      // ask2049: in Chord the loop reads an ask_user call before any tool runs (normalizeClarify → the answer carries `clarify`,
      // the turn ends); a call it could not turn into a card fell through to runTool and answered "no such tool". Here the
      // runner hands the card back for the caller's loop to do the same, and says why when there is nothing to ask.
      const card = normalizeClarify(args);
      return { ...none, data: card ? { clarify: card } : { error: "nothing to ask: a question and at least two options are needed", note: "Answer from what you have instead of asking." } };
    }
    default:
      return { ...none, data: { error: `no such tool ${name}` } };
  }
}
