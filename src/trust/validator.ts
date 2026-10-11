// Validation of an agent's track record through the ERC-8004 Validation Registry.
//  · The operator (the identity's owner) asks: a request document names the agent, the TrackRecord contract and a range of
//    committed fills; its keccak-256 goes on-chain with validationRequest(validator, agentId, requestURI, requestHash).
//  · The validator (its own key) replays the range from public data only — the chain and Chord's API — and answers with
//    validationResponse(requestHash, score 0–100, responseURI, responseHash, "replay"). Per fill:
//      1. hash      the served document hashes to the fillHash of the Committed event at its sequence (fatal);
//      2. chain     the hashes rebuild the head the chain recorded after the last fill of the range (fatal);
//      3. on time   the commit landed within 10 min of the fill (a record written when the outcome was still unknown);
//      4. price     the fill's price sits inside that minute's candle on Chord's Monad index (±2 %; no candle = not checked);
//                   a perp fill on Perpl (token perpl:<SYMBOL>) sits inside Perpl's own 1m candle (±0.5 %);
//      5. source    a copied trade is in Chord's index for that wallet and token, before the fill (not found = not checked).
//    Score = 0 when a fatal check fails, else the share of the checked items that passed. The full report is published.
// The hash, chain and timing checks run from anyone's machine against the published documents and Monad: scripts/verify.ts.
import { candles as perplCandles, market as perplMarket } from "../perpl/client";
import { decodeEventLog, type Hex } from "viem";
import { logger } from "../chord/utils/logger";
import { chordMonad } from "../monad/chord";
import { MONAD_CHAIN_ID, AGENT_REGISTRY_ID } from "../monad/chain";
import { validatorAccount } from "../monad/client";
import { canonical, chainHead, hashDoc } from "./canonical";
import { blockTime, committedEventsAt, requestValidation, respondValidation, trustConfig } from "./chain";
import { agentRow, trustDb, validationRow, type FillRow, type ValidationRow } from "./registry";
import { chainOf, meta, onchainFills, setMeta, syncChain } from "./open";
import { safeFetch } from "./safeFetch";
import { balances } from "./chain";
import { publicClient } from "../monad/client";
import { validationAbi } from "./abi";

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

/** A perp fill on Perpl (token "perpl:<SYMBOL>"): inside that minute's candle on Perpl itself (±0.5 %). */
async function perpPriceCheck(symbol: string, ts: number, px: number): Promise<Check> {
  try {
    const m = await perplMarket(symbol);
    if (!m) return { pass: null, note: `${symbol} is not listed on Perpl` };
    const cs = (await perplCandles(m, 60, ts - 180_000, ts + 60_000)).filter((c) => c.t <= ts).sort((a, b) => b.t - a.t);
    const c = cs[0];
    if (!c || ts - c.t > 5 * 60_000) return { pass: null, note: "no Perpl candle within 5 min of the fill" };
    const lo = c.l * (1 - PERP_TOLERANCE), hi = c.h * (1 + PERP_TOLERANCE), ok = px >= lo && px <= hi;
    return { pass: ok, note: `${ok ? "inside" : "outside"} Perpl's ${new Date(c.t).toISOString().slice(11, 16)} UTC 1m candle ${c.l.toPrecision(6)}–${c.h.toPrecision(6)} (±${PERP_TOLERANCE * 100}%), fill ${px.toPrecision(6)}` };
  } catch (e) { return { pass: null, note: `Perpl candles unreadable: ${String((e as Error)?.message ?? e).slice(0, 80)}` }; }
}
const PERP_TOLERANCE = 0.005;

async function priceCheck(doc: any): Promise<Check> {
  const token = doc?.fill?.token, ts = Number(doc?.fill?.ts), px = Number(doc?.fill?.priceUsd);
  if (!token || !Number.isFinite(ts) || !(px > 0)) return { pass: null, note: "no price on the fill" };
  if (typeof token === "string" && token.startsWith("perpl:")) return perpPriceCheck(token.slice(6), ts, px);
  if (typeof token === "string" && token.startsWith("lp:")) return { pass: null, note: "a liquidity position has no single market price to check" };
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

/** One fill as the replay sees it: this app's own (from its record) or an outside agent's (the chain index joined with the
 *  published document; a fill with no published document fails its hash check). */
interface ReplayFill { seq: number; fill_id: string; doc: string | null; fill_ts: number | null; commit_block: number | null }
/** An outside agent's validation rows carry bot_id "ext:<agentId>". */
export const extBotId = (agentId: string) => `ext:${agentId}`;
function fillsOfRequest(row: ValidationRow): ReplayFill[] {
  if (row.bot_id.startsWith("ext:")) return onchainFills(row.agent_id, row.from_seq, row.to_seq).map((f) => ({ seq: f.seq, fill_id: f.hash, doc: f.doc, fill_ts: f.fillTs, commit_block: f.commitBlock }));
  return (trustDb().query("SELECT * FROM trust_fills WHERE bot_id = ? AND seq BETWEEN ? AND ? ORDER BY seq").all(row.bot_id, row.from_seq, row.to_seq) as FillRow[])
    .map((f) => ({ seq: f.seq, fill_id: f.fill_id, doc: f.doc, fill_ts: f.fill_ts, commit_block: f.commit_block }));
}
function prevBlockOf(row: ValidationRow): number | null {
  if (row.from_seq <= 1) return null;
  if (row.bot_id.startsWith("ext:")) return chainOf(row.agent_id).find((e) => e.seq === row.from_seq - 1)?.block ?? null;
  return (trustDb().query("SELECT commit_block FROM trust_fills WHERE bot_id = ? AND seq = ?").get(row.bot_id, row.from_seq - 1) as { commit_block: number | null } | null)?.commit_block ?? null;
}

/** The validator's replay of one request, then its on-chain answer. */
export async function runValidation(requestHash: Hex): Promise<ValidationRow> {
  const db = trustDb();
  const row = validationRow(requestHash);
  if (!row) throw new ValidationInputError("unknown validation request", 404);
  if (row.response != null) return row;
  const fills = fillsOfRequest(row);
  // the events sit in the blocks the commits landed in, plus the block of the fill before the range (its head starts the chain)
  const prevBlock = prevBlockOf(row);
  const blocks = [...fills.map((f) => f.commit_block), prevBlock].filter((b): b is number => b != null);
  const events = blocks.length ? await committedEventsAt(row.agent_id, blocks) : [];
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const times = new Map<number, number>();
  const items: FillReport[] = [];
  for (const f of fills) {
    const ev = bySeq.get(f.seq);
    const served = f.doc == null ? null : hashDoc(f.doc);
    const hash: Check = !ev ? { pass: false, note: `no Committed event for #${f.seq}` }
      : served == null ? { pass: false, note: `no published document for #${f.seq}` }
      : { pass: ev.fillHash.toLowerCase() === served.toLowerCase(), note: ev.fillHash.toLowerCase() === served.toLowerCase() ? `matches the event in ${ev.tx.slice(0, 10)}…` : "the document does not hash to the committed fillHash" };
    let onTime: Check = { pass: null, note: "not committed" };
    if (ev && f.fill_ts != null) {
      if (!times.has(ev.block)) times.set(ev.block, await blockTime(ev.block));
      const lag = times.get(ev.block)! - f.fill_ts;
      onTime = { pass: lag <= ON_TIME_MS, note: `committed ${Math.round(lag / 1000)} s after the fill (limit ${ON_TIME_MS / 60_000} min)` };
    } else if (ev) onTime = { pass: null, note: "the document carries no fill time (fill.ts)" };
    let doc: any = null;
    try { doc = f.doc == null ? null : JSON.parse(f.doc); } catch { /* not JSON */ }
    const [price, source] = doc ? await Promise.all([priceCheck(doc), sourceCheck(doc)]) : [{ pass: null, note: "no document" } as Check, { pass: null, note: "no document" } as Check];
    items.push({ seq: f.seq, fillId: f.fill_id, hash, onTime, price, source });
  }
  // the chain: the head before the range (the event of fromSeq − 1, or zero) plus the range's hashes must give the event head at toSeq
  const before = row.from_seq > 1 ? bySeq.get(row.from_seq - 1)?.head : (`0x${"0".repeat(64)}` as Hex);
  const allDocs = fills.length === row.to_seq - row.from_seq + 1 && fills.every((f) => f.doc != null);
  const rebuilt = before && allDocs ? chainHead(fills.map((f) => hashDoc(f.doc!) as Hex), before as Hex) : null;
  const atTo = bySeq.get(row.to_seq)?.head ?? null;
  const chain: Check = !allDocs ? { pass: false, note: "a fill of the range has no published document, so the chain cannot be rebuilt" }
    : !rebuilt || !atTo ? { pass: false, note: "the chain around the range could not be read" }
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

// ── outside agents ask too ────────────────────────────────────────────────────────────────────────────────────────────
// Any ERC-8004 agent can point a validationRequest at this validator. Its request document (at requestURI, hashing to
// requestHash) names the range; the replay reads the chain index and the documents published on the document host. Limits
// keep a stranger from draining the validator: EXT_VALIDATIONS_PER_DAY in all (default 20), one per agent per hour, at most
// 200 fills a request.
const EXT_PER_DAY = () => Number(process.env.EXT_VALIDATIONS_PER_DAY || 20);
const EXT_MAX_RANGE = 200;
export interface RequestEvent { requestHash: Hex; agentId: string; requestURI: string; validator: string; tx: Hex | null }
export async function acceptExternalRequest(ev: RequestEvent): Promise<ValidationRow | null> {
  const db = trustDb(), hash = ev.requestHash.toLowerCase();
  const known = validationRow(hash);
  if (known) return known;
  const v = validatorAccount();
  if (!v || ev.validator.toLowerCase() !== v.address.toLowerCase()) return null;
  if (db.query("SELECT 1 FROM trust_agents WHERE agent_id = ?").get(ev.agentId)) return null; // this app's own agents ask through askValidation
  const now = Date.now(), bot = extBotId(ev.agentId);
  const refuse = (error: string) => { db.run(`INSERT OR IGNORE INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, request_tx, created_at, error) VALUES (?, ?, ?, ?, 0, 0, '', '', ?, ?, ?)`, [hash, bot, ev.agentId, v.address.toLowerCase(), ev.tx, now, error]); logger.info({ agentId: ev.agentId, hash, error }, "trust: outside validation refused"); return validationRow(hash); };
  const today = (db.query("SELECT COUNT(*) AS n FROM trust_validations WHERE bot_id LIKE 'ext:%' AND error IS NULL AND created_at > ?").get(now - 86_400_000) as { n: number }).n;
  if (today >= EXT_PER_DAY()) return refuse(`this validator answers ${EXT_PER_DAY()} outside requests a day; try again tomorrow`);
  const recent = db.query("SELECT 1 FROM trust_validations WHERE bot_id = ? AND error IS NULL AND created_at > ?").get(bot, now - 3_600_000);
  if (recent) return refuse("one request per agent per hour");
  if (!/^https?:\/\//.test(ev.requestURI)) return refuse("requestURI must be an http(s) URL");
  let text: string;
  try { const r = await safeFetch(ev.requestURI, { signal: AbortSignal.timeout(5_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); text = (await r.text()).slice(0, 65_536); }
  catch (e) { return refuse(`requestURI did not load: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
  if (hashDoc(text).toLowerCase() !== hash) return refuse("the request document does not hash to requestHash");
  let req: any = null;
  try { req = JSON.parse(text); } catch { return refuse("the request document is not JSON"); }
  await syncChain(60);
  const chain = chainOf(ev.agentId);
  if (!chain.length) return refuse("this agent has no commit on TrackRecord yet");
  const top = chain[chain.length - 1]!.seq;
  const fromSeq = Number.isInteger(req?.range?.fromSeq) && req.range.fromSeq >= 1 ? req.range.fromSeq : 1;
  const toSeq = Number.isInteger(req?.range?.toSeq) ? Math.min(req.range.toSeq, top) : top;
  if (toSeq < fromSeq) return refuse("the range holds no committed fill");
  if (toSeq - fromSeq + 1 > EXT_MAX_RANGE) return refuse(`at most ${EXT_MAX_RANGE} fills a request`);
  const head = chain.find((e) => e.seq === toSeq)?.head ?? "";
  db.run(`INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, request_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [hash, bot, ev.agentId, v.address.toLowerCase(), fromSeq, toSeq, head, text, ev.tx, now]);
  logger.info({ agentId: ev.agentId, hash, fromSeq, toSeq }, "trust: outside validation accepted");
  void runValidation(hash as Hex).catch((e) => logger.warn({ err: String(e).slice(0, 200) }, "trust: outside validation failed"));
  return validationRow(hash);
}
/** The ValidationRequest events of a transaction (an agent tells us right after it asks: POST /validation/notify). */
export async function requestsInTx(tx: Hex): Promise<RequestEvent[]> {
  const reg = trustConfig.validationRegistry(); if (!reg) return [];
  const r = await publicClient().getTransactionReceipt({ hash: tx });
  const out: RequestEvent[] = [];
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== reg.toLowerCase()) continue;
    try { const d = decodeEventLog({ abi: validationAbi, data: l.data, topics: l.topics }) as any; if (d.eventName === "ValidationRequest") out.push({ requestHash: d.args.requestHash, agentId: d.args.agentId.toString(), requestURI: d.args.requestURI, validator: d.args.validatorAddress, tx }); } catch { /* another event */ }
  }
  return out;
}
/** Requests addressed to this validator since the last look (100-block windows from a cursor). */
async function pollRequests(): Promise<void> {
  const reg = trustConfig.validationRegistry(), v = validatorAccount(); if (!reg || !v) return;
  const pc = publicClient(), head = Number(await pc.getBlockNumber());
  let from = Number(meta("vreq_cursor") ?? head - 3_000) + 1;
  for (let i = 0; i < 60 && from <= head; i++) {
    const to = Math.min(head, from + 99);
    const logs = await pc.getContractEvents({ address: reg, abi: validationAbi, eventName: "ValidationRequest", args: { validatorAddress: v.address }, fromBlock: BigInt(from), toBlock: BigInt(to) }) as any[];
    for (const l of logs) await acceptExternalRequest({ requestHash: l.args.requestHash, agentId: l.args.agentId.toString(), requestURI: l.args.requestURI, validator: l.args.validatorAddress, tx: l.transactionHash }).catch(() => null);
    setMeta("vreq_cursor", String(to));
    from = to + 1;
  }
}

// ── this app's agents, validated without anyone asking ────────────────────────────────────────────────────────────────
// Every 10 minutes: an agent with 3 new committed fills, or 1 new fill and no validation for 12 hours (or never validated),
// gets a validation request. AUTO_VALIDATIONS_PER_DAY caps the day (default 36); nothing is asked while the validator holds
// under 0.05 MON (AUTO_VALIDATE=0 turns it off).
const AUTO_PER_DAY = () => Number(process.env.AUTO_VALIDATIONS_PER_DAY || 36);
export function autoCandidates(now = Date.now()): string[] {
  const db = trustDb();
  const rows = db.query(`SELECT a.bot_id, (SELECT MAX(seq) FROM trust_fills f WHERE f.bot_id = a.bot_id AND f.commit_tx IS NOT NULL) AS top,
      (SELECT MAX(to_seq) FROM trust_validations v WHERE v.bot_id = a.bot_id AND v.request_tx IS NOT NULL) AS done,
      (SELECT MAX(created_at) FROM trust_validations v WHERE v.bot_id = a.bot_id) AS last,
      (SELECT COUNT(*) FROM trust_validations v WHERE v.bot_id = a.bot_id AND v.response IS NULL AND v.error IS NULL) AS open
    FROM trust_agents a WHERE a.agent_id IS NOT NULL`).all() as { bot_id: string; top: number | null; done: number | null; last: number | null; open: number }[];
  return rows.filter((r) => (r.top ?? 0) > 0 && !r.open).filter((r) => {
    const fresh = (r.top ?? 0) - (r.done ?? 0);
    return fresh > 0 && (r.done == null || fresh >= 3 || now - (r.last ?? 0) > 12 * 3_600_000) && now - (r.last ?? 0) > 10 * 60_000;
  }).sort((a, b) => (a.last ?? 0) - (b.last ?? 0)).map((r) => r.bot_id);
}
let autoState: { at: number; asked: number; error: string | null } = { at: 0, asked: 0, error: null };
async function autoTick(): Promise<void> {
  if (process.env.AUTO_VALIDATE === "0" || !validatorAccount()) return;
  try {
    const b = await balances();
    if (!b.validator || Number(b.validator.mon) < 0.05) { autoState = { at: Date.now(), asked: 0, error: `validator holds ${b.validator?.mon ?? "?"} MON: auto validation waits for a top-up` }; return; }
    if (!b.operator || b.operator.wei < trustConfig.minOperatorWei()) { autoState = { at: Date.now(), asked: 0, error: "operator under its minimum: auto validation waits" }; return; }
    const day = (trustDb().query("SELECT COUNT(*) AS n FROM trust_validations WHERE bot_id NOT LIKE 'ext:%' AND created_at > ?").get(Date.now() - 86_400_000) as { n: number }).n;
    let asked = 0;
    for (const id of autoCandidates().slice(0, Math.max(0, Math.min(3, AUTO_PER_DAY() - day)))) {
      try { await askValidation(id); asked++; } catch (e) { logger.warn({ bot: id, err: String((e as Error)?.message ?? e).slice(0, 160) }, "trust: auto validation not asked"); }
    }
    autoState = { at: Date.now(), asked, error: null };
  } catch (e) { autoState = { at: Date.now(), asked: 0, error: String((e as Error)?.message ?? e).slice(0, 200) }; }
}
let svcTimers: ReturnType<typeof setInterval>[] = [];
/** On boot: answer requests addressed to this validator (every 2 minutes) and validate this app's agents (every 10). */
export function startValidatorService(): void {
  if (svcTimers.length || process.env.NODE_ENV === "test" || !validatorAccount()) return;
  const poll = () => void pollRequests().catch((e) => logger.warn({ err: String(e).slice(0, 160) }, "trust: request poll failed"));
  setTimeout(poll, 20_000); setTimeout(() => void autoTick(), 90_000);
  svcTimers = [setInterval(poll, 120_000), setInterval(() => void autoTick(), 600_000)];
  for (const t of svcTimers) (t as any).unref?.();
}
export const validatorServiceStatus = () => ({ auto: { ...autoState, perDay: AUTO_PER_DAY() }, outside: { perDay: EXT_PER_DAY(), cursor: Number(meta("vreq_cursor") ?? 0) } });

/** Requests asked but not answered (a restart mid-replay): answered again on boot. */
export async function resumeValidations(): Promise<void> {
  const open = trustDb().query("SELECT request_hash FROM trust_validations WHERE request_tx IS NOT NULL AND response IS NULL").all() as { request_hash: string }[];
  for (const r of open) await runValidation(r.request_hash as Hex).catch((e) => logger.warn({ err: String(e).slice(0, 200) }, "trust: resumed validation failed"));
}
