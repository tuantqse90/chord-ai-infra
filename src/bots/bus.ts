// In-process fan-out of a bot's fills, events and stats to its subscribers (the SSE stream). A listener that throws is
// dropped from that one emit, never from the others.
import type { BotStreamEvent } from "./types";

const listeners = new Map<string, Set<(e: BotStreamEvent) => void>>();

export function subscribe(botId: string, fn: (e: BotStreamEvent) => void): () => void {
  let set = listeners.get(botId);
  if (!set) listeners.set(botId, (set = new Set()));
  set.add(fn);
  return () => {
    const s = listeners.get(botId);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(botId);
  };
}

export function emit(botId: string, e: BotStreamEvent): void {
  const set = listeners.get(botId);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(e); } catch { /* one subscriber's failure is its own */ }
  }
}

export const hasListeners = (botId: string): boolean => (listeners.get(botId)?.size ?? 0) > 0;
export function _resetBus(): void { listeners.clear(); }
