// What the page shows for each lookup while Ask works (owner 2026-09-26, Minara screenshots: "Search Token 'Pearl Useful Proof
// Of Work'" with the token's card under it, "Social Media Search" with post cards, "Work complete in 3s · 8 Sources" with the
// sources' logos). Pure: the loop hands over the tool's name, arguments and result; this picks the one-line detail, the
// sources and up to four small cards. Nothing here is written by the model.

export type StepCard =
  | { kind: "token"; symbol: string; name: string; logo: string | null; price: number | null; change24hPct: number | null; marketCapUsd: number | null; fdvUsd: number | null; liquidityUsd: number | null; volume24hUsd: number | null; chainName: string | null; href: string | null;
      /** The logo when `logo` is empty (2026-09-29, BTC showed a "B"): a Hyperliquid coin, or chain + address for /v1/logo. */
      hl: string | null; chain: number | null; address: string | null; assetKind: string | null;
      /** Live-price source for a coin without `address` (askAgent AssetChip.feed). */
      feed?: { chain: number; address: string } }
  | { kind: "post"; name: string; handle: string; text: string; url: string; likes: number | null; /** the author's picture (twimg.com), when the tool's feed has it */ avatar?: string }
  | { kind: "link"; title: string; host: string; url: string; snippet: string | null };
export interface StepSource { label: string; href: string }

const str = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
const short = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The argument that says what this lookup is about: "Pearl Useful Proof Of Work", "$SUI", "pearlresearch.ai". */
export function stepDetail(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "web_read") { const u = str(args.url, 200); return u ? u.replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 80) : null; }
  if (tool === "image_read") { const r = str(args.region, 20); return `Image ${Math.max(1, Math.round(Number(args.image) || 1))}${r && r !== "full" ? ` · ${r.replace("-", " ")}` : ""}`; }
  for (const k of ["query", "q", "protocol", "coin", "asset", "token", "ticker", "symbol", "wallet", "pool", "category", "chain", "kind", "topic"]) {
    const v = str(args[k]);
    if (v) return short(v);
  }
  const assets = Array.isArray(args.assets) ? args.assets.filter((x) => typeof x === "string").slice(0, 4).join(", ") : null;
  return assets || null;
}

interface ChipLike { symbol: string; label: string; price: number | null; change24hPct: number | null; href: string | null; logo?: string; marketCapUsd?: number | null; volume24hUsd?: number | null; liquidityUsd?: number | null; fdvUsd?: number | null; chainName?: string; hl?: string | null; chain?: number; address?: string; kind?: string; feed?: { chain: number; address: string } }
interface ToolOut { data: unknown; citations: StepSource[]; assets?: ChipLike[]; chipCandidates?: ChipLike[]; viz?: unknown[] }

/** Sources (≤ 8, deduped by link) and cards (≤ 4) for one finished lookup. */
export function stepView(tool: string, out: ToolOut): { sources: StepSource[]; cards: StepCard[] } {
  const seen = new Set<string>();
  const sources = (out.citations ?? []).filter((c) => c?.href && !seen.has(c.href) && (seen.add(c.href), true)).slice(0, 8).map((c) => ({ label: String(c.label).slice(0, 80), href: c.href }));
  const d = (out.data ?? {}) as Record<string, any>;
  const cards: StepCard[] = [];
  if (tool === "x_search" || tool === "x_user") {
    // Pictures live in the tool's feed (viz), not in `data` — the model never reads image links.
    const avatars = new Map<string, string>();
    for (const v of (out.viz ?? []) as any[]) for (const it of (v?.posts?.items ?? []) as any[]) if (typeof it?.handle === "string" && typeof it?.avatar === "string") avatars.set(it.handle.toLowerCase(), it.avatar);
    for (const p of ((d.posts ?? d.tweets ?? []) as any[]).slice(0, 3)) {
      if (!p?.url) continue;
      const handle = String(p.author?.userName ?? "");
      const avatar = avatars.get(handle.toLowerCase());
      cards.push({ kind: "post", name: String(p.author?.name ?? p.author?.userName ?? ""), handle, text: String(p.text ?? "").replace(/\s+/g, " ").slice(0, 180), url: String(p.url), likes: numOrNull(p.likes), ...(avatar ? { avatar } : {}) });
    }
  } else if (tool === "web_search") {
    for (const h of ((d.results ?? []) as any[]).slice(0, 4)) if (h?.url) cards.push({ kind: "link", title: String(h.title ?? "").slice(0, 90), host: String(h.host ?? hostOf(h.url)), url: String(h.url), snippet: str(h.snippet, 140) });
  } else if (tool === "web_read") {
    if (d.opened && d.url) cards.push({ kind: "link", title: String(d.title ?? d.url).slice(0, 90), host: hostOf(String(d.url)), url: String(d.url), snippet: str(d.description, 140) });
  } else if (tool === "news_latest" || tool === "news_search") {
    for (const n of ((d.items ?? []) as any[]).slice(0, 3)) if (n?.url) cards.push({ kind: "link", title: String(n.title ?? "").slice(0, 90), host: String(n.source ?? hostOf(n.url)), url: String(n.url), snippet: null });
  } else {
    const chips = [...(out.assets ?? []), ...(out.chipCandidates ?? [])];
    const bySym = new Set<string>();
    for (const c of chips) {
      const k = `${c.symbol}|${c.chainName ?? ""}|${c.label}`;
      if (bySym.has(k)) continue;
      bySym.add(k);
      cards.push({ kind: "token", symbol: c.symbol, name: c.label, logo: c.logo ?? null, price: c.price, change24hPct: c.change24hPct, marketCapUsd: c.marketCapUsd ?? null, fdvUsd: c.fdvUsd ?? null, liquidityUsd: c.liquidityUsd ?? null, volume24hUsd: c.volume24hUsd ?? null, chainName: c.chainName ?? null, href: c.href,
        hl: c.hl ?? null, chain: c.chain ?? null, address: c.address ?? null, assetKind: c.kind ?? null, ...(c.feed ? { feed: c.feed } : {}) });
      if (cards.length >= 3) break;
    }
  }
  return { sources, cards: cards.slice(0, 4) };
}

/** Live reasoning for the page: addresses the tools did not return are masked, and only the tail is sent. */
export function thinkingTail(text: string, allowed: Set<string>, max = 900): string {
  const masked = text.replace(/0x[0-9a-fA-F]{40}/g, (m) => (allowed.has(m) || allowed.has(m.toLowerCase()) ? m : "(address)"));
  if (masked.length <= max) return masked.trim();
  const cut = masked.slice(-max);
  const sp = cut.search(/\s/);
  return `…${(sp >= 0 && sp < 40 ? cut.slice(sp + 1) : cut).trim()}`;
}
