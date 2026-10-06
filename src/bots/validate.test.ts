import { describe, expect, it } from "bun:test";
import { addr } from "./_testkit";
import { BotInputError } from "./errors";
import { botName, validateAlertParams, validateCopyParams, validateDays, validateMode, validateType } from "./validate";

const W1 = addr(1), W2 = addr(2);

describe("copy params", () => {
  it("fills every default and keeps the address case", () => {
    const p = validateCopyParams({ wallets: [` ${W1} `, W2, W1], usdPerTrade: 20 });
    expect(p).toEqual({ wallets: [W1, W2], usdPerTrade: 20, maxPerTokenUsd: 60, maxOpenPositions: 10, mirrorSells: true, slippageBps: 100, minLiquidityUsd: 20_000, safety: true, dailyLossStopUsd: null });
    expect(p.wallets[0]).not.toBe(W1.toLowerCase());
  });
  it("takes numeric strings and explicit values", () => {
    const p = validateCopyParams({ wallets: [W1], usdPerTrade: "50", maxPerTokenUsd: 100, maxOpenPositions: 3, mirrorSells: false, slippageBps: 300, minLiquidityUsd: 0, safety: false, dailyLossStopUsd: 25 });
    expect(p).toMatchObject({ usdPerTrade: 50, maxPerTokenUsd: 100, maxOpenPositions: 3, mirrorSells: false, slippageBps: 300, minLiquidityUsd: 0, safety: false, dailyLossStopUsd: 25 });
  });
  it("refuses bad input with a message that names the field", () => {
    const bad: [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ usdPerTrade: 20 }, /wallets is required/],
      [{ wallets: [], usdPerTrade: 20 }, /at least 1 wallet/],
      [{ wallets: ["0xabc"], usdPerTrade: 20 }, /wallets\[0\] "0xabc" is not a Solana wallet/],
      [{ wallets: [W1.toLowerCase()], usdPerTrade: 20 }, /not a Solana wallet/],
      [{ wallets: Array.from({ length: 11 }, (_, i) => addr(i + 1)), usdPerTrade: 20 }, /at most 10 wallets/],
      [{ wallets: [W1] }, /usdPerTrade is required/],
      [{ wallets: [W1], usdPerTrade: 0.5 }, /usdPerTrade must be between 1 and 1000/],
      [{ wallets: [W1], usdPerTrade: 1001 }, /usdPerTrade must be between 1 and 1000/],
      [{ wallets: [W1], usdPerTrade: "lots" }, /usdPerTrade must be a number/],
      [{ wallets: [W1], usdPerTrade: 20, maxPerTokenUsd: 10 }, /maxPerTokenUsd must be between 20/],
      [{ wallets: [W1], usdPerTrade: 20, maxOpenPositions: 2.5 }, /maxOpenPositions must be a whole number/],
      [{ wallets: [W1], usdPerTrade: 20, slippageBps: 0 }, /slippageBps must be between 1 and 5000/],
      [{ wallets: [W1], usdPerTrade: 20, mirrorSells: "yes" }, /mirrorSells must be true or false/],
      [{ wallets: [W1], usdPerTrade: 20, dailyLossStopUsd: -5 }, /dailyLossStopUsd must be more than 0/],
      [{ wallets: [W1], usdPerTrade: 20, stopLoss: 5 }, /unknown copy params field "stopLoss"/],
    ];
    for (const [input, msg] of bad) {
      expect(() => validateCopyParams(input)).toThrow(msg);
      try { validateCopyParams(input); } catch (e) { expect(e).toBeInstanceOf(BotInputError); }
    }
  });
});

describe("alert params", () => {
  it("defaults minUsd to 1000, webhook to null; needs wallets or mints", () => {
    expect(validateAlertParams({ wallets: [W1] })).toEqual({ wallets: [W1], mints: [], minUsd: 1000, webhook: null });
    expect(validateAlertParams({ mints: [W2], minUsd: 50, webhook: "https://hooks.example.com/x" })).toEqual({ wallets: [], mints: [W2], minUsd: 50, webhook: "https://hooks.example.com/x" });
    expect(() => validateAlertParams({})).toThrow(/needs wallets to watch, mints to watch, or both/);
  });
  it("webhooks must be public https", () => {
    for (const w of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://10.0.0.2/a", "https://hooks.example.com:8443/x", "ftp://x.com", 42]) {
      expect(() => validateAlertParams({ wallets: [W1], webhook: w })).toThrow(/webhook must be a public https URL/);
    }
  });
});

describe("type, mode, days, name", () => {
  it("validates the small fields", () => {
    expect(validateType("copy")).toBe("copy");
    expect(() => validateType("grid")).toThrow(/type must be "copy", "alert", "lp" or "custom"/);
    expect(validateMode(undefined)).toBe("paper");
    expect(validateMode("live")).toBe("live");
    expect(() => validateMode("real")).toThrow(/mode must be/);
    expect(validateDays(7)).toBe(7);
    expect(() => validateDays(2)).toThrow(/days must be 1, 3 or 7/);
  });
  it("names a bot from what it follows when no name is given", () => {
    const p = validateCopyParams({ wallets: [W1, W2], usdPerTrade: 5 });
    expect(botName(undefined, "copy", p)).toBe(`Copy ${W1.slice(0, 4)}…${W1.slice(-4)} +1`);
    expect(botName("  My\u0007 bot  ", "copy", p)).toBe("My bot");
    expect(botName("", "alert", validateAlertParams({ mints: [W2] }))).toBe(`Alert ${W2.slice(0, 4)}…${W2.slice(-4)}`);
  });
});
