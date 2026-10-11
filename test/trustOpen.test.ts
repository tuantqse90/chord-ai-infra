import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const { _closeTrustDb, trustDb } = await import("../src/trust/registry");
const { canonical, hashDoc, chainHead } = await import("../src/trust/canonical");
const { putDoc, getDoc, onchainFills, DocInputError, _resetOpen } = await import("../src/trust/open");
const { autoCandidates } = await import("../src/trust/validator");
beforeAll(() => { _closeTrustDb(); _resetOpen(); tmp = useTempDb("trustopen"); });
afterAll(() => { _closeTrustDb(); tmp.restore(); });

describe("document host", () => {
  it("stores canonical JSON by its keccak-256; an object is canonicalised; a non-canonical text is refused", () => {
    const doc = { type: "chord-agent-fill/v1", seq: 1, fill: { ts: 1000, side: "buy", usd: 10 } };
    const r = putDoc(doc);
    expect(r.hash as string).toBe(hashDoc(canonical(doc)).toLowerCase());
    expect(getDoc(r.hash)).toBe(canonical(doc));
    expect(putDoc(canonical(doc)).hash).toBe(r.hash); // the same document twice: same hash, one row
    expect(() => putDoc('{"b":1, "a":2}')).toThrow(DocInputError);
    expect(() => putDoc("x".repeat(20_000))).toThrow("at most");
  });
});

describe("any agent's fills", () => {
  it("joins the chain index with published documents (this app's record first, then the host); a missing document stays null", () => {
    const db = trustDb();
    const d1 = canonical({ seq: 1, fill: { ts: 5000 } }), d2 = canonical({ seq: 2, fill: { ts: 6000 } });
    const h1 = hashDoc(d1).toLowerCase(), h2 = hashDoc(d2).toLowerCase();
    putDoc(d1); // d2 is never published
    const ins = db.prepare("INSERT INTO trust_chain (agent_id, seq, fill_hash, head, block, tx) VALUES ('900', ?, ?, ?, ?, ?)");
    ins.run(1, h1, chainHead([h1 as any]).toLowerCase(), 10, "0xa"); ins.run(2, h2, "0xhead2", 11, "0xb");
    const f = onchainFills("900");
    expect(f.map((x) => [x.seq, x.doc != null, x.fillTs, x.commitBlock])).toEqual([[1, true, 5000, 10], [2, false, null, 11]]);
    expect(onchainFills("900", 2, 2)).toHaveLength(1);
  });
});

describe("auto validation candidates", () => {
  it("never validated with a commit, or 3 new fills, or 1 new fill and 12 h; none with a request in flight", () => {
    const db = trustDb(), now = 100 * 3_600_000;
    const agent = db.prepare("INSERT INTO trust_agents (bot_id, agent_id, count, updated) VALUES (?, ?, 0, 0)");
    const fill = db.prepare("INSERT INTO trust_fills (fill_id, bot_id, seq, doc, hash, fill_ts, commit_tx) VALUES (?, ?, ?, '{}', '0x', 0, ?)");
    const val = db.prepare("INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, request_tx, created_at, response) VALUES (?, ?, '1', '0xv', 1, ?, '0x', '{}', '0xt', ?, ?)");
    const mk = (bot: string, n: number) => { agent.run(bot, bot.slice(0, 3)); for (let i = 1; i <= n; i++) fill.run(`${bot}${i}`, bot, i, "0xc"); };
    mk("aaa000000000", 1);                                              // never validated: yes
    mk("bbb000000000", 4); val.run("0x01", "bbb000000000", 1, now - 3_600_000, 100);      // 3 new since #1: yes
    mk("ccc000000000", 2); val.run("0x02", "ccc000000000", 1, now - 3_600_000, 100);      // 1 new, 1 h ago: no
    mk("ddd000000000", 2); val.run("0x03", "ddd000000000", 1, now - 13 * 3_600_000, 100); // 1 new, 13 h ago: yes
    mk("eee000000000", 5); val.run("0x04", "eee000000000", 1, now - 13 * 3_600_000, null); // in flight: no
    mk("fff000000000", 0);                                              // no commit: no
    expect(autoCandidates(now).sort()).toEqual(["aaa000000000", "bbb000000000", "ddd000000000"]);
  });
});

describe("outside validation requests", () => {
  it("only requests addressed to this validator; this app's own agents excluded; the daily cap and the hourly limit refuse with a reason", async () => {
    const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // a well-known test key, no funds
    const prev = { k: process.env.VALIDATOR_PRIVATE_KEY, cap: process.env.EXT_VALIDATIONS_PER_DAY };
    process.env.VALIDATOR_PRIVATE_KEY = KEY; process.env.EXT_VALIDATIONS_PER_DAY = "2";
    try {
      const { acceptExternalRequest } = await import("../src/trust/validator");
      const { privateKeyToAccount } = await import("viem/accounts");
      const me = privateKeyToAccount(KEY).address;
      const ev = (h: string, agentId = "777", validator = me) => ({ requestHash: `0x${h.padStart(64, "0")}` as `0x${string}`, agentId, requestURI: "https://example.invalid/r.json", validator, tx: null });
      expect(await acceptExternalRequest(ev("a1", "777", "0x000000000000000000000000000000000000dEaD"))).toBeNull();
      expect(await acceptExternalRequest(ev("a2", "aaa"))).toBeNull(); // agent "aaa" is this app's (an id in trust_agents above)
      const db = trustDb();
      db.run("INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, created_at) VALUES ('0xold', 'ext:777', '777', ?, 1, 1, '', '', ?)", [me.toLowerCase(), Date.now() - 600_000]);
      expect((await acceptExternalRequest(ev("a3")))?.error).toBe("one request per agent per hour");
      db.run("INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, created_at) VALUES ('0xold2', 'ext:778', '778', ?, 1, 1, '', '', ?)", [me.toLowerCase(), Date.now() - 600_000]);
      expect((await acceptExternalRequest(ev("a4", "779")))?.error).toContain("answers 2 outside requests a day");
    } finally {
      if (prev.k === undefined) delete process.env.VALIDATOR_PRIVATE_KEY; else process.env.VALIDATOR_PRIVATE_KEY = prev.k;
      if (prev.cap === undefined) delete process.env.EXT_VALIDATIONS_PER_DAY; else process.env.EXT_VALIDATIONS_PER_DAY = prev.cap;
    }
  });
});
