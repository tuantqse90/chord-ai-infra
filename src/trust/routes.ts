// /v1/trust: the trust layer over HTTP. Everything a third party needs to check an agent without trusting this server:
//   GET  /status                                  contracts, operator / validator, committer state
//   GET  /agents/:botId                           identity, the on-chain chain (read live), committed fills, validations
//   GET  /agents/:botId/registration.json         the ERC-8004 registration file the agent's agentURI points at
//   GET  /agents/:botId/fills?from=&to=           the committed documents (exact text), their hashes and transactions
//   POST /agents/:botId/validate                  ask the validator to replay the fills not validated yet (operator signs)
//   GET  /validation/requests/:hash(.json)        the request document (its keccak-256 is the on-chain requestHash)
//   GET  /validation/responses/:hash(.json)       the validator's report (its keccak-256 is the on-chain responseHash)
//   GET  /agents/:botId/reputation                feedback from the canonical ERC-8004 Reputation Registry
// Open to any ERC-8004 agent (TrackRecord takes commits from any identity's owner):
//   POST /docs                                    publish fill documents (canonical JSON, content-addressed by keccak-256)
//   GET  /docs/:hash(.json)                       one published document, exactly as hashed
//   GET  /onchain/:agentId                        any agent: identity, chain read live, commits indexed, documents published
//   GET  /onchain/:agentId/fills?from=&to=        any agent's commits joined with their documents (a track-record endpoint)
//   GET  /outside                                 agents committing to TrackRecord that this app does not run
//   POST /validation/notify { tx }                an agent just asked this validator: read the request from its transaction
import { Hono } from "hono";
import { getBot } from "../bots";
import { strategyById } from "../classic/strategies";
import { EXPLORER, IDENTITY_REGISTRY, MONAD_CHAIN_ID, REPUTATION_REGISTRY, AGENT_REGISTRY_ID } from "../monad/chain";
import { operatorAccount, validatorAccount } from "../monad/client";
import { balances, gateCheck, gatePolicy, onchainChain, reputationOf, trustConfig, validationSummary, type GateCheck } from "./chain";
import { committerStatus, trades } from "./committer";
import { agentRow, fillsOfBot, trustDb, validationRow, validationsOf, type FillRow } from "./registry";
import { acceptExternalRequest, askValidation, requestsInTx, ValidationInputError, validatorServiceStatus } from "./validator";
import { chainIndexStatus, chainOf, DocInputError, getDoc, identityOf, onchainFills, outsideAgents, putDoc, syncChain } from "./open";
import { registryStats, searchRegistry, registryMap } from "./registryIndex";

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
    ...recordStats(),
    open: { chainIndex: chainIndexStatus(), validator: validatorServiceStatus(), gate: { contract: trustConfig.trustGate(), vault: trustConfig.agentVault(), ...gateSummary() } },
  });
});

/** How fast fills reach Monad (fill time to the commit's block time, the last 500 commits), the validations' scores, the newest commit. */
export function recordStats() {
  const db = trustDb();
  const lags = (db.query("SELECT committed_at - fill_ts AS lag FROM trust_fills WHERE commit_tx IS NOT NULL ORDER BY committed_at DESC LIMIT 500").all() as { lag: number }[])
    .map((r) => Math.max(0, r.lag)).filter(Number.isFinite).sort((a, b) => a - b); // block times are whole seconds: below 0 = under a second
  const q = (p: number) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(p * lags.length))]! : null);
  const v = db.query("SELECT COUNT(*) AS n, AVG(response) AS avg, MAX(responded_at) AS at FROM trust_validations WHERE response IS NOT NULL").get() as { n: number; avg: number | null; at: number | null };
  const last = db.query("SELECT f.commit_tx AS tx, f.committed_at AS at, f.seq, a.agent_id AS agentId FROM trust_fills f LEFT JOIN trust_agents a ON a.bot_id = f.bot_id WHERE f.commit_tx IS NOT NULL ORDER BY f.committed_at DESC, f.seq DESC LIMIT 1").get() as { tx: string; at: number; seq: number; agentId: string | null } | null;
  return {
    commitLag: { medianMs: q(0.5), p90Ms: q(0.9), sample: lags.length },
    validation: { count: v.n, avgScore: v.avg == null ? null : Math.round(v.avg * 10) / 10, lastAt: v.at },
    lastCommit: last ? { ...last, explorer: tx(last.tx) } : null,
  };
}

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
  const cp = b.bot.params as any;
  const what = b.bot.type === "copy" ? `Copies the trades of ${cp?.wallets?.length ?? 0} Monad wallet(s)`
    : b.bot.type === "lp" ? `Provides paper liquidity ($${cp?.amountUsd ?? "?"}, ${cp?.preset ?? "balanced"} range) in Monad pool ${cp?.pool}`
    : b.bot.type === "classic" ? `Runs ${strategyById(cp?.strategy)?.title ?? "a classic strategy"} on ${cp?.symbol} ${cp?.tf} ${cp?.venue === "perpl" ? "perps on Perpl (Monad)" : "spot on Monad"}`
      : st?.description ?? "A custom trading strategy";
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: b.bot.name,
    description: `${what}. Paper trading on Monad, every fill priced by a real router quote and committed on-chain to its TrackRecord chain the moment it fills. Built with Chord.`,
    image: `${base}/agent-avatar.svg`,
    services: [
      { name: "web", endpoint: `${base}/app#agents/public/${id}` },
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

// ── open to any ERC-8004 agent ──────────────────────────────────────────────────────────────────────────────────────
const AGENT_ID = /^\d{1,12}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const docHits = new Map<string, { at: number; n: number }>();
/** 200 documents a minute per address (the host is free; it is not a bulk store) */
function docBudget(c: any, n: number): boolean {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now(), h = docHits.get(ip);
  const cur = !h || now - h.at > 60_000 ? { at: now, n: 0 } : h;
  cur.n += n; docHits.set(ip, cur);
  return cur.n <= 200;
}
trust.post("/docs", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { doc?: unknown; docs?: unknown[] } | null;
  const list = Array.isArray(b?.docs) ? b!.docs : b && "doc" in b ? [b.doc] : null;
  if (!list?.length) return c.json({ error: "bad_request", message: "send { doc } or { docs: [...] } (up to 50): each a JSON object, or its canonical text" }, 400);
  if (list.length > 50) return c.json({ error: "bad_request", message: "up to 50 documents a request" }, 400);
  if (!docBudget(c, list.length)) return c.json({ error: "rate_limited", message: "200 documents a minute per address" }, 429);
  try { return c.json({ docs: list.map((d) => ({ ...putDoc(d), url: `${trustConfig.publicBase()}/v1/trust/docs/${putDoc(d).hash}` })) }, 201); }
  catch (e) { if (e instanceof DocInputError) return c.json({ error: "bad_document", message: e.message }, 400); throw e; }
});
trust.get("/docs/:hash", (c) => {
  const h = c.req.param("hash").replace(/\.json$/, "");
  if (!HASH.test(h)) return c.json({ error: "not_found" }, 404);
  return docOut(c, getDoc(h));
});
trust.get("/onchain/:agentId", async (c) => {
  const id = c.req.param("agentId");
  if (!AGENT_ID.test(id)) return c.json({ error: "not_found" }, 404);
  const own = trustDb().query("SELECT bot_id FROM trust_agents WHERE agent_id = ?").get(id) as { bot_id: string } | null;
  const live = await onchainChain(id).catch(() => null);
  if (live && live.count > chainOf(id).length) await syncChain(30);
  const [chain, identity, validation] = await Promise.all([onchainChain(id).catch(() => null), identityOf(id).catch(() => null), validationSummary(id).catch(() => null)]);
  const idx = chainOf(id), fills = onchainFills(id);
  return c.json({
    agentId: id, agentRegistry: AGENT_REGISTRY_ID, trackRecord: trustConfig.trackRecord(), ours: own ? { botId: own.bot_id, web: `${trustConfig.publicBase()}/app#agents/public/${own.bot_id}` } : null,
    identity: identity ? { owner: identity.owner, agentURI: identity.uri, name: identity.name, description: identity.description } : null,
    chain, indexed: idx.length, published: fills.filter((f) => f.doc != null).length,
    fillsUrl: identity?.fillsUrl ?? `${trustConfig.publicBase()}/v1/trust/onchain/${id}/fills`, validationSummary: validation,
    validations: (trustDb().query("SELECT * FROM trust_validations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20").all(id) as any[]).map((v) => ({ requestHash: v.request_hash, range: { fromSeq: v.from_seq, toSeq: v.to_seq }, response: v.response, responseTx: v.response_tx, responseExplorer: tx(v.response_tx), error: v.error, responseURI: v.report ? `/v1/trust/validation/responses/${v.request_hash}.json` : null })),
  });
});
trust.get("/onchain/:agentId/fills", async (c) => {
  const id = c.req.param("agentId");
  if (!AGENT_ID.test(id)) return c.json({ error: "not_found" }, 404);
  const from = Math.max(1, Number(c.req.query("from")) || 1), to = Number(c.req.query("to")) || Number.MAX_SAFE_INTEGER;
  // a commit newer than the last index pass (it runs every minute): catch up before answering, so a verifier never sees a gap
  const live = await onchainChain(id).catch(() => null);
  if (live && live.count > chainOf(id).length) await syncChain(30);
  const fills = onchainFills(id, from, to).slice(0, 1000).map((f) => ({ ...f, explorer: tx(f.commitTx) }));
  return c.json({ agentId: id, trackRecord: trustConfig.trackRecord(), fills });
});
trust.get("/outside", async (c) => c.json({ agents: await outsideAgents(), index: chainIndexStatus() }));
trust.post("/validation/notify", async (c) => {
  const b = (await c.req.json().catch(() => null)) as { tx?: string } | null;
  if (!b?.tx || !HASH.test(b.tx)) return c.json({ error: "bad_request", message: "send { tx }: the transaction that called validationRequest" }, 400);
  try {
    const evs = await requestsInTx(b.tx as `0x${string}`);
    if (!evs.length) return c.json({ error: "not_found", message: "no ValidationRequest in that transaction" }, 404);
    const rows = await Promise.all(evs.map((e) => acceptExternalRequest(e)));
    return c.json({ requests: rows.filter(Boolean).map((v: any) => ({ requestHash: v.request_hash, agentId: v.agent_id, range: { fromSeq: v.from_seq, toSeq: v.to_seq }, error: v.error, responseURI: `/v1/trust/validation/responses/${v.request_hash}.json` })) }, 202);
  } catch (e) { return c.json({ error: "unreadable", message: String((e as Error)?.message ?? e).slice(0, 160) }, 502); }
});

// ── TrustGate ───────────────────────────────────────────────────────────────────────────────────────────────────────
// GET /gate/:agentId: TrustGate.check read from Monad, the answer a contract gets, with the policy it applies.
let gateMemo: { at: number; passing: number; checked: number } = { at: 0, passing: 0, checked: 0 };
let gateBusy = false;
/** how many of this app's agents the gate trusts today (re-read every 10 minutes in the background) */
function gateSummary() {
  if (!gateBusy && Date.now() - gateMemo.at > 600_000) {
    gateBusy = true;
    const ids = (trustDb().query("SELECT agent_id FROM trust_agents WHERE agent_id IS NOT NULL").all() as { agent_id: string }[]).map((r) => r.agent_id);
    Promise.all(ids.map((id) => gateCheck(id).catch(() => null))).then((rs) => { gateMemo = { at: Date.now(), passing: rs.filter((r) => r?.ok).length, checked: rs.filter(Boolean).length }; }).finally(() => { gateBusy = false; });
  }
  return { passing: gateMemo.passing, checked: gateMemo.checked, at: gateMemo.at || null };
}
trust.get("/gate/:agentId", async (c) => {
  const id = c.req.param("agentId");
  if (!AGENT_ID.test(id)) return c.json({ error: "not_found" }, 404);
  try {
    const [g, p] = await Promise.all([gateCheck(id), gatePolicy()]);
    const why: string[] = [];
    if (g.fills < p.minFills) why.push(`${g.fills} of ${p.minFills} fills committed`);
    if (g.validations < p.minValidations) why.push(`${g.validations} of ${p.minValidations} validations`);
    if (g.validations && g.avgScore < p.minAvgScore) why.push(`average score ${g.avgScore}, the gate asks ${p.minAvgScore}`);
    if (p.maxIdleS && (!g.lastAt || Date.now() - g.lastAt > p.maxIdleS * 1000)) why.push(`no commit in the last ${Math.round(p.maxIdleS / 86400)} days`);
    return c.json({ agentId: id, contract: trustConfig.trustGate(), ...g, policy: p, missing: g.ok ? [] : why } satisfies Record<string, unknown> & GateCheck);
  } catch (e) { return c.json({ error: "unreadable", message: String((e as Error)?.message ?? e).slice(0, 160) }, 502); }
});

// ── every ERC-8004 agent on Monad ──────────────────────────────────────────────────────────────────────────────────
// GET /registry?q=&filter=all|record|validated|card&page=   GET /registry/stats
trust.get("/registry", (c) => {
  const f = c.req.query("filter");
  const filter = f === "record" || f === "validated" || f === "card" ? f : "all";
  return c.json({ ...searchRegistry({ q: c.req.query("q") ?? "", filter, page: Number(c.req.query("page")) || 0, size: Number(c.req.query("size")) || 50 }), stats: registryStats() });
});
trust.get("/registry/stats", (c) => c.json(registryStats()));
trust.get("/registry/map", (c) => c.json(registryMap(), 200, { "Cache-Control": "public, max-age=60" }));
