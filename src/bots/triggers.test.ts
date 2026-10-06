import { afterEach, describe, expect, it } from "bun:test";
import { addr, FakeWS, rawTx, tick } from "./_testkit";
import { Triggers, wsUrl } from "./triggers";
import type { TapeRow } from "./tape";
import type { SourceTrade } from "./types";

const W1 = addr(31), W2 = addr(32), X = addr(41), POOL = addr(42);
const NOW = 1_800_000_000_000;
const buyTx = (sig: string) => rawTx({ sig, payer: W1, blockTime: NOW / 1000, sol: [{ account: W1, pre: 10e9, post: 10e9 - 2e9 - 5000 }, { account: POOL, pre: 1e9, post: 3e9 }],
  tokens: [{ owner: W1, mint: X, post: "4000000", decimals: 6 }] });

let live: Triggers | null = null;
afterEach(() => { live?.stop(); live = null; });

function setup(tape: Record<string, TapeRow[]> = {}) {
  const got: SourceTrade[] = [];
  const sockets: FakeWS[] = [];
  const getTx: string[] = [];
  const t = new Triggers((x) => got.push(x), {
    wsFactory: (url) => { const s = new FakeWS(url); sockets.push(s); return s; },
    getTx: async (sig) => { getTx.push(sig); return buyTx(sig); },
    walletTrades: async (w) => tape[w] ?? [],
    tokenTrades: async (m) => tape[m] ?? [],
    solUsd: () => 150,
    now: () => NOW,
    sleep: async () => {},
  });
  live = t;
  return { t, got, sockets, getTx };
}
const subscribeAck = (s: FakeWS, i: number, subId: number) => s.push({ jsonrpc: "2.0", id: s.sent[i].id, result: subId });
const notify = (s: FakeWS, sub: number, signature: string, err: unknown = null) => s.push({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: sub, result: { context: { slot: 1 }, value: { signature, err, logs: [] } } } });

describe("websocket trigger", () => {
  it("subscribes logs per followed wallet, turns a notification into a buy, ignores failed txs", async () => {
    const { t, got, sockets, getTx } = setup();
    t.setFollowed([W1], []);
    t.start();
    expect(sockets.length).toBe(1);
    sockets[0].open();
    expect(sockets[0].sent[0]).toMatchObject({ method: "logsSubscribe", params: [{ mentions: [W1] }, { commitment: "confirmed" }] });
    subscribeAck(sockets[0], 0, 77);
    notify(sockets[0], 77, "SIGFAIL", { InstructionError: [0, "x"] });
    notify(sockets[0], 77, "SIG1");
    await tick();
    expect(getTx).toEqual(["SIG1"]);
    expect(got).toEqual([{ wallet: W1, tx: "SIG1", side: "buy", mint: X, symbol: null, usd: 300, priceUsd: 75, ts: NOW, via: "websocket" }]);
    expect(t.status()).toMatchObject({ ws: "open", subscriptions: 1, wallets: 1 });
  });

  it("follows the bots: subscribe new wallets, unsubscribe dropped ones, close when nothing is followed", () => {
    const { t, sockets } = setup();
    t.setFollowed([W1], []);
    t.start();
    sockets[0].open();
    subscribeAck(sockets[0], 0, 5);
    t.setFollowed([W1, W2], []);
    expect(sockets[0].sent[1]).toMatchObject({ method: "logsSubscribe", params: [{ mentions: [W2] }, { commitment: "confirmed" }] });
    subscribeAck(sockets[0], 1, 6);
    t.setFollowed([W2], []);
    expect(sockets[0].sent[2]).toMatchObject({ method: "logsUnsubscribe", params: [5] });
    t.setFollowed([], []);
    expect(sockets[0].readyState).toBe(3);
    expect(t.status().ws).toBe("off");
  });

  it("reconnects after a drop and subscribes everything again", () => {
    const { t, sockets } = setup();
    t.setFollowed([W1, W2], []);
    t.start();
    sockets[0].open();
    subscribeAck(sockets[0], 0, 1);
    subscribeAck(sockets[0], 1, 2);
    sockets[0].close();
    expect(t.status()).toMatchObject({ ws: "off", subscriptions: 0 });
    t._reconnectNow();
    expect(sockets.length).toBe(2);
    sockets[1].open();
    expect(sockets[1].sent.map((m) => m.params[0].mentions[0]).sort()).toEqual([W1, W2].sort());
  });

  it("the socket URL is SOLANA_WS_URL, else the RPC URL as wss", () => {
    const was = { ws: process.env.SOLANA_WS_URL, rpc: process.env.SOLANA_RPC_URL };
    process.env.SOLANA_WS_URL = "";
    process.env.SOLANA_RPC_URL = "https://rpc.example.com/abc";
    expect(wsUrl()).toBe("wss://rpc.example.com/abc");
    process.env.SOLANA_WS_URL = "wss://ws.example.com";
    expect(wsUrl()).toBe("wss://ws.example.com");
    for (const [k, v] of [["SOLANA_WS_URL", was.ws], ["SOLANA_RPC_URL", was.rpc]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
});

describe("dedupe across websocket and tape", () => {
  const row = (tx: string, ts: number, extra: Partial<TapeRow> = {}): TapeRow => ({ ts, side: "buy", token: X, symbol: "XX", usd: 300, priceUsd: 75, tokenAmount: 4, tx, ...extra });

  it("a trade seen on the websocket is not repeated by the tape, and a tape trade is not fetched again", async () => {
    const tape: Record<string, TapeRow[]> = {};
    const { t, got, sockets, getTx } = setup(tape);
    t.setFollowed([W1], []);
    t.start();
    sockets[0].open();
    subscribeAck(sockets[0], 0, 9);
    notify(sockets[0], 9, "SIG1");
    await tick();
    // the tape serves newest first: SIG2 (only on the tape), SIG1 (already seen), and the same SIG1 swap again
    tape[W1] = [row("SIG2", NOW / 1000 + 2), row("SIG1", NOW / 1000), row("SIG1", NOW / 1000)];
    await t.pollOnce();
    expect(got.map((g) => `${g.tx}:${g.via}`)).toEqual(["SIG1:websocket", "SIG2:tape"]);
    expect(got[1]).toEqual({ wallet: W1, tx: "SIG2", side: "buy", mint: X, symbol: "XX", usd: 300, priceUsd: 75, ts: NOW + 2000, via: "tape" });
    // the websocket now reports SIG2: the tape already delivered it, so no getTransaction and no second trade
    notify(sockets[0], 9, "SIG2");
    await tick();
    expect(getTx).toEqual(["SIG1"]);
    await t.pollOnce();
    expect(got.length).toBe(2);
  });

  it("tape rows older than the follow start (beyond the overlap) and quote-token rows are dropped", async () => {
    const tape: Record<string, TapeRow[]> = {};
    const { t, got } = setup(tape);
    t.setFollowed([W1], []);
    tape[W1] = [row("NEW", NOW / 1000 + 5), row("SOLROW", NOW / 1000 + 4, { token: "So11111111111111111111111111111111111111112", side: "sell" }), row("OLD", NOW / 1000 - 3600)];
    await t.pollOnce();
    expect(got.map((g) => g.tx)).toEqual(["NEW"]);
  });

  it("watched mints are polled from the token tape with each row's wallet", async () => {
    const tape: Record<string, TapeRow[]> = { [X]: [{ ts: NOW / 1000 + 1, side: "sell", token: X, symbol: "XX", usd: 2500, priceUsd: 1, tokenAmount: 2500, tx: "M1", wallet: W2 }] };
    const { t, got } = setup(tape);
    t.setFollowed([], [X]);
    await t.pollOnce();
    expect(got).toEqual([{ wallet: W2, tx: "M1", side: "sell", mint: X, symbol: "XX", usd: 2500, priceUsd: 1, ts: NOW + 1000, via: "tape" }]);
  });
});
