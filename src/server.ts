// HTTP: the page, the Ask stream, payments and the NOWNodes usage ledger.
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ask, type AskEvent } from "./agent";
import { config, isNowNodes, providerName, viaLabel } from "./config";
import { dbEnabled } from "./db/pg";
import { enabledChains } from "./db/tools";
import { parsePaymentRef, redeemPayment } from "./pay";
import { paymentStats, refundAsk, session, spendAsk } from "./payments";
import { ledger } from "./rpc/ledger";
import { activeTools } from "./tools";
import { trade } from "./trade/routes";

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
  tools: activeTools().map((t) => ({ name: t.name, via: viaLabel(t.via) })),
}));

app.get("/v1/session", (c) => {
  const id = sessionOf(c.req.header("x-session"));
  if (!id) return c.json({ error: "bad_session", message: "send X-Session (8-120 chars: letters, digits, : _ -)" }, 400);
  return c.json(session(id));
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
    await ask(parsed.data.question, parsed.data.history ?? [], async (e: AskEvent) => {
      if (e.type === "error") failed = true;
      const payload = e.type === "answer" ? { ...e, session: session(id!) } : e;
      await stream.writeSSE({ event: e.type, data: JSON.stringify(payload) });
    });
    if (failed) refundAsk(id!, spent.source!);
    await stream.writeSSE({ event: "done", data: JSON.stringify({ session: session(id!) }) });
  });
});

app.route("/v1/trade", trade);

app.get("/v1/status", (c) => c.json({ nownodes: ledger(), payments: paymentStats(), databases: { index: dbEnabled("index"), solana: dbEnabled("solana") } }));

// The page must never be served stale by a CDN; assets carry ?v= so they can be cached briefly.
app.use("/*", async (c, next) => {
  await next();
  const p = new URL(c.req.url).pathname;
  if (p === "/" || p.endsWith(".html")) c.header("Cache-Control", "no-cache");
  else if (/\.(js|css)$/.test(p)) c.header("Cache-Control", "public, max-age=300");
});
app.use("/*", serveStatic({ root: "./public" }));

if (import.meta.main) {
  const port = config.port();
  Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });
  console.log(`${config.appName()} Ask on http://localhost:${port} · Solana RPC ${providerName(config.solanaRpcUrl())}${config.nownodesKey() ? " (key set)" : " (no NOWNodes key)"}`);
}
