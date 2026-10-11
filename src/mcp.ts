// /mcp: the trust layer as Model Context Protocol tools, so an AI agent (Claude, Cursor, any MCP client) can check another
// agent before it hands it money or work. Streamable HTTP, stateless: every POST is one JSON-RPC message answered as JSON
// (no session, no server-sent stream; GET answers 405 as the spec allows). Read-only: nothing here signs or spends.
//   claude mcp add --transport http chord-trust https://chordsi.xyz/mcp
import { Hono } from "hono";
import { verify as verifyRecord } from "../sdk/trackrecord";
import { currentBoard } from "./classic/board";
import { strategyById } from "./classic/strategies";
import { gateCheck, gatePolicy, onchainChain, trustConfig, validationSummary } from "./trust/chain";
import { identityOf, onchainFills, chainOf } from "./trust/open";
import { registryStats, searchRegistry } from "./trust/registryIndex";
import { recordStats } from "./trust/routes";
import { trustDb } from "./trust/registry";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "chord-trust", title: "Chord Agents trust layer on Monad", version: "1.0.0" };
const INSTRUCTIONS = "Check an ERC-8004 agent on Monad before trusting it: agent_record for its identity, on-chain record, validations and TrustGate answer; verify_agent re-hashes its published fills against the head Monad holds; gate_check is what a contract gets from TrustGate; search_agents finds agents among every ERC-8004 agent on Monad. Agent ids are numbers (e.g. 10333).";

const AGENT_ID = { type: "string", pattern: "^\\d{1,12}$", description: "ERC-8004 agent id on Monad's canonical Identity Registry, e.g. 10333" };
export const TOOLS = [
  { name: "trust_status", title: "Trust layer status", description: "The trust layer on Monad in numbers: contracts, agents with an identity, fills committed, median seconds from fill to block, validations and their average score, how many agents TrustGate trusts, and every ERC-8004 agent on Monad indexed.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "agent_record", title: "An agent's record", description: "Everything that says whether to trust one ERC-8004 agent: owner and agent card, its TrackRecord chain read live from Monad (fills, head, last commit), published documents, validator replays with scores, and TrustGate's answer with what is missing.", inputSchema: { type: "object", properties: { agentId: AGENT_ID }, required: ["agentId"] }, annotations: { readOnlyHint: true } },
  { name: "verify_agent", title: "Verify an agent's record", description: "Re-hash every committed fill document of an agent, fold the hash chain and compare with chains(agentId) read from Monad's RPC. Equal means the documents served are the ones committed, in order, none missing or edited.", inputSchema: { type: "object", properties: { agentId: AGENT_ID }, required: ["agentId"] }, annotations: { readOnlyHint: true } },
  { name: "gate_check", title: "TrustGate check", description: "What TrustGate.check(agentId) answers a contract on Monad today: ok, fills, validations, average score, last commit, and the gate's policy with what the agent is missing.", inputSchema: { type: "object", properties: { agentId: AGENT_ID }, required: ["agentId"] }, annotations: { readOnlyHint: true } },
  { name: "search_agents", title: "Search ERC-8004 agents on Monad", description: "Search every agent registered on Monad's canonical ERC-8004 Identity Registry by name, description, id or owner address. filter: record = keeps fills on TrackRecord, validated = has validator replays, card = publishes an agent card.", inputSchema: { type: "object", properties: { query: { type: "string", description: "name, words, an id or an owner address prefix (0x...)" }, filter: { type: "string", enum: ["all", "record", "validated", "card"] }, limit: { type: "integer", minimum: 1, maximum: 25 } } }, annotations: { readOnlyHint: true } },
  { name: "best_backtests", title: "Best backtested strategies", description: "The backtest board's setups that made money over the last 1, 3 and 6 months (median of Binance, OKX, Hyperliquid and Perpl data, $1,000 at 1x on Perpl, fees and funding), with what holding the coin did. History, not a forecast.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } } }, annotations: { readOnlyHint: true } },
] as const;

const idArg = (a: any): string => { const v = String(a?.agentId ?? "").trim(); if (!/^\d{1,12}$/.test(v)) throw new ToolError("agentId must be a number like 10333"); return v; };
class ToolError extends Error {}
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : null);

async function gateWithPolicy(id: string) {
  const [g, p] = await Promise.all([gateCheck(id), gatePolicy()]);
  const missing: string[] = [];
  if (g.fills < p.minFills) missing.push(`${g.fills} of ${p.minFills} fills committed`);
  if (g.validations < p.minValidations) missing.push(`${g.validations} of ${p.minValidations} validations`);
  if (g.validations && g.avgScore < p.minAvgScore) missing.push(`average score ${g.avgScore}, the gate asks ${p.minAvgScore}`);
  if (p.maxIdleS && (!g.lastAt || Date.now() - g.lastAt > p.maxIdleS * 1000)) missing.push(`no commit in the last ${Math.round(p.maxIdleS / 86400)} days`);
  return { contract: trustConfig.trustGate(), ok: g.ok, fills: g.fills, validations: g.validations, avgScore: g.avgScore, lastCommit: iso(g.lastAt), policy: p, missing };
}

export async function callTool(name: string, args: any): Promise<unknown> {
  const base = trustConfig.publicBase();
  switch (name) {
    case "trust_status": {
      const n = (q: string) => (trustDb().query(q).get() as { n: number }).n;
      const r = recordStats();
      return {
        chain: "Monad mainnet (143)",
        contracts: { identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", trackRecord: trustConfig.trackRecord(), validationRegistry: trustConfig.validationRegistry(), reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", trustGate: trustConfig.trustGate() },
        agentsWithIdentity: n("SELECT COUNT(*) AS n FROM trust_agents WHERE agent_id IS NOT NULL"), fillsCommitted: n("SELECT COUNT(*) AS n FROM trust_fills WHERE commit_tx IS NOT NULL"),
        medianSecondsFillToBlock: r.commitLag.medianMs == null ? null : Math.round(r.commitLag.medianMs / 100) / 10, validations: r.validation,
        everyErc8004AgentOnMonad: (({ agents, cardsOk, withRecord, validated, owners }) => ({ agents, cardsOk, withRecord, validated, owners }))(registryStats()),
        app: `${base}/app`,
      };
    }
    case "agent_record": {
      const id = idArg(args);
      const [chain, identity, gate, validation] = await Promise.all([onchainChain(id).catch(() => null), identityOf(id).catch(() => null), gateWithPolicy(id).catch(() => null), validationSummary(id).catch(() => null)]);
      if (!identity?.owner) throw new ToolError(`agent ${id} is not registered on Monad's ERC-8004 Identity Registry`);
      const own = trustDb().query("SELECT bot_id FROM trust_agents WHERE agent_id = ?").get(id) as { bot_id: string } | null;
      const vals = (trustDb().query("SELECT from_seq, to_seq, response, response_tx, request_hash FROM trust_validations WHERE agent_id = ? AND response IS NOT NULL ORDER BY responded_at DESC LIMIT 5").all(id) as any[])
        .map((v) => ({ fills: `${v.from_seq}-${v.to_seq}`, score: v.response, tx: v.response_tx, report: `${base}/v1/trust/validation/responses/${v.request_hash}.json` }));
      const fills = onchainFills(id);
      return {
        agentId: id, name: identity.name, description: identity.description, owner: identity.owner, agentCard: identity.uri,
        runByChord: own ? { page: `${base}/app#agents/public/${own.bot_id}` } : null,
        trackRecord: chain ? { fills: chain.count, head: chain.head, lastCommit: iso(chain.lastAt), published: fills.filter((f) => f.doc != null).length, documents: identity.fillsUrl ?? `${base}/v1/trust/onchain/${id}/fills` } : null,
        validation: { summary: validation, latest: vals }, trustGate: gate,
        verdict: !chain?.count ? "No fills on TrackRecord: nothing to check yet." : gate?.ok ? "TrustGate trusts this agent today." : `TrustGate does not trust it yet: ${gate?.missing.join(", ")}.`,
      };
    }
    case "verify_agent": {
      const id = idArg(args);
      const own = chainOf(id).length ? `${base}/v1/trust/onchain/${id}/fills` : undefined;
      const r = await verifyRecord(id, { rpcUrl: process.env.MONAD_RPC_URL || undefined, fillsUrl: (await identityOf(id).catch(() => null))?.fillsUrl ?? own });
      return { agentId: id, ok: r.ok, verdict: r.reason, documents: r.documents, committed: r.onchain.count, rebuiltHead: r.rebuiltHead, monadHead: r.onchain.head, missing: r.missing, fills: r.fillsUrl, checkYourself: `curl -sO ${base}/sdk/chord-verify.mjs && node chord-verify.mjs verify ${id}` };
    }
    case "gate_check": return { agentId: idArg(args), ...(await gateWithPolicy(idArg(args))) };
    case "search_agents": {
      const limit = Math.max(1, Math.min(25, Number(args?.limit) || 10));
      const filter = ["record", "validated", "card"].includes(args?.filter) ? args.filter : "all";
      const { total, rows } = searchRegistry({ q: String(args?.query ?? ""), filter, size: limit });
      return { total, agents: rows.map((a) => ({ agentId: String(a.agentId), name: a.name, description: a.description, owner: a.owner, fillsOnTrackRecord: a.commits, validations: a.validations, avgScore: a.avgScore, agentCard: a.uri })) };
    }
    case "best_backtests": {
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 8));
      const b = currentBoard(); if (!b) throw new ToolError("the backtest board is being built; try again in a few minutes");
      const m = (r: any, w: number) => r.windows?.[w]?.median;
      const good = b.rows.filter((r) => [30, 90, 180].every((w) => (m(r, w) ?? -1) > 0 && r.windows[w as 30]?.agree !== false)).sort((x, y) => m(y, 180) - m(x, 180)).slice(0, limit);
      return { builtAt: iso(b.at), basis: "$1,000 at 1x on Perpl, default parameters, median of the sources covering each window", setups: good.map((r) => ({ strategy: strategyById(r.strategy)?.title ?? r.strategy, symbol: r.symbol, tf: r.tf, month1: m(r, 30), months3: m(r, 90), months6: m(r, 180), hold6: r.holdPct?.[180] ?? null, maxDrawdown6: r.windows[180]?.maxDrawdownPct ?? null, open: `${base}/app#agents/classic/${r.strategy}` })) };
    }
  }
  throw new ToolError(`unknown tool ${name}`);
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const err = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
/** one JSON-RPC message in, its answer out (null for a notification) */
export async function handle(m: Rpc): Promise<object | null> {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(m?.id, -32600, "invalid request");
  const notification = m.id === undefined || m.id === null;
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok(m.id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    }
    case "notifications/initialized": case "notifications/cancelled": return null;
    case "ping": return ok(m.id, {});
    case "tools/list": return ok(m.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return err(m.id, -32602, `unknown tool ${name}`);
      try {
        const out = await callTool(name, m.params?.arguments ?? {});
        return ok(m.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
      } catch (e) {
        return ok(m.id, { content: [{ type: "text", text: String((e as Error)?.message ?? e).slice(0, 300) }], isError: true });
      }
    }
  }
  return notification ? null : err(m.id, -32601, `method not found: ${m.method}`);
}

export const mcp = new Hono();
// GET opens a server-sent stream in the spec; this server has none (405), but a browser or curl asking for JSON gets the card
mcp.get("/", (c) => (c.req.header("accept") ?? "").includes("text/event-stream") ? c.body(null, 405, { Allow: "POST" }) : c.json({ ...SERVER, transport: "streamable-http (POST JSON-RPC)", install: "claude mcp add --transport http chord-trust https://chordsi.xyz/mcp", tools: TOOLS.map((t) => t.name) }, 200, { Allow: "POST" }));
mcp.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json(err(null, -32700, "parse error"), 400);
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(body);
  return out ? c.json(out) : c.body(null, 202);
});
mcp.delete("/", (c) => c.body(null, 405));
