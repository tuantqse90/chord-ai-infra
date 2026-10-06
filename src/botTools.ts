// Ask tools for bots as a service: find traders to copy, backtest, start a paper bot, read and steer your bots. The owner is
// the asking session (ctx.session), the same owner the Bots tab and /v1/bots use. Paper mode only in phase 1.
import { ToolInputError, type Tool, type ToolResult } from "./types";
import { backtest, createBot, getBot, listBots, setStatus, smartTraders } from "./bots";

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
const need = (ctx?: { session?: string }) => { if (!ctx?.session) throw new ToolInputError("bots need a session"); return ctx.session; };
const COPY_PROPS = {
  wallets: { type: "array", items: { type: "string" }, description: "Solana wallets to copy (case kept). Omit to use the top traders." },
  top: { type: "number", description: "copy the top N wallets of the smart-traders board (1-10), default 3, when wallets are not given" },
  days: { type: "number", enum: [1, 3, 7], description: "window for the board and the backtest, default 3" },
  usd_per_trade: { type: "number", description: "USDC per mirrored buy, 1-1000, default 20" },
  max_per_token_usd: { type: "number" }, max_open_positions: { type: "number" }, mirror_sells: { type: "boolean" },
  min_liquidity_usd: { type: "number" }, daily_loss_stop_usd: { type: "number" },
};

export const botTools: Tool[] = [
  {
    name: "bot_traders", via: "ext", provider: "Chord · Solana tape", label: "Ranking Solana smart traders", group: "bots",
    description: "Top Solana wallets by realized trading skill over 1, 3 or 7 days (Chord's smart-traders board): wallet, score, realized PnL, ROI, win rate, trades, tokens, median hold, best token. Use to pick wallets for a copy bot or to answer 'who are the best Solana traders'.",
    parameters: { type: "object", properties: { days: COPY_PROPS.days, limit: { type: "number", description: "rows, default 10, max 25" } } },
    async run(a) {
      const rows = await smartTraders(days(a.days), Math.min(25, Number(a.limit) || 10));
      return ok({ days: days(a.days), traders: rows.map((t) => ({ ...t, realizedPnlUsd: usd(t.realizedPnlUsd), volumeUsd: usd(t.volumeUsd) })), note: "Realized PnL on closed tokens in the window; past results are not a promise. Wallet addresses are exact (case matters)." },
        `${rows.length} traders`, { sources: rows.slice(0, 4).map((t) => ({ kind: "web" as const, id: SOLSCAN(t.wallet), label: `Wallet ${short(t.wallet)}`, url: SOLSCAN(t.wallet) })), addresses: rows.map((t) => t.wallet) });
    },
  },
  {
    name: "bot_backtest", via: "ext", provider: "Chord · Solana tape", label: "Backtesting the copy bot", group: "bots", timeoutMs: 45_000,
    description: "Backtest a Solana copy-trading bot on real history: replay the followed wallets' trades over 1/3/7 days with the bot's rules (USD per buy, mirror sells, caps). Returns PnL, win rate, trades, max drawdown, an equity curve. Run this before starting a bot.",
    parameters: { type: "object", properties: COPY_PROPS },
    async run(a) {
      const wallets = await walletsFrom(a);
      const bt = await backtest({ params: copyParams(a, wallets) as any, days: days(a.days) });
      const eq = bt.equity.slice(-60);
      return ok({ ...bt, equity: undefined, fills: bt.fills.slice(-25), note: "A backtest replays past trades at their recorded prices; real fills pay slippage and fees and can miss fast moves." },
        `${bt.trades} trades, PnL ${usd(bt.realizedUsd + bt.unrealizedUsd)} USD`,
        { addresses: wallets, viz: eq.length > 1 ? [{ kind: "line", title: `Copy bot backtest · ${bt.days}d`, x: eq.map((p) => new Date(p.ts).toISOString().slice(5, 16).replace("T", " ")), series: [{ name: "PnL", values: eq.map((p) => usd(p.usd)) }], unit: "usd" }] : [] });
    },
  },
  {
    name: "bot_create", via: "ext", provider: "Bots", label: "Starting the paper bot", group: "bots",
    description: "Start a Solana copy-trading bot in PAPER mode for the person (fills priced by a real Jupiter quote when a followed wallet trades; nothing is sent). Live trading is not switched on yet. Only call when the person asks to start / create / run a bot; backtest first unless they already did.",
    parameters: { type: "object", properties: { name: { type: "string" }, ...COPY_PROPS } },
    async run(a, ctx) {
      const wallets = await walletsFrom(a);
      const bot = createBot(need(ctx), { name: a.name, type: "copy", params: copyParams(a, wallets), mode: "paper" });
      return ok({ bot, open: "The Bots tab (left rail) shows it live: fills, positions, PnL." }, `${bot.name} started (paper)`, { addresses: wallets });
    },
  },
  {
    name: "bot_list", via: "ext", provider: "Bots", label: "Reading your bots", group: "bots",
    description: "The person's bots: status, mode, PnL realized and open, trades, open positions.",
    parameters: { type: "object", properties: {} },
    async run(_a, ctx) { const b = listBots(need(ctx)); return ok({ bots: b }, `${b.length} bot${b.length === 1 ? "" : "s"}`); },
  },
  {
    name: "bot_status", via: "ext", provider: "Bots", label: "Reading the bot", group: "bots",
    description: "One of the person's bots in detail: positions, recent fills (with the followed wallet's trade behind each), skipped trades and why, events.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) {
      const b = getBot(need(ctx), String(a.id ?? ""));
      if (!b) throw new ToolInputError("no bot with that id for this person; call bot_list");
      return ok({ ...b, fills: b.fills.slice(0, 30), events: b.events.slice(0, 20) }, `${b.bot.name}: ${b.fills.length} fills`);
    },
  },
  {
    name: "bot_pause", via: "ext", provider: "Bots", label: "Pausing the bot", group: "bots",
    description: "Pause one of the person's bots (it stops mirroring; positions stay).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) { const b = setStatus(need(ctx), String(a.id ?? ""), "paused"); if (!b) throw new ToolInputError("no bot with that id"); return ok({ bot: b }, `${b.name} paused`); },
  },
  {
    name: "bot_resume", via: "ext", provider: "Bots", label: "Resuming the bot", group: "bots",
    description: "Resume one of the person's paused bots.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async run(a, ctx) { const b = setStatus(need(ctx), String(a.id ?? ""), "running"); if (!b) throw new ToolInputError("no bot with that id"); return ok({ bot: b }, `${b.name} running`); },
  },
];

export const BOT_PLAYBOOK = `PLAYBOOK — trading bots (copy traders on Solana, paper mode).
- "Who should I copy / best Solana traders" → bot_traders (days 1, 3 or 7).
- "Make / build / start a bot that copies …" → bot_backtest FIRST with their rules (wallets they name, or the top N), show the result, then bot_create only when they ask to start it (or asked to start in the same message). Defaults: $20 a trade, mirror sells on, safety on.
- "How is my bot doing / my bots" → bot_list, then bot_status for one. "Pause / stop / resume" → bot_pause / bot_resume.
- Bots run in PAPER mode: fills are priced by a real Jupiter quote at the moment the followed wallet trades; nothing is sent. Live trading (your own wallet signs under limits) is not switched on yet — say so if asked.
Answer: a | Metric | Value | table (PnL, win rate, trades, max drawdown) or the bot's state, one line on the main risk (copying fast meme flippers, thin liquidity), and where to watch it (the Bots tab).`;
