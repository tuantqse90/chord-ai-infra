// /v1/agents/execute: execute an agent's signal for real from the owner's own wallet, every chain call on NOWNodes
// (src/agentExec.ts). Mounted BEFORE the other /v1/agents routers so "/execute/…" is never read as an agent id.
//   POST /prepare      { botId, fillId, wallet, usd?, pct?, slippageBps? } → unsigned tx + Jupiter quote + NOWNodes simulation
//   POST /send         { prepareId, signedTx } → NOWNodes sendTransaction → { signature, status, via }
//   GET  /status/:sig  NOWNodes getSignatureStatuses → { status: pending | confirmed | finalized | failed, err, slot, via }
//   GET  /mine?botId=  the owner's executions, newest first, and whether the lane is on
// The owner is the caller's X-Session, or `key:<id>` for a developer API key, exactly as on /v1/bots.
import { Hono } from "hono";
import { ExecError, executionStatus, myExecutions, prepareExecution, sendExecution } from "./agentExec";
import { KEY_RPM, resolveKey, useKey } from "./devkeys";
import { NowNodesOffError, nownodesReady } from "./nownodes";

const SESSION_RE = /^[A-Za-z0-9:_-]{8,120}$/;
type Owner = { owner: string } | { error: Response };

function ownerOf(c: any): Owner {
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? "";
  if (bearer.startsWith("ak_")) {
    const k = resolveKey(bearer);
    if (!k) return { error: c.json({ error: "bad_key", message: "unknown or revoked API key" }, 401) };
    if (!useKey(k.id)) return { error: c.json({ error: "rate_limited", message: `${KEY_RPM} requests a minute per key` }, 429) };
    return { owner: `key:${k.id}` };
  }
  const s = c.req.header("x-session");
  if (s && SESSION_RE.test(s)) return { owner: s };
  return { error: c.json({ error: "no_session", message: "send X-Session (web) or an API key" }, 401) };
}

const OFF_MSG = "NOWNodes key not set on this server: execution is off. Agent swaps go through NOWNodes only, never another RPC.";
function fail(c: any, e: unknown): Response {
  if (e instanceof NowNodesOffError) return c.json({ error: "nownodes_off", message: OFF_MSG }, 503);
  if (e instanceof ExecError) return c.json({ error: e.code, message: e.message, ...e.extra }, e.status);
  return c.json({ error: "execute_error", message: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
}

export const agentExec = new Hono();

agentExec.post("/prepare", async (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await prepareExecution(o.owner, body)); } catch (e) { return fail(c, e); }
});
agentExec.post("/send", async (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await sendExecution(o.owner, body)); } catch (e) { return fail(c, e); }
});
agentExec.get("/status/:sig", async (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  try { return c.json(await executionStatus(o.owner, c.req.param("sig"))); } catch (e) { return fail(c, e); }
});
agentExec.get("/mine", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const botId = c.req.query("botId") || null;
  return c.json({ lane: { provider: "NOWNodes", on: nownodesReady(), message: nownodesReady() ? null : OFF_MSG }, executions: myExecutions(o.owner, botId) });
});
