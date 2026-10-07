// /v1/x402: this server as an x402 facilitator for "exact" on Solana (src/x402.ts), the spec's HTTP API.
//   GET  /supported   { kinds: [{ x402Version 2 | 1, scheme: "exact", network, extra: { feePayer } }], signers }
//   POST /verify      { x402Version, paymentPayload, paymentRequirements } → { isValid, invalidReason?, payer? }
//   POST /settle      same body → { success, errorReason?, payer, transaction, network }. Settles ONLY for a payTo that is the
//                     payout wallet of a live marketplace listing (or X402_SETTLE_PAYTO): our fee payer's SOL is not a public faucet.
// v1 requirements (network "solana", maxAmountRequired) are read as their v2 twin. Every call reads through NOWNodes.
import { Hono } from "hono";
import { listings } from "./marketplace";
import { facilitatorReady, facilitatorStatus, feePayer, settle, SOLANA_CAIP2, verify, type Requirements } from "./x402";

export const x402 = new Hono();

const hits = new Map<string, number[]>();
function allow(c: any, perMin: number): boolean {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
  const t = Date.now(), list = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
  if (list.length >= perMin) { hits.set(ip, list); return false; }
  list.push(t); hits.set(ip, list);
  return true;
}
/** the body's requirements in the v2 shape (a v1 body says network "solana" and maxAmountRequired) */
function reqOf(r: any): Requirements | null {
  if (!r || typeof r !== "object") return null;
  const network = r.network === "solana" ? SOLANA_CAIP2 : r.network;
  const amount = String(r.amount ?? r.maxAmountRequired ?? "");
  if (r.scheme !== "exact" || network !== SOLANA_CAIP2 || !/^\d+$/.test(amount) || typeof r.asset !== "string" || typeof r.payTo !== "string") return null;
  return { scheme: "exact", network, amount, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: Number(r.maxTimeoutSeconds) || 120, extra: { ...(r.extra ?? {}) } };
}
const txOf = (p: any): string | null => (typeof p?.payload?.transaction === "string" ? p.payload.transaction : null);
const settleable = (payTo: string) => listings().some((l) => l.payTo === payTo) || (process.env.X402_SETTLE_PAYTO ?? "").split(",").map((x) => x.trim()).includes(payTo);

x402.get("/supported", (c) => {
  const fp = feePayer();
  if (!fp || !facilitatorReady()) return c.json({ kinds: [], extensions: [], signers: {}, status: facilitatorStatus(), message: fp ? "the fee payer has no SOL yet" : "the facilitator is not configured on this server" });
  const extra = { feePayer: fp.publicKey.toBase58() };
  return c.json({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_CAIP2, extra }, { x402Version: 1, scheme: "exact", network: "solana", extra }],
    extensions: [], signers: { "solana:*": [extra.feePayer] }, settles: "payout wallets of this server's marketplace listings", via: "NOWNodes" });
});
x402.post("/verify", async (c) => {
  if (!allow(c, 60)) return c.json({ isValid: false, invalidReason: "rate_limited" }, 429);
  const b = await c.req.json().catch(() => null);
  const r = reqOf(b?.paymentRequirements), tx = txOf(b?.paymentPayload);
  if (!r || !tx) return c.json({ isValid: false, invalidReason: "invalid_payload", message: "send { x402Version, paymentPayload: { payload: { transaction } }, paymentRequirements }" }, 400);
  if (!facilitatorReady()) return c.json({ isValid: false, invalidReason: "facilitator_off" }, 503);
  return c.json(await verify(tx, r));
});
x402.post("/settle", async (c) => {
  if (!allow(c, 20)) return c.json({ success: false, errorReason: "rate_limited", transaction: "", network: SOLANA_CAIP2 }, 429);
  const b = await c.req.json().catch(() => null);
  const r = reqOf(b?.paymentRequirements), tx = txOf(b?.paymentPayload);
  if (!r || !tx) return c.json({ success: false, errorReason: "invalid_payload", transaction: "", network: SOLANA_CAIP2 }, 400);
  if (!facilitatorReady()) return c.json({ success: false, errorReason: "facilitator_off", transaction: "", network: SOLANA_CAIP2 }, 503);
  if (!settleable(r.payTo)) return c.json({ success: false, errorReason: "pay_to_not_served", message: "this facilitator settles only for its marketplace's payout wallets", transaction: "", network: SOLANA_CAIP2 }, 403);
  return c.json(await settle(tx, r));
});
