// A strategy in plain words, one line per block (Trigger · Filters · Action · Exits · Limits). Deterministic: no model, the
// same strategy always reads the same, so the page, Ask and the compiler's answer agree.
import { KNOWN_TOKENS } from "../monad/chain";
import { isFieldFilter, type Filter, type FilterField, type SafetyCheck, type Strategy, type Wallets } from "./schema";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tokenName = (mint: string) => KNOWN_TOKENS[mint.toLowerCase()]?.symbol ?? short(mint);
export function money(n: number): string {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M` : a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}$${s}`;
}
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
export function duration(min: number): string {
  if (min < 60) return `${num(min)} min`;
  if (min < 1440) return `${num(min / 60)} h`;
  return `${num(min / 1440)} day${min === 1440 ? "" : "s"}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function walletsText(w: Wallets): string {
  if ("list" in w) return w.list.length === 1 ? `wallet ${short(w.list[0])}` : `${w.list.length} followed wallets`;
  const d = w.smartTraders.days;
  return `the top ${w.smartTraders.top} smart traders (${d === 1 ? "1-day" : `${d}-day`} board)`;
}

export const FIELD_LABEL: Record<FilterField, string> = {
  liquidityUsd: "liquidity", marketCapUsd: "market cap", fdvUsd: "FDV", volume24hUsd: "24 h volume", ageMin: "age", holders: "holders",
  top10Pct: "top-10 holders' share", priceChange5mPct: "5 min price change", priceChange1hPct: "1 h price change", priceChange24hPct: "24 h price change",
  organicScore: "organic score", buyShare1hPct: "buy share over the last hour", smartBuyers1h: "smart traders buying in the last hour",
};
export const SAFETY_LABEL: Record<SafetyCheck, string> = {
  no_mint_authority: "no mint authority", no_freeze_authority: "no freeze authority", verified: "on Chord's verified Monad list", not_flagged: "no transfer tax and sellable",
};

/** A field's value as the person reads it ($ for USD fields, % for percentages, minutes for age). */
export function fieldValue(field: FilterField, v: number): string {
  if (field.endsWith("Usd")) return money(v);
  if (field.endsWith("Pct")) return `${v > 0 && field.startsWith("priceChange") ? "+" : ""}${num(v)} %`;
  if (field === "ageMin") return duration(v);
  return num(v);
}

export function filterText(f: Filter): string {
  if (!isFieldFilter(f)) return SAFETY_LABEL[f.safety];
  const label = FIELD_LABEL[f.field];
  if (f.op === "between" && Array.isArray(f.value)) return `${label} between ${fieldValue(f.field, f.value[0])} and ${fieldValue(f.field, f.value[1])}`;
  const v = fieldValue(f.field, f.value as number);
  if (f.field === "ageMin") return f.op === ">=" ? `at least ${v} old` : f.op === ">" ? `older than ${v}` : f.op === "<=" ? `at most ${v} old` : `younger than ${v}`;
  const op = f.op === ">=" ? "at least" : f.op === ">" ? "above" : f.op === "<=" ? "at most" : "below";
  return `${label} ${op} ${v}`;
}

function triggerLine(s: Strategy): string {
  const t = s.trigger;
  switch (t.type) {
    case "wallet_trade": {
      const side = t.side === "any" ? "trades" : t.side === "buy" ? "buys" : "sells";
      const who = walletsText(t.wallets);
      const many = !("list" in t.wallets && t.wallets.list.length === 1);
      return `Trigger: when ${many ? `any of ${who}` : who} ${side} a token${t.minUsd ? ` for ${money(t.minUsd)} or more` : ""}.`;
    }
    case "confluence":
      return `Trigger: when ${t.minWallets} or more of ${walletsText(t.wallets)} ${t.side} the same token within ${duration(t.windowMin)} (once per token per window).`;
    case "new_token":
      return t.source === "launch" ? "Trigger: when a new Solana token starts trading (a pump.fun or launchpad launch)."
        : t.source === "graduation" ? "Trigger: when a Solana token graduates from its bonding curve to a real pool."
          : "Trigger: when a new Solana token launches or graduates from its bonding curve.";
    case "price": {
      const what = t.mint === "trending" ? "one of Monad's most traded tokens on Chord" : t.mint === "held" ? "a token you hold" : tokenName(t.mint);
      if (t.op === "change_pct") return `Trigger: when ${what} moves ${t.value > 0 ? "up" : "down"} ${num(Math.abs(t.value))} % or more within ${duration(t.windowMin ?? 60)}.`;
      return `Trigger: when ${what} trades ${t.op} ${money(t.value)}.`;
    }
    case "schedule": {
      const every = { "15m": "every 15 minutes", "1h": "every hour", "4h": "every 4 hours", "1d": "once a day", "1w": "once a week" }[t.every];
      return `Trigger: ${every}, on ${tokenName(t.mint)} (the first run right away).`;
    }
    case "lp_event": {
      const targets = [
        t.pools?.length ? plural(t.pools.length, "pool") : "",
        t.mints?.length ? (t.mints.length === 1 ? tokenName(t.mints[0]) : plural(t.mints.length, "token")) : "",
      ].filter(Boolean);
      const where = targets.length ? join(targets) : "the tokens you hold";
      const min = t.minUsd ?? 0;
      if (t.event === "exodus") return `Trigger: when liquidity leaves ${where}: withdrawals over twice the deposits within an hour${min ? ` (at least ${money(min)} withdrawn)` : ""}.`;
      return `Trigger: when someone ${t.event === "large_remove" ? "removes" : "adds"} ${money(min)} or more of liquidity in ${where}.`;
    }
  }
}

function actionLine(s: Strategy): string {
  const a = s.action;
  switch (a.type) {
    case "buy": return `Action: paper-buy ${money(a.usd)} of the token at a real router quote on Monad (paper mode: nothing is sent; the fill is committed on-chain).`;
    case "sell": return `Action: paper-sell ${num(a.pct)} % of the bot's position in the token (nothing when it holds none).`;
    case "alert": return "Action: alert you (an event on the bot's page), no trade.";
    case "webhook": return `Action: POST the event to ${(() => { try { return new URL(a.url).host; } catch { return "your webhook"; } })()} (https, at most 20 a minute), no trade.`;
  }
}

function exitsLine(s: Strategy): string {
  if (s.action.type !== "buy") return "Exits: none (this bot does not open positions).";
  const e = s.exits ?? {};
  const parts: string[] = [];
  if (e.takeProfitPct != null) parts.push(`take profit at +${num(e.takeProfitPct)} %`);
  if (e.stopLossPct != null) parts.push(`stop loss at −${num(e.stopLossPct)} %`);
  if (e.trailingPct != null) parts.push(`trailing stop ${num(e.trailingPct)} % below the peak`);
  if (e.maxHoldMin != null) parts.push(`sell after ${duration(e.maxHoldMin)} at most`);
  if (e.sellWhen === "followed_sells") parts.push("sell when a followed wallet sells the token");
  return parts.length ? `Exits: ${join(parts)}; each exit sells the whole position.` : "Exits: none: positions are held until you sell (they are marked at the live price).";
}

function limitsLine(s: Strategy): string {
  const l = s.limits;
  if (s.action.type === "buy") {
    return `Limits: at most ${plural(l.maxOpenPositions, "open position")}, ${money(l.maxPerTokenUsd)} per token, ${money(l.dailyBudgetUsd)} a day, ${plural(l.maxTradesPerDay, "trade")} a day, ${l.cooldownMin ? `${duration(l.cooldownMin)} before acting on the same token again` : "no cooldown"}.`;
  }
  if (s.action.type === "sell") return `Limits: ${plural(l.maxTradesPerDay, "trade")} a day, ${l.cooldownMin ? `${duration(l.cooldownMin)} before acting on the same token again` : "no cooldown"}.`;
  return `Limits: ${l.cooldownMin ? `${duration(l.cooldownMin)} before alerting on the same token again` : "no cooldown"}, at most 30 alerts a minute.`;
}

/** One plain line per block: Trigger, Filters, Action, Exits, Limits. */
export function explainStrategy(s: Strategy): string[] {
  const filters = s.filters.length ? `Filters: only when ${join(s.filters.map(filterText))}; a token whose value is unknown is skipped.` : "Filters: none: every trigger acts.";
  return [triggerLine(s), filters, actionLine(s), exitsLine(s), limitsLine(s)];
}
