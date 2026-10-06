// /v1/bots: bots as a service over HTTP (ask2049-notes/bots-contract.md). The owner of a bot is the caller's session: the
// X-Session id from the page, or `key:<id>` for a developer API key (Authorization: Bearer ak_live_… or X-API-Key).
// Phase 1 is paper mode only; live answers 403 until the owner switches on Privy session signers.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveKey, useKey, KEY_RPM } from "./devkeys";
import { backtest, createBot, deleteBot, getBot, leaderboard, listBots, setStatus, smartTraders, subscribe } from "./bots";

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

/** Engine errors carry their own HTTP meaning by name (BotInputError 400, BotLimitError 409, live mode 403). */
function fail(c: any, e: unknown): Response {
  const err = e as Error & { status?: number; code?: string };
  const name = err?.name ?? "";
  if (/Live/i.test(name) || err?.code === "live_not_enabled") return c.json({ error: "live_not_enabled", message: "Live mode signs from your own wallet under limits and is not switched on yet. Bots run in paper mode." }, 403);
  if (/Limit/i.test(name)) return c.json({ error: "too_many_bots", message: err.message }, 409);
  if (/Input|Validation/i.test(name)) return c.json({ error: "bad_request", message: err.message }, 400);
  return c.json({ error: "bot_error", message: String(err?.message ?? e).slice(0, 200) }, err?.status && err.status >= 400 && err.status < 600 ? err.status : 500);
}

const days = (v: unknown): 1 | 3 | 7 => (Number(v) === 1 ? 1 : Number(v) === 7 ? 7 : 3);

export const bots = new Hono();

bots.get("/traders", async (c) => {
  try { return c.json({ traders: await smartTraders(days(c.req.query("days")), Math.min(50, Number(c.req.query("limit")) || 20)) }); } catch (e) { return fail(c, e); }
});
bots.get("/leaderboard", (c) => c.json({ bots: leaderboard(50) }));
bots.get("/public/:id", (c) => {
  const b = getBot(null, c.req.param("id"));
  return b ? c.json(b) : c.json({ error: "not_found" }, 404);
});
bots.post("/backtest", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await backtest({ params: body.params, days: days(body.days) })); } catch (e) { return fail(c, e); }
});

bots.get("/", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  return c.json({ bots: listBots(o.owner) });
});
bots.post("/", async (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(createBot(o.owner, { name: body.name, type: body.type, params: body.params, mode: body.mode }), 201); } catch (e) { return fail(c, e); }
});
bots.get("/:id", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const b = getBot(o.owner, c.req.param("id"));
  return b ? c.json(b) : c.json({ error: "not_found" }, 404);
});
bots.post("/:id/pause", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const b = setStatus(o.owner, c.req.param("id"), "paused");
  return b ? c.json(b) : c.json({ error: "not_found" }, 404);
});
bots.post("/:id/resume", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const b = setStatus(o.owner, c.req.param("id"), "running");
  return b ? c.json(b) : c.json({ error: "not_found" }, 404);
});
bots.delete("/:id", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  return deleteBot(o.owner, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
bots.get("/:id/stream", (c) => {
  const o = ownerOf(c); if ("error" in o) return o.error;
  const id = c.req.param("id");
  if (!getBot(o.owner, id)) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    const off = subscribe(id, (e) => { if (open) stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => { open = false; }); });
    stream.onAbort(() => { open = false; off(); });
    // Keep-alive comment every 20 s; the stream ends when the client leaves (or after 30 minutes, the page reconnects).
    for (let i = 0; open && i < 90; i++) { await stream.sleep(20_000); if (open) await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => { open = false; }); }
    off();
  });
});
