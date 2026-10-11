// HTTP: the page, the Ask stream, the agents on Monad and their trust layer (ERC-8004 identity, track record, validation).
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ask, type AskEvent } from "./agent";
import { config, isNowNodes, providerName, viaLabel } from "./config";
import { dbEnabled } from "./db/pg";
import { enabledChains } from "./db/tools";
import { parsePaymentRef, redeemPayment } from "./pay";
import { paymentStats, readShare, refundAsk, saveFeedback, saveShare, session, spendAsk } from "./payments";
import { cleanShare } from "./share";
import { CATS, suggestions, type Cat } from "./suggest";
import { AuthError, verifyPrivyToken } from "./privyAuth";
import { createKey, KEY_RPM, listKeys, MAX_KEYS, resolveKey, revokeKey, usageSeries, useKey } from "./devkeys";
import { readFileSync } from "node:fs";
import { ledger } from "./rpc/ledger";
import { activeTools } from "./tools";
import { trade } from "./trade/routes";
import { bots, warmBoards } from "./botRoutes";
import { agents, startAgentsWarm } from "./agentsApi";
import { logos } from "./logos";
import { nownodesStatus } from "./nownodes";
import { startHeadlines, strategies } from "./strategyRoutes";
import { initBots } from "./bots";
import { trust } from "./trust/routes";
import { market } from "./market";
import { classic, startClassicWarm } from "./classic/routes";
import { startBoard } from "./classic/board";
import { lp } from "./lp/routes";
import { startCommitter } from "./trust/committer";
import { resumeValidations, startValidatorService } from "./trust/validator";
import { startChainIndex } from "./trust/open";

export const app = new Hono();

const SESSION_RE = /^[A-Za-z0-9:_-]{8,120}$/;
const sessionOf = (h: string | undefined) => (h && SESSION_RE.test(h) ? h : null);
const AskBody = z.object({
  question: z.string().trim().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(12).optional(),
});

function payInfo() {
  return {
    freeAsks: config.freeAsks(),
    unlimited: config.unlimitedAsks(),
    solana: config.treasurySol() ? { treasury: config.treasurySol(), mint: config.payMint(), price: config.priceUsdc(), asset: "USDC" } : null,
    cardano: config.treasuryAda() ? { treasury: config.treasuryAda(), price: config.priceAda(), asset: "ADA" } : null,
  };
}

app.get("/v1/config", (c) => c.json({
  appName: config.appName(),
  pay: payInfo(),
  nownodes: {
    solana: isNowNodes(config.solanaRpcUrl()) && !!config.nownodesKey(),
    cardano: isNowNodes(config.cardanoApiUrl()) && !!config.nownodesKey(),
    solanaEndpoint: providerName(config.solanaRpcUrl()),
  },
  databases: { index: dbEnabled("index"), solana: dbEnabled("solana") },
  indexChains: enabledChains(),
  tools: activeTools().map((t) => ({ name: t.name, via: viaLabel(t.via, t.provider) })),
  privy: config.privyAppId() ? { appId: config.privyAppId(), clientId: config.privyClientId() || null } : null,
}));

app.get("/v1/session", (c) => {
  const id = sessionOf(c.req.header("x-session"));
  if (!id) return c.json({ error: "bad_session", message: "send X-Session (8-120 chars: letters, digits, : _ -)" }, 400);
  return c.json(session(id));
});

app.get("/v1/suggest", async (c) => {
  const cat = String(c.req.query("cat") ?? "crypto") as Cat;
  if (!(CATS as readonly string[]).includes(cat)) return c.json({ error: "bad_request", message: `cat must be one of ${CATS.join(", ")}` }, 400);
  return c.json({ cat, items: await suggestions(cat) }, 200, { "Cache-Control": "public, max-age=60" });
});

// ── developer console: a signed-in Chord account (Privy access token) manages its API keys ──
async function devOwner(c: any): Promise<string | Response> {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  try { return (await verifyPrivyToken(token)).did; } catch (e) {
    const err = e instanceof AuthError ? e : new AuthError(401, "AUTH_FAILED", "sign in again");
    return c.json({ error: err.code, message: err.message }, err.status);
  }
}
app.get("/v1/dev/account", async (c) => {
  const owner = await devOwner(c); if (owner instanceof Response) return owner;
  const keys = listKeys(owner);
  const series = usageSeries(owner, 30);
  return c.json({ owner, plan: config.unlimitedAsks() ? { label: "Unlimited", note: "Free while the hackathon runs" } : { label: "Pay per ask", note: `${config.priceUsdc()} USDC or ${config.priceAda()} ADA per answer` }, limits: { rpm: KEY_RPM, maxKeys: MAX_KEYS }, usage: { today: series[series.length - 1].n, month: series.reduce((a, d) => a + d.n, 0) }, keys });
});
app.get("/v1/dev/usage", async (c) => {
  const owner = await devOwner(c); if (owner instanceof Response) return owner;
  return c.json({ days: usageSeries(owner, 30), keys: listKeys(owner) });
});
app.post("/v1/dev/keys", async (c) => {
  const owner = await devOwner(c); if (owner instanceof Response) return owner;
  const b = await c.req.json().catch(() => ({}));
  const k = createKey(owner, String(b.label ?? ""));
  if (!k) return c.json({ error: "too_many_keys", message: `At most ${MAX_KEYS} keys per account. Revoke one first.` }, 409);
  return c.json(k, 201);
});
app.delete("/v1/dev/keys/:id", async (c) => {
  const owner = await devOwner(c); if (owner instanceof Response) return owner;
  return revokeKey(owner, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
// The console is one static page; every /developer/* path serves it.
let devHtml: string | null = null;
// "/" is the landing page; the app (chat, agents, marketplace, trust) lives at /app. Old /#… and /?s= links are moved
// to /app by the landing page itself (a hash never reaches the server).
let landingHtml: string | null = null, appHtml: string | null = null;
app.get("/", (c) => { c.header("Cache-Control", "no-cache"); return c.html(landingHtml ??= readFileSync("public/landing.html", "utf8")); });
app.get("/app", (c) => { c.header("Cache-Control", "no-cache"); return c.html(appHtml ??= readFileSync("public/index.html", "utf8")); });
const devPage = (c: any) => { c.header("Cache-Control", "no-cache"); return c.html(devHtml ??= readFileSync("public/developer.html", "utf8")); };
app.get("/developer", devPage);
app.get("/developer/*", devPage);

app.post("/v1/share", async (c) => {
  const id = sessionOf(c.req.header("x-session"));
  const raw = await c.req.text();
  if (!id || raw.length > 400_000) return c.json({ error: "bad_request", message: "send X-Session and a chat under 400 KB" }, 400);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ error: "bad_request", message: "not JSON" }, 400); }
  const share = cleanShare(body);
  if (!share) return c.json({ error: "bad_request", message: "nothing to share" }, 400);
  const sid = saveShare(id, JSON.stringify(share));
  if (!sid) return c.json({ error: "rate_limited", message: "Too many shared chats today." }, 429);
  return c.json({ id: sid, url: `${new URL(c.req.url).origin.replace(/^http:/, "https:")}/app?s=${sid}` });
});
app.get("/v1/share/:id", (c) => {
  const id = c.req.param("id");
  const body = /^[0-9a-f]{12}$/.test(id) ? readShare(id) : null;
  return body ? c.body(body, 200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }) : c.json({ error: "not_found" }, 404);
});

app.post("/v1/feedback", async (c) => {
  const id = sessionOf(c.req.header("x-session"));
  const b = await c.req.json().catch(() => ({}));
  const rating = b.rating === "up" || b.rating === "down" ? b.rating : null;
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!id || !rating || !question) return c.json({ error: "bad_request", message: "send X-Session, question and rating up | down" }, 400);
  saveFeedback(id, question, rating);
  return c.json({ ok: true });
});

app.post("/v1/pay", async (c) => {
  const id = sessionOf(c.req.header("x-session"));
  const body = await c.req.json().catch(() => ({}));
  const ref = parsePaymentRef(`${body.chain ?? ""}:${String(body.ref ?? "").trim()}`);
  if (!id) return c.json({ error: "bad_session", message: "send X-Session" }, 400);
  if (!ref) return c.json({ error: "bad_payment", message: "chain must be solana or cardano, ref a transaction signature / hash" }, 400);
  const r = await redeemPayment(ref.chain, ref.ref, id).catch((e) => ({ ok: false as const, status: 502, reason: `could not read the chain: ${(e as Error).message}` }));
  if (!r.ok) return c.json({ error: "payment_rejected", message: r.reason }, r.status as 402);
  return c.json({ ...r, session: session(id) });
});

app.post("/v1/ask", async (c) => {
  const parsed = AskBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad_request", message: "body must be { question, history? }" }, 400);
  let id = sessionOf(c.req.header("x-session"));
  // API key from the developer console: Authorization: Bearer ak_live_… or X-API-Key. The key is its own session.
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? "";
  if (bearer.startsWith("ak_")) {
    const k = resolveKey(bearer);
    if (!k) return c.json({ error: "bad_key", message: "unknown or revoked API key" }, 401);
    if (!useKey(k.id)) return c.json({ error: "rate_limited", message: `${KEY_RPM} requests a minute per key` }, 429);
    id = `key:${k.id}`;
  }
  // Pay-per-call for agents: X-Payment: solana:<signature> | cardano:<txhash>. The leftover credits stay on a session we return.
  const payHeader = c.req.header("x-payment");
  if (payHeader) {
    const ref = parsePaymentRef(payHeader);
    if (!ref) return c.json({ error: "bad_payment", message: "X-Payment must be solana:<signature> or cardano:<txhash>" }, 400);
    id = id ?? `pay:${ref.ref.slice(0, 64)}`;
    const r = await redeemPayment(ref.chain, ref.ref, id).catch((e) => ({ ok: false as const, status: 502, reason: `could not read the chain: ${(e as Error).message}` }));
    if (!r.ok && r.status !== 409) return c.json({ error: "payment_rejected", message: r.reason, pay: payInfo() }, r.status as 402);
  }
  if (!id) return c.json({ error: "payment_required", message: "send X-Session (web) or X-Payment (agents)", pay: payInfo() }, 402);
  const spent = spendAsk(id);
  if (!spent.ok) return c.json({ error: "payment_required", message: "no free asks or credits left on this session", pay: payInfo(), session: session(id) }, 402);
  c.header("X-Session", id);
  return streamSSE(c, async (stream) => {
    let failed = false;
    // one writer at a time; a ping every 15 s keeps proxies from cutting a turn whose tool runs long (a replay can take 2 min:
    // QA 07/10 saw the stream dropped after 137 s of silence)
    let chain: Promise<unknown> = Promise.resolve();
    const write = (event: string, data: unknown) => (chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {}));
    const beat = setInterval(() => { void write("ping", {}); }, 15_000);
    try {
      await ask(parsed.data.question, parsed.data.history ?? [], async (e: AskEvent) => {
        if (e.type === "error") failed = true;
        await write(e.type, e.type === "answer" ? { ...e, session: session(id!) } : e);
      }, { session: id! });
      if (failed) refundAsk(id!, spent.source!);
      await write("done", { session: session(id!) });
    } finally { clearInterval(beat); }
  });
});

app.route("/v1/trade", trade);
// Agents (documented path) = the public board / feed / stats first, then the same routes as /v1/bots (kept as an alias).
app.route("/v1/agents/lp", lp); // LP agents on Monad: pool scan, range backtests (src/lp)
app.route("/v1/agents", agents);
app.route("/v1/agents", bots);
app.route("/v1/bots", bots);
app.route("/v1/strategies", strategies);
// the trust API and the SDK are for other sites and agents too: any origin may read them (nothing here uses cookies)
app.use("/v1/trust/*", cors());
app.use("/sdk/*", cors());
app.route("/v1/trust", trust); // ERC-8004 identity, TrackRecord commits, validations, reputation (src/trust)
app.route("/v1/market", market); // listed agents ranked by their record on Monad (src/market.ts)
app.route("/v1/classic", classic); // classic strategies backtested on Binance, OKX, Hyperliquid and Perpl (src/classic)
app.route("/v1/logo", logos); // a token's real picture (Jupiter icon, else Chord's)

// nownodes = the agents' swap lane (src/nownodes.ts: key set, calls per method, last ok); rpc = every read call by provider and method.
app.get("/v1/status", (c) => c.json({ nownodes: nownodesStatus(), rpc: ledger(), payments: paymentStats(), databases: { index: dbEnabled("index"), solana: dbEnabled("solana") } }));

// The page must never be served stale by a CDN; assets carry ?v= so they can be cached briefly.
app.use("/*", async (c, next) => {
  await next();
  const p = new URL(c.req.url).pathname;
  if (p === "/" || p.endsWith(".html")) c.header("Cache-Control", "no-cache");
  else if (/\.(m?js|css)$/.test(p)) c.header("Cache-Control", "public, max-age=300");
});
app.use("/*", serveStatic({ root: "./public" }));

if (import.meta.main) {
  const port = config.port();
  Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });
  startHeadlines(); // template backtest headlines for the Agents page, hourly
  initBots(); // load running bots, start their triggers (paper fills) and marking
  startCommitter(); // ERC-8004 identities + every filled fill committed to its TrackRecord chain on Monad
  void resumeValidations();
  startChainIndex(); // every commit on TrackRecord (any agent), for outside agents and the document host
  startValidatorService(); // answers requests addressed to the validator, validates this app's agents on its own
  startAgentsWarm(); // hero, board and smart money kept warm
  startClassicWarm(); // classic strategy headlines on four data sources, every 6 h
  startBoard(); // the backtest board: every strategy × Perpl market × 1h / 4h over 1, 3 and 6 months, every 12 h
  warmBoards(); // the Smart traders board kept warm
  console.log(`${config.appName()} Ask on http://localhost:${port} · Solana RPC ${providerName(config.solanaRpcUrl())}${config.nownodesKey() ? " (key set)" : " (no NOWNodes key)"}`);
}
