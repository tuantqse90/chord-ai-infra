// Ask tools for agents as a service (the engine still calls them bots; tool names keep bot_ for now): find traders to copy,
// backtest, start a paper copy-trading or custom agent on Monad, read and steer your agents. Every fill an agent makes is
// committed on-chain to its ERC-8004 identity's TrackRecord chain (src/trust). The owner is the asking session (ctx.session),
// the same owner the Agents tab and /v1/bots use. Paper mode only.
import { ToolInputError, type Tool, type ToolResult } from "./types";
import { backtest, BotInputError, BotLimitError, BotLiveError, createBot, getBot, listBots, setStatus, smartTraders } from "./bots";
import { backtestStrategy, compileStrategy, explainStrategy, getTemplate, listTemplates, StrategyInputError, validateStrategy } from "./strategy";
import { backtestAll } from "./classic/backtest";
import { catalog as classicCatalog } from "./classic/routes";
import { CLASSIC, ClassicInputError } from "./classic/strategies";
import { lpBacktest, LpInputError } from "./lp/backtest";
import { scan as lpScan } from "./lp/routes";

const EXPLORER_ADDR = (a: string) => `https://monadscan.com/address/${a}`;
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const usd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const days = (v: unknown): 1 | 3 | 7 => (Number(v) === 1 ? 1 : Number(v) === 7 ? 7 : 3);
const ok = (data: unknown, summary: string, extra: Partial<ToolResult> = {}): ToolResult => ({ data, sources: [], summary, ...extra });
/** Return on what was invested, computed here (the model once called −$42.20 on $200 "11.3 %"). */
const returnPct = (pnl: number, invested: number) => (invested > 0 ? Math.round((pnl / invested) * 1000) / 10 : null);
const APP = (process.env.PUBLIC_BASE_URL ?? "https://chordsi.xyz").replace(/\/$/, "");
/** The card under the answer for an agent the chat just started: the page shows "Open agent" (its page in My agents). */
const agentCard = (b: { id: string; name: string; type: string; mode?: string }) => ({ kind: "agent", id: b.id, name: b.name, type: b.type, mode: b.mode ?? "paper" });
const TAPE_SOURCE = { kind: "web" as const, id: "chord-monad-feed", label: "Chord · Monad trade feed (replayed)", url: "https://getchord.xyz" };

/** wallets given, or the top N of Chord's Monad smart-traders board. */
async function walletsFrom(a: Record<string, any>): Promise<string[]> {
  const given = Array.isArray(a.wallets) ? a.wallets.map((w: unknown) => String(w).trim()).filter(Boolean) : [];
  if (given.length) return given.slice(0, 10);
  const n = Math.max(1, Math.min(10, Number(a.top) || 3));
  return (await smartTraders(days(a.days), n)).slice(0, n).map((t) => t.wallet);
}
function copyParams(a: Record<string, any>, wallets: string[]) {
  return {
    wallets, usdPerTrade: Number(a.usd_per_trade ?? a.usdPerTrade ?? 20),
    ...(a.max_per_token_usd != null ? { maxPerTokenUsd: Number(a.max_per_token_usd) } : {}),
    ...(a.max_open_positions != null ? { maxOpenPositions: Number(a.max_open_positions) } : {}),
    ...(a.mirror_sells != null ? { mirrorSells: !!a.mirror_sells } : {}),
    ...(a.min_liquidity_usd != null ? { minLiquidityUsd: Number(a.min_liquidity_usd) } : {}),
    ...(a.daily_loss_stop_usd != null ? { dailyLossStopUsd: Number(a.daily_loss_stop_usd) } : {}),
  };
}
/** Starting an agent is an action: only when the person's own words this turn ask for it, or a short yes to the offer. A demo
 *  question ("build me an agent that …, then backtest it") once made the model start one by itself. */
const START_RE = /\b(start|run|launch|create|deploy|activate|spin (?:it |one )?up|set (?:it |one )?up|turn (?:it )?on|go live)\b|bật|chạy|khởi động|tạo agent|tạo bot/i;
const YES_RE = /^\s*(yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|please do|start it|ừ|ok luôn|làm đi|có|được)\b/i;
function mayStart(ctx?: { question?: string }): void {
  const q = ctx?.question;
  if (q == null) return; // API callers and tests without a chat turn
  if (START_RE.test(q) || (q.length <= 40 && YES_RE.test(q))) return;
  throw new ToolInputError("The person has not asked to start an agent: show the result (backtest, plan) and ask whether to start it in paper mode.");
}
const need = (ctx?: { session?: string }) => { if (!ctx?.session) throw new ToolInputError("agents need a session"); return ctx.session; };
const COPY_PROPS = {
  wallets: { type: "array", items: { type: "string" }, description: "Monad wallets (0x…) to copy. Omit to use the top traders." },
  top: { type: "number", description: "copy the top N wallets of the smart-traders board (1-10), default 3, when wallets are not given" },
  days: { type: "number", enum: [1, 3, 7], description: "window for the board and the backtest, default 3" },
  usd_per_trade: { type: "number", description: "USDC per mirrored buy, 1-1000, default 20" },
  max_per_token_usd: { type: "number" }, max_open_positions: { type: "number" }, mirror_sells: { type: "boolean" },
  min_liquidity_usd: { type: "number" }, daily_loss_stop_usd: { type: "number" },
};

/** At most n points, evenly spaced, the last one kept. */
const thin = <T>(xs: T[], n: number): T[] => { const k = Math.ceil(xs.length / n); return k <= 1 ? xs : xs.filter((_, i) => i % k === 0 || i === xs.length - 1); };
const hourLabel = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

const CLASSIC_PROPS = {
  strategy: { type: "string", description: CLASSIC.map((s) => s.id).join(" | ") },
  symbol: { type: "string", description: "BTC, ETH, SOL, MON, HYPE… (Perpl's markets); Monad spot: BTC, ETH, MON" },
  venue: { type: "string", enum: ["perpl", "monad_spot"], description: "perpl = perps on Perpl (long and short), monad_spot = long only through Chord's router; default perpl" },
  tf: { type: "string", enum: ["15m", "1h", "4h", "1d"], description: "default: the strategy's own" },
  days: { type: "number", description: "window, 7 to 1095 days (up to 3 years; Binance and OKX keep years, Hyperliquid ~5000 candles, Perpl since its listing); default: the strategy's own (1 year on 1h, 2 years on 4h)" },
  params: { type: "object", description: "the strategy's parameters (classic_strategies lists them with ranges); omitted = defaults" },
  size_usd: { type: "number", description: "per position, 10 to 10000, default 1000" },
  leverage: { type: "number", description: "1 to 3 (Perpl only), default 1" },
};
const classicInput = (a: Record<string, any>) => ({ strategy: String(a.strategy ?? ""), symbol: String(a.symbol ?? "BTC"), venue: a.venue === "monad_spot" ? "monad_spot" as const : "perpl" as const, tf: a.tf, days: a.days, params: a.params, sizeUsd: a.size_usd ?? a.sizeUsd ?? 1000, leverage: a.leverage });

export const botTools: Tool[] = [
  {
    name: "lp_scan", via: "ext", provider: "Chord · Monad LP index", label: "Reading Monad's LP pools", group: "bots",
    description: "The Monad pools an LP agent can provide liquidity to (against WMON or a dollar stable), from Chord's LP index: pair, DEX, fee tier, TVL, 24 h volume and fees, Chord's fee APR, trades. Use for 'which Monad pools should I LP', 'best fee APR on Monad'.",
    parameters: { type: "object", properties: { limit: { type: "number", description: "1 to 40, default 12" } } },
    async run(a) {
      const rows = (await lpScan(40)).slice(0, Math.max(1, Math.min(40, Number(a.limit) || 12)));
      return ok({ pools: rows, open: `${APP}/app#agents/lp`, note: "Fee APR is Chord's: the last 24 h of fees over today's TVL, annualised. A concentrated range earns more per dollar while in range and nothing out of it." }, `${rows.length} Monad pools`,
        { sources: [{ kind: "web" as const, id: `${APP}/app#agents/lp`, label: "LP pools on Monad", url: `${APP}/app#agents/lp` }],
          viz: [{ kind: "table", title: "Monad pools · Chord LP index", columns: ["Pool", "DEX", "Fee %", "TVL $", "Volume 24h $", "Fee APR %"], rows: rows.map((r) => [r.pair, r.dex, r.feeBps / 100, r.tvlUsd, r.volume24hUsd, r.feeAprPct]), align: ["l", "l", "r", "r", "r", "r"] }] });
    },
  },
  {
    name: "lp_backtest", via: "ext", provider: "Chord · Monad LP index", label: "Replaying LP ranges on the pool", group: "bots", timeoutMs: 120_000,
    description: "Replay a liquidity position on a Monad pool over its last 1, 3, 7 or 30 days, every range side by side (tight ±5%, balanced ±15%, wide ±40%, full range): PnL, fees, value against holding the tokens (impermanent loss), hours in range, re-centres, fee APR, and the assumptions. Uniswap V3 math on the pool's hourly volume and price from Chord.",
    parameters: { type: "object", properties: { pool: { type: "string", description: "the pool address (lp_scan gives them)" }, amount_usd: { type: "number", description: "100 to 10000, default 1000" }, days: { type: "number", enum: [1, 3, 7, 30], description: "default 7; 30 = the last month" }, rebalance: { type: "boolean", description: "re-centre after 6 hours out of range, default true" } }, required: ["pool"] },
    async run(a) {
      let r;
      try { r = await lpBacktest({ pool: a.pool, amountUsd: a.amount_usd ?? 1000, days: a.days ?? 7, rebalance: a.rebalance }); }
      catch (e) { if (e instanceof LpInputError) throw new ToolInputError(e.message); throw e; }
      // against holding, in words as well as a signed number: a model read "vsHodlUsd: -60.26" back as "+$60.26 better" (2026-10-12)
      const vsHolding = (n: number) => (n === 0 ? "the same as holding the tokens" : `$${Math.abs(n).toFixed(2)} ${n < 0 ? "WORSE" : "better"} than holding the tokens`);
      const by = Object.fromEntries(Object.entries(r.byPreset).map(([k, v]) => [k, v ? { pnlUsd: v.pnlUsd, returnPct: v.returnPct, feesUsd: v.feesUsd, lpMinusHoldingUsd: v.ilUsd, vsHolding: vsHolding(v.ilUsd), holdingPnlUsd: Math.round((v.hodlUsd - r.amountUsd) * 100) / 100, inRangePct: v.inRangePct, rebalances: v.rebalances, feeAprPct: v.aprPct } : null]));
      const link = `${APP}/app#agents/lp/${r.pool}`;
      return ok({ pool: r.pool, pair: r.pair, dex: r.dex, feeBps: r.feeBps, tvlUsd: r.tvlUsd, days: r.days, amountUsd: r.amountUsd, byRange: by, assumptions: r.notes, open: link, reminder: "History, not a forecast. Quote each range's numbers as given, and vsHolding in its own words: lpMinusHoldingUsd below zero means the position ended WORSE than holding (fees not counted in it; pnlUsd counts them). holdingPnlUsd is what holding the tokens made: quote it, do not derive it." },
        `${r.pair}: ${Object.entries(by).map(([k, v]) => `${k} ${v?.returnPct}%`).join(", ")}`,
        { sources: [{ kind: "web" as const, id: link, label: `LP · ${r.pair}`, url: link }],
          viz: [{ kind: "table", title: `${r.pair} · ${r.days}d · $${r.amountUsd}`, columns: ["Range", "PnL $", "Fees $", "vs HODL $", "In range %", "Fee APR %"], rows: Object.entries(by).filter(([, v]) => v).map(([k, v]) => [k, v!.pnlUsd, v!.feesUsd, v!.lpMinusHoldingUsd, v!.inRangePct, v!.feeAprPct]), align: ["l", "r", "r", "r", "r", "r"] }] });
    },
  },
  {
    name: "lp_agent_create", via: "ext", provider: "Agents", label: "Starting the LP agent", group: "bots",
    description: "Start an LP agent in paper mode on a Monad pool: it adds the amount in a range around the price, earns its share of each hour's fees while in range, re-centres after 6 hours out (when rebalance is on); every fill is committed to its ERC-8004 record on Monad. Only when the person asks to start it.",
    parameters: { type: "object", properties: { pool: { type: "string" }, amount_usd: { type: "number", description: "100 to 10000, default 1000" }, preset: { type: "string", enum: ["tight", "balanced", "wide", "full"], description: "default balanced" }, rebalance: { type: "boolean" }, name: { type: "string" } }, required: ["pool"] },
    async run(a, ctx) {
      mayStart(ctx);
      const owner = need(ctx);
      try {
        const b = createBot(owner, { type: "lp", name: a.name, params: { pool: a.pool, amountUsd: a.amount_usd ?? 1000, preset: a.preset ?? "balanced", ...(a.rebalance != null ? { rebalance: !!a.rebalance } : {}) } });
        return ok({ agent: { id: b.id, name: b.name, status: b.status, open: `${APP}/app#agents/${b.id}` } }, `${b.name} started (paper)`, { card: agentCard(b) });
      } catch (e) {
        if (e instanceof BotInputError || e instanceof BotLimitError || e instanceof BotLiveError) throw new ToolInputError(e.message);
        throw e;
      }
    },
  },
  {
    name: "classic_strategies", via: "ext", provider: "Agents", label: "Reading the classic strategies", group: "bots",
    description: `The classic and quant strategies an agent can run on Perpl perps (Monad) or Monad spot: ${CLASSIC.map((s) => s.title).join(", ")}. Each with its rule, its timeframe and window, and its parameters with ranges.`,
    parameters: { type: "object", properties: {} },
    async run() {
      const c = classicCatalog();
      return ok({ strategies: c, open: `${APP}/app#agents/classic` }, `${c.length} classic strategies`, { sources: [{ kind: "web" as const, id: `${APP}/app#agents/classic`, label: "Classic strategies", url: `${APP}/app#agents/classic` }] });
    },
  },
  {
    name: "classic_backtest", via: "ext", provider: "Binance · OKX · Hyperliquid · Perpl", label: "Backtesting the classic strategy on four data sources", group: "bots", timeoutMs: 120_000,
    description: "Backtest a classic strategy on a symbol with real candles and funding from Binance, OKX, Hyperliquid and Perpl, side by side: return, PnL, holding the same size, max drawdown, Sharpe, win rate, trades, fees and funding per source, whether the sources agree, and the assumptions. Trades at the next candle's open with Perpl's 3.45 bps taker fee (or Chord's router on Monad spot). Use for 'backtest a golden cross on ETH 4h', 'does RSI reversion work on MON'.",
    parameters: { type: "object", properties: CLASSIC_PROPS, required: ["strategy", "symbol"] },
    async run(a) {
      let r;
      try { r = await backtestAll(classicInput(a)); }
      catch (e) { if (e instanceof ClassicInputError) throw new ToolInputError(e.message); throw e; }
      const per = Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v ? { returnPct: v.returnPct, pnlUsd: v.pnlUsd, buyHoldPct: v.buyHoldPct, maxDrawdownPct: v.maxDrawdownPct, sharpe: v.sharpe, winRate: v.winRate, trades: v.tradeCount, feesUsd: v.feesUsd, fundingUsd: v.fundingUsd } : null]));
      const any = Object.values(r.results)[0];
      const link = `${APP}/app#agents/classic/${encodeURIComponent(String(a.strategy))}`;
      return ok({ strategy: any?.title, rule: any?.rule, symbol: any?.symbol, tf: any?.tf, days: any?.days, venue: any?.venue, sizeUsd: any?.sizeUsd, leverage: any?.leverage, bySource: per, errors: r.errors, agree: r.agree, note: r.note, assumptions: any?.notes, open: link,
        reminder: "History, not a forecast. Quote the numbers per source as given; do not average them or compute percentages yourself." },
        any ? `${any.title} on ${any.symbol} ${any.tf}: ${Object.entries(per).map(([k, v]) => `${k} ${v?.returnPct}%`).join(", ")}` : "no source could replay it",
        { sources: [{ kind: "web" as const, id: link, label: `Classic · ${any?.title ?? a.strategy}`, url: link }],
          viz: any ? [{ kind: "table", title: `${any.title} · ${any.symbol} ${any.tf} · ${any.days}d`, columns: ["Data", "Return %", "PnL $", "Hold %", "Max DD %", "Trades"], rows: Object.entries(per).filter(([, v]) => v).map(([k, v]) => [k, v!.returnPct, v!.pnlUsd, v!.buyHoldPct, v!.maxDrawdownPct, v!.trades]), align: ["l", "r", "r", "r", "r", "r"] }] : [] });
    },
  },
  {
    name: "classic_start", via: "ext", provider: "Agents", label: "Starting the classic agent", group: "bots",
    description: "Start a classic strategy as a paper agent on Perpl perps (or Monad spot): it acts on each closed candle, fills walk Perpl's live book, every fill is committed to its ERC-8004 record on Monad. Only when the person asks to start it.",
    parameters: { type: "object", properties: { ...CLASSIC_PROPS, signal_source: { type: "string", enum: ["binance", "okx", "hyperliquid", "perpl"], description: "where the agent reads its candles, default binance" }, name: { type: "string" } }, required: ["strategy", "symbol"] },
    async run(a, ctx) {
      mayStart(ctx);
      const owner = need(ctx);
      const { days: _d, ...p } = classicInput(a);
      try {
        const b = createBot(owner, { type: "classic", name: a.name, params: { ...p, signalSource: a.signal_source ?? "binance" } });
        return ok({ agent: { id: b.id, name: b.name, status: b.status, open: `${APP}/app#agents/${b.id}` } }, `${b.name} started (paper)`, { card: agentCard(b) });
      } catch (e) {
        if (e instanceof BotInputError || e instanceof BotLimitError || e instanceof BotLiveError) throw new ToolInputError(e.message);
        throw e;
      }
    },
  },
  {
    name: "agent_traders", via: "ext", provider: "Chord · Monad feed", label: "Ranking Monad smart traders", group: "bots",
    description: "Top Monad wallets by Chord's Smart Score over 24 h (days 1) or 7 days (days 3 or 7), bots removed: wallet, score, realized PnL, win rate, trades, tokens, volume, best token (ROI and hold time are not on Monad's board). Use to pick wallets for a copy-trading agent or to answer 'who are the best Monad traders'.",
    parameters: { type: "object", properties: { days: COPY_PROPS.days, limit: { type: "number", description: "rows, default 10, max 25" } } },
    async run(a) {
      const rows = await smartTraders(days(a.days), Math.min(25, Number(a.limit) || 10));
      return ok({ days: days(a.days), traders: rows.map((t) => ({ ...t, realizedPnlUsd: usd(t.realizedPnlUsd), volumeUsd: usd(t.volumeUsd) })), note: "Realized PnL on closed tokens in the window; past results are not a promise. Wallet addresses are exact (case matters)." },
        `${rows.length} traders`, { sources: rows.slice(0, 4).map((t) => ({ kind: "web" as const, id: EXPLORER_ADDR(t.wallet), label: `Wallet ${short(t.wallet)}`, url: EXPLORER_ADDR(t.wallet) })), addresses: rows.map((t) => t.wallet) });
    },
  },
  {
    name: "agent_backtest", via: "ext", provider: "Chord · Monad feed", label: "Backtesting the copy-trading agent", group: "bots", timeoutMs: 120_000,
    description: "Backtest a Monad copy-trading agent on real history: replay the followed wallets' trades from Chord's Monad feed (it keeps 24 h of $50+ swaps) with the agent's rules (USD per buy, mirror sells, caps). Returns PnL, win rate, trades, max drawdown, an equity curve. Run this before starting an agent.",
    parameters: { type: "object", properties: COPY_PROPS },
    async run(a) {
      const wallets = await walletsFrom(a);
      const bt = await backtest({ params: copyParams(a, wallets) as any, days: days(a.days) });
      const eq = bt.equity.slice(-60);
      return ok({ ...bt, equity: undefined, fills: bt.fills.slice(-25), pnlUsd: usd(bt.realizedUsd + bt.unrealizedUsd), returnPct: returnPct(bt.realizedUsd + bt.unrealizedUsd, bt.investedUsd), note: "A backtest replays past trades at their recorded prices; real fills pay slippage and fees and can miss fast moves. Quote returnPct as given; do not compute percentages yourself." },
        `${bt.trades} trades, PnL ${usd(bt.realizedUsd + bt.unrealizedUsd)} USD`,
        { sources: [TAPE_SOURCE, ...wallets.slice(0, 3).map((w) => ({ kind: "web" as const, id: EXPLORER_ADDR(w), label: `Wallet ${short(w)}`, url: EXPLORER_ADDR(w) }))], addresses: wallets, viz: eq.length > 1 ? [{ kind: "line", title: `Copy-trading agent backtest · ${bt.days}d`, x: eq.map((p) => hourLabel(p.ts)), series: [{ name: "PnL", values: eq.map((p) => usd(p.usd)) }], unit: "usd" }] : [] });
    },
  },
  {
    name: "agent_create", via: "ext", provider: "Agents", label: "Starting the paper agent", group: "bots",
    description: "Start a Monad agent in PAPER mode for the person (every action priced by a real Chord router quote; nothing is sent; it gets an ERC-8004 identity and every fill is committed on-chain). Either a copy-trading agent (wallets / top + the copy rules) OR a custom agent: pass `strategy` (Strategy JSON from agent_build or agent_templates) or `template_id`. Live trading is not switched on yet. Only call when the person asks to start / create / run an agent; backtest first unless they already did.",
    parameters: { type: "object", properties: { name: { type: "string" }, strategy: { type: "object", description: "custom agent: a Strategy v1 object (from agent_build / agent_templates), not a copy agent" }, template_id: { type: "string", description: "custom agent from a gallery template id (agent_templates)" }, ...COPY_PROPS } },
    async run(a, ctx) {
      mayStart(ctx);
      if (a.strategy != null || a.template_id != null) {
        const tpl = a.template_id != null ? getTemplate(String(a.template_id)) : null;
        if (a.template_id != null && !tpl) throw new ToolInputError(`unknown template_id; agent_templates lists them (${listTemplates().map((t) => t.id).join(", ")})`);
        const v = validateStrategy(a.strategy ?? tpl!.strategy);
        if (!v.ok) throw new ToolInputError(`the strategy is not valid: ${v.errors.join("; ")}`);
        let bot;
        try { bot = createBot(need(ctx), { name: a.name, type: "custom", params: { strategy: v.strategy, templateId: tpl?.id ?? null }, mode: "paper" }); }
        catch (e) { if (e instanceof BotInputError || e instanceof BotLimitError || e instanceof BotLiveError) throw new ToolInputError(e.message); throw e; }
        return ok({ bot, explanation: explainStrategy(v.strategy), open: "The Open agent button under the answer opens it in My agents: signals, fills, skips with the check that said no, PnL." }, `${bot.name} started (paper)`, { card: agentCard(bot) });
      }
      const wallets = await walletsFrom(a);
      const bot = createBot(need(ctx), { name: a.name, type: "copy", params: copyParams(a, wallets), mode: "paper" });
      return ok({ bot, open: "The Open agent button under the answer opens it in My agents: fills, positions, PnL." }, `${bot.name} started (paper)`, { addresses: wallets, card: agentCard(bot) });
    },
  },
  {
    name: "agent_list", via: "ext", provider: "Agents", label: "Reading your agents", group: "bots",
    description: "The person's agents (copy-trading, alert and custom): status, mode, PnL realized and open, trades, open positions.",
    parameters: { type: "object", properties: {} },
    async run(_a, ctx) { const b = listBots(need(ctx)); return ok({ bots: b }, `${b.length} agent${b.length === 1 ? "" : "s"}`); },
  },
  {
    name: "agent_status", via: "ext", provider: "Agents", label: "Reading the agent", group: "bots",
    description: "One of the person's agents in detail: positions, recent fills (with the followed wallet's trade behind each), skipped trades and why, events.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) {
      const b = getBot(need(ctx), String(a.id ?? ""));
      if (!b) throw new ToolInputError("no agent with that id for this person; call agent_list");
      return ok({ ...b, fills: b.fills.slice(0, 30), events: b.events.slice(0, 20) }, `${b.bot.name}: ${b.fills.length} fills`);
    },
  },
  {
    name: "agent_pause", via: "ext", provider: "Agents", label: "Pausing the agent", group: "bots",
    description: "Pause one of the person's agents (a copy-trading agent stops mirroring, a custom agent stops acting; positions stay).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) { const b = setStatus(need(ctx), String(a.id ?? ""), "paused"); if (!b) throw new ToolInputError("no agent with that id"); return ok({ bot: b }, `${b.name} paused`); },
  },
  {
    name: "agent_resume", via: "ext", provider: "Agents", label: "Resuming the agent", group: "bots",
    description: "Resume one of the person's paused agents.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) { const b = setStatus(need(ctx), String(a.id ?? ""), "running"); if (!b) throw new ToolInputError("no agent with that id"); return ok({ bot: b }, `${b.name} running`); },
  },
  {
    name: "agent_templates", via: "ext", provider: "Agents", label: "Reading the agent templates", group: "bots",
    description: "The ready-made custom agent strategies (smart-money confluence, copy trader, momentum, DCA, crash guard): id, title, what it does, how it loses money, the Strategy JSON and its plain-words explanation. Use for 'what agents can I run', 'show me templates', or as a starting point before agent_build.",
    parameters: { type: "object", properties: {} },
    async run() {
      const t = listTemplates();
      return ok({ templates: t.map((x) => ({ id: x.id, title: x.title, oneLine: x.oneLine, risk: x.risk, explanation: explainStrategy(x.strategy), strategy: x.strategy, open: `${APP}/app#agents/build/${x.id}` })) }, `${t.length} templates`,
        { sources: t.slice(0, 6).map((x) => ({ kind: "web" as const, id: `${APP}/app#agents/build/${x.id}`, label: `Template · ${x.title}`, url: `${APP}/app#agents/build/${x.id}` })) });
    },
  },
  {
    name: "agent_build", via: "ext", provider: "Agents", label: "Building the agent from your words", group: "bots", timeoutMs: 60_000,
    description: "Turn the person's description of a Monad trading agent into a validated Strategy JSON (trigger · filters · action · exits · limits) with one plain line per block, warnings and the questions still open. Never invents wallets, mints or pools: when one is needed and not given, it asks. Use for 'build / make me an agent that …' when it is NOT a plain copy of wallets (that is agent_backtest + agent_create). Then agent_backtest_strategy, then agent_create with the strategy when they ask to start.",
    parameters: { type: "object", properties: { description: { type: "string", description: "the person's own words, with any wallet / mint / pool they gave (exact case)" } }, required: ["description"] },
    async run(a) {
      let r;
      try { r = await compileStrategy(String(a.description ?? "")); }
      catch (e) { if (e instanceof StrategyInputError) throw new ToolInputError(e.errors.join("; ")); throw e; }
      return ok({ ...r, builder: "The Agents tab › Build your own shows and edits these blocks." },
        r.strategy ? `${r.strategy.name}: ${r.explanation.length} blocks${r.questions.length ? `, ${r.questions.length} open question${r.questions.length > 1 ? "s" : ""}` : ""}` : `${r.questions.length} question${r.questions.length === 1 ? "" : "s"} before a strategy can be built`);
    },
  },
  {
    name: "agent_backtest_strategy", via: "ext", provider: "Chord · Monad feed", label: "Backtesting the agent's strategy", group: "bots", timeoutMs: 120_000,
    description: "Backtest a custom agent's Strategy JSON (or a template_id) on real history over 1, 3 or 7 days: signals, trades, skips, PnL, win rate, max drawdown, an equity curve, and notes on what the history could not replay (filters that need live data). Run before agent_create with a strategy.",
    parameters: { type: "object", properties: { strategy: { type: "object" }, template_id: { type: "string" }, days: { type: "number", enum: [1, 3, 7], description: "default 3" } } },
    async run(a) {
      const tpl = a.template_id != null ? getTemplate(String(a.template_id)) : null;
      if (a.strategy == null && !tpl) throw new ToolInputError("pass strategy (from agent_build) or a template_id (agent_templates)");
      let bt;
      try { bt = await backtestStrategy(a.strategy ?? tpl!.strategy, days(a.days)); }
      catch (e) { if (e instanceof StrategyInputError) throw new ToolInputError(e.errors.join("; ")); throw e; }
      const eq = thin(bt.equity, 60);
      return ok({ ...bt, equity: undefined, fills: bt.fills.slice(-25), pnlUsd: usd(bt.realizedUsd + bt.unrealizedUsd), returnPct: returnPct(bt.realizedUsd + bt.unrealizedUsd, bt.investedUsd), note: "A backtest replays recorded trades and candles; real fills pay slippage and fees, and filters that need live data are listed in notes as not applied. Quote returnPct as given; do not compute percentages yourself." },
        `${bt.signals} signals, ${bt.trades} trades, PnL ${usd(bt.realizedUsd + bt.unrealizedUsd)} USD`,
        { sources: [TAPE_SOURCE, ...(tpl ? [{ kind: "web" as const, id: `${APP}/app#agents/build/${tpl.id}`, label: `Template · ${tpl.title}`, url: `${APP}/app#agents/build/${tpl.id}` }] : [])], viz: eq.length > 1 ? [{ kind: "line", title: `${bt.strategy} backtest · ${bt.days}d`, x: eq.map((p) => hourLabel(p.ts)), series: [{ name: "PnL", values: eq.map((p) => usd(p.usd)) }], unit: "usd" }] : [] });
    },
  },
];

export const BOT_PLAYBOOK = `PLAYBOOK — trading agents on Monad (copy traders and custom strategies, paper mode, every fill committed on-chain).
- "Who should I copy / best Monad traders" → agent_traders (days 1, 3 or 7; Chord keeps 24 h and 7 d boards).
- "Make / build / start an agent that copies …" → agent_backtest FIRST with their rules (wallets they name, or the top N), show the result, then agent_create only when they ask to start it (or asked to start in the same message). Defaults: $20 a trade, mirror sells on, safety on.
- "Build me an agent that buys when … / sells when … / alerts me when …" (anything beyond copying wallets) → agent_build with their words; show the blocks in plain words and ask the open questions; then agent_backtest_strategy; agent_create with that strategy when they ask to start. "What agents can I run / templates" → agent_templates (agent_create template_id starts one).
- "How is my agent doing / my agents" → agent_list, then agent_status for one. "Pause / stop / resume" → agent_pause / agent_resume.
- Agents run in PAPER mode: fills are priced by a real router quote on Monad (Chord's router) when the trade reaches Chord's feed; nothing is sent. Every filled fill is hashed and committed to the agent's on-chain track record (ERC-8004 identity on Monad); say so when asked how to trust a record.
- Classic and quant strategies (${CLASSIC.map((s) => s.title).join(", ")}) → classic_backtest (strategy, symbol, venue perpl by default): it replays on Binance, OKX, Hyperliquid and Perpl data side by side; report each source's return, drawdown and trades against holding, and say when the sources disagree. classic_start only when they ask to start it; classic_strategies lists the rules and parameters.
- Liquidity on Monad (which pool to LP, what range, impermanent loss, an LP agent) → lp_scan for the pools, lp_backtest for one pool (every range against holding the tokens, fees, hours in range), lp_agent_create only when they ask to start it. Say the fee estimate assumes today's TVL and a share scaled by the range's concentration.
- "How do I check / verify / trust an agent's record" → no lookup needed: every committed fill is a JSON document whose keccak-256 is chained into the agent's TrackRecord on Monad (head = keccak(previous head, fill hash)); the agent page's Track record card has Verify in your browser (re-hashes every fill and compares with the head the contract holds), the raw documents are at ${APP}/v1/trust/agents/<id>/fills (this app's own API, no key; not api.getchord.xyz), scripts/verify.ts in the repo checks it from the command line, and the validator's replay verdicts sit in the ERC-8004 Validation Registry.
Answer: a | Metric | Value | table (PnL, win rate, trades, max drawdown) or the agent's state, one line on the main risk (copying fast meme flippers, thin liquidity), and where to watch it (the Agents tab). Call them agents, not bots.
Where to watch: this app's Agents tab (left rail, chordsi.xyz/app#agents). Never send people to getchord.xyz for agents.`;
