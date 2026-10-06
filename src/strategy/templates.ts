// The template gallery (ask2049-notes/PROMPT-bot-builder.md "Templates"): six ready strategies, each a Strategy like any other
// (validated through the same schema, so every default is filled), with what the gallery shows: title, one line, the risk.
// The compiler shows them to the model as examples.
import { SOL_MINT } from "../bots/market";
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
    oneLine: "Buys $20 when 3 of the top 20 smart traders buy the same token within 15 minutes.",
    risk: "Smart wallets enter first and exit first: a buy that lands after theirs can be their exit liquidity.",
    strategy: {
      version: 1, name: "Smart-money confluence",
      description: "Follow the crowd of the day's best Solana traders, only when several agree.",
      trigger: { type: "confluence", wallets: { smartTraders: { top: 20, days: 1 } }, minWallets: 3, windowMin: 15, side: "buy" },
      filters: [{ field: "liquidityUsd", op: ">=", value: 30_000 }, { safety: "no_mint_authority" }, { safety: "no_freeze_authority" }],
      action: { type: "buy", usd: 20 },
      exits: { takeProfitPct: 100, stopLossPct: 30, trailingPct: 25, maxHoldMin: 1440 },
      limits: { maxOpenPositions: 5, dailyBudgetUsd: 100 },
    },
  },
  {
    id: "graduation-sniper",
    title: "Graduation sniper",
    oneLine: "Buys $10 of a token right after it graduates from its bonding curve, when it already has depth and holders.",
    risk: "Most graduated tokens fade within hours; a fast stop loss is the only thing standing between you and a rug.",
    strategy: {
      version: 1, name: "Graduation sniper",
      description: "Catch bonding-curve graduations that already look like real markets.",
      trigger: { type: "new_token", source: "graduation" },
      filters: [
        { field: "liquidityUsd", op: ">=", value: 20_000 }, { field: "holders", op: ">=", value: 150 },
        { field: "top10Pct", op: "<=", value: 40 }, { field: "ageMin", op: "<=", value: 30 },
      ],
      action: { type: "buy", usd: 10 },
      exits: { takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 120 },
      limits: {},
    },
  },
  {
    id: "guardian",
    title: "Guardian",
    oneLine: "Alerts you when liquidity leaves a token you hold (withdrawals over twice the deposits in an hour). Switch the action to sell 100 % to exit instead; pair it with a price bot (change −20 % in 15 min) for crashes without an LP move.",
    risk: "An alert is not an exit: by the time liquidity has left, the price may already be down.",
    strategy: {
      version: 1, name: "Guardian",
      description: "Watch the pools of the tokens you hold for a liquidity exodus.",
      trigger: { type: "lp_event", event: "exodus" },
      filters: [],
      action: { type: "alert" },
      limits: {},
    },
  },
  {
    id: "dca",
    title: "DCA",
    oneLine: "Buys $10 of a token once a day, whatever the price (SOL here; change the mint to any token).",
    risk: "DCA averages the entry, it does not protect it: a token that keeps falling is bought all the way down.",
    strategy: {
      version: 1, name: "Daily DCA",
      description: "Dollar-cost average into one token.",
      trigger: { type: "schedule", every: "1d", mint: SOL_MINT },
      filters: [],
      action: { type: "buy", usd: 10 },
      // a DCA bot buys the same token every day: the per-token cap is what it may put in over time (100 daily buys)
      limits: { dailyBudgetUsd: 10, maxPerTokenUsd: 1000 },
    },
  },
  {
    id: "momentum",
    title: "Momentum",
    oneLine: "Buys $15 of a trending Solana token up 15 % in an hour, when buyers lead and at least 2 smart traders bought it; rides it with a 15 % trailing stop.",
    risk: "Momentum buys after the move: a reversal right after the entry hits the trailing stop at a loss.",
    strategy: {
      version: 1, name: "Momentum",
      description: "Ride trending tokens that smart money is buying.",
      trigger: { type: "price", mint: "trending", op: "change_pct", value: 15, windowMin: 60 },
      filters: [{ field: "buyShare1hPct", op: ">=", value: 60 }, { field: "smartBuyers1h", op: ">=", value: 2 }],
      action: { type: "buy", usd: 15 },
      exits: { trailingPct: 15 },
      limits: {},
    },
  },
  {
    id: "copy-trader",
    title: "Copy trader",
    oneLine: "Mirrors the buys of the top 5 smart traders (3-day board) with $10 each and sells when they sell.",
    risk: "A copy lands after the wallet's own trade: on a fast token you buy higher and sell lower than the wallet did.",
    strategy: {
      version: 1, name: "Copy trader",
      description: "The copy bot as a strategy: follow the best wallets of the last 3 days.",
      trigger: { type: "wallet_trade", wallets: { smartTraders: { top: 5, days: 3 } }, side: "buy" },
      filters: [{ field: "liquidityUsd", op: ">=", value: 20_000 }, { safety: "no_mint_authority" }, { safety: "no_freeze_authority" }],
      action: { type: "buy", usd: 10 },
      exits: { sellWhen: "followed_sells" },
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
