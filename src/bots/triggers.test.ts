import { describe, expect, it } from "bun:test";
import { addr, SOL } from "./_testkit";
import type { TapeRow } from "./tape";
import { Triggers } from "./triggers";
import type { SourceTrade } from "./types";

const W1 = addr(31), W2 = addr(32), X = addr(41);
const NOW = 1_800_000_000_000;
const row = (tx: string, ts: number, extra: Partial<TapeRow> = {}): TapeRow => ({ ts, side: "buy", token: X, symbol: "XX", usd: 300, priceUsd: 75, tokenAmount: 4, tx, ...extra });

function setup(tape: Record<string, TapeRow[]> = {}, now = () => NOW) {
  const got: SourceTrade[] = [];
  const asked: string[] = [];
  const t = new Triggers((x) => got.push(x), {
    walletTrades: async (w) => { asked.push(`w:${w}`); return tape[w] ?? []; },
    tokenTrades: async (m) => { asked.push(`m:${m}`); return tape[m] ?? []; },
    now,
  });
  return { t, got, asked };
}

describe("Monad feed trigger", () => {
  it("turns a followed wallet's new feed rows into source trades, oldest first, once each", async () => {
    const tape: Record<string, TapeRow[]> = {};
    const { t, got } = setup(tape);
    t.setFollowed([W1], []);
    // the feed serves newest first, and the same swap can show up twice
    tape[W1] = [row("0x2", NOW / 1000 + 2), row("0x1", NOW / 1000), row("0x1", NOW / 1000)];
    await t.pollOnce();
    expect(got.map((g) => g.tx)).toEqual(["0x1", "0x2"]);
    expect(got[1]).toEqual({ wallet: W1, tx: "0x2", side: "buy", mint: X, symbol: "XX", usd: 300, priceUsd: 75, ts: NOW + 2000, via: "tape" });
    await t.pollOnce();
    expect(got.length).toBe(2);
    expect(t.status()).toMatchObject({ source: "chord-monad-feed", wallets: 1, mints: 0, lastPollAt: NOW, lastError: null });
  });

  it("rows older than the follow start (beyond the 2 min overlap) and quote-token rows are dropped", async () => {
    const tape: Record<string, TapeRow[]> = {};
    const { t, got } = setup(tape);
    t.setFollowed([W1], []);
    tape[W1] = [row("NEW", NOW / 1000 + 5), row("WMONROW", NOW / 1000 + 4, { token: SOL, symbol: "WMON", side: "sell" }), row("LATE", NOW / 1000 - 60), row("OLD", NOW / 1000 - 3600)];
    await t.pollOnce();
    expect(got.map((g) => g.tx)).toEqual(["LATE", "NEW"]);
  });

  it("watched tokens are polled from Chord's per-token swaps with each row's wallet", async () => {
    const tape: Record<string, TapeRow[]> = { [X]: [row("M1", NOW / 1000 + 1, { side: "sell", usd: 2500, priceUsd: 1, tokenAmount: 2500, wallet: W2 }), row("NOWALLET", NOW / 1000 + 1)] };
    const { t, got } = setup(tape);
    t.setFollowed([], [X]);
    await t.pollOnce();
    expect(got).toEqual([{ wallet: W2, tx: "M1", side: "sell", mint: X, symbol: "XX", usd: 2500, priceUsd: 1, ts: NOW + 1000, via: "tape" }]);
  });

  it("follows the agents: a dropped wallet is not read, an added one starts at its follow time; addresses compare in lower case", async () => {
    const tape: Record<string, TapeRow[]> = {};
    const { t, got, asked } = setup(tape);
    t.setFollowed([W1.toUpperCase().replace("0X", "0x")], []);
    tape[W1] = [row("A", NOW / 1000 + 1)];
    tape[W2] = [row("B", NOW / 1000 + 1)];
    await t.pollOnce();
    t.setFollowed([W2], []);
    await t.pollOnce();
    expect(asked).toEqual([`w:${W1}`, `w:${W2}`]);
    expect(got.map((g) => `${g.wallet}:${g.tx}`)).toEqual([`${W1}:A`, `${W2}:B`]);
  });

  it("a failing read is reported and the other followed wallets still deliver", async () => {
    const got: SourceTrade[] = [];
    const t = new Triggers((x) => got.push(x), {
      walletTrades: async (w) => { if (w === W1) throw new Error("Chord API /smart-money/whales answered 503"); return [row("OK", NOW / 1000 + 1)]; },
      tokenTrades: async () => [],
      now: () => NOW,
    });
    t.setFollowed([W1, W2], []);
    await t.pollOnce();
    expect(got.map((g) => `${g.wallet}:${g.tx}`)).toEqual([`${W2}:OK`]);
    expect(t.status().lastError).toBe("wallet poll: Chord API /smart-money/whales answered 503");
  });

  it("a trade handler that throws does not stop the poll", async () => {
    const seen: string[] = [];
    const t = new Triggers((x) => { seen.push(x.tx); if (x.tx === "0x1") throw new Error("boom"); }, {
      walletTrades: async () => [row("0x2", NOW / 1000 + 2), row("0x1", NOW / 1000 + 1)], tokenTrades: async () => [], now: () => NOW,
    });
    t.setFollowed([W1], []);
    await t.pollOnce();
    expect(seen).toEqual(["0x1", "0x2"]);
  });
});
