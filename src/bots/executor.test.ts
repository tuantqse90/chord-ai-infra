import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { addr, useTempDb } from "./_testkit";
import type { ExecDeps } from "./executor";
import type { TokenInfo } from "./market";
import type { SourceTrade } from "./types";

let tmp: ReturnType<typeof useTempDb>;
const E = await import("./index");
beforeAll(() => { E._resetBots(); tmp = useTempDb("bots-exec"); });
afterAll(() => { E._resetBots(); tmp.restore(); });

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603"; // Monad USDC: what the engine pays with
const W1 = addr(11), W2 = addr(12), A = addr(21), B = addr(22), C = addr(23);
const T0 = 1_800_000_000_000;
let now = T0;
let px: Record<string, number> = {};
let info: Record<string, TokenInfo | null> = {};
let quoteFail: string | null = null;
let sellBack: Record<string, number | "fail"> = {}; // a token whose sell returns this share of its price, or no route
let quotes: { in: string; out: string; amount: number }[] = [];
let hooks: { url: string; body: any }[] = [];
let hookOk = true;
const safe = (mint: string, liquidityUsd = 1_000_000): TokenInfo => ({ mint, symbol: `T${mint.slice(2, 5)}`, name: null, decimals: 6, liquidityUsd, usdPrice: px[mint] ?? null, taxPct: null, verified: true, icon: null });

const deps: Partial<ExecDeps> = {
  now: () => now,
  // A quote at the mocked price: USDC → token = usd / price tokens; token → USDC = qty × price.
  quote: async (inMint, outMint, amount) => {
    quotes.push({ in: inMint, out: outMint, amount });
    if (quoteFail) throw new Error(quoteFail);
    const back = outMint === USDC ? sellBack[inMint] : undefined;
    if (back === "fail") throw new Error("no route");
    const amountOut = inMint === USDC ? amount / px[outMint] : amount * px[inMint] * (back ?? 1);
    return { amountOut, priceImpactPct: 0.12, route: ["Uniswap V4"], outSymbol: null, inSymbol: null, feeBps: 5 };
  },
  tokenInfo: async (mint) => (mint in info ? info[mint] : safe(mint)),
  prices: async (mints) => new Map(mints.filter((m) => px[m] != null).map((m) => [m, px[m]])),
  webhook: async (url, body) => { hooks.push({ url, body }); return hookOk ? { ok: true, status: 200 } : { ok: false, status: 500 }; },
};

let n = 0;
const trade = (o: Partial<SourceTrade>): SourceTrade => ({ wallet: W1, tx: `tx${++n}`, side: "buy", mint: A, symbol: null, usd: 500, priceUsd: null, ts: now, via: "tape", ...o });
const send = async (...ts: SourceTrade[]) => { for (const t of ts) E._dispatch(t); await E._drain(); };
const copy = (owner: string, params: Record<string, unknown>) => E.createBot(owner, { type: "copy", params: { wallets: [W1], usdPerTrade: 20, ...params } });
const lastFill = (id: string) => E.getBot(id.split("|")[0], id.split("|")[1])!.fills[0];

beforeEach(() => {
  now = T0; px = { [A]: 0.5, [B]: 2, [C]: 1 }; info = {}; quoteFail = null; sellBack = {}; quotes = []; hooks = []; hookOk = true;
  E._setBotDeps({ exec: deps });
});

describe("paper copy trading", () => {
  it("mirrors a buy at a router quote, then a sell with its PnL", async () => {
    const bot = copy("o-pnl", {});
    now += 1000;
    await send(trade({ mint: A }));
    let d = E.getBot("o-pnl", bot.id)!;
    expect(d.fills[0]).toMatchObject({ side: "buy", mint: A, status: "filled", usd: 20, tokenAmount: 40, priceUsd: 0.5, reason: null, mode: "paper", quote: { provider: "Chord router", route: ["Uniswap V4"], priceImpactPct: 0.12 } });
    expect(d.fills[0].source.via).toBe("tape");
    expect(quotes[0]).toEqual({ in: USDC, out: A, amount: 20 });
    expect(d.positions).toEqual([expect.objectContaining({ mint: A, qty: 40, costUsd: 20, priceUsd: 0.5, valueUsd: 20, pnlUsd: 0 })]);

    // Price moves to 0.8: marking shows +12 unrealized, then the followed wallet sells → the whole position sells at 0.8.
    px[A] = 0.8;
    await E._markTick();
    expect(E.listBots("o-pnl")[0].stats.unrealizedUsd).toBe(12);
    now += 1000;
    await send(trade({ side: "sell", mint: A, usd: 900 }));
    d = E.getBot("o-pnl", bot.id)!;
    expect(d.fills[0]).toMatchObject({ side: "sell", status: "filled", usd: 32, tokenAmount: 40, priceUsd: 0.8, pnlUsd: 12 });
    expect(quotes[1]).toEqual({ in: A, out: USDC, amount: 40 });
    expect(d.positions).toEqual([]);
    expect(d.bot.stats).toMatchObject({ trades: 2, buys: 1, sells: 1, skipped: 0, investedUsd: 20, realizedUsd: 12, unrealizedUsd: 0, openPositions: 0, winRate: 1 });
  });

  it("ignores a sell of a token it does not hold, and sells only when mirrorSells is on", async () => {
    const off = copy("o-mirror", { mirrorSells: false });
    await send(trade({ mint: B }), trade({ side: "sell", mint: B }), trade({ side: "sell", mint: C }));
    const d = E.getBot("o-mirror", off.id)!;
    expect(d.fills.map((f) => `${f.side}:${f.status}`)).toEqual(["buy:filled"]);
    expect(d.positions.length).toBe(1);
  });

  it("only acts on followed wallets, and not on trades from before it started", async () => {
    const bot = copy("o-scope", {});
    await send(trade({ wallet: W2, mint: A }), trade({ mint: A, ts: T0 - 60_000 }));
    expect(E.getBot("o-scope", bot.id)!.fills).toEqual([]);
  });
});

describe("every gate leaves a skipped fill with a reason", () => {
  const reasonFor = async (owner: string, params: Record<string, unknown>, setup: (botId: string) => Promise<void> | void, t: Partial<SourceTrade>) => {
    const bot = copy(owner, params);
    await setup(bot.id);
    await send(trade(t));
    const f = E.getBot(owner, bot.id)!.fills[0];
    expect(f.status).toBe("skipped");
    expect(f.quote).toBeNull();
    expect(f.tokenAmount).toBe(0);
    return f.reason!;
  };

  it("status: paused before the queued buy ran", async () => {
    const bot = copy("g-status", {});
    E._dispatch(trade({ mint: A }));
    E.setStatus("g-status", bot.id, "paused");
    await E._drain();
    expect(lastFill(`g-status|${bot.id}`)).toMatchObject({ status: "skipped", reason: "the bot was paused when this buy came in" });
  });
  it("max open positions", async () => {
    const r = await reasonFor("g-open", { maxOpenPositions: 1 }, () => send(trade({ mint: A })), { mint: B });
    expect(r).toBe("max open positions: 1 already open");
  });
  it("max per token", async () => {
    const r = await reasonFor("g-tok", { maxPerTokenUsd: 30 }, () => send(trade({ mint: A })), { mint: A });
    expect(r).toMatch(/^max per token: already \$20 in .+, another \$20 would pass the \$30 cap$/);
  });
  it("safety: a transfer tax, a round trip that does not come back, a sell nobody routes", async () => {
    info[B] = { ...safe(B), taxPct: 5 };
    expect(await reasonFor("g-tax", {}, () => {}, { mint: B })).toMatch(/takes a 5% transfer tax/);
    info[B] = safe(B); sellBack[B] = 0.5;
    expect(await reasonFor("g-rt", {}, () => {}, { mint: B })).toMatch(/selling it straight back returns \$10 \(50% lost\)/);
    sellBack[B] = "fail";
    expect(await reasonFor("g-nosell", {}, () => {}, { mint: B })).toMatch(/no sell route for/);
    sellBack[B] = 0.95; // a 5 % round-trip cost passes (at least 90 % back)
    const ok = copy("g-ok", {});
    await send(trade({ mint: B }));
    expect(lastFill(`g-ok|${ok.id}`).status).toBe("filled");
  });
  it("safety off lets a taxed token through; a token nobody describes cannot be checked", async () => {
    info[B] = { ...safe(B), taxPct: 5 };
    const bot = copy("g-safeoff", { safety: false });
    await send(trade({ mint: B }));
    expect(lastFill(`g-safeoff|${bot.id}`).status).toBe("filled");
    info[C] = null;
    expect(await reasonFor("g-unlisted", {}, () => {}, { mint: C })).toMatch(/neither Chord nor the chain describes .*safety and liquidity cannot be checked/);
  });
  it("minimum liquidity", async () => {
    info[B] = safe(B, 5_000);
    expect(await reasonFor("g-liq", {}, () => {}, { mint: B })).toBe("liquidity $5,000 is below the bot's $20,000 minimum");
  });
  it("daily loss stop: skips, and pauses the bot", async () => {
    const r = await reasonFor("g-loss", { dailyLossStopUsd: 5 }, async () => {
      await send(trade({ mint: A }));
      px[A] = 0.3; // 40 A bought at 0.5 sell for 12: realized -8
      await send(trade({ side: "sell", mint: A }));
    }, { mint: B });
    expect(r).toBe("daily loss stop: today's loss $8 reached the $5 stop");
    const b = E.listBots("g-loss")[0];
    expect(b.status).toBe("paused");
    expect(E.getBot("g-loss", b.id)!.events[0]).toMatchObject({ level: "warn" });
  });
  it("no router quote", async () => {
    quoteFail = "Chord API /quote answered 502 ENGINE_ERROR";
    expect(await reasonFor("g-quote", {}, () => {}, { mint: A })).toBe("no router quote: Chord API /quote answered 502 ENGINE_ERROR");
  });
  it("marking pauses a bot whose open loss passes the stop", async () => {
    const bot = copy("g-mark", { dailyLossStopUsd: 5 });
    await send(trade({ mint: A }));
    px[A] = 0.25; // 40 × 0.25 = 10 for 20 paid: -10 open
    await E._markTick();
    expect(E.getBot("g-mark", bot.id)!.bot).toMatchObject({ status: "paused", stats: { unrealizedUsd: -10, openPositions: 1 } });
  });
});

describe("alert bots", () => {
  it("fires on a watched wallet's big trade (event + webhook), not on a small one; a failing webhook is a warning", async () => {
    const bot = E.createBot("o-alert", { type: "alert", params: { wallets: [W1], minUsd: 1000, webhook: "https://hooks.example.com/b" } });
    await send(trade({ mint: A, usd: 1500, symbol: "AAA" }), trade({ mint: A, usd: 100 }));
    let d = E.getBot("o-alert", bot.id)!;
    expect(d.events[0].msg.startsWith(`${W1.slice(0, 6)}…${W1.slice(-4)} bought $1,500 of AAA · tx `)).toBe(true);
    expect(d.events[0].msg.endsWith("(tape)")).toBe(true);
    expect(hooks.length).toBe(1);
    expect(hooks[0]).toMatchObject({ url: "https://hooks.example.com/b", body: { type: "alert", bot: { id: bot.id }, trade: { mint: A, usd: 1500 } } });
    expect(d.fills).toEqual([]);
    hookOk = false;
    await send(trade({ side: "sell", mint: B, usd: 5000 }));
    d = E.getBot("o-alert", bot.id)!;
    expect(d.events[0]).toMatchObject({ level: "warn", msg: "Webhook answered 500" });
    expect(d.events[1].msg).toMatch(/sold \$5,000 of/);
    // the public view never shows the webhook
    expect((E.getBot(null, bot.id)!.bot.params as any).webhook).toBeNull();
  });
  it("watched mints fire for any wallet at minUsd, and for a watched wallet at any size", async () => {
    const bot = E.createBot("o-alert2", { type: "alert", params: { wallets: [W1], mints: [B], minUsd: 1000 } });
    await send(trade({ wallet: W2, mint: B, usd: 2000 }), trade({ wallet: W2, mint: B, usd: 10 }), trade({ wallet: W1, mint: B, usd: 10 }), trade({ wallet: W2, mint: A, usd: 9000 }));
    const msgs = E.getBot("o-alert2", bot.id)!.events.map((e) => e.msg).filter((m) => / (bought|sold) /.test(m));
    expect(msgs.length).toBe(2);
  });
});
