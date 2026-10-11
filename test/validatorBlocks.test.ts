import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";

// the chain, faked: Committed events live in given blocks; the validator must ask for exactly the blocks the record names
type Ev = { seq: number; fillHash: string; head: string; block: number; tx: string };
let events: Ev[] = [];
const asked: number[][] = [];
const real = await import("../src/trust/chain");
mock.module("../src/trust/chain", () => ({
  ...real,
  committedEventsAt: async (_agentId: string, blocks: number[]) => { asked.push([...new Set(blocks)].sort((a, b) => a - b)); return events.filter((e) => blocks.includes(e.block)); },
  blockTime: async (b: number) => b * 1000,
  respondValidation: async () => ({ tx: "0xresp", block: 1, timestamp: 99_000 }),
}));
const { _closeTrustDb, trustDb, validationRow } = await import("../src/trust/registry");
const { canonical, chainHead, hashDoc } = await import("../src/trust/canonical");
const { runValidation } = await import("../src/trust/validator");

let tmp: ReturnType<typeof useTempDb>;
beforeAll(() => { _closeTrustDb(); tmp = useTempDb("validatorblocks"); });
afterAll(() => { _closeTrustDb(); tmp.restore(); });

/** Three fills of one LP agent (no market price, fired by the strategy: only the hash, chain and timing checks grade). */
function seed(bot: string, blocks: [number, number, number], eventBlocks = blocks) {
  const db = trustDb();
  const docs = [1, 2, 3].map((seq) => canonical({ seq, fill: { token: "lp:0x1", ts: blocks[seq - 1] * 1000 - 1000, priceUsd: 1 }, source: { via: "strategy" } }));
  const hashes = docs.map((d) => hashDoc(d));
  const heads = hashes.map((_, i) => chainHead(hashes.slice(0, i + 1)));
  const ins = db.prepare("INSERT INTO trust_fills (fill_id, bot_id, seq, doc, hash, fill_ts, commit_tx, commit_block, committed_at, head) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  docs.forEach((d, i) => ins.run(`${bot}-${i + 1}`, bot, i + 1, d, hashes[i], blocks[i] * 1000 - 1000, `0xtx${i}`, blocks[i], blocks[i] * 1000, heads[i]));
  events.push(...hashes.map((h, i) => ({ seq: i + 1, fillHash: h, head: heads[i], block: eventBlocks[i], tx: `0xtx${i}` })));
  const rh = `0x${bot.padEnd(64, "0")}`;
  db.run("INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, request_tx, created_at) VALUES (?, ?, '7', '0xv', 2, 3, ?, '{}', '0xreq', 0)", [rh, bot, heads[2]]);
  return rh as `0x${string}`;
}

describe("validator replay reads only the commit blocks", () => {
  it("asks for the range's blocks plus the block of the fill before it, and passes an honest record", async () => {
    events = []; asked.length = 0;
    const rh = seed("aaaaaaaaaaaa", [10, 10, 25]);
    const v = await runValidation(rh);
    expect(asked).toEqual([[10, 25]]); // fills 2 and 3 in blocks 10 and 25, fill 1 (the head before) in block 10
    expect(v.response).toBe(100);
    expect(v.response_tx).toBe("0xresp");
    expect(JSON.parse(validationRow(rh)!.report!).chain.pass).toBe(true);
  });
  it("a record naming the wrong block hides nothing: the event is missing and the score is 0", async () => {
    events = []; asked.length = 0;
    const rh = seed("bbbbbbbbbbbb", [40, 41, 42], [40, 41, 43]); // fill 3 was really committed in block 43
    const v = await runValidation(rh);
    expect(asked).toEqual([[40, 41, 42]]);
    expect(v.response).toBe(0);
    const r = JSON.parse(validationRow(rh)!.report!);
    expect(r.fatal).toBe(true);
    expect(r.items.find((i: any) => i.seq === 3).hash.pass).toBe(false);
  });
});
