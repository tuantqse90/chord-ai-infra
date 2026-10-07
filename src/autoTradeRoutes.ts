// /v1/agents/auto: auto-trade through a Privy session signer (src/autoTrade.ts). Mounted BEFORE the other /v1/agents
// routers so "/auto/…" is never read as an agent id. The owner is the caller's X-Session (or `key:<id>`), as on /v1/agents/execute.
//   GET  /status?botId=      feature on?, the owner's grant and limits, spent today, auto agents, recent auto runs
//   POST /enable             { perTradeUsd 1..100, dailyUsd 1..500, slippageBps 10..300, days 1..30, wallet? } + the person's Privy
//                            access token (X-Privy-Token, or Authorization: Bearer <token>). The page adds our session signer to the
//                            wallet first (409 signer_missing { fix: "add" | "replace" } until it is there), then this records the limits.
//   POST /disable            kill switch: off at once; answers removeSigners: true so the page also takes the signer off the wallet
//   POST /agents/:botId      { on } auto-execute one of the owner's trading agents (on needs an enabled grant)
import { Hono } from "hono";
import { ownerOf } from "./agentExecRoutes";
import { AutoError, autoStatus, disableAutoTrade, enableAutoTrade, setAutoAgent } from "./autoTrade";
import { AuthError, verifyPrivyToken } from "./privyAuth";

let verifyToken: (token: string) => Promise<{ did: string }> = verifyPrivyToken;
export function _setAutoVerifier(f: ((token: string) => Promise<{ did: string }>) | null): void { verifyToken = f ?? verifyPrivyToken; }

function fail(c: any, e: unknown): Response {
  if (e instanceof AutoError) return c.json({ error: e.code, message: e.message, ...e.extra }, e.status);
  if (e instanceof AuthError) return c.json({ error: e.code, message: e.message }, e.status);
  return c.json({ error: "auto_error", message: String((e as Error)?.message ?? e).slice(0, 200) }, 500);
}

export const autoTrade = new Hono();

autoTrade.get("/status", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  try { return c.json(autoStatus(o.owner, c.req.query("botId") || null)); } catch (e) { return fail(c, e); }
});

autoTrade.post("/enable", async (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const token = c.req.header("x-privy-token") || (bearer && !bearer.startsWith("ak_") ? bearer : "");
  if (!token) return c.json({ error: "AUTH_REQUIRED", message: "sign in with your Chord account: auto-trade needs its Privy access token" }, 401);
  const body = await c.req.json().catch(() => ({}));
  try {
    const { did } = await verifyToken(token);
    return c.json({ grant: await enableAutoTrade(o.owner, did, body) });
  } catch (e) { return fail(c, e); }
});

autoTrade.post("/disable", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  try { return c.json({ ok: disableAutoTrade(o.owner), removeSigners: true }); } catch (e) { return fail(c, e); }
});

autoTrade.post("/agents/:botId", async (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(setAutoAgent(o.owner, c.req.param("botId"), (body as { on?: unknown })?.on)); } catch (e) { return fail(c, e); }
});
