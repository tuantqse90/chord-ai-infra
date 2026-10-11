import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const { _closeTrustDb, trustDb } = await import("../src/trust/registry");
const { recordStats } = await import("../src/trust/routes");
beforeAll(() => { _closeTrustDb(); tmp = useTempDb("truststats"); });
afterAll(() => { _closeTrustDb(); tmp.restore(); });

describe("trust status: record stats", () => {
  it("empty: no lag, no validations, no last commit", () => {
    expect(recordStats()).toEqual({ commitLag: { medianMs: null, p90Ms: null, sample: 0 }, validation: { count: 0, avgScore: null, lastAt: null }, lastCommit: null });
  });
  it("lag quantiles over committed fills only; validation average of answered ones; the newest commit with its agent id", () => {
    const db = trustDb();
    db.run("INSERT INTO trust_agents (bot_id, agent_id, count, updated) VALUES ('aaaaaaaaaaaa', '77', 4, 0)");
    const fill = db.prepare("INSERT INTO trust_fills (fill_id, bot_id, seq, doc, hash, fill_ts, commit_tx, committed_at) VALUES (?, 'aaaaaaaaaaaa', ?, '{}', '0x', ?, ?, ?)");
    [[1, 1_000, 6_000], [2, 2_000, 4_000], [3, 3_000, 13_000], [4, 4_000, 9_000]].forEach(([seq, ts, at]) => fill.run(`f${seq}`, seq, ts, `0xtx${seq}`, at));
    fill.run("f5", 5, 5_000, null, null); // pending: not a lag
    const val = db.prepare("INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, created_at, response, responded_at) VALUES (?, 'aaaaaaaaaaaa', '77', '0xv', 1, 2, '0x', '{}', 0, ?, ?)");
    val.run("0x1", 100, 50); val.run("0x2", 80, 70); val.run("0x3", null, null);
    const s = recordStats();
    expect(s.commitLag).toEqual({ medianMs: 5_000, p90Ms: 10_000, sample: 4 }); // lags 2, 5, 5, 10 s
    expect(s.validation).toEqual({ count: 2, avgScore: 90, lastAt: 70 });
    expect(s.lastCommit).toMatchObject({ tx: "0xtx3", at: 13_000, seq: 3, agentId: "77" });
  });
});
