// ask2049: stand-in for the read side of Chord's services/askAttention.ts (2026-10-06). "Mindshare" without X: what people on
// Chord are looking at — per token per UTC day, a question in Ask that resolved to it (×3), a search that matched it, a token
// page view, a watchlist add (×5). Chord counts those in its own Redis; this app reads the board from Chord's public route
// GET /v1/arc/attention and counts nothing (its people are not on Chord).
import { chordGet } from "./chordApi";
import { getArcTokens } from "./arcTokens";

export interface AttentionRow { token: string; score: number; ask: number; search: number; view: number; watch: number }

/** Top tokens by weighted attention over the last `days` UTC days (today included). */
export async function getAttention(days = 1, limit = 20): Promise<AttentionRow[]> {
  const d = Math.max(1, Math.min(7, Math.round(days) || 1)), l = Math.max(1, Math.min(50, Math.round(limit) || 20));
  const j = await chordGet<{ rows?: AttentionRow[] }>(`/v1/arc/attention?days=${d}&limit=${l}`, 60_000);
  if (!Array.isArray(j?.rows)) throw new Error("Chord API: no attention board");
  return j.rows.map((r) => ({ token: String(r.token).toLowerCase(), score: Number(r.score) || 0, ask: Number(r.ask) || 0, search: Number(r.search) || 0, view: Number(r.view) || 0, watch: Number(r.watch) || 0 }));
}

/** Arc symbols for a list of addresses. ask2049: Chord's searchArcTokensMany runs one search per address; the public search
 *  route counts every query as a "search" on this very board, so the symbols come from the Arc token list and the 24h board
 *  (GET /v1/tokens?chain=5042, GET /v1/arc/tokens?limit=500&includeUnlisted=1) instead. A token on neither keeps a null symbol. */
export async function arcSymbols(addrs: string[]): Promise<Map<string, { symbol: string | null }>> {
  const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))].slice(0, 30);
  const out = new Map<string, { symbol: string | null }>();
  if (!uniq.length) return out;
  const [list, board] = await Promise.all([
    getArcTokens().catch(() => []),
    chordGet<{ tokens?: { address: string; symbol: string | null }[] }>("/v1/arc/tokens?limit=500&includeUnlisted=1", 60_000).catch(() => null),
  ]);
  const sym = new Map<string, string>();
  for (const t of Array.isArray(board?.tokens) ? board.tokens : []) if (t.symbol) sym.set(t.address.toLowerCase(), t.symbol);
  for (const t of list) if (t.symbol) sym.set(t.address.toLowerCase(), t.symbol);
  for (const a of uniq) out.set(a, { symbol: sym.get(a) ?? null });
  return out;
}
