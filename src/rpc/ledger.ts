// Every call to NOWNodes is counted per method with its latency, so /v1/status shows exactly how the product uses the infra.
type Row = { calls: number; errors: number; totalMs: number; maxMs: number; last: number };

const rows = new Map<string, Row>();
const started = Date.now();

export function record(provider: "solana" | "cardano", method: string, ms: number, ok: boolean): void {
  const key = `${provider}:${method}`;
  const r = rows.get(key) ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0, last: 0 };
  r.calls++;
  if (!ok) r.errors++;
  r.totalMs += ms;
  r.maxMs = Math.max(r.maxMs, ms);
  r.last = Date.now();
  rows.set(key, r);
}

export function ledger() {
  const methods = [...rows.entries()]
    .map(([k, r]) => {
      const [provider, method] = k.split(":");
      return { provider, method, calls: r.calls, errors: r.errors, avgMs: Math.round(r.totalMs / r.calls), maxMs: Math.round(r.maxMs), lastAt: new Date(r.last).toISOString() };
    })
    .sort((a, b) => b.calls - a.calls);
  return { since: new Date(started).toISOString(), totalCalls: methods.reduce((s, m) => s + m.calls, 0), methods };
}

export function resetLedger(): void {
  rows.clear();
}
