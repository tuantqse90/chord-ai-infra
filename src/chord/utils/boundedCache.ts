// Address-keyed caches on unauthenticated endpoints must never grow without bound — an attacker who
// sprays random valid-format addresses would otherwise OOM the process. FIFO eviction past a hard cap.
export function boundedCache<V>(max = 5000) {
  const m = new Map<string, V>();
  return {
    get: (k: string): V | undefined => m.get(k),
    delete: (k: string): boolean => m.delete(k),
    set: (k: string, v: V): void => {
      if (!m.has(k) && m.size >= max) {
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
      m.set(k, v);
    },
  };
}

// Coalesce concurrent identical async work so N simultaneous requests for the same key fire the
// underlying (expensive) fetch ONCE instead of N times — kills the concurrency-amplification vector.
export function coalescer<V>() {
  const inflight = new Map<string, Promise<V>>();
  return (key: string, fn: () => Promise<V>): Promise<V> => {
    const ex = inflight.get(key);
    if (ex) return ex;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
