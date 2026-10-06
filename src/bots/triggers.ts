// How the bots see a followed wallet trade, two ways, deduplicated:
//  1. fast: ONE Solana WebSocket (SOLANA_WS_URL, else the RPC URL with https → wss) carrying a `logsSubscribe {mentions}`
//     per followed wallet. A notification without err → getTransaction (jsonParsed) → parseTx → detectSwaps. Subscriptions
//     follow the running bots; the socket reconnects with backoff and resubscribes everything.
//  2. safety net: Chord's tape, polled every ~20 s per followed wallet (and per watched mint for alert bots), rows newer
//     than the last one seen (2 min of overlap, the dedupe absorbs it).
// Dedupe key = wallet | tx | mint | side, shared by both paths; a tx the tape already delivered is not fetched again.
import { config, isNowNodes } from "../config";
import { rpc } from "../rpc/solana";
import { parseTx } from "../solana/parse";
import { logger } from "../chord/utils/logger";
import { detectSwaps } from "./detect";
import { cachedPrice, SOL_MINT } from "./market";
import { sourceKey } from "./store";
import { tokenTrades, toSource, walletTrades, type TapeRow } from "./tape";
import type { SourceTrade } from "./types";

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}
export interface TriggerDeps {
  wsFactory: (url: string) => WsLike;
  getTx: (sig: string) => Promise<any | null>;
  walletTrades: (wallet: string) => Promise<TapeRow[]>;
  tokenTrades: (mint: string) => Promise<TapeRow[]>;
  solUsd: () => number | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const POLL_MS = 20_000;
const OVERLAP_S = 120;
const SEEN_TTL_MS = 6 * 3600_000;
const TX_QUEUE_MAX = 500;
const TX_WORKERS = 4;
const TX_PER_WALLET_MIN = 60;
const POLL_CONCURRENCY = 6;

export function wsUrl(): string {
  const env = (process.env.SOLANA_WS_URL ?? "").trim();
  if (env) return env;
  return config.solanaRpcUrl().replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}

function defaultWs(url: string): WsLike {
  const key = config.nownodesKey();
  const opts = key && isNowNodes(url.replace(/^ws/i, "http")) ? { headers: { "api-key": key } } : undefined;
  // Bun's WebSocket takes { headers } (the DOM typing only knows protocols).
  const Ctor = WebSocket as unknown as new (u: string, o?: { headers: Record<string, string> }) => WsLike;
  return opts ? new Ctor(url, opts) : new Ctor(url);
}

const defaults = (): TriggerDeps => ({
  wsFactory: defaultWs,
  getTx: (sig) => rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]),
  walletTrades: (w) => walletTrades(w, 100),
  tokenTrades: (m) => tokenTrades(m, 100),
  solUsd: () => cachedPrice(SOL_MINT),
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
});

export type TriggerStatus = { ws: "off" | "connecting" | "open"; subscriptions: number; wallets: number; mints: number; lastPollAt: number | null; lastError: string | null; queued: number };

export class Triggers {
  private d: TriggerDeps;
  private wallets = new Set<string>();
  private mints = new Set<string>();
  /** Tape cursor per followed wallet / mint, unix seconds. */
  private cursor = new Map<string, number>();
  private seen = new Map<string, number>();
  private seenTx = new Map<string, number>();
  private ws: WsLike | null = null;
  private subs = new Map<string, number>(); // wallet → subscription id
  private subWallet = new Map<number, string>();
  private pending = new Map<number, { op: "sub" | "unsub"; wallet: string }>();
  private pendingSub = new Set<string>();
  private nextId = 1;
  private attempt = 0;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private queue: { sig: string; wallet: string }[] = [];
  private workers = 0;
  private rate = new Map<string, { m: number; n: number }>();
  private lastPollAt: number | null = null;
  private lastError: string | null = null;

  constructor(private onTrade: (t: SourceTrade) => void, deps: Partial<TriggerDeps> = {}) {
    this.d = { ...defaults(), ...deps };
  }

  /** The wallets and mints the running bots follow; the socket and the polls follow this set. */
  setFollowed(wallets: Iterable<string>, mints: Iterable<string>): void {
    const nowS = Math.floor(this.d.now() / 1000);
    const w = new Set(wallets), m = new Set(mints);
    for (const x of w) if (!this.wallets.has(x)) this.cursor.set(`w:${x}`, nowS);
    for (const x of m) if (!this.mints.has(x)) this.cursor.set(`m:${x}`, nowS);
    for (const x of this.wallets) if (!w.has(x)) this.cursor.delete(`w:${x}`);
    for (const x of this.mints) if (!m.has(x)) this.cursor.delete(`m:${x}`);
    this.wallets = w;
    this.mints = m;
    if (this.started) this.syncWs();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.syncWs();
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_MS);
    (this.pollTimer as any).unref?.();
    this.pingTimer = setInterval(() => {
      const ws = this.ws as any;
      if (ws && ws.readyState === 1 && typeof ws.ping === "function") { try { ws.ping(); } catch { /* the close handler reconnects */ } }
    }, 30_000);
    (this.pingTimer as any).unref?.();
  }

  stop(): void {
    this.started = false;
    for (const t of [this.pollTimer, this.pingTimer]) if (t) clearInterval(t);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = this.pingTimer = this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.resetSubs();
    if (ws) { try { ws.close(); } catch { /* */ } }
  }

  status(): TriggerStatus {
    return {
      ws: !this.ws ? "off" : this.ws.readyState === 1 ? "open" : "connecting", subscriptions: this.subs.size, wallets: this.wallets.size, mints: this.mints.size,
      lastPollAt: this.lastPollAt, lastError: this.lastError, queued: this.queue.length,
    };
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────────────────────────────────────────────
  private resetSubs(): void { this.subs.clear(); this.subWallet.clear(); this.pending.clear(); this.pendingSub.clear(); }

  private syncWs(): void {
    if (!this.started) return;
    if (!this.wallets.size) {
      if (this.ws) { const ws = this.ws; this.ws = null; this.resetSubs(); try { ws.close(); } catch { /* */ } }
      return;
    }
    if (!this.ws) { if (!this.reconnectTimer) this.connect(); return; }
    if (this.ws.readyState !== 1) return; // onopen subscribes everything
    for (const w of this.wallets) if (!this.subs.has(w) && !this.pendingSub.has(w)) this.send("sub", w, "logsSubscribe", [{ mentions: [w] }, { commitment: "confirmed" }]);
    for (const [w, id] of [...this.subs]) {
      if (this.wallets.has(w)) continue;
      this.subs.delete(w);
      this.subWallet.delete(id);
      this.send("unsub", w, "logsUnsubscribe", [id]);
    }
  }

  private send(op: "sub" | "unsub", wallet: string, method: string, params: unknown[]): void {
    const id = this.nextId++;
    this.pending.set(id, { op, wallet });
    if (op === "sub") this.pendingSub.add(wallet);
    try { this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); } catch (e) { this.lastError = `websocket send: ${String(e).slice(0, 120)}`; }
  }

  private connect(): void {
    this.reconnectTimer = null;
    let ws: WsLike;
    try {
      ws = this.d.wsFactory(wsUrl());
    } catch (e) {
      this.lastError = `websocket: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // A socket that never opens is closed after 15 s, which schedules the next try.
    const openTimer = setTimeout(() => { if (this.ws === ws && ws.readyState !== 1) { try { ws.close(); } catch { /* */ } } }, 15_000);
    (openTimer as any).unref?.();
    ws.onopen = () => {
      clearTimeout(openTimer);
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.resetSubs();
      this.syncWs();
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.onMessage(ev.data); };
    ws.onerror = () => { try { ws.close(); } catch { /* */ } };
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (this.ws !== ws) return; // replaced or stopped on purpose
      this.ws = null;
      this.resetSubs();
      this.lastError = "websocket closed";
      if (this.attempt % 5 === 0) logger.warn({ attempt: this.attempt, wallets: this.wallets.size }, "bots: Solana websocket closed; reconnecting (the tape poll keeps trades coming)");
      if (this.started && this.wallets.size) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    const wait = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt, 6));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
    (this.reconnectTimer as any).unref?.();
  }

  /** Test hook: what reconnecting would do now, without waiting for the timer. */
  _reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!this.ws) this.connect();
  }

  private onMessage(data: unknown): void {
    let msg: any;
    try { msg = JSON.parse(typeof data === "string" ? data : String(data)); } catch { return; }
    if (msg?.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (p.op === "sub") {
        this.pendingSub.delete(p.wallet);
        if (msg.error || typeof msg.result !== "number") { this.lastError = `logsSubscribe: ${String(msg.error?.message ?? "no subscription id").slice(0, 120)}`; return; }
        if (!this.wallets.has(p.wallet)) { this.send("unsub", p.wallet, "logsUnsubscribe", [msg.result]); return; }
        this.subs.set(p.wallet, msg.result);
        this.subWallet.set(msg.result, p.wallet);
      }
      return;
    }
    if (msg?.method === "logsNotification") {
      const wallet = this.subWallet.get(msg.params?.subscription);
      const v = msg.params?.result?.value;
      if (!wallet || !v || v.err != null || typeof v.signature !== "string") return;
      this.enqueue(v.signature, wallet);
    }
  }

  private enqueue(sig: string, wallet: string): void {
    if (this.seenTx.has(`${wallet}|${sig}`)) return;
    const m = Math.floor(this.d.now() / 60_000);
    const r = this.rate.get(wallet);
    if (r && r.m === m && r.n >= TX_PER_WALLET_MIN) return; // a very busy wallet: the tape poll covers the rest
    this.rate.set(wallet, r && r.m === m ? { m, n: r.n + 1 } : { m, n: 1 });
    if (this.queue.length >= TX_QUEUE_MAX) return;
    this.queue.push({ sig, wallet });
    while (this.workers < TX_WORKERS && this.queue.length) { this.workers++; void this.work(); }
  }

  private async work(): Promise<void> {
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) await this.handleTx(job.sig, job.wallet);
    } finally {
      this.workers--;
    }
  }

  /** getTransaction (retried while the node has not got it yet), then the wallet's swap. Exposed for tests. */
  async handleTx(sig: string, wallet: string): Promise<void> {
    if (this.seenTx.has(`${wallet}|${sig}`)) return;
    let raw: any = null;
    for (let i = 0; i < 3 && !raw; i++) {
      if (i) await this.d.sleep(1_500 * i);
      if (this.seenTx.has(`${wallet}|${sig}`)) return; // the tape got there first
      try { raw = await this.d.getTx(sig); } catch (e) { this.lastError = `getTransaction: ${String((e as Error)?.message ?? e).slice(0, 120)}`; }
    }
    if (!raw) return; // the tape poll is the safety net
    const parsed = parseTx(raw);
    if (!parsed) return;
    for (const t of detectSwaps(parsed, wallet, this.d.solUsd(), this.d.now())) this.accept({ ...t, via: "websocket" });
    this.seenTx.set(`${wallet}|${sig}`, this.d.now());
  }

  // ── tape ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async poll(): Promise<void> {
    this.prune();
    const jobs = [...[...this.wallets].map((id) => ({ kind: "w" as const, id })), ...[...this.mints].map((id) => ({ kind: "m" as const, id }))];
    let i = 0;
    const run = async () => {
      for (let job = jobs[i++]; job; job = jobs[i++]) {
        const key = `${job.kind}:${job.id}`;
        try {
          const rows = job.kind === "w" ? await this.d.walletTrades(job.id) : await this.d.tokenTrades(job.id);
          const from = this.cursor.get(key);
          if (from === undefined) continue; // unfollowed meanwhile
          const fresh = rows.filter((r) => r.ts >= from - OVERLAP_S).sort((a, b) => a.ts - b.ts);
          for (const r of fresh) {
            const t = toSource(r, job.kind === "w" ? job.id : r.wallet ?? null);
            if (t) this.accept(t);
          }
          if (fresh.length && this.cursor.has(key)) this.cursor.set(key, Math.max(from, fresh[fresh.length - 1].ts));
        } catch (e) {
          this.lastError = `tape ${job.kind === "w" ? "wallet" : "token"} poll: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, jobs.length) }, run));
    this.lastPollAt = this.d.now();
  }

  /** One trade, once, whichever path saw it first. */
  private accept(t: SourceTrade): void {
    const key = sourceKey(t);
    if (this.seen.has(key)) return;
    const now = this.d.now();
    this.seen.set(key, now);
    this.seenTx.set(`${t.wallet}|${t.tx}`, now);
    try { this.onTrade(t); } catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "bots: trade handler threw"); }
  }

  private prune(): void {
    const cut = this.d.now() - SEEN_TTL_MS;
    for (const [k, at] of this.seen) if (at < cut) this.seen.delete(k);
    for (const [k, at] of this.seenTx) if (at < cut) this.seenTx.delete(k);
    const m = Math.floor(this.d.now() / 60_000);
    for (const [k, r] of this.rate) if (r.m < m) this.rate.delete(k);
  }
}
