// /v1/trust: the trust layer over HTTP. Everything a third party needs to check an agent without trusting this server:
//   GET  /status                                  contracts, operator / validator, committer state
//   GET  /agents/:botId                           identity, the on-chain chain (read live), committed fills, validations
//   GET  /agents/:botId/registration.json         the ERC-8004 registration file the agent's agentURI points at
//   GET  /agents/:botId/fills?from=&to=           the committed documents (exact text), their hashes and transactions
//   POST /agents/:botId/validate                  ask the validator to replay the fills not validated yet (operator signs)
//   GET  /validation/requests/:hash(.json)        the request document (its keccak-256 is the on-chain requestHash)
//   GET  /validation/responses/:hash(.json)       the validator's report (its keccak-256 is the on-chain responseHash)
//   GET  /agents/:botId/reputation                feedback from the canonical ERC-8004 Reputation Registry
import { Hono } from "hono";
import { getBot } from "../bots";
import { EXPLORER, IDENTITY_REGISTRY, MONAD_CHAIN_ID, REPUTATION_REGISTRY, AGENT_REGISTRY_ID } from "../monad/chain";
import { operatorAccount, validatorAccount } from "../monad/client";
import { balances, onchainChain, reputationOf, trustConfig, validationSummary } from "./chain";
import { committerStatus, trades } from "./committer";
import { agentRow, fillsOfBot, trustDb, validationRow, validationsOf, type FillRow } from "./registry";
import { askValidation, ValidationInputError } from "./validator";

export const trust = new Hono();
const BOT_ID = /^[0-9a-f]{12}$/;
const tx = (h: string | null) => (h ? `${EXPLORER}/tx/${h}` : null);

trust.get("/status", async (c) => {
  let bal: Awaited<ReturnType<typeof balances>> | null = null;
  try { bal = await balances(); } catch { /* RPC down: the rest still answers */ }
  const n = (q: string) => (trustDb().query(q).get() as { n: number }).n;
  return c.json({
    chainId: MONAD_CHAIN_ID, explorer: EXPLORER,
    contracts: { identityRegistry: IDENTITY_REGISTRY, reputationRegistry: REPUTATION_REGISTRY, validationRegistry: trustConfig.validationRegistry(), trackRecord: trustConfig.trackRecord() },
    agentRegistry: AGENT_REGISTRY_ID,
    operator: bal?.operator ? { address: bal.operator.address, mon: bal.operator.mon } : operatorAccount() ? { address: operatorAccount()!.address, mon: null } : null,
    validator: bal?.validator ?? (validatorAccount() ? { address: validatorAccount()!.address, mon: null } : null),
    committer: committerStatus(),
    counts: { agents: n("SELECT COUNT(*) AS n FROM trust_agents WHERE agent_id IS NOT NULL"), committed: n("SELECT COUNT(*) AS n FROM trust_fills WHERE commit_tx IS NOT NULL"),
      pending: n("SELECT COUNT(*) AS n FROM trust_fills WHERE commit_tx IS NULL"), validations: n("SELECT COUNT(*) AS n FROM trust_validations WHERE response IS NOT NULL") },
  });
});

const fillOut = (f: FillRow) => ({ seq: f.seq, fillId: f.fill_id, hash: f.hash, doc: f.doc, fillTs: f.fill_ts, commitTx: f.commit_tx, commitBlock: f.commit_block,
  committedAt: f.committed_at, lagMs: f.committed_at != null ? f.committed_at - f.fill_ts : null, head: f.head, explorer: tx(f.commit_tx) });

trust.get("/agents/:botId", async (c) => {
  const id = c.req.param("botId");
  if (!BOT_ID.test(id) || !getBot(null, id)) return c.json({ error: "not_found" }, 404);
  const a = agentRow(id);
  let onchain: Awaited<ReturnType<typeof onchainChain>> | null = null, validation: Awaited<ReturnType<typeof validationSummary>> = null;
  if (a?.agent_id) {
    [onchain, validation] = await Promise.all([onchainChain(a.agent_id).catch(() => null), validationSummary(a.agent_id).catch(() => null)]);
  }
  return c.json({
    botId: id, agentRegistry: AGENT_REGISTRY_ID, trackRecord: trustConfig.trackRecord(), validationRegistry: trustConfig.validationRegistry(),
    identity: a?.agent_id ? { agentId: a.agent_id, agentURI: a.agent_uri, registerTx: a.register_tx, registeredAt: a.registered_at, explorer: tx(a.register_tx) } : null,
    chain: { head: a?.head ?? null, count: a?.count ?? 0, lastCommitTx: a?.last_commit_tx ?? null, lastCommitAt: a?.last_commit_at ?? null, onchain },
    error: a?.error ?? null,
    fills: fillsOfBot(id, 200).map(fillOut),
    validations: validationsOf(id).map((v) => ({ requestHash: v.request_hash, range: { fromSeq: v.from_seq, toSeq: v.to_seq }, validator: v.validator, requestTx: v.request_tx, requestExplorer: tx(v.request_tx),
      response: v.response, responseTx: v.response_tx, responseExplorer: tx(v.response_tx), respondedAt: v.responded_at, createdAt: v.created_at, error: v.error,
      requestURI: `/v1/trust/validation/requests/${v.request_hash}.json`, responseURI: v.report ? `/v1/trust/validation/responses/${v.request_hash}.json` : null })),
    validationSummary: validation,
  });
});

/** ERC-8004 registration-v1 for one agent: what it does, where to talk to it, its registration, the trust models it supports. */
trust.get("/agents/:botId/registration.json", (c) => {
  const id = c.req.param("botId");
  const b = BOT_ID.test(id) ? getBot(null, id) : null;
  if (!b) return c.json({ error: "not_found" }, 404);
  const a = agentRow(id), base = trustConfig.publicBase();
  const st = (b.bot.params as any)?.strategy;
  const what = b.bot.type === "copy" ? `Copies the trades of ${(b.bot.params as any)?.wallets?.length ?? 0} Monad wallet(s)` : st?.description ?? "A custom trading strategy";
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: b.bot.name,
    description: `${what}. Paper trading on Monad, every fill priced by a real router quote and committed on-chain to its TrackRecord chain the moment it fills. Built with Chord.`,
    image: `${base}/agent-avatar.svg`,
    services: [
      { name: "web", endpoint: `${base}/#agents/public/${id}` },
      { name: "agent-api", endpoint: `${base}/v1/agents/public/${id}`, version: "1" },
      { name: "track-record", endpoint: `${base}/v1/trust/agents/${id}/fills`, version: "chord-agent-fill/v1" },
    ],
    x402Support: false,
    active: b.bot.status === "running",
    registrations: a?.agent_id ? [{ agentId: Number(a.agent_id), agentRegistry: AGENT_REGISTRY_ID }] : [],
    supportedTrust: ["reputation", "validation"],
    trackRecord: { chainId: MONAD_CHAIN_ID, contract: trustConfig.trackRecord(), agentId: a?.agent_id ?? null, committedFills: a?.count ?? 0 },
  });
});

trust.get("/agents/:botId/fills", (c) => {
  const id = c.req.param("botId");
  if (!BOT_ID.test(id)) return c.json({ error: "not_found" }, 404);
  const from = Math.max(1, Number(c.req.query("from")) || 1), to = Number(c.req.query("to")) || Number.MAX_SAFE_INTEGER;
  const rows = trustDb().query("SELECT * FROM trust_fills WHERE bot_id = ? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT 1000").all(id, from, to) as FillRow[];
  return c.json({ botId: id, agentId: agentRow(id)?.agent_id ?? null, trackRecord: trustConfig.trackRecord(), fills: rows.map(fillOut) });
});

trust.post("/agents/:botId/validate", async (c) => {
  const id = c.req.param("botId");
  const b = BOT_ID.test(id) ? getBot(null, id) : null;
  if (!b || !trades(b.bot)) return c.json({ error: "not_found" }, 404);
  try { const v = await askValidation(id); return c.json({ requestHash: v.request_hash, range: { fromSeq: v.from_seq, toSeq: v.to_seq }, requestTx: v.request_tx }, 202); }
  catch (e) {
    if (e instanceof ValidationInputError) return c.json({ error: "validation_refused", message: e.message }, e.status as 400);
    return c.json({ error: "validation_failed", message: String((e as Error)?.message ?? e).slice(0, 200) }, 502);
  }
});

const docOut = (c: any, text: string | null) => (text ? c.body(text, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" }) : c.json({ error: "not_found" }, 404));
trust.get("/validation/requests/:hash", (c) => docOut(c, validationRow(c.req.param("hash").replace(/\.json$/, ""))?.request ?? null));
trust.get("/validation/responses/:hash", (c) => docOut(c, validationRow(c.req.param("hash").replace(/\.json$/, ""))?.report ?? null));

trust.get("/agents/:botId/reputation", async (c) => {
  const a = agentRow(c.req.param("botId"));
  if (!a?.agent_id) return c.json({ agentId: null, count: 0, feedback: [] });
  try { return c.json({ agentId: a.agent_id, registry: REPUTATION_REGISTRY, ...(await reputationOf(a.agent_id)) }); }
  catch (e) { return c.json({ error: "unreadable", message: String((e as Error)?.message ?? e).slice(0, 160) }, 502); }
});
