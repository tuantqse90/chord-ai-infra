// Long replays (a strategy / copy / LP backtest can take 1-2 min on the throttled box) must not die at the CDN's 100 s limit
// (QA 07/10: a 3-day replay ran 125 s and the page got a 524). A request waits up to 80 s; past that it answers "still
// running" and the replay goes on: the same request again gets the result, kept 10 minutes. Errors are not kept.
const done = new Map<string, { at: number; v: unknown }>();
const running = new Map<string, Promise<unknown>>();
export const KEEP_MS = 600_000;
export const WAIT_MS = 80_000;

export class StillRunning extends Error {
  readonly status = 503;
  readonly code = "still_running";
  constructor() { super("Still replaying the history: ask again in a minute, the result is kept for 10 minutes."); this.name = "StillRunning"; }
}

export async function longJob<T>(key: string, run: () => Promise<T>, waitMs = WAIT_MS): Promise<T> {
  const now = Date.now();
  for (const [k, e] of done) if (now - e.at > KEEP_MS) done.delete(k);
  const hit = done.get(key);
  if (hit) return hit.v as T;
  let p = running.get(key) as Promise<T> | undefined;
  if (!p) {
    p = run().then((v) => { done.set(key, { at: Date.now(), v }); return v; }).finally(() => running.delete(key));
    running.set(key, p);
    p.catch(() => { /* surfaced to the waiting request only */ });
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StillRunning()), waitMs); });
  try { return await Promise.race([p, late]); } finally { if (timer) clearTimeout(timer); }
}
export function _resetLongJobs(): void { done.clear(); running.clear(); }
