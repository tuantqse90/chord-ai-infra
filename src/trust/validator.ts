// Validation of an agent's track record through the ERC-8004 Validation Registry.
//  · The operator (the identity's owner) asks: a request document names the agent, the TrackRecord contract and a range of
//    committed fills; its keccak-256 goes on-chain with validationRequest(validator, agentId, requestURI, requestHash).
//  · The validator (its own key) replays the range from public data only — the chain and Chord's API — and answers with
//    validationResponse(requestHash, score 0–100, responseURI, responseHash, "replay"). Per fill:
//      1. hash      the served document hashes to the fillHash of the Committed event at its sequence (fatal);
//      2. chain     the hashes rebuild the head the chain recorded after the last fill of the range (fatal);
//      3. on time   the commit landed within 10 min of the fill (a record written when the outcome was still unknown);
//      4. price     the fill's price sits inside that minute's candle on Chord's Monad index (±2 %; no candle = not checked);
//      5. source    a copied trade is in Chord's index for that wallet and token, before the fill (not found = not checked).
//    Score = 0 when a fatal check fails, else the share of the checked items that passed. The full report is published.
// The hash, chain and timing checks run from anyone's machine against the published documents and Monad: scripts/verify.ts.
import type { Hex } from "viem";
import { logger } from "../chord/utils/logger";
import { chordMonad } from "../monad/chord";
import { MONAD_CHAIN_ID, AGENT_REGISTRY_ID } from "../monad/chain";
import { validatorAccount } from "../monad/client";
import { canonical, chainHead, hashDoc } from "./canonical";
import { blockTime, committedEvents, requestValidation, respondValidation, trustConfig } from "./chain";
import { agentRow, trustDb, validationRow, type FillRow, type ValidationRow } from "./registry";

export const ON_TIME_MS = 10 * 60_000;
export const PRICE_TOLERANCE = 0.02;
const REQUEST_GAP_MS = 10 * 60_000;
export const REQUEST_TYPE = "chord-agent-validation-request/v1";
export const REPORT_TYPE = "chord-agent-validation-report/v1";

export class ValidationInputError extends Error { constructor(msg: string, readonly status = 400) { super(msg); } }

/** Ask for a validation of the agent's fills not validated yet (at least one committed fill; one ask per 10 min). */
export async function askValidation(botId: string): Promise<ValidationRow> {
  const db = trustDb();
  const a = agentRow(botId);
  if (!a?.agent_id) throw new ValidationInputError("this agent has no ERC-8004 identity yet", 409);
  const v = validatorAccount();
  if (!v) throw new ValidationInputError("no validator is configured on this server", 503);
  const last = db.query("SELECT created_at, to_seq FROM trust_validations WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1").get(botId) as { created_at: number; to_seq: number } | null;
  if (last && Date.now() - last.created_at < REQUEST_GAP_MS) throw new ValidationInputError("a validation of this agent was asked less than 10 minutes ago", 429);
  const top = db.query("SELECT seq, head FROM trust_fills WHERE bot_id = ? AND commit_tx IS NOT NULL ORDER BY seq DESC LIMIT 1").get(botId) as { seq: number; head: string } | null;
  if (!top) throw new ValidationInputError("this agent has no committed fill yet", 409);
  const fromSeq = last && last.to_seq < top.seq ? last.to_seq + 1 : 1;
  const base = trustConfig.publicBase();
  const request = canonical({
    type: REQUEST_TYPE, chainId: MONAD_CHAIN_ID, agentRegistry: AGENT_REGISTRY_ID, agentId: a.agent_id,
    trackRecord: trustConfig.trackRecord(), range: { fromSeq, toSeq: top.seq }, headAtToSeq: top.head,
    fills: `${base}/v1/trust/agents/${botId}/fills?from=${fromSeq}&to=${top.seq}`,
    checks: ["hash", "chain", "on_time", "price", "source"], createdAt: Date.now(),
  });
  const requestHash = hashDoc(request);
  db.run(`INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [requestHash.toLowerCase(), botId, a.agent_id, v.address.toLowerCase(), fromSeq, top.seq, top.head, request, Date.now()]);
  try {
    const s = await requestValidation(v.address, a.agent_id, `${base}/v1/trust/validation/requests/${requestHash}.json`, requestHash);
    db.run("UPDATE trust_validations SET request_tx = ? WHERE request_hash = ?", [s.tx, requestHash.toLowerCase()]);
  } catch (e) {
    db.run("UPDATE trust_validations SET error = ? WHERE request_hash = ?", [String((e as Error)?.message ?? e).slice(0, 300), requestHash.toLowerCase()]);
    throw e;
  }
  void runValidation(requestHash).catch((e) => logger.warn({ err: String(e).slice(0, 200) }, "trust: validation failed"));
  return validationRow(requestHash)!;
}

type Check = { pass: boolean | null; note: string };
interface FillReport { seq: number; fillId: string; hash: Check; onTime: Check; price: Check; source: Check }

async function priceCheck(doc: any): Promise<Check> {
  const token = doc?.fill?.token, ts = Number(doc?.fill?.ts), px = Number(doc?.fill?.priceUsd);
  if (!token || !Number.isFinite(ts) || !(px > 0)) return { pass: null, note: "no price on the fill" };
  const fromS = Math.floor(ts / 1000) - 180, toS = Math.floor(ts / 1000) + 120;
  try {
    const j = await chordMonad<any>(`/candles?chain=${MONAD_CHAIN_ID}&token=${token}&tf=1m&from=${fromS}&to=${toS}&limit=10`);
    const cs = (Array.isArray(j?.candles) ? j.candles : []).filter((c: any) => Number(c.t) * 1000 <= ts).sort((a: any, b: any) => b.t - a.t);
    const c = cs[0];
    if (!c || ts - Number(c.t) * 1000 > 5 * 60_000) return { pass: null, note: "no candle within 5 min of the fill on Chord's index" };
    const lo = Number(c.l) * (1 - PRICE_TOLERANCE), hi = Number(c.h) * (1 + PRICE_TOLERANCE);
    const ok = px >= lo && px <= hi;
    return { pass: ok, note: `${ok ? "inside" : "outside"} the ${new Date(Number(c.t) * 1000).toISOString().slice(11, 16)} UTC candle ${Number(c.l).toPrecision(5)}–${Number(c.h).toPrecision(5)} (±${PRICE_TOLERANCE * 100}%), fill ${px.toPrecision(5)}` };
  } catch (e) { return { pass: null, note: `candles unreadable: ${String((e as Error)?.message ?? e).slice(0, 80)}` }; }
}
async function sourceCheck(doc: any): Promise<Check> {
  const s = doc?.source;
  if (!s || s.via === "strategy" || !s.tx || !s.wallet) return { pass: null, note: "fired by the strategy, no followed trade" };
  try {
    const j = await chordMonad<any>(`/tokens/trades/${doc.fill.token}?wallet=${s.wallet}&limit=100`);
    const hit = (Array.isArray(j?.trades) ? j.trades : []).find((t: any) => String(t.tx).toLowerCase() === String(s.tx).toLowerCase());
    if (!hit) return { pass: null, note: "the followed trade is not among the wallet's last 100 trades of this token on Chord's index" };
    const ok = Number(hit.ts) * 1000 <= Number(doc.fill.ts) + 1000;
    return { pass: ok, note: ok ? `${s.wallet.slice(0, 8)}… ${hit.side} at ${new Date(Number(hit.ts) * 1000).toISOString().slice(11, 19)} UTC, before the fill` : "the followed trade is dated after the fill" };
  } catch (e) { return { pass: null, note: `trades unreadable: ${String((e as Error)?.message ?? e).slice(0, 80)}` }; }
}

/** The validator's replay of one request, then its on-chain answer. */
export async function runValidation(requestHash: Hex): Promise<ValidationRow> {
  const db = trustDb();
  const row = validationRow(requestHash);
  if (!row) throw new ValidationInputError("unknown validation request", 404);
  if (row.response != null) return row;
  const fills = db.query("SELECT * FROM trust_fills WHERE bot_id = ? AND seq BETWEEN ? AND ? ORDER BY seq").all(row.bot_id, row.from_seq, row.to_seq) as FillRow[];
  const firstBlock = Math.min(...fills.map((f) => f.commit_block ?? Infinity));
  const events = Number.isFinite(firstBlock) ? await committedEvents(row.agent_id, firstBlock) : [];
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const times = new Map<number, number>();
  const items: FillReport[] = [];
  for (const f of fills) {
    const ev = bySeq.get(f.seq);
    const served = hashDoc(f.doc);
    const hash: Check = !ev ? { pass: false, note: `no Committed event for #${f.seq}` }
      : { pass: ev.fillHash.toLowerCase() === served.toLowerCase(), note: ev.fillHash.toLowerCase() === served.toLowerCase() ? `matches the event in ${ev.tx.slice(0, 10)}…` : "the document does not hash to the committed fillHash" };
    let onTime: Check = { pass: null, note: "not committed" };
    if (ev) {
      if (!times.has(ev.block)) times.set(ev.block, await blockTime(ev.block));
      const lag = times.get(ev.block)! - f.fill_ts;
      onTime = { pass: lag <= ON_TIME_MS, note: `committed ${Math.round(lag / 1000)} s after the fill (limit ${ON_TIME_MS / 60_000} min)` };
    }
    const doc = JSON.parse(f.doc);
    const [price, source] = await Promise.all([priceCheck(doc), sourceCheck(doc)]);
    items.push({ seq: f.seq, fillId: f.fill_id, hash, onTime, price, source });
  }
  // the chain: the head before the range (the event of fromSeq − 1, or zero) plus the range's hashes must give the event head at toSeq
  const before = row.from_seq > 1 ? (await committedEvents(row.agent_id, 0)).find((e) => e.seq === row.from_seq - 1)?.head : (`0x${"0".repeat(64)}` as Hex);
  const rebuilt = before ? chainHead(fills.map((f) => f.hash as Hex), before as Hex) : null;
  const atTo = bySeq.get(row.to_seq)?.head ?? null;
  const chain: Check = !rebuilt || !atTo ? { pass: false, note: "the chain around the range could not be read" }
    : { pass: rebuilt.toLowerCase() === atTo.toLowerCase(), note: rebuilt.toLowerCase() === atTo.toLowerCase() ? `rebuilt head ${atTo.slice(0, 12)}… matches the chain at #${row.to_seq}` : "the rebuilt head differs from the chain" };
  const fatal = !chain.pass || items.some((i) => !i.hash.pass);
  const graded = items.flatMap((i) => [i.onTime, i.price, i.source]).filter((c) => c.pass !== null);
  const passed = graded.filter((c) => c.pass).length;
  const score = fatal ? 0 : graded.length ? Math.round((passed / graded.length) * 100) : 100;
  const report = canonical({
    type: REPORT_TYPE, requestHash: requestHash.toLowerCase(), agentRegistry: AGENT_REGISTRY_ID, agentId: row.agent_id, range: { fromSeq: row.from_seq, toSeq: row.to_seq },
    score, fatal, chain, checked: graded.length, passed, items, validator: row.validator, at: Date.now(),
  });
  const responseHash = hashDoc(report);
  db.run("UPDATE trust_validations SET report = ?, response_hash = ? WHERE request_hash = ?", [report, responseHash, row.request_hash]);
  const s = await respondValidation(requestHash, score, `${trustConfig.publicBase()}/v1/trust/validation/responses/${requestHash}.json`, responseHash, "replay");
  db.run("UPDATE trust_validations SET response = ?, response_tx = ?, responded_at = ?, error = NULL WHERE request_hash = ?", [score, s.tx, s.timestamp, row.request_hash]);
  logger.info({ bot: row.bot_id, agentId: row.agent_id, score, fills: items.length, tx: s.tx }, "trust: validation answered");
  return validationRow(requestHash)!;
}

/** Requests asked but not answered (a restart mid-replay): answered again on boot. */
export async function resumeValidations(): Promise<void> {
  const open = trustDb().query("SELECT request_hash FROM trust_validations WHERE request_tx IS NOT NULL AND response IS NULL").all() as { request_hash: string }[];
  for (const r of open) await runValidation(r.request_hash as Hex).catch((e) => logger.warn({ err: String(e).slice(0, 200) }, "trust: resumed validation failed"));
}
