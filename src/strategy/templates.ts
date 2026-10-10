// The template gallery: five ready Monad strategies, each a Strategy like any other
// (validated through the same schema, so every default is filled), with what the gallery shows: title, one line, the risk.
// The compiler shows them to the model as examples.
import { NATIVE_MINT } from "../bots/market";
import { parseStrategy, type Strategy } from "./schema";

export interface Template {
  id: string;
  title: string;
  /** One plain line: what the bot does. */
  oneLine: string;
  /** One plain line: how it loses money. */
  risk: string;
  strategy: Strategy;
}

const RAW: { id: string; title: string; oneLine: string; risk: string; strategy: unknown }[] = [
  {
    id: "smart-money-confluence",
    title: "Smart-money confluence",
    oneLine: "Buys $20 when 2 of the top 30 Monad smart traders buy the same token within 30 minutes.",
    risk: "Smart wallets enter first and exit first: a buy that lands after theirs can be their exit liquidity.",
    strategy: {
      version: 1, name: "Smart-money confluence",
      description: "Follow the crowd of the day's best Monad traders, only when several agree.",
      trigger: { type: "confluence", wallets: { smartTraders: { top: 30, days: 1 } }, minWallets: 2, windowMin: 30, side: "buy" },
      filters: [{ field: "liquidityUsd", op: ">=", value: 20_000 }, { safety: "not_flagged" }],
      action: { type: "buy", usd: 20 },
      exits: { takeProfitPct: 50, stopLossPct: 20, trailingPct: 20, maxHoldMin: 1440 },
      limits: { maxOpenPositions: 5, dailyBudgetUsd: 100 },
    },
  },
  {
    id: "copy-trader",
    title: "Copy trader",
    oneLine: "Mirrors the buys of the top 5 Monad smart traders (7-day board) with $10 each and sells when they sell.",
    risk: "A copy lands after the wallet's own trade: on a fast token you buy higher and sell lower than the wallet did.",
    strategy: {
      version: 1, name: "Copy trader",
      description: "The copy agent as a strategy: follow the best Monad wallets of the last 7 days.",
      trigger: { type: "wallet_trade", wallets: { smartTraders: { top: 5, days: 7 } }, side: "buy" },
      filters: [{ field: "liquidityUsd", op: ">=", value: 10_000 }, { safety: "not_flagged" }],
      action: { type: "buy", usd: 10 },
      exits: { sellWhen: "followed_sells" },
      limits: {},
    },
  },
  {
    id: "momentum",
    title: "Momentum",
    oneLine: "Buys $15 of one of Monad's most traded tokens up 8 % in an hour when buyers lead; rides it with a 10 % trailing stop.",
    risk: "Momentum buys after the move: a reversal right after the entry hits the trailing stop at a loss.",
    strategy: {
      version: 1, name: "Momentum",
      description: "Ride Monad's most traded tokens when they break out with buyers in charge.",
      trigger: { type: "price", mint: "trending", op: "change_pct", value: 8, windowMin: 60 },
      filters: [{ field: "buyShare1hPct", op: ">=", value: 55 }, { field: "liquidityUsd", op: ">=", value: 50_000 }],
      action: { type: "buy", usd: 15 },
      exits: { trailingPct: 10, maxHoldMin: 720 },
      limits: {},
    },
  },
  {
    id: "dca",
    title: "DCA",
    oneLine: "Buys $10 of MON (wrapped) every 4 hours, whatever the price; change the token to any Monad token.",
    risk: "DCA averages the entry, it does not protect it: a token that keeps falling is bought all the way down.",
    strategy: {
      version: 1, name: "MON DCA",
      description: "Dollar-cost average into one token.",
      trigger: { type: "schedule", every: "4h", mint: NATIVE_MINT },
      filters: [],
      action: { type: "buy", usd: 10 },
      // a DCA agent buys the same token again and again: the per-token cap is what it may put in over time (100 buys)
      limits: { dailyBudgetUsd: 60, maxPerTokenUsd: 1000 },
    },
  },
  {
    id: "crash-guard",
    title: "Crash guard",
    oneLine: "Sells everything of a held token that drops 15 % within 15 minutes. Run it next to a buying agent's token list.",
    risk: "A stop sells into the drop: a token that bounces right after is sold at the bottom.",
    strategy: {
      version: 1, name: "Crash guard",
      description: "Exit a held token on a sharp drop.",
      trigger: { type: "price", mint: "held", op: "change_pct", value: -15, windowMin: 15 },
      filters: [],
      action: { type: "sell", pct: 100 },
      limits: {},
    },
  },
];

export const TEMPLATES: Template[] = RAW.map((t) => ({ ...t, strategy: parseStrategy(t.strategy) }));

/** The gallery (deep copies: a caller editing one never changes the template). */
export function listTemplates(): Template[] {
  return TEMPLATES.map((t) => ({ ...t, strategy: structuredClone(t.strategy) }));
}

export function getTemplate(id: string): Template | null {
  const t = TEMPLATES.find((x) => x.id === id);
  return t ? { ...t, strategy: structuredClone(t.strategy) } : null;
}
