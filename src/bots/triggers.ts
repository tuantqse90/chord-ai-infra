// How the agents see a followed wallet's trade on Monad: Chord's shared Monad feed (src/bots/tape.ts, refreshed every 10 s)
// is read every 10 s for each followed wallet (a filter in memory, no network call per wallet), and Chord's per-token swaps
// for each token an alert watches. Rows newer than the last one seen (2 min of overlap, the dedupe absorbs it) become source
// trades. Dedupe key = wallet | tx | token | side. The feed's own lag behind the chain is reported by feedStatus().
import { logger } from "../chord/utils/logger";
import { sourceKey } from "./store";
import { feedStatus, tokenTrades, toSource, walletTrades, type TapeRow } from "./tape";
import type { SourceTrade } from "./types";

export interface TriggerDeps {
  walletTrades: (wallet: string) => Promise<TapeRow[]>;
  tokenTrades: (mint: string) => Promise<TapeRow[]>;
  now: () => number;
}

export const POLL_MS = 10_000;
const OVERLAP_S = 120;
const SEEN_TTL_MS = 6 * 3600_000;
const POLL_CONCURRENCY = 4;

const defaults = (): TriggerDeps => ({
  walletTrades: (w) => walletTrades(w, 100),
  tokenTrades: (m) => tokenTrades(m, 100),
  now: () => Date.now(),
});

export type TriggerStatus = {
  source: "chord-monad-feed"; wallets: number; mints: number; lastPollAt: number | null; lastError: string | null;
  feed: ReturnType<typeof feedStatus>;
};

export class Triggers {
  private d: TriggerDeps;
  private wallets = new Set<string>();
  private mints = new Set<string>();
  /** Feed cursor per followed wallet / token, unix seconds. */
  private cursor = new Map<string, number>();
  private seen = new Map<string, number>();
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;

  constructor(private onTrade: (t: SourceTrade) => void, deps: Partial<TriggerDeps> = {}) {
    this.d = { ...defaults(), ...deps };
  }

  /** The wallets and tokens the running agents follow; the polls follow this set. */
  setFollowed(wallets: Iterable<string>, mints: Iterable<string>): void {
    const nowS = Math.floor(this.d.now() / 1000);
    const w = new Set([...wallets].map((x) => x.toLowerCase())), m = new Set([...mints].map((x) => x.toLowerCase()));
    for (const x of w) if (!this.wallets.has(x)) this.cursor.set(`w:${x}`, nowS);
    for (const x of m) if (!this.mints.has(x)) this.cursor.set(`m:${x}`, nowS);
    for (const x of this.wallets) if (!w.has(x)) this.cursor.delete(`w:${x}`);
    for (const x of this.mints) if (!m.has(x)) this.cursor.delete(`m:${x}`);
    this.wallets = w;
    this.mints = m;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_MS);
    (this.pollTimer as any).unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  status(): TriggerStatus {
    return { source: "chord-monad-feed", wallets: this.wallets.size, mints: this.mints.size, lastPollAt: this.lastPollAt, lastError: this.lastError, feed: feedStatus() };
  }

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
          if (fresh.length && this.cursor.has(key)) this.cursor.set(key, Math.max(from, fresh[fresh.length - 1]!.ts));
        } catch (e) {
          this.lastError = `${job.kind === "w" ? "wallet" : "token"} poll: ${String((e as Error)?.message ?? e).slice(0, 140)}`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, jobs.length) }, run));
    this.lastPollAt = this.d.now();
  }

  /** One trade, once. */
  private accept(t: SourceTrade): void {
    const key = sourceKey(t);
    if (this.seen.has(key)) return;
    this.seen.set(key, this.d.now());
    try { this.onTrade(t); } catch (e) { logger.warn({ err: String(e).slice(0, 200) }, "agents: trade handler threw"); }
  }

  private prune(): void {
    const cut = this.d.now() - SEEN_TTL_MS;
    for (const [k, at] of this.seen) if (at < cut) this.seen.delete(k);
  }
}
