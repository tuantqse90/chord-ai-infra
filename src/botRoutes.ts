// /v1/agents (alias /v1/bots): agents as a service over HTTP. The owner of an agent is the caller's session: the X-Session id
// from the page, or `key:<id>` for a developer API key (Authorization: Bearer ak_live_… or X-API-Key). Paper mode only.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveKey, useKey, KEY_RPM } from "./devkeys";
import { keepFresh, swr } from "./swr";
import { longJob, StillRunning } from "./longJob";
import { createHash } from "node:crypto";
const jobKey = (kind: string, input: unknown) => `${kind}:${createHash("sha1").update(JSON.stringify(input ?? null)).digest("hex")}`;
import { backtest, botsStatus, createBot, deleteBot, getBot, leaderboard, listBots, setStatus, smartTraders, subscribe } from "./bots";

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
  if (e instanceof StillRunning) return c.json({ error: e.code, message: e.message }, 503);
  // Chord's Monad reads time out while the shared box is throttled: say "slow, try again", not a 500
  if (/timed out|timeout|answered 5\d\d/i.test(String(err?.message ?? ""))) return c.json({ error: "upstream_slow", message: "Chord's Monad data is slow right now: try again in a minute." }, 503);
  return c.json({ error: "bot_error", message: String(err?.message ?? e).slice(0, 200) }, err?.status && err.status >= 400 && err.status < 600 ? err.status : 500);
}

const days = (v: unknown): 1 | 3 | 7 => (Number(v) === 1 ? 1 : Number(v) === 7 ? 7 : 3);

export const bots = new Hono();

bots.get("/traders", async (c) => {
  const d = days(c.req.query("days")), n = Math.min(100, Number(c.req.query("limit")) || 20);
  try { return c.json({ traders: await swr(`traders:${d}:${n}`, 120_000, () => smartTraders(d, n)) }); } catch (e) { return fail(c, e); }
});
/** Engine health: the chain socket (connected, subscriptions), the tape poller, running bots. No wallets inside. */
bots.get("/status", (c) => {
  const st: any = botsStatus();
  const scrub = (v: any): any => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : typeof v === "string" ? v.replace(/(https?|wss?):\/\/\S+/g, "[endpoint]") : v);
  return c.json(scrub(st));
});
bots.get("/leaderboard", (c) => c.json({ bots: leaderboard(50) }));
bots.get("/public/:id", (c) => {
  const b = getBot(null, c.req.param("id"));
  if (!b) return c.json({ error: "not_found" }, 404);
  const viewer = ownerOf(c);
  return c.json(b);
});
bots.post("/backtest", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const input = { params: body.params, days: days(body.days) };
  try { return c.json(await longJob(jobKey("bt", input), () => backtest(input))); } catch (e) { return fail(c, e); }
});

/** On boot: keep the Smart traders board warm (the tab opens on 1 day). */
export function warmBoards(): void {
  keepFresh("traders:1:100", 300_000, () => smartTraders(1, 100));
}

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
    await stream.writeSSE({ event: "ping", data: "{}" }); // the page shows "live" at once, not after the first 20 s keep-alive
    // Keep-alive comment every 20 s; the stream ends when the client leaves (or after 30 minutes, the page reconnects).
    for (let i = 0; open && i < 90; i++) { await stream.sleep(20_000); if (open) await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => { open = false; }); }
    off();
  });
});
