// Ask tools for agents as a service (the engine still calls them bots; tool names keep bot_ for now): find traders to copy,
// backtest, start a paper copy-trading agent, read and steer your agents; and the LP agent: scan Solana pools for providing
// liquidity, size a range, backtest it, start a paper LP agent. The owner is the asking session (ctx.session), the same owner
// the Agents tab and /v1/bots use. Paper mode only in phase 1.
import { ToolInputError, type Tool, type ToolResult } from "./types";
import { backtest, BotInputError, BotLimitError, BotLiveError, createBot, getBot, listBots, lpBacktest, lpCopyBacktest, lpRange, lpScan, LP_SCAN_SORTS, setStatus, smartLps, smartTraders, type LpFlag, type LpPoolScan } from "./bots";
import { money, pctText, priceText } from "./bots/lp";
import { backtestStrategy, compileStrategy, explainStrategy, getTemplate, listTemplates, StrategyInputError, validateStrategy } from "./strategy";

const SOLSCAN = (a: string) => `https://solscan.io/account/${a}`;
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const usd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const days = (v: unknown): 1 | 3 | 7 => (Number(v) === 1 ? 1 : Number(v) === 7 ? 7 : 3);
const ok = (data: unknown, summary: string, extra: Partial<ToolResult> = {}): ToolResult => ({ data, sources: [], summary, ...extra });

/** wallets given, or the top N of Chord's Solana smart-traders board. */
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
const need = (ctx?: { session?: string }) => { if (!ctx?.session) throw new ToolInputError("agents need a session"); return ctx.session; };
const COPY_PROPS = {
  wallets: { type: "array", items: { type: "string" }, description: "Solana wallets to copy (case kept). Omit to use the top traders." },
  top: { type: "number", description: "copy the top N wallets of the smart-traders board (1-10), default 3, when wallets are not given" },
  days: { type: "number", enum: [1, 3, 7], description: "window for the board and the backtest, default 3" },
  usd_per_trade: { type: "number", description: "USDC per mirrored buy, 1-1000, default 20" },
  max_per_token_usd: { type: "number" }, max_open_positions: { type: "number" }, mirror_sells: { type: "boolean" },
  min_liquidity_usd: { type: "number" }, daily_loss_stop_usd: { type: "number" },
};

// ── LP agent ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// What lp.ts reads for each call (lpData.ts): Chord's Solana LP tape (pool list, the pool's last hour of LP flows, hourly
// candles), the venue's public pool API (Meteora DLMM / DAMM v2, Raydium CLMM: TVL, volume, fee APR, bin step / tick
// spacing) and Jupiter (token safety facts in the scan, live prices in the range, a quote for the rebalance cost in the backtest).
const LP_PROVIDER = "Chord · Solana tape + Meteora / Raydium / Jupiter";
const LP_DEXES = ["meteora_dlmm", "meteora_damm_v2", "raydium_clmm", "pumpswap"];
const FLAG_TEXT: Record<LpFlag["code"], string> = {
  thin_tvl: "thin TVL", new_pool: "new pool", lp_exodus: "LP exodus", mint_authority: "live mint authority", freeze_authority: "live freeze authority",
  safety_unknown: "safety unknown", no_tvl: "no TVL", no_fee_apr: "no fee APR", short_history: "short price history",
};
const flagList = (r: Pick<LpPoolScan, "flags">) => (r.flags.length ? r.flags.map((f) => FLAG_TEXT[f.code] ?? f.code).join(", ") : "none");
const LP_PROPS = {
  pool: { type: "string", description: "Solana pool address (base58, case-sensitive), from lp_scan or sol_lp_pools" },
  amount_usd: { type: "number", description: "paper deposit in USD, 10-10000" },
  preset: { type: "string", enum: ["tight", "balanced", "wide"], description: "range from the token's volatility (1, 2 or 3 sigma over 24 h); default balanced. Not together with range_pct" },
  range_pct: { type: "number", description: "custom range, plus or minus this % around the price (1-90). Not together with preset" },
  out_of_range_minutes: { type: "number", description: "rebalance after the price has been out of range this long, 5-1440, default 30" },
  max_rebalances_per_day: { type: "number", description: "0-24, default 4; 0 = never rebalance" },
  lp_exodus: { type: "boolean", description: "exit when the pool's LPs leave (last hour's withdrawals over 2x deposits and at least $1,000), default true" },
  token_drop_pct: { type: "number", description: "exit when the token falls this % from the open, 5-95; default none" },
};
/** The engine's field names → this tool's, so an input error names the argument the model sent. */
const argNames = (m: string) => m
  .replace(/\bamountUsd\b/g, "amount_usd").replace(/\brangePct\b/g, "range_pct").replace(/\bhorizonHours\b/g, "hours")
  .replace(/\brebalance\.outOfRangeMinutes\b/g, "out_of_range_minutes").replace(/\brebalance\.maxPerDay\b/g, "max_rebalances_per_day")
  .replace(/\bexits\.lpExodus\b/g, "lp_exodus").replace(/\bexits\.tokenDropPct\b/g, "token_drop_pct").replace(/\bexits\.dailyLossStopUsd\b/g, "daily_loss_stop_usd")
  .replace(/\bminTvlUsd\b/g, "min_tvl_usd").replace(/\bmaxOpenPositions\b/g, "max_open_positions").replace(/\bminPoolTvlUsd\b/g, "min_pool_tvl_usd")
  .replace(/\bfollowRemoves\b/g, "follow_removes").replace(/\bsmartLps\.top\b/g, "top").replace(/\bsmartLps\.days\b/g, "days");
/** Engine input / limit / live errors are the caller's to fix: the model sees the plain message. */
async function lpCall<T>(run: () => T | Promise<T>): Promise<T> {
  try { return await run(); }
  catch (e) {
    if (e instanceof BotInputError || e instanceof BotLimitError || e instanceof BotLiveError) throw new ToolInputError(argNames(e.message));
    throw e;
  }
}
/** LpParams from this tool's arguments (only what was given: the engine fills the defaults and checks the rules). */
function lpParams(a: Record<string, any>) {
  const rebalance = { ...(a.out_of_range_minutes != null ? { outOfRangeMinutes: a.out_of_range_minutes } : {}), ...(a.max_rebalances_per_day != null ? { maxPerDay: a.max_rebalances_per_day } : {}) };
  const exits = {
    ...(a.lp_exodus != null ? { lpExodus: a.lp_exodus } : {}), ...(a.token_drop_pct != null ? { tokenDropPct: a.token_drop_pct } : {}),
    ...(a.daily_loss_stop_usd != null ? { dailyLossStopUsd: a.daily_loss_stop_usd } : {}),
  };
  return {
    pool: typeof a.pool === "string" ? a.pool.trim() : a.pool, amountUsd: a.amount_usd,
    ...(a.preset != null && a.preset !== "" ? { preset: a.preset } : {}), ...(a.range_pct != null ? { rangePct: a.range_pct } : {}),
    ...(Object.keys(rebalance).length ? { rebalance } : {}), ...(Object.keys(exits).length ? { exits } : {}),
  };
}
// Copy smart LPs (bot type "lp", params.mode "copy"): the board, the copy backtest, the paper copy agent.
const LP_COPY_PROPS = {
  wallets: { type: "array", items: { type: "string" }, description: "Solana LP wallets to copy (exact case), 1-10. Omit to copy the top of the smart-LP board (lp_smart)." },
  top: { type: "number", description: "copy the top N wallets of the smart-LP board, 1-10, default 3, when wallets are not given" },
  days: { type: "number", enum: [1, 3, 7], description: "window of the board and the backtest, default 3" },
  amount_usd: { type: "number", description: "paper deposit of each copied position in USD, 10-2000, default 200" },
  max_open_positions: { type: "number", description: "positions open at once (one per pool), 1-10, default 3" },
  min_pool_tvl_usd: { type: "number", description: "skip a copied add into a pool under this TVL, default 50000" },
  venues: { type: "array", items: { type: "string", enum: LP_DEXES }, description: "copy only adds on these venues (default all four)" },
  follow_removes: { type: "boolean", description: "close the copy when the wallet closes the position or takes out half of its deposit, default true" },
  lp_exodus: LP_PROPS.lp_exodus,
  token_drop_pct: { type: "number", description: "exit a copied position when its token falls this % from that open, 5-95; default none" },
};
/** LpCopyParams from this tool's arguments (only what was given, the engine fills the defaults); wallets, else the board's top N. */
function lpCopyParams(a: Record<string, any>) {
  const wallets = Array.isArray(a.wallets) ? a.wallets.map((w: unknown) => String(w).trim()).filter(Boolean) : typeof a.wallets === "string" && a.wallets.trim() ? a.wallets.trim().split(/[\s,]+/) : [];
  const exits = {
    ...(a.lp_exodus != null ? { lpExodus: a.lp_exodus } : {}), ...(a.token_drop_pct != null ? { tokenDropPct: a.token_drop_pct } : {}),
    ...(a.daily_loss_stop_usd != null ? { dailyLossStopUsd: a.daily_loss_stop_usd } : {}),
  };
  return {
    mode: "copy" as const, ...(wallets.length ? { wallets } : { smartLps: { top: a.top ?? 3, days: days(a.days) } }), amountUsd: a.amount_usd ?? 200,
    ...(a.max_open_positions != null ? { maxOpenPositions: a.max_open_positions } : {}), ...(a.min_pool_tvl_usd != null ? { minPoolTvlUsd: a.min_pool_tvl_usd } : {}),
    ...(a.venues != null ? { venues: a.venues } : {}), ...(a.follow_removes != null ? { followRemoves: a.follow_removes } : {}),
    ...(Object.keys(exits).length ? { exits } : {}),
  };
}
const holdText = (s: number | null) => (s == null ? null : s < 3600 ? `${Math.round(s / 60)} min` : s < 86_400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86_400).toFixed(1)} d`);
const TRAP_NOTE = "Every row is built ONLY on positions Chord's tape saw from their first deposit: say that number (`builtOn`) next to each wallet. Chord's own sort=pnl is a trap: a wallet whose deposit happened before the tape shows a $0 deposit and its withdrawal as profit (\"$127k realized, 100% win rate\"); `trap` lists Chord's top 5 by raw PnL and what this board made of each. Fees are what the wallets CLAIMED; past results on a tape that is days old.";

/** At most n points, evenly spaced, the last one kept. */
const thin = <T>(xs: T[], n: number): T[] => { const k = Math.ceil(xs.length / n); return k <= 1 ? xs : xs.filter((_, i) => i % k === 0 || i === xs.length - 1); };
const hourLabel = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const FEE_NOTE = "Fee income is an ESTIMATE (the pool's fee APR today applied to the hours in range), not a measured payout: say so with every fee number, and name the impermanent loss next to it.";

export const botTools: Tool[] = [
  {
    name: "agent_traders", via: "ext", provider: "Chord · Solana tape", label: "Ranking Solana smart traders", group: "bots",
    description: "Top Solana wallets by realized trading skill over 1, 3 or 7 days (Chord's smart-traders board): wallet, score, realized PnL, ROI, win rate, trades, tokens, median hold, best token. Use to pick wallets for a copy-trading agent or to answer 'who are the best Solana traders'.",
    parameters: { type: "object", properties: { days: COPY_PROPS.days, limit: { type: "number", description: "rows, default 10, max 25" } } },
    async run(a) {
      const rows = await smartTraders(days(a.days), Math.min(25, Number(a.limit) || 10));
      return ok({ days: days(a.days), traders: rows.map((t) => ({ ...t, realizedPnlUsd: usd(t.realizedPnlUsd), volumeUsd: usd(t.volumeUsd) })), note: "Realized PnL on closed tokens in the window; past results are not a promise. Wallet addresses are exact (case matters)." },
        `${rows.length} traders`, { sources: rows.slice(0, 4).map((t) => ({ kind: "web" as const, id: SOLSCAN(t.wallet), label: `Wallet ${short(t.wallet)}`, url: SOLSCAN(t.wallet) })), addresses: rows.map((t) => t.wallet) });
    },
  },
  {
    name: "agent_backtest", via: "ext", provider: "Chord · Solana tape", label: "Backtesting the copy-trading agent", group: "bots", timeoutMs: 45_000,
    description: "Backtest a Solana copy-trading agent on real history: replay the followed wallets' trades over 1/3/7 days with the agent's rules (USD per buy, mirror sells, caps). Returns PnL, win rate, trades, max drawdown, an equity curve. Run this before starting an agent.",
    parameters: { type: "object", properties: COPY_PROPS },
    async run(a) {
      const wallets = await walletsFrom(a);
      const bt = await backtest({ params: copyParams(a, wallets) as any, days: days(a.days) });
      const eq = bt.equity.slice(-60);
      return ok({ ...bt, equity: undefined, fills: bt.fills.slice(-25), note: "A backtest replays past trades at their recorded prices; real fills pay slippage and fees and can miss fast moves." },
        `${bt.trades} trades, PnL ${usd(bt.realizedUsd + bt.unrealizedUsd)} USD`,
        { addresses: wallets, viz: eq.length > 1 ? [{ kind: "line", title: `Copy-trading agent backtest · ${bt.days}d`, x: eq.map((p) => hourLabel(p.ts)), series: [{ name: "PnL", values: eq.map((p) => usd(p.usd)) }], unit: "usd" }] : [] });
    },
  },
  {
    name: "agent_create", via: "ext", provider: "Agents", label: "Starting the paper agent", group: "bots",
    description: "Start a Solana agent in PAPER mode for the person (every action priced by a real Jupiter quote; nothing is sent). Either a copy-trading agent (wallets / top + the copy rules) OR a custom agent: pass `strategy` (Strategy JSON from agent_build or agent_templates) or `template_id`. Live trading is not switched on yet. Only call when the person asks to start / create / run an agent; backtest first unless they already did.",
    parameters: { type: "object", properties: { name: { type: "string" }, strategy: { type: "object", description: "custom agent: a Strategy v1 object (from agent_build / agent_templates), not a copy agent" }, template_id: { type: "string", description: "custom agent from a gallery template id (agent_templates)" }, ...COPY_PROPS } },
    async run(a, ctx) {
      if (a.strategy != null || a.template_id != null) {
        const tpl = a.template_id != null ? getTemplate(String(a.template_id)) : null;
        if (a.template_id != null && !tpl) throw new ToolInputError(`unknown template_id; agent_templates lists them (${listTemplates().map((t) => t.id).join(", ")})`);
        const v = validateStrategy(a.strategy ?? tpl!.strategy);
        if (!v.ok) throw new ToolInputError(`the strategy is not valid: ${v.errors.join("; ")}`);
        let bot;
        try { bot = createBot(need(ctx), { name: a.name, type: "custom", params: { strategy: v.strategy, templateId: tpl?.id ?? null }, mode: "paper" }); }
        catch (e) { if (e instanceof BotInputError || e instanceof BotLimitError || e instanceof BotLiveError) throw new ToolInputError(e.message); throw e; }
        return ok({ bot, explanation: explainStrategy(v.strategy), open: "The Agents tab (left rail) shows it live: signals, fills, skips with the check that said no, PnL." }, `${bot.name} started (paper)`);
      }
      const wallets = await walletsFrom(a);
      const bot = createBot(need(ctx), { name: a.name, type: "copy", params: copyParams(a, wallets), mode: "paper" });
      return ok({ bot, open: "The Agents tab (left rail) shows it live: fills, positions, PnL." }, `${bot.name} started (paper)`, { addresses: wallets });
    },
  },
  {
    name: "agent_list", via: "ext", provider: "Agents", label: "Reading your agents", group: "bots",
    description: "The person's agents (copy-trading, alert and LP): status, mode, PnL realized and open, trades, open positions.",
    parameters: { type: "object", properties: {} },
    async run(_a, ctx) { const b = listBots(need(ctx)); return ok({ bots: b }, `${b.length} agent${b.length === 1 ? "" : "s"}`); },
  },
  {
    name: "agent_status", via: "ext", provider: "Agents", label: "Reading the agent", group: "bots",
    description: "One of the person's agents in detail: positions, recent fills (with the followed wallet's trade behind each), skipped trades and why, events. An LP agent also answers `lp`: its range, in range or not, fees (an estimate), IL and LP vs HODL; an LP copy agent answers `lp.copy`: the wallets it copies and each copied position.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) {
      const b = getBot(need(ctx), String(a.id ?? ""));
      if (!b) throw new ToolInputError("no agent with that id for this person; call agent_list");
      return ok({ ...b, fills: b.fills.slice(0, 30), events: b.events.slice(0, 20), ...(b.lp ? { lp: { state: b.lp.state, points: b.lp.points.slice(-24), ...(b.lp.copy ? { copy: b.lp.copy } : {}) } } : {}) }, `${b.bot.name}: ${b.fills.length} fills`);
    },
  },
  {
    name: "agent_pause", via: "ext", provider: "Agents", label: "Pausing the agent", group: "bots",
    description: "Pause one of the person's agents (a copy-trading agent stops mirroring; an LP agent stops rebalancing and exiting; positions stay).",
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
    description: "The ready-made custom agent strategies (smart-money confluence, graduation sniper, guardian, DCA, momentum, copy trader): id, title, what it does, how it loses money, the Strategy JSON and its plain-words explanation. Use for 'what agents can I run', 'show me templates', or as a starting point before agent_build.",
    parameters: { type: "object", properties: {} },
    async run() {
      const t = listTemplates();
      return ok({ templates: t.map((x) => ({ id: x.id, title: x.title, oneLine: x.oneLine, risk: x.risk, explanation: explainStrategy(x.strategy), strategy: x.strategy })) }, `${t.length} templates`);
    },
  },
  {
    name: "agent_build", via: "ext", provider: "Agents", label: "Building the agent from your words", group: "bots", timeoutMs: 60_000,
    description: "Turn the person's description of a Solana trading agent into a validated Strategy JSON (trigger · filters · action · exits · limits) with one plain line per block, warnings and the questions still open. Never invents wallets, mints or pools: when one is needed and not given, it asks. Use for 'build / make me an agent that …' when it is NOT a plain copy of wallets (that is agent_backtest + agent_create). Then agent_backtest_strategy, then agent_create with the strategy when they ask to start.",
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
    name: "agent_backtest_strategy", via: "ext", provider: "Chord · Solana tape", label: "Backtesting the agent's strategy", group: "bots", timeoutMs: 60_000,
    description: "Backtest a custom agent's Strategy JSON (or a template_id) on real history over 1, 3 or 7 days: signals, trades, skips, PnL, win rate, max drawdown, an equity curve, and notes on what the history could not replay (filters that need live data). Run before agent_create with a strategy.",
    parameters: { type: "object", properties: { strategy: { type: "object" }, template_id: { type: "string" }, days: { type: "number", enum: [1, 3, 7], description: "default 3" } } },
    async run(a) {
      const tpl = a.template_id != null ? getTemplate(String(a.template_id)) : null;
      if (a.strategy == null && !tpl) throw new ToolInputError("pass strategy (from agent_build) or a template_id (agent_templates)");
      let bt;
      try { bt = await backtestStrategy(a.strategy ?? tpl!.strategy, days(a.days)); }
      catch (e) { if (e instanceof StrategyInputError) throw new ToolInputError(e.errors.join("; ")); throw e; }
      const eq = thin(bt.equity, 60);
      return ok({ ...bt, equity: undefined, fills: bt.fills.slice(-25), note: "A backtest replays recorded trades and candles; real fills pay slippage and fees, and filters that need live data are listed in notes as not applied." },
        `${bt.signals} signals, ${bt.trades} trades, PnL ${usd(bt.realizedUsd + bt.unrealizedUsd)} USD`,
        { viz: eq.length > 1 ? [{ kind: "line", title: `${bt.strategy} backtest · ${bt.days}d`, x: eq.map((p) => hourLabel(p.ts)), series: [{ name: "PnL", values: eq.map((p) => usd(p.usd)) }], unit: "usd" }] : [] });
    },
  },
  {
    name: "lp_scan", via: "ext", provider: LP_PROVIDER, label: "Scanning Solana LP pools", group: "bots", timeoutMs: 60_000, untrusted: true,
    description: "Rank Solana pools for providing liquidity (Meteora DLMM / DAMM v2, Raydium CLMM, PumpSwap): Chord's most active LP pools of the last 24 h with TVL, volume, fee APR (from the venue's API), LP flows, age, volatility, token safety and a 0-100 score. Every row carries its flags (thin TVL, new pool, LP exodus, live mint or freeze authority, safety unknown, no TVL, no fee APR, short price history): SAY EACH FLAG OF A POOL BEFORE NAMING OR SUGGESTING IT. `best` is the top pool with no flag (null = every pool is flagged).",
    parameters: { type: "object", properties: {
      limit: { type: "number", description: "pools, 1-20, default 10" },
      sort: { type: "string", enum: [...LP_SCAN_SORTS], description: "which of Chord's LP pools to read first: fees (claimed, default), deposits, withdrawals, net (inflow), lps, tvl" },
      dex: { type: "string", enum: LP_DEXES, description: "only this venue" },
      min_tvl_usd: { type: "number", description: "drop pools under this TVL" },
    } },
    async run(a) {
      const s = await lpCall(() => lpScan({
        ...(a.limit != null ? { limit: Number(a.limit) } : {}), ...(a.sort ? { sort: a.sort } : {}), ...(a.dex ? { dex: String(a.dex) } : {}),
        ...(a.min_tvl_usd != null ? { minTvlUsd: Number(a.min_tvl_usd) } : {}),
      }));
      const rows = s.rows.map((r) => ({
        pool: r.pool, pair: r.pair, venue: r.venue, flags: r.flags.map((f) => ({ flag: FLAG_TEXT[f.code] ?? f.code, why: f.msg })), score: r.score,
        tvlUsd: r.tvlUsd, tvlSource: r.tvlSource, feeAprPct: r.feeAprPct, feeAprSource: r.feeAprSource, volume24hUsd: r.volume24hUsd, volumeSource: r.volumeSource, volumeTvl: r.volumeTvl,
        fees24hUsd: r.fees24hUsd, feesClaimed24hUsd: r.feesClaimed24hUsd, deposits24hUsd: r.deposits24hUsd, withdrawals24hUsd: r.withdrawals24hUsd, netFlow24hUsd: r.netFlow24hUsd,
        lps24h: r.lps24h, openPositions: r.openPositions, lastHour: r.lastHour, ageHours: r.ageHours, ageSource: r.ageSource, volatility: r.volatility, safety: r.safety,
        priceUsd: r.priceUsd, token: r.token, tokenSymbol: r.tokenSymbol, quote: r.quote, quoteSymbol: r.quoteSymbol, binStep: r.binStep, tickSpacing: r.tickSpacing,
      }));
      const best = s.rows.find((r) => r.pool === s.best) ?? null;
      const summary = `${rows.length} pool${rows.length === 1 ? "" : "s"}, ${best ? `best ${best.pair}` : "every pool flagged"}. Flags: ${s.rows.map((r) => `${r.pair} ${flagList(r)}`).join("; ") || "none"}`;
      return ok({ best: s.best, bestPair: best?.pair ?? null, windowHours: s.windowHours, rows, notes: s.notes,
        note: `Before naming any pool, say each of its flags (a pool with none says "no flags"). ${FEE_NOTE} Fee APRs of new pools fade fast.` },
        summary, {
          sources: s.rows.slice(0, 4).map((r) => ({ kind: "web" as const, id: SOLSCAN(r.pool), label: `Pool ${r.pair}`, url: SOLSCAN(r.pool) })),
          addresses: [...new Set(s.rows.flatMap((r) => [r.pool, r.token, r.quote]))],
          viz: s.rows.length ? [{
            kind: "table", title: "Solana LP pools · Chord tape + venue APIs", columns: ["Pool", "Venue", "Score", "TVL", "Fee APR", "Vol / TVL", "LPs 24h", "Net LP flow 24h", "Flags"],
            align: ["l", "l", "r", "r", "r", "r", "r", "r", "l"],
            rows: s.rows.map((r) => [r.pair, r.venue, r.score, r.tvlUsd == null ? null : money(r.tvlUsd), r.feeAprPct == null ? null : pctText(r.feeAprPct), r.volumeTvl, r.lps24h, money(r.netFlow24hUsd), flagList(r)]),
            links: s.rows.map((r) => SOLSCAN(r.pool)), linkCol: 0,
          }] : [],
        });
    },
  },
  {
    name: "lp_range", via: "ext", provider: LP_PROVIDER, label: "Sizing the LP range", group: "bots", timeoutMs: 30_000, untrusted: true,
    description: "Price ranges for providing liquidity in one Solana pool: tight / balanced / wide (1, 2, 3 sigma of the token's hourly volatility over 7 days on Chord's tape, scaled to `hours`), each with lower and upper bounds (quote per token and USD), how far down and up they reach, the share of past windows that stayed in range, and DLMM bins / CLMM ticks. Full-range venues (PumpSwap, Meteora DAMM v2) have no range to set. Price now from Jupiter.",
    parameters: { type: "object", properties: { pool: LP_PROPS.pool, hours: { type: "number", description: "horizon the range is sized for, 1-168 hours, default 24" } }, required: ["pool"] },
    async run(a) {
      const r = await lpCall(() => lpRange(typeof a.pool === "string" ? a.pool.trim() : "", a.hours != null ? Number(a.hours) : 24));
      const unit = r.dex === "meteora_dlmm" ? "Bins" : r.dex === "raydium_clmm" ? "Ticks" : null;
      const bal = r.presets.find((p) => p.preset === "balanced");
      const summary = r.fullRange ? `${r.pair}: full range (no range to set)` : bal
        ? `${r.pair} at ${priceText(r.price)}: balanced ${priceText(bal.lower)} to ${priceText(bal.upper)}${bal.expectedTimeInRangePct != null ? `, ${bal.expectedTimeInRangePct}% of past windows in range` : ""}`
        : `${r.pair}: no presets (too little price history; use range_pct)`;
      return ok({ ...r, note: "Ranges come from past volatility, not a forecast. Prices are quote per token (the pair is TOKEN-QUOTE). A tighter range earns more fees per dollar while in range and loses more to impermanent loss when the price leaves it." },
        summary, {
          sources: [{ kind: "web", id: SOLSCAN(r.pool), label: `Pool ${r.pair}`, url: SOLSCAN(r.pool) }], addresses: [r.pool, r.token, r.quote],
          viz: r.presets.length ? [{
            kind: "table", title: `Range presets · ${r.pair} · ${r.horizonHours} h`, columns: ["Preset", "Lower", "Upper", "Lower USD", "Upper USD", "Down", "Up", "Time in range", ...(unit ? [unit] : [])],
            align: ["l", "r", "r", "r", "r", "r", "r", "r", ...(unit ? ["r" as const] : [])],
            rows: r.presets.map((p) => [p.preset, priceText(p.lower), priceText(p.upper), `$${priceText(p.lowerUsd)}`, `$${priceText(p.upperUsd)}`, `−${pctText(p.downPct)}`, `+${pctText(p.upPct)}`,
              p.expectedTimeInRangePct == null ? null : `${p.expectedTimeInRangePct}%`, ...(unit ? [unit === "Bins" ? p.bins : p.ticks] : [])]),
          }] : [],
        });
    },
  },
  {
    name: "lp_backtest", via: "ext", provider: LP_PROVIDER, label: "Backtesting the LP agent", group: "bots", timeoutMs: 45_000, untrusted: true,
    description: "Backtest an LP agent on one Solana pool: replay the last 1, 3 or 7 days of hourly prices through a position with the agent's rules (range preset or range_pct, rebalance when out of range, exits on LP exodus / token drop). Returns LP vs HODL vs all in the quote token, fees (an ESTIMATE from today's fee APR), impermanent loss, time in range, rebalances and their cost, max drawdown, the fills and an equity curve. Run this before starting an LP agent.",
    parameters: { type: "object", properties: { ...LP_PROPS, days: { type: "number", enum: [1, 3, 7], description: "window, default 3" } }, required: ["pool", "amount_usd"] },
    async run(a) {
      const d = days(a.days);
      let bt;
      try { bt = await lpCall(() => lpBacktest({ ...lpParams(a), days: d })); }
      catch (e) {
        // lp.ts: fewer than 3 hourly prices in the window is a plain Error ("… nothing to replay")
        if (e instanceof ToolInputError || !/nothing to replay/.test(String((e as Error)?.message))) throw e;
        throw new ToolInputError(`History is too short to backtest: ${String((e as Error).message)}.${d < 7 ? " Try days 7, or" : " Try"} another pool from lp_scan.`);
      }
      const eq = thin(bt.equity, 120);
      const quoteSym = bt.pair.split("-").pop() || "quote";
      return ok({ ...bt, equity: undefined, equityPoints: bt.equity.length, fills: bt.fills.slice(-25),
        note: `${FEE_NOTE} ilUsd = the impermanent loss of the range held at the end against holding what it was opened with (negative = a loss); lpVsHodlUsd = the whole run against holding the first deposit. Hourly closes only: moves inside an hour, real slippage and fading launch-day APRs are not in it. Paper only.` },
        `${bt.pair} ${bt.days}d: LP ${money(bt.finalUsd)} vs HODL ${money(bt.hodlUsd)}, fees ${money(bt.feesUsd)} (estimate), IL ${money(bt.ilUsd)}, ${bt.rebalances} rebalance${bt.rebalances === 1 ? "" : "s"}`,
        {
          sources: [{ kind: "web", id: SOLSCAN(bt.pool), label: `Pool ${bt.pair}`, url: SOLSCAN(bt.pool) }], addresses: [bt.pool],
          viz: eq.length > 1 ? [{ kind: "line", title: `LP vs HODL · ${bt.pair} · ${bt.days}d`, x: eq.map((p) => hourLabel(p.ts)),
            series: [{ name: "LP", values: eq.map((p) => usd(p.usd)) }, { name: "HODL", values: eq.map((p) => usd(p.hodlUsd)) }, { name: `All in ${quoteSym}`, values: eq.map((p) => usd(p.quoteOnlyUsd)) }], unit: "usd" }] : [],
        });
    },
  },
  {
    name: "lp_agent_create", via: "ext", provider: "Agents", label: "Starting the paper LP agent", group: "bots",
    description: "Start an LP agent in PAPER mode for the person on one Solana pool: it opens a position with the range (preset or range_pct), marks it every minute at Jupiter's price, counts fees (an estimate) and IL against holding, rebalances after the price stays out of range, and exits on an LP exodus, a token drop or the daily loss stop. Nothing is sent; live LP is not switched on. Only call when the person asks to start / create / run an LP agent; scan, range and backtest first unless they already did.",
    parameters: { type: "object", properties: { name: { type: "string" }, ...LP_PROPS, daily_loss_stop_usd: { type: "number", description: "stop the agent when the day's loss passes this many USD; default none" } }, required: ["pool", "amount_usd"] },
    async run(a, ctx) {
      const owner = need(ctx);
      const bot = await lpCall(() => createBot(owner, { name: a.name, type: "lp", params: lpParams(a), mode: "paper" }));
      return ok({ agent: bot, open: "The Agents tab (left rail) shows it live: range, in range or not, fees (estimate), IL vs holding, rebalances.",
        note: "The position opens in a moment (pool, token safety, prices). If it is refused (live mint or freeze authority, a pool Chord does not know) the agent stops and its events say why: check with agent_status." },
        `${bot.name} started (paper)`, { addresses: [(bot.params as { pool: string }).pool] });
    },
  },
  {
    name: "lp_smart", via: "ext", provider: "Chord · Solana LP tape", label: "Ranking smart Solana LPs", group: "bots", timeoutMs: 60_000, untrusted: true,
    description: "The smart-LP board: Solana wallets that earn the most providing liquidity (Meteora DLMM / DAMM v2, Raydium CLMM, PumpSwap) over 1, 3 or 7 days, built only on positions Chord's tape saw from their first deposit. Each row: score, the number of positions it is built on, fee yield (claimed fees / deposits), realized ROI and win rate of closed positions, median hold, pools. Vaults, wallets that only remove (creators, migrators), launchers seeding their own pools and one-pool bets are dropped and counted. `trap` = Chord's raw top 5 by realized PnL and why each is gone. Use for 'who are the best LPs', 'copy the best LPs'.",
    parameters: { type: "object", properties: { days: LP_COPY_PROPS.days, limit: { type: "number", description: "rows, 1-20, default 10" } } },
    async run(a) {
      const b = await lpCall(() => smartLps(days(a.days), Math.min(20, Math.max(1, Number(a.limit) || 10))));
      const rows = b.rows.map((r) => ({
        wallet: r.wallet, score: r.score, builtOn: r.positions, chordPositions: r.positionsAll, closed: r.closed, open: r.open, pools: r.pools, pairs: r.pairs, venues: r.venues,
        depositedUsd: r.depositedUsd, feesClaimedUsd: r.feesUsd, feeYieldPct: r.feeYieldPct, realizedUsd: r.realizedUsd, realizedRoiPct: r.roiPct, winRate: r.winRate,
        medianHold: holdText(r.medianHoldS), positionsPerDay: r.positionsPerDay, lastMove: new Date(r.lastEventAt).toISOString().slice(0, 16).replace("T", " "),
      }));
      const t0 = b.trap[0];
      const cov = b.coverageStart != null ? ` (Chord's LP tape since ${new Date(b.coverageStart).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
      return ok({ days: b.days, windowHours: b.windowHours, coverageStart: b.coverageStart, rows, dropped: b.dropped, trap: b.trap, candidates: b.candidates, read: b.read, notes: b.notes, note: TRAP_NOTE },
        `${rows.length} smart LP${rows.length === 1 ? "" : "s"} over ${b.days} d${cov}${rows[0] ? `; top ${short(rows[0].wallet)} score ${rows[0].score} on ${rows[0].builtOn} positions` : ""}${t0 ? `. Chord's raw PnL #1 ${short(t0.wallet)}: ${t0.verdict}` : ""}`,
        {
          sources: b.rows.slice(0, 4).map((r) => ({ kind: "web" as const, id: SOLSCAN(r.wallet), label: `LP ${short(r.wallet)}`, url: SOLSCAN(r.wallet) })), addresses: b.rows.map((r) => r.wallet),
          viz: rows.length ? [{
            kind: "table", title: `Smart Solana LPs · ${b.days}d · Chord LP tape`, columns: ["Wallet", "Score", "Built on", "Fee yield", "Realized ROI", "Win rate", "Median hold", "Pools"],
            align: ["l", "r", "r", "r", "r", "r", "r", "l"],
            rows: rows.map((r) => [short(r.wallet), r.score, `${r.builtOn} positions`, `${r.feeYieldPct}%`, r.realizedRoiPct == null ? "no closes" : `${r.realizedRoiPct}%`,
              r.winRate == null ? null : `${Math.round(r.winRate * 100)}%`, r.medianHold, r.pairs.join(", ")]),
            links: rows.map((r) => SOLSCAN(r.wallet)), linkCol: 0,
          }] : [],
        });
    },
  },
  {
    name: "lp_copy_backtest", via: "ext", provider: LP_PROVIDER, label: "Backtesting the LP copy agent", group: "bots", timeoutMs: 60_000, untrusted: true,
    description: "Backtest copying Solana LP wallets (given, or the top N of the smart-LP board) over 1, 3 or 7 days: replays their LP adds and removes on Chord's 5 / 15 minute prices with the copy rules (same pool, the wallet's own range, amount per position, max open, TVL floor, venues, follow removes, LP exodus / token drop exits). Returns PnL, fees (an ESTIMATE from each pool's fee APR today), IL, every copied position, the skips with why, an equity curve and notes on what cannot be replayed. Run before lp_copy_create.",
    parameters: { type: "object", properties: LP_COPY_PROPS },
    async run(a) {
      const d = days(a.days);
      const bt = await lpCall(() => lpCopyBacktest({ ...lpCopyParams(a), days: d }));
      const eq = thin(bt.equity, 120);
      return ok({ ...bt, equity: undefined, equityPoints: bt.equity.length, fills: bt.fills.slice(-25),
        note: `${FEE_NOTE} Each copied position opens at the wallet's own range in the same pool; skips say which rule said no. Paper only; the live agent reacts within about a minute.` },
        `${bt.copied} of ${bt.entries} LP adds copied over ${bt.windowHours} h: PnL ${money(bt.pnlUsd)} on ${money(bt.investedUsd)}, fees ${money(bt.feesUsd)} (estimate), IL ${money(bt.ilUsd)}`,
        {
          sources: bt.wallets.slice(0, 4).map((w) => ({ kind: "web" as const, id: SOLSCAN(w), label: `LP ${short(w)}`, url: SOLSCAN(w) })), addresses: bt.wallets,
          viz: eq.length > 1 ? [{ kind: "line", title: `LP copy agent backtest · ${bt.days}d`, x: eq.map((p) => hourLabel(p.ts)), series: [{ name: "PnL", values: eq.map((p) => usd(p.usd)) }], unit: "usd" }] : [],
        });
    },
  },
  {
    name: "lp_copy_create", via: "ext", provider: "Agents", label: "Starting the paper LP copy agent", group: "bots",
    description: "Start an LP copy agent in PAPER mode for the person: it follows Solana LP wallets (given, or the top N of the smart-LP board at the start) every minute and mirrors their LP moves: an add in a pool it does not hold opens a paper position there with the wallet's own range (amount_usd each, at most max_open_positions), the wallet's remove or close closes it. It never rebalances on its own; LP exodus and token drop exits and the daily loss stop apply. Fees are an estimate. Nothing is sent. Only call when the person asks to start it; lp_smart and lp_copy_backtest first unless they already did.",
    parameters: { type: "object", properties: { name: { type: "string" }, ...LP_COPY_PROPS, daily_loss_stop_usd: { type: "number", description: "close every copied position and stop when the day's loss passes this many USD; default none" } } },
    async run(a, ctx) {
      const owner = need(ctx);
      const params = lpCopyParams(a);
      const bot = await lpCall(() => createBot(owner, { name: a.name, type: "lp", params, mode: "paper" }));
      return ok({ agent: bot, open: "The Agents tab (left rail) shows it live: the wallets it copies, each copied move with the wallet's transaction next to the agent's fill, fees (estimate) and IL per position.",
        note: "It copies LP adds made from now on; a wallet may not move for hours. With the smart-LP form the wallets are fixed at the start (agent_status lists them)." },
        `${bot.name} started (paper)`, { addresses: "wallets" in params ? params.wallets : [] });
    },
  },
];

export const BOT_PLAYBOOK = `PLAYBOOK — trading agents (copy traders on Solana, paper mode).
- "Who should I copy / best Solana traders" → agent_traders (days 1, 3 or 7).
- "Make / build / start an agent that copies …" → agent_backtest FIRST with their rules (wallets they name, or the top N), show the result, then agent_create only when they ask to start it (or asked to start in the same message). Defaults: $20 a trade, mirror sells on, safety on.
- "Build me an agent that buys when … / sells when … / alerts me when …" (anything beyond copying wallets) → agent_build with their words; show the blocks in plain words and ask the open questions; then agent_backtest_strategy; agent_create with that strategy when they ask to start. "What agents can I run / templates" → agent_templates (agent_create template_id starts one).
- "How is my agent doing / my agents" → agent_list, then agent_status for one. "Pause / stop / resume" → agent_pause / agent_resume.
- Agents run in PAPER mode: fills are priced by a real Jupiter quote at the moment the followed wallet trades; nothing is sent. Live trading (your own wallet signs under limits) is not switched on yet — say so if asked.
- Providing liquidity (an LP agent on a Solana pool): lp_scan (say each pool's flags) → lp_range → lp_backtest → lp_agent_create; fee income there is an ESTIMATE, name the impermanent loss, paper only.
- Copy the best LPs: lp_smart (say how many positions each row is built on) → lp_copy_backtest → lp_copy_create when they ask to start.
Answer: a | Metric | Value | table (PnL, win rate, trades, max drawdown) or the agent's state, one line on the main risk (copying fast meme flippers, thin liquidity), and where to watch it (the Agents tab). Call them agents, not bots.`;

export const LP_PLAYBOOK = `PLAYBOOK — LP agent (provide liquidity on Solana, paper mode).
- "Where should I LP / best Solana pools / pools to farm" → lp_scan (sort fees by default; dex or min_tvl_usd when they name one). Before naming ANY pool, say each of its flags (thin TVL, new pool, LP exodus, live mint or freeze authority, safety unknown, no TVL, no fee APR, short price history), or that it has none. \`best\` is the top pool with no flag; when it is null, say every pool is flagged.
- "What range / how wide" → lp_range on that pool (tight, balanced, wide from past volatility, with the share of past windows each stayed in range). PumpSwap and Meteora DAMM v2 are full range: no range to set, say so.
- "Backtest / would it have made money / LP or hold" → lp_backtest with their pool, amount and range (preset or range_pct) over 1, 3 or 7 days: LP vs HODL vs all in the quote token, fees, IL, rebalances and their cost.
- "Start / run / make an LP agent" → lp_scan, lp_range and lp_backtest FIRST (skip a step they already did in this conversation), show the result, then lp_agent_create only when they ask to start it (or asked to in the same message). Defaults: balanced range, rebalance after 30 min out of range (max 4 a day), exit on an LP exodus.
- "Copy the best LPs / smart LPs / who LPs best on Solana" → lp_smart (days 1, 3 or 7): name each wallet with the number of positions its row is built on, and say why Chord's raw PnL ranking is a trap (deposits from before the tape count as profit; \`trap\` shows Chord's top 5 and what became of each). Then lp_copy_backtest (their wallets, or the top N), show PnL, estimated fees, IL and the skips, then lp_copy_create only when they ask to start. Defaults: $200 a position, at most 3 open, pools with $50,000 TVL or more, removes followed. The copy never rebalances on its own: it moves when the wallet moves.
- "How is my LP agent doing / pause / resume" → agent_list, then agent_status (range, in range or not, fees, IL, LP vs HODL); agent_pause / agent_resume.
- Who is LPing a Solana pool, flows in or out, a wallet's Solana LP positions, the leading Solana LPs → sol_lp_pools, sol_lp_pool, sol_lp_wallet, sol_lp_top (Chord's own tape: CLAIMED fees only).
- Rules: fee income is an ESTIMATE (the pool's fee APR today × the time in range): say "estimated" with every fee number. Name the impermanent loss in dollars next to the fees, and compare with simply holding. PAPER mode only: priced by Jupiter and Chord, nothing is sent; live LP is not switched on, say so if asked.
Answer: the scan table with every pool's flags, or a | Metric | Value | table (LP vs HODL, estimated fees, IL, time in range, rebalances), one line on the main risk (IL on a falling token, thin pools, launch-day APRs that fade), and where to watch it (the Agents tab). Call it an agent, not a bot.
On Arc, Robinhood Chain and Monad, and for yields elsewhere, the playbook below applies (Chord's lp_* tools are those chains, not Solana).`;
