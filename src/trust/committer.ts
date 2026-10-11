// The commit loop (every 15 s): 1) every trading agent gets an ERC-8004 identity on Monad (the operator registers it, the
// agentURI is this server's registration file for it); 2) every new FILLED fill of a registered agent becomes a canonical
// document with the next sequence number (oldest first); 3) each agent's pending documents are appended to its TrackRecord
// chain in one transaction (up to 40), building on the head read from the chain. A skipped fill moves no money and is not
// committed. Everything waits while the operator holds less than TRUST_MIN_OPERATOR_MON.
import type { Hex } from "viem";
import { logger } from "../chord/utils/logger";
import { allBots, filledSince } from "../bots/store";
import type { Bot } from "../bots/types";
import { fillDoc, hashDoc } from "./canonical";
import { balances, commitFills, onchainChain, registerAgent, trustConfig } from "./chain";
import { agentRow, trustDb, type AgentRow } from "./registry";

export const COMMIT_MS = 15_000;
const BATCH = 40;
const REGISTER_PER_TICK = 3;
const MAX_TRIES = 5;

/** Agents that trade (copy agents, custom agents whose action buys or sells): the ones whose record means something. */
export const trades = (b: Pick<Bot, "type" | "params">) => b.type === "copy" || b.type === "classic" || b.type === "lp" || (b.type === "custom" && ["buy", "sell"].includes(((b.params as any)?.strategy?.action?.type ?? "") as string));
export const registrationUri = (botId: string) => `${trustConfig.publicBase()}/v1/trust/agents/${botId}/registration.json`;

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let lastError: string | null = null;
let lastTickAt: number | null = null;
let lowFunds = false;

async function ensureIdentities(): Promise<void> {
  const db = trustDb();
  const todo = allBots("all").filter((b) => trades(b) && b.status !== "error").filter((b) => { const a = agentRow(b.id); return !a?.agent_id && (a?.tries ?? 0) < MAX_TRIES; }).slice(0, REGISTER_PER_TICK);
  for (const b of todo) {
    const uri = registrationUri(b.id);
    try {
      const r = await registerAgent(uri);
      db.run(`INSERT INTO trust_agents (bot_id, agent_id, agent_uri, register_tx, registered_at, updated) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id) DO UPDATE SET agent_id = excluded.agent_id, agent_uri = excluded.agent_uri, register_tx = excluded.register_tx, registered_at = excluded.registered_at, error = NULL, updated = excluded.updated`,
        [b.id, r.agentId, uri, r.tx, r.timestamp, Date.now()]);
      logger.info({ bot: b.id, agentId: r.agentId, tx: r.tx }, "trust: agent registered on ERC-8004");
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 300);
      db.run(`INSERT INTO trust_agents (bot_id, error, tries, updated) VALUES (?, ?, 1, ?) ON CONFLICT (bot_id) DO UPDATE SET error = excluded.error, tries = tries + 1, updated = excluded.updated`, [b.id, err, Date.now()]);
      logger.warn({ bot: b.id, err }, "trust: registration failed");
    }
  }
}

/** New filled fills of registered agents → documents with the next sequence numbers. */
function stageFills(): number {
  const db = trustDb();
  let staged = 0;
  const agents = db.query("SELECT * FROM trust_agents WHERE agent_id IS NOT NULL").all() as AgentRow[];
  for (const a of agents) {
    const known = new Set((db.query("SELECT fill_id FROM trust_fills WHERE bot_id = ?").all(a.bot_id) as { fill_id: string }[]).map((r) => r.fill_id));
    const fresh = filledSince(a.bot_id, 0).filter((f) => !known.has(f.id)).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    if (!fresh.length) continue;
    let seq = (db.query("SELECT COALESCE(MAX(seq), 0) AS n FROM trust_fills WHERE bot_id = ?").get(a.bot_id) as { n: number }).n;
    const ins = db.prepare("INSERT OR IGNORE INTO trust_fills (fill_id, bot_id, seq, doc, hash, fill_ts) VALUES (?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (const f of fresh) {
        seq++;
        const doc = fillDoc(f, { botId: a.bot_id, agentId: a.agent_id! }, seq);
        ins.run(f.id, a.bot_id, seq, doc, hashDoc(doc), f.ts);
        staged++;
      }
    })();
  }
  return staged;
}

async function commitPending(): Promise<void> {
  const db = trustDb();
  const bots = db.query("SELECT DISTINCT f.bot_id AS id FROM trust_fills f JOIN trust_agents a ON a.bot_id = f.bot_id WHERE f.commit_tx IS NULL AND a.agent_id IS NOT NULL").all() as { id: string }[];
  for (const { id } of bots) {
    const a = agentRow(id)!;
    const rows = db.query("SELECT fill_id, seq, hash FROM trust_fills WHERE bot_id = ? AND commit_tx IS NULL ORDER BY seq LIMIT ?").all(id, BATCH) as { fill_id: string; seq: number; hash: Hex }[];
    if (!rows.length) continue;
    try {
      const chain = await onchainChain(a.agent_id!);
      if (chain.count !== rows[0]!.seq - 1) throw new Error(`the chain holds ${chain.count} fills but the next document is #${rows[0]!.seq}; not committing out of order`);
      const r = await commitFills(a.agent_id!, chain.head, rows.map((x) => x.hash));
      const bySeq = new Map(r.committed.map((c) => [c.seq, c]));
      const upd = db.prepare("UPDATE trust_fills SET commit_tx = ?, commit_block = ?, committed_at = ?, head = ? WHERE fill_id = ?");
      db.transaction(() => {
        for (const x of rows) {
          const c = bySeq.get(x.seq);
          if (!c || c.fillHash.toLowerCase() !== x.hash.toLowerCase()) throw new Error(`commit ${r.tx}: fill #${x.seq} missing or different in the Committed events`);
          upd.run(r.tx, r.block, r.timestamp, c.head, x.fill_id);
        }
        const last = r.committed[r.committed.length - 1]!;
        db.run("UPDATE trust_agents SET head = ?, count = ?, last_commit_tx = ?, last_commit_at = ?, error = NULL, updated = ? WHERE bot_id = ?", [last.head, last.seq, r.tx, r.timestamp, Date.now(), id]);
      })();
      logger.info({ bot: id, agentId: a.agent_id, fills: rows.length, tx: r.tx }, "trust: fills committed");
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 300);
      db.run("UPDATE trust_agents SET error = ?, updated = ? WHERE bot_id = ?", [err, Date.now(), id]);
      logger.warn({ bot: id, err }, "trust: commit failed");
    }
  }
}

export async function commitTick(): Promise<void> {
  if (!trustConfig.enabled()) return;
  if (running) return running;
  running = (async () => {
    try {
      const b = await balances();
      lowFunds = !b.operator || b.operator.wei < trustConfig.minOperatorWei();
      stageFills();
      if (lowFunds) { lastError = `operator balance ${b.operator?.mon ?? "?"} MON is below the minimum; nothing is sent until it is topped up`; return; }
      await ensureIdentities();
      stageFills();
      await commitPending();
      lastError = null;
    } catch (e) {
      lastError = String((e as Error)?.message ?? e).slice(0, 300);
      logger.warn({ err: lastError }, "trust: commit tick failed");
    } finally {
      lastTickAt = Date.now();
    }
  })().finally(() => { running = null; });
  return running;
}

export function startCommitter(): void {
  if (timer || !trustConfig.enabled()) return;
  timer = setInterval(() => { void commitTick(); }, COMMIT_MS);
  (timer as any).unref?.();
  setTimeout(() => { void commitTick(); }, 4_000);
  logger.info({}, "trust: committer started");
}
export const committerStatus = () => ({ enabled: trustConfig.enabled(), running: !!timer, lastTickAt, lastError, lowFunds });
export function _stopCommitter(): void { if (timer) clearInterval(timer); timer = null; }
