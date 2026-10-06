// Runs the index tools against a real Postgres that holds the same tables as the Chord databases (schema copied from the
// monorepo DDL), seeded with a few rows. Skipped unless TEST_INDEX_URL and TEST_SOLANA_URL point at scratch databases.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import bs58 from "bs58";
import { closeDbs } from "../src/db/pg";
import { dbTools, MAX_SANE_HOUR_USD } from "../src/db/tools";

const IDX = process.env.TEST_INDEX_URL, SOL = process.env.TEST_SOLANA_URL;
const run = IDX && SOL ? describe : describe.skip;
const now = Math.floor(Date.now() / 1000), hour = Math.floor(now / 3600) * 3600, day = Math.floor(now / 86400) * 86400;
const TOKEN = "0x" + "a1".repeat(20), WALLET = "0x" + "b2".repeat(20);
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", BAD = "EmpirdtfUMfBQXEjnNmTngeimjfizfuSBD3TN9zqzydj";
const SOLW = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const hex = (b: string) => Buffer.from(bs58.decode(b)).toString("hex");
const tool = (name: string) => dbTools().find((t) => t.name === name)!;

run("index tools on Postgres", () => {
  beforeAll(async () => {
    process.env.INDEX_DATABASE_URL = IDX; process.env.SOLANA_DATABASE_URL = SOL; process.env.CHORD_API = "off";
    const i = new SQL(IDX!), s = new SQL(SOL!);
    await i.unsafe(`DROP TABLE IF EXISTS dex_trades, chain_trades, rh_token_hourly, rh_chain_daily, chain_token_hourly, chain_chain_daily;
      CREATE TABLE dex_trades (tx TEXT NOT NULL, log_index INTEGER NOT NULL, pool TEXT NOT NULL, dex TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL,
        token_amt DOUBLE PRECISION NOT NULL, usd DOUBLE PRECISION NOT NULL, price_usd DOUBLE PRECISION NOT NULL, block BIGINT NOT NULL, ts BIGINT NOT NULL, wallet TEXT,
        chain SMALLINT NOT NULL DEFAULT 143, PRIMARY KEY (tx, log_index));
      CREATE TABLE chain_trades (chain INTEGER NOT NULL, tx TEXT NOT NULL, log_index INTEGER NOT NULL, pool TEXT NOT NULL, dex TEXT NOT NULL, token TEXT NOT NULL, side TEXT NOT NULL,
        token_amt DOUBLE PRECISION NOT NULL, usd DOUBLE PRECISION NOT NULL, price_usd DOUBLE PRECISION NOT NULL, block BIGINT NOT NULL, ts BIGINT NOT NULL, wallet TEXT, PRIMARY KEY (chain, tx, log_index));
      CREATE TABLE rh_token_hourly (hour BIGINT NOT NULL, token TEXT NOT NULL, dex TEXT NOT NULL, vol_usd DOUBLE PRECISION NOT NULL, buy_usd DOUBLE PRECISION NOT NULL,
        sell_usd DOUBLE PRECISION NOT NULL, trades INTEGER NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL, wallets INTEGER NOT NULL, price_last DOUBLE PRECISION NOT NULL,
        last_ts BIGINT NOT NULL, price_ref DOUBLE PRECISION, ref_ts BIGINT, PRIMARY KEY (hour, token, dex));
      CREATE TABLE rh_chain_daily (day BIGINT PRIMARY KEY, swaps INTEGER NOT NULL, vol_usd DOUBLE PRECISION NOT NULL, tokens INTEGER NOT NULL, wallets INTEGER NOT NULL, venues INTEGER NOT NULL);
      CREATE TABLE chain_token_hourly (chain INTEGER NOT NULL, hour BIGINT NOT NULL, token TEXT NOT NULL, dex TEXT NOT NULL, vol_usd DOUBLE PRECISION NOT NULL, buy_usd DOUBLE PRECISION NOT NULL,
        sell_usd DOUBLE PRECISION NOT NULL, trades INTEGER NOT NULL, buys INTEGER NOT NULL, sells INTEGER NOT NULL, wallets INTEGER NOT NULL, price_last DOUBLE PRECISION NOT NULL,
        last_ts BIGINT NOT NULL, PRIMARY KEY (chain, hour, token, dex));
      CREATE TABLE chain_chain_daily (chain INTEGER NOT NULL, day BIGINT NOT NULL, swaps INTEGER NOT NULL, vol_usd DOUBLE PRECISION NOT NULL, tokens INTEGER NOT NULL, wallets INTEGER NOT NULL,
        venues INTEGER NOT NULL, PRIMARY KEY (chain, day));`);
    await i.unsafe(`INSERT INTO rh_chain_daily VALUES (${day}, 1200000, 470000000, 4900, 24000, 20), (${day - 86400}, 1100000, 430000000, 4800, 70000, 20);
      INSERT INTO rh_token_hourly VALUES (${hour}, '${TOKEN}', 'uniswap_v3', 5000, 3000, 2000, 10, 6, 4, 8, 1.5, ${now - 60}, null, null),
                                         (${hour - 3600}, '${TOKEN}', 'uniswap_v4', 2000, 1000, 1000, 4, 2, 2, 3, 1.4, ${now - 4000}, null, null);
      INSERT INTO chain_chain_daily VALUES (8453, ${day}, 1500000, 700000000, 11000, 15000, 130), (56, ${day}, 1, 1, 1, 1, 1);
      INSERT INTO chain_token_hourly VALUES (8453, ${hour}, '${TOKEN}', 'aerodrome', 9000, 4000, 5000, 20, 9, 11, 15, 2.0, ${now - 30});
      INSERT INTO dex_trades VALUES ('0x${"c3".repeat(32)}', 1, 'p', 'uniswap_v3', '${TOKEN}', 'buy', 10, 15, 1.5, 1, ${now - 100}, '${WALLET}', 4663),
                                    ('0x${"c4".repeat(32)}', 1, 'p', 'uniswap_v3', '${TOKEN}', 'sell', 4, 6, 1.5, 2, ${now - 50}, '${WALLET}', 4663),
                                    ('0x${"c5".repeat(32)}', 1, 'p', 'uniswap_v3', '${TOKEN}', 'buy', 1, 1, 1, 3, ${now - 40}, '${WALLET}', 143);
      INSERT INTO chain_trades VALUES (8453, '0x${"d6".repeat(32)}', 1, 'p', 'aerodrome', '${TOKEN}', 'buy', 3, 6, 2, 1, ${now - 20}, '${WALLET}');`);
    await s.unsafe(`DROP TABLE IF EXISTS sol_swaps, sol_pools, sol_tokens, sol_token_hourly, sol_wallet_token_daily;
      CREATE TABLE sol_swaps (slot BIGINT NOT NULL, token_amt DOUBLE PRECISION NOT NULL, quote_amt DOUBLE PRECISION NOT NULL, usd DOUBLE PRECISION, price_usd DOUBLE PRECISION,
        ts INTEGER NOT NULL, tx_index INTEGER NOT NULL, ev_index SMALLINT NOT NULL, dex SMALLINT NOT NULL, side SMALLINT NOT NULL, pool BYTEA NOT NULL, wallet BYTEA NOT NULL, sig BYTEA NOT NULL);
      CREATE TABLE sol_pools (pool BYTEA PRIMARY KEY, dex SMALLINT NOT NULL, token BYTEA NOT NULL, quote BYTEA NOT NULL, token_dec SMALLINT NOT NULL, quote_dec SMALLINT NOT NULL,
        first_slot BIGINT NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, swaps BIGINT NOT NULL DEFAULT 0, vol_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        price_usd DOUBLE PRECISION, liq_usd DOUBLE PRECISION);
      CREATE TABLE sol_tokens (mint BYTEA PRIMARY KEY, decimals SMALLINT NOT NULL, first_slot BIGINT NOT NULL, first_ts INTEGER NOT NULL, symbol TEXT, name TEXT, uri TEXT, image TEXT,
        supply DOUBLE PRECISION, meta_at INTEGER, meta_tries SMALLINT NOT NULL DEFAULT 0);
      CREATE TABLE sol_token_hourly (hour INTEGER NOT NULL, token BYTEA NOT NULL, dex SMALLINT NOT NULL, vol_usd DOUBLE PRECISION NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0,
        buys INTEGER NOT NULL DEFAULT 0, buy_usd DOUBLE PRECISION NOT NULL DEFAULT 0);
      CREATE TABLE sol_wallet_token_daily (day INTEGER NOT NULL, buy_usd DOUBLE PRECISION NOT NULL DEFAULT 0, sell_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        buy_amt DOUBLE PRECISION NOT NULL DEFAULT 0, sell_amt DOUBLE PRECISION NOT NULL DEFAULT 0, n_buy INTEGER NOT NULL DEFAULT 0, n_sell INTEGER NOT NULL DEFAULT 0,
        wallet BYTEA NOT NULL, token BYTEA NOT NULL);`);
    const h = Math.floor(now / 3600);
    await s.unsafe(`INSERT INTO sol_tokens (mint, decimals, first_slot, first_ts, symbol, name) VALUES (decode('${hex(MINT)}', 'hex'), 6, 1, 1, 'USDC', 'USD Coin');
      INSERT INTO sol_pools VALUES (decode('${hex(POOL)}', 'hex'), 1, decode('${hex(MINT)}', 'hex'), decode('${hex(MINT)}', 'hex'), 6, 9, 1, 1, ${now}, 5, 100, 1.0, 50000);
      INSERT INTO sol_token_hourly VALUES (${h}, decode('${hex(MINT)}', 'hex'), 1, 800000, 900, 500, 450000),
                                          (${h}, decode('${hex(BAD)}', 'hex'), 10, ${MAX_SANE_HOUR_USD * 1000}, 61, 6, 1);
      INSERT INTO sol_swaps VALUES (1, 100, 100, 100, 1.0, ${now - 30}, 0, 0, 1, 1, decode('${hex(POOL)}', 'hex'), decode('${hex(SOLW)}', 'hex'),
        decode('${Buffer.from(bs58.decode("5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf")).toString("hex")}', 'hex'));
      INSERT INTO sol_wallet_token_daily VALUES (${Math.floor(now / 86400)}, 100, 40, 100, 40, 2, 1, decode('${hex(SOLW)}', 'hex'), decode('${hex(MINT)}', 'hex'));`);
    await i.close(); await s.close();
  });
  afterAll(async () => { await closeDbs(); });

  it("chain activity: Robinhood days from rh_chain_daily, Base from chain_chain_daily", async () => {
    const rh = (await tool("index_chain_activity").run({ chain: "robinhood", days: 2 })).data as any;
    expect(rh.days.map((d: any) => d.volumeUsd)).toEqual([470000000, 430000000]);
    const base = (await tool("index_chain_activity").run({ chain: "Base Chain" })).data as any;
    expect(base.days[0].swaps).toBe(1500000);
  });
  it("chain activity on Solana leaves the $154T-style pricing error out and says so", async () => {
    const r = (await tool("index_chain_activity").run({ chain: "solana", days: 1 })).data as any;
    expect(r.days[0].volumeUsd).toBe(800000);
    expect(r.excludedAsErrors.tokenHours).toBe(1);
  });
  it("Monad has no rollup: a clear input error", async () => {
    await expect(tool("index_chain_activity").run({ chain: "monad" })).rejects.toThrow("no daily rollup");
  });
  it("top tokens: hours summed per token, last price from the newest hour", async () => {
    const rh = (await tool("index_top_tokens").run({ chain: "robinhood" })).data as any;
    expect(rh.tokens[0]).toMatchObject({ token: TOKEN, volumeUsd: 7000, trades: 14, priceUsd: 1.5 });
    const sol = (await tool("index_top_tokens").run({ chain: "solana" })).data as any;
    expect(sol.tokens.map((t: any) => t.symbol)).toEqual(["USDC"]);
    expect(sol.tokens[0].mainVenue).toBe("pumpswap");
  });
  it("token trades: dex_trades by chain, chain_trades for Base, sol_swaps through the token's pools", async () => {
    const rh = (await tool("index_token_trades").run({ chain: "robinhood", token: TOKEN.toUpperCase().replace("0X", "0x") })).data as any;
    expect(rh.trades.map((t: any) => t.side)).toEqual(["sell", "buy"]);
    const base = (await tool("index_token_trades").run({ chain: "base", token: TOKEN })).data as any;
    expect(base.trades).toHaveLength(1);
    const sol = (await tool("index_token_trades").run({ chain: "solana", token: MINT })).data as any;
    expect(sol.trades[0]).toMatchObject({ side: "buy", usd: 100, wallet: SOLW, tx: "5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf" });
  });
  it("wallet book per token, per chain", async () => {
    const rh = (await tool("index_wallet").run({ chain: "robinhood", wallet: WALLET })).data as any;
    expect(rh.tokens[0]).toMatchObject({ boughtUsd: 15, soldUsd: 6, buys: 1, sells: 1 });
    const sol = (await tool("index_wallet").run({ chain: "solana", wallet: SOLW })).data as any;
    expect(sol.tokens[0]).toMatchObject({ symbol: "USDC", boughtUsd: 100, soldUsd: 40 });
  });
  it("the connection is read-only even with a writable role", async () => {
    const { q } = await import("../src/db/pg");
    await expect(q("index", "INSERT INTO rh_chain_daily VALUES (1, 1, 1, 1, 1, 1)")).rejects.toThrow(/read-only/);
  });
});
