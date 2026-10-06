// Price chips for an answer (Chord Ask): the assets a tool vouched for, then the board rows the answer actually names, in
// the order it names them, at most eight. Nothing here is written by the model.
export type Chip = { id: string; symbol: string; label: string; price: number | null; change24hPct: number | null; hl: string | null; href: string | null; logo?: string; chain?: number; address?: string; chainName?: string; kind?: string; marketCapUsd?: number | null; volume24hUsd?: number | null };

/** Chord Ask's chipsNamedIn: $TICKER in any case; a bare word only as the exact symbol and 3+ characters. */
export function chipsNamedIn(text: string, candidates: Map<string, Chip>): Chip[] {
  const hits: { at: number; chip: Chip }[] = [];
  for (const [k, chip] of candidates) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dollar = new RegExp(`\\$${esc}(?![A-Za-z0-9])`, "i").exec(text);
    const bare = chip.symbol.length >= 3 ? new RegExp(`(^|[^A-Za-z0-9$])${chip.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`).exec(text) : null;
    const at = Math.min(dollar ? dollar.index : Infinity, bare ? bare.index + bare[1].length : Infinity);
    if (Number.isFinite(at)) hits.push({ at, chip });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.chip);
}

const CHORD_API = "https://api.getchord.xyz";
/** Logos as absolute links (Chord's proxy for Hyperliquid coins and chain tokens), Chord page paths as getchord.xyz links. */
export function finishChip(c: Chip): Chip {
  const logo = c.logo ? (c.logo.startsWith("/") ? `${CHORD_API}${c.logo}` : c.logo) : c.hl ? `${CHORD_API}/v1/logo/hl/${encodeURIComponent(c.hl)}?v=2` : c.chain && c.address ? `${CHORD_API}/v1/logo/${c.chain}/${c.address}` : undefined;
  const href = c.href ? (c.href.startsWith("/") ? `https://getchord.xyz${c.href}` : /^https:\/\//.test(c.href) ? c.href : null) : null;
  return { ...c, logo, href };
}

export class ChipBag {
  private named: Chip[] = [];
  private board = new Map<string, Chip>();
  add(assets?: unknown[], candidates?: unknown[]): void {
    for (const a of (assets ?? []) as Chip[]) if (a?.symbol && !this.named.some((x) => x.id === a.id) && this.named.length < 8) this.named.push(a);
    for (const c of (candidates ?? []) as Chip[]) if (c?.symbol && !this.board.has(c.symbol.toUpperCase())) this.board.set(c.symbol.toUpperCase(), c);
  }
  /** The chips for this answer text. */
  pick(text: string): Chip[] {
    const out = [...this.named];
    for (const c of chipsNamedIn(text, this.board)) if (out.length < 8 && !out.some((x) => x.symbol.toUpperCase() === c.symbol.toUpperCase())) out.push(c);
    return out.slice(0, 8).map(finishChip);
  }
}
