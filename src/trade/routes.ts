// /v1/trade/*: token lists, quotes on both lanes, and the Solana build → relay → status steps.
import { Hono } from "hono";
import { TradeError } from "./amounts";
import { EVM, isEvm, TRADE_CHAINS, type TradeChain } from "./chains";
import { evmQuote, evmTokens } from "./evm";
import { solBuild, solQuote, solSend, solStatus, solTokens } from "./solana";

export const trade = new Hono();

const fail = (c: any, e: unknown) => {
  if (e instanceof TradeError) return c.json({ error: "trade", message: e.message }, e.status);
  return c.json({ error: "upstream", message: String((e as Error)?.message ?? e).replace(/(https?|wss?):\/\/\S+/g, "[endpoint]").slice(0, 200) }, 502);
};
const chainOf = (v: string | undefined): TradeChain => {
  const k = String(v ?? "").toLowerCase();
  if (!(TRADE_CHAINS as string[]).includes(k)) throw new TradeError(`chain must be one of ${TRADE_CHAINS.join(", ")}`);
  return k as TradeChain;
};
const slip = (v: string | undefined) => { const n = Math.round(Number(v ?? 50)); return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 50; };

trade.get("/chains", (c) => c.json({ chains: TRADE_CHAINS.map((k) => k === "solana"
  ? { key: k, name: "Solana", kind: "solana", provider: "Jupiter" }
  : { key: k, name: EVM[k].name, kind: "evm", chainId: EVM[k].id, hex: EVM[k].hex, provider: "Chord router", native: EVM[k].native, explorer: EVM[k].explorer, rpc: EVM[k].rpc }) }));

trade.get("/tokens", async (c) => {
  try {
    const chain = chainOf(c.req.query("chain"));
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    if (chain === "solana") return c.json({ chain, tokens: await solTokens(q) });
    const list = await evmTokens(chain);
    const out = q ? list.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address === q) : list;
    return c.json({ chain, tokens: out.slice(0, q ? 50 : 80) });
  } catch (e) { return fail(c, e); }
});

trade.get("/quote", async (c) => {
  try {
    const chain = chainOf(c.req.query("chain"));
    const tin = c.req.query("in") ?? "", tout = c.req.query("out") ?? "", amount = c.req.query("amount") ?? "";
    if (chain === "solana") return c.json(await solQuote(tin, tout, amount, slip(c.req.query("slippageBps"))));
    if (!isEvm(chain)) throw new TradeError("unknown chain");
    return c.json(await evmQuote(chain, tin, tout, amount, slip(c.req.query("slippageBps")), c.req.query("taker") || null));
  } catch (e) { return fail(c, e); }
});

trade.post("/sol/build", async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await solBuild(String(b.quoteId ?? ""), String(b.user ?? "")));
  } catch (e) { return fail(c, e); }
});

trade.post("/sol/send", async (c) => {
  try {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await solSend(String(b.transaction ?? "")));
  } catch (e) { return fail(c, e); }
});

trade.get("/sol/status", async (c) => {
  try {
    const sig = c.req.query("sig") ?? "";
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) throw new TradeError("sig must be a Solana signature");
    return c.json(await solStatus(sig));
  } catch (e) { return fail(c, e); }
});
