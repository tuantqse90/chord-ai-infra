import { describe, expect, it } from "bun:test";
import { addr } from "../bots/_testkit";
import { explainStrategy, filterText } from "./explain";
import { FILTER_FIELDS, MONAD_UNAVAILABLE, parseStrategy, SAFETY_CHECKS, StrategyInputError, TRIGGER_TYPES, validateStrategy, type Strategy } from "./schema";
import { SYSTEM_PROMPT } from "./compile";
import { getTemplate, listTemplates, TEMPLATES } from "./templates";

const W1 = addr(11), W2 = addr(12), M1 = addr(21), P1 = addr(31);
const base = { name: "t", trigger: { type: "schedule", every: "1h", mint: M1 }, action: { type: "alert" } };
const MONAD_FIELDS = FILTER_FIELDS.filter((f) => !MONAD_UNAVAILABLE.fields[f]);
const errs = (input: unknown) => { const r = validateStrategy(input); if (r.ok) throw new Error("expected errors"); return r.errors; };

describe("schema: valid strategies and defaults", () => {
  it("fills every default and lower-cases addresses", () => {
    const r = validateStrategy({ trigger: { type: "wallet_trade", wallets: { list: [` ${W1.toUpperCase().replace("0X", "0x")} `, W1, W2] } }, action: { type: "buy", usd: "25" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.strategy;
    expect(s.version).toBe(1);
    expect(s.name).toBe("Wallet trade bot");
    expect(s.trigger).toEqual({ type: "wallet_trade", wallets: { list: [W1, W2] }, side: "buy", minUsd: 0 });
    expect(s.filters).toEqual([]);
    expect(s.action).toEqual({ type: "buy", usd: 25 });
    expect(s.limits).toEqual({ maxOpenPositions: 5, maxPerTokenUsd: 75, dailyBudgetUsd: 100, cooldownMin: 10, maxTradesPerDay: 20 });
    expect(s.trigger).toMatchObject({ wallets: { list: [W1.toLowerCase(), W2] } });
  });

  it("defaults per trigger: change_pct window 60, confluence side buy", () => {
    const p = parseStrategy({ ...base, trigger: { type: "price", mint: M1, op: "change_pct", value: -20 } });
    expect(p.trigger).toMatchObject({ windowMin: 60 });
    expect(parseStrategy({ ...base, trigger: { type: "confluence", wallets: { smartTraders: { top: 5, days: 3 } }, minWallets: 2, windowMin: 30 } }).trigger).toMatchObject({ side: "buy" });
    expect(parseStrategy(base).trigger).toEqual({ type: "schedule", every: "1h", mint: M1 });
    // not a buy: the per-token cap is not used
    expect(parseStrategy(base).limits.maxPerTokenUsd).toBe(0);
    expect(parseStrategy({ ...base, trigger: { type: "price", mint: "trending", op: "above", value: 1 } }).trigger).toMatchObject({ mint: "trending" });
  });

  it("accepts between pairs, numeric strings and every filter field Monad backs", () => {
    const filters = MONAD_FIELDS.map((field) => ({ field, op: "between", value: ["1", 5] }));
    const s = parseStrategy({ ...base, filters: [...filters, { safety: "verified" }] });
    expect(s.filters[0]).toEqual({ field: "liquidityUsd", op: "between", value: [1, 5] });
    expect(s.filters.at(-1)).toEqual({ safety: "verified" });
  });

  it("what Monad's data cannot back is refused with the reason, not run as a trigger that never fires", () => {
    expect(errs({ ...base, trigger: { type: "new_token" } })[0]).toMatch(/^Trigger › new_token: not available on Monad/);
    expect(errs({ ...base, trigger: { type: "lp_event", event: "exodus" } })[0]).toMatch(/^Trigger › lp_event: not available on Monad/);
    expect(errs({ ...base, filters: [{ field: "marketCapUsd", op: ">", value: 1 }] })).toEqual(["Filters › marketCapUsd: not available on Monad (Chord has no market cap for Monad tokens)"]);
    expect(errs({ ...base, filters: [{ safety: "no_mint_authority" }] })[0]).toMatch(/^Filters › safety no_mint_authority: not available on Monad .*use verified or not_flagged$/);
  });
});

describe("schema: every error names the block and the field", () => {
  it("filters", () => {
    expect(errs({ ...base, filters: [{ field: "liquidityUsd", op: ">=", value: "lots" }] })).toEqual(["Filters › liquidityUsd: value must be a number"]);
    expect(errs({ ...base, filters: [{ field: "liquidityUsd", op: ">=" }] })).toEqual(["Filters › liquidityUsd: value is required"]);
    expect(errs({ ...base, filters: [{ field: "foo", op: ">", value: 1 }] })[0]).toMatch(/^Filters › foo: field must be one of liquidityUsd, /);
    expect(errs({ ...base, filters: [{ field: "holders", op: "≈", value: 1 }] })[0]).toBe("Filters › holders: op must be one of >, >=, <, <=, between");
    expect(errs({ ...base, filters: [{ field: "holders", op: "between", value: 5 }] })).toEqual(['Filters › holders: value must be a pair [low, high] for "between"']);
    expect(errs({ ...base, filters: [{ field: "holders", op: "between", value: [9, 5] }] })).toEqual(["Filters › holders: value low must not be above high"]);
    expect(errs({ ...base, filters: [{ field: "holders", op: ">", value: [1, 2] }] })).toEqual(['Filters › holders: value must be a number for ">" (a pair only goes with "between")']);
    expect(errs({ ...base, filters: [{ safety: "rugproof" }] })[0]).toBe("Filters › safety rugproof: safety must be one of no_mint_authority, no_freeze_authority, verified, not_flagged");
    expect(errs({ ...base, filters: [{ op: ">", value: 1 }] })).toEqual(["Filters › filter 1: field is required"]);
    expect(errs({ ...base, filters: [{ field: "holders", op: ">", value: 1, extra: true }] })).toEqual(['Filters › holders: unknown field "extra"']);
    expect(errs({ ...base, filters: Array.from({ length: 13 }, () => ({ safety: "verified" })) })).toEqual(["Filters: takes at most 12 items"]);
  });

  it("trigger", () => {
    expect(errs({ ...base, trigger: { type: "nope" } })).toEqual(["Trigger › type: must be one of " + TRIGGER_TYPES.join(", ")]);
    expect(errs({ ...base, trigger: undefined })).toEqual(["Trigger: is required"]);
    expect(errs({ ...base, trigger: { type: "wallet_trade", wallets: { list: [W1, "0xabc"] } } })).toEqual(["Trigger › wallets.list[1]: must be a Monad address (0x + 40 hex characters)"]);
    expect(errs({ ...base, trigger: { type: "wallet_trade", wallets: { list: [] } } })).toEqual(["Trigger › wallets.list: needs at least 1 item"]);
    expect(errs({ ...base, trigger: { type: "wallet_trade", wallets: { list: Array.from({ length: 11 }, (_, i) => addr(100 + i)) } } })).toEqual(["Trigger › wallets.list: takes at most 10 items"]);
    expect(errs({ ...base, trigger: { type: "wallet_trade", wallets: "smart money" } })[0]).toMatch(/^Trigger › wallets: must be \{ "list"/);
    expect(errs({ ...base, trigger: { type: "wallet_trade" } })).toEqual(["Trigger › wallets: is required"]);
    expect(errs({ ...base, trigger: { type: "confluence", wallets: { smartTraders: { top: 60, days: 2 } }, minWallets: 3, windowMin: 15 } }))
      .toEqual(["Trigger › wallets.smartTraders.top: must be at most 50", "Trigger › wallets.smartTraders.days: must be 1, 3 or 7"]);
    expect(errs({ ...base, trigger: { type: "confluence", wallets: { list: [W1, W2] }, minWallets: 3, windowMin: 15 } })).toEqual(["Trigger › minWallets: 3 wallets needed but only 2 are followed"]);
    expect(errs({ ...base, trigger: { type: "confluence", wallets: { list: [W1, W2] }, minWallets: 2.5, windowMin: 500 } })).toEqual(["Trigger › minWallets: must be a whole number", "Trigger › windowMin: must be at most 240"]);
    expect(errs({ ...base, trigger: { type: "price", mint: "BONK", op: "above", value: 1 } })).toEqual(['Trigger › mint: must be a Monad token address, "trending" or "held"']);
    expect(errs({ ...base, trigger: { type: "price", mint: M1, op: "below", value: 0 } })).toEqual(['Trigger › value: must be a USD price above 0 for "below"']);
    expect(errs({ ...base, trigger: { type: "price", mint: M1, op: "change_pct", value: 0 } })[0]).toMatch(/^Trigger › value: must not be 0 for change_pct/);
    expect(errs({ ...base, trigger: { type: "schedule", every: "2d", mint: M1 } })).toEqual(["Trigger › every: must be one of 15m, 1h, 4h, 1d, 1w"]);
    expect(errs({ ...base, trigger: { type: "lp_event", event: "rug" } })).toEqual(["Trigger › event: must be one of exodus, large_remove, large_add"]);
    expect(errs({ ...base, trigger: { type: "new_token", sauce: 1 } })).toEqual(['Trigger: unknown field "sauce" (takes type, source)']);
  });

  it("action, exits, limits and the strategy itself", () => {
    expect(errs({ ...base, action: { type: "buy" } })).toEqual(["Action › usd: is required"]);
    expect(errs({ ...base, action: { type: "buy", usd: 5000 } })).toEqual(["Action › usd: must be at most 1000"]);
    expect(errs({ ...base, action: { type: "sell", pct: 0 } })).toEqual(["Action › pct: must be at least 1"]);
    expect(errs({ ...base, action: { type: "webhook", url: "http://example.com/x" } })).toEqual(["Action › url: must be a public https URL (no http, no private or internal hosts, default port)"]);
    expect(errs({ ...base, action: { type: "webhook", url: "https://127.0.0.1/x" } })[0]).toMatch(/^Action › url: must be a public https URL/);
    expect(errs({ ...base, action: { type: "trade" } })).toEqual(["Action › type: must be one of buy, sell, alert, webhook"]);
    expect(errs({ ...base, exits: { takeProfit: 50 } })).toEqual(['Exits: unknown field "takeProfit" (takes takeProfitPct, stopLossPct, trailingPct, maxHoldMin, sellWhen)']);
    expect(errs({ ...base, exits: { stopLossPct: 100 } })).toEqual(["Exits › stopLossPct: must be at most 99"]);
    expect(errs({ ...base, exits: { sellWhen: "followed_sells" } })).toEqual(["Exits › sellWhen: followed_sells needs a wallet_trade or confluence trigger (wallets to follow)"]);
    expect(errs({ ...base, limits: { dailyBudgetUsd: "x" } })).toEqual(["Limits › dailyBudgetUsd: must be a number"]);
    expect(errs({ ...base, limits: { maxOpenPositions: 0 } })).toEqual(["Limits › maxOpenPositions: must be at least 1"]);
    expect(errs({ ...base, action: { type: "buy", usd: 50 }, limits: { dailyBudgetUsd: 10, maxPerTokenUsd: 20 } })).toEqual([
      "Limits › maxPerTokenUsd: must be at least the buy size ($50)", "Limits › dailyBudgetUsd: must be at least the buy size ($50), or the bot can never buy",
    ]);
    expect(errs({ ...base, version: 2 })).toEqual(["Strategy › version: must be 1"]);
    expect(errs({ ...base, name: "x".repeat(61) })).toEqual(["Strategy › name: must be at most 60 characters"]);
    expect(errs({ ...base, id: "abc" })[0]).toMatch(/^Strategy: unknown field "id" \(takes version, name/);
    expect(validateStrategy("nope")).toEqual({ ok: false, errors: ["Strategy: must be a JSON object"] });
    expect(() => parseStrategy({ ...base, action: { type: "buy" } })).toThrow(StrategyInputError);
  });
});

describe("templates", () => {
  it("every template validates and round-trips through the schema unchanged", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["smart-money-confluence", "copy-trader", "momentum", "dca", "crash-guard"]);
    for (const t of TEMPLATES) {
      expect(t.title && t.oneLine && t.risk).toBeTruthy();
      const r = validateStrategy(t.strategy);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.strategy).toEqual(t.strategy);
    }
  });

  it("matches the gallery's numbers", () => {
    const c = getTemplate("smart-money-confluence")!.strategy;
    expect(c.trigger).toEqual({ type: "confluence", wallets: { smartTraders: { top: 30, days: 1 } }, minWallets: 2, windowMin: 30, side: "buy" });
    expect(c.exits).toEqual({ takeProfitPct: 50, stopLossPct: 20, trailingPct: 20, maxHoldMin: 1440 });
    expect(c.limits).toMatchObject({ maxOpenPositions: 5, dailyBudgetUsd: 100 });
    expect(getTemplate("dca")!.strategy.trigger).toMatchObject({ type: "schedule", every: "4h", mint: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" });
    expect(getTemplate("momentum")!.strategy.trigger).toMatchObject({ type: "price", mint: "trending", op: "change_pct", value: 8, windowMin: 60 });
    expect(getTemplate("copy-trader")!.strategy.exits).toEqual({ sellWhen: "followed_sells" });
    // copies: editing one never changes the gallery
    const t = listTemplates()[0];
    (t.strategy.action as any).usd = 999;
    expect((getTemplate(t.id)!.strategy.action as any).usd).toBe(20);
    expect(getTemplate("nope")).toBeNull();
  });

  it("the compiler's prompt names every trigger type, filter field and safety check Monad backs, and every template", () => {
    const ok = (x: string) => !MONAD_UNAVAILABLE.triggers[x] && !MONAD_UNAVAILABLE.fields[x] && !MONAD_UNAVAILABLE.safety[x];
    for (const x of [...TRIGGER_TYPES, ...FILTER_FIELDS, ...SAFETY_CHECKS].filter(ok)) expect(SYSTEM_PROMPT).toContain(`"${x}"`);
    for (const t of TEMPLATES) expect(SYSTEM_PROMPT).toContain(t.title);
  });
});

describe("explain", () => {
  it("one plain line per block", () => {
    const s = getTemplate("smart-money-confluence")!.strategy;
    expect(explainStrategy(s)).toEqual([
      "Trigger: when 2 or more of the top 30 smart traders (1-day board) buy the same token within 30 min (once per token per window).",
      "Filters: only when liquidity at least $20,000 and no transfer tax and sellable; a token whose value is unknown is skipped.",
      "Action: paper-buy $20 of the token at a real router quote on Monad (paper mode: nothing is sent; the fill is committed on-chain).",
      "Exits: take profit at +50 %, stop loss at −20 %, trailing stop 20 % below the peak and sell after 1 day at most; each exit sells the whole position.",
      "Limits: at most 5 open positions, $60 per token, $100 a day, 20 trades a day, 10 min before acting on the same token again.",
    ]);
  });

  it("covers every trigger and action", () => {
    const lines = (x: unknown) => explainStrategy(parseStrategy(x));
    expect(lines({ ...base, trigger: { type: "wallet_trade", wallets: { list: [W1] }, side: "sell", minUsd: 500 } })[0]).toBe(`Trigger: when wallet ${W1.slice(0, 6)}…${W1.slice(-4)} sells a token for $500 or more.`);
    expect(lines({ ...base, trigger: { type: "price", mint: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", op: "below", value: 0.02 } })[0]).toBe("Trigger: when WMON trades below $0.02.");
    expect(lines({ ...base, trigger: { type: "price", mint: "held", op: "change_pct", value: -20, windowMin: 15 } })[0]).toBe("Trigger: when a token you hold moves down 20 % or more within 15 min.");
    expect(lines({ ...base, trigger: { type: "schedule", every: "4h", mint: M1 } })[0]).toBe(`Trigger: every 4 hours, on ${M1.slice(0, 6)}…${M1.slice(-4)} (the first run right away).`);
    expect(lines(getTemplate("crash-guard")!.strategy)).toEqual([
      "Trigger: when a token you hold moves down 15 % or more within 15 min.",
      "Filters: none: every trigger acts.", "Action: paper-sell 100 % of the bot's position in the token (nothing when it holds none).", "Exits: none (this bot does not open positions).",
      "Limits: 20 trades a day, 10 min before acting on the same token again.",
    ]);
    expect(lines({ ...base, action: { type: "sell", pct: 50 } })[2]).toBe("Action: paper-sell 50 % of the bot's position in the token (nothing when it holds none).");
    expect(lines({ ...base, action: { type: "webhook", url: "https://hooks.example.com/a" } })[2]).toBe("Action: POST the event to hooks.example.com (https, at most 20 a minute), no trade.");
    expect(filterText({ field: "ageMin", op: "<=", value: 30 })).toBe("at most 30 min old");
    expect(filterText({ field: "priceChange1hPct", op: "between", value: [-5, 10] })).toBe("1 h price change between −5 % and +10 %".replace("−5", "-5"));
  });
});

export type _S = Strategy;
