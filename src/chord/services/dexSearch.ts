// Any token on any chain, by ticker, name or address — DexScreener's public search (no key, 300 req/min). Owner 2026-09-26
// sent Minara's "$PEARL" answer: the ticker is a $20k Solana meme, an Abstract token, an Ink token and a Robinhood Chain
// launch at once, and none of them is on CoinMarketCap / CoinGecko or our three chains, so Ask could not see any of them.
//
// DexScreener's search also matches DEX names ("pearl" = the Pearl DEX on Polygon → dozens of USDR pairs), so pairs are kept
// only when the BASE token's symbol / name / address matches the query; pairs are then grouped per token (chain + address),
// volumes and liquidity summed, the deepest pair speaks for price / market cap. Token names and links are chosen by whoever
// launched the token — the Ask tool says so.
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

export interface DexToken {
  chain: string; chainName: string; address: string; symbol: string; name: string;
  priceUsd: number | null; change24hPct: number | null; volume24hUsd: number; liquidityUsd: number; marketCapUsd: number | null; fdvUsd: number | null;
  pairs: number; topDex: string; url: string; image: string | null; ageDays: number | null; txns24h: number; website: string | null; x: string | null;
}

const CHAIN_NAME: Record<string, string> = {
  solana: "Solana", ethereum: "Ethereum", bsc: "BNB Chain", base: "Base", arbitrum: "Arbitrum", polygon: "Polygon", optimism: "Optimism", avalanche: "Avalanche",
  robinhood: "Robinhood Chain", monad: "Monad", arc: "Arc", hyperevm: "HyperEVM", sui: "Sui", ton: "TON", tron: "Tron", abstract: "Abstract", ink: "Ink", unichain: "Unichain",
  sonic: "Sonic", blast: "Blast", linea: "Linea", scroll: "Scroll", zksync: "zkSync", mantle: "Mantle", berachain: "Berachain", pulsechain: "PulseChain", apechain: "ApeChain",
};
export const chainNameOf = (id: string) => CHAIN_NAME[id] ?? id.replace(/(^|[-_])([a-z])/g, (_m, s, c) => `${s ? " " : ""}${c.toUpperCase()}`);
/** Our own token pages for chains Chord indexes; everything else links to DexScreener. */
export function chipHref(t: Pick<DexToken, "chain" | "address" | "url">): string {
  const a = t.address.toLowerCase();
  if (t.chain === "robinhood" && /^0x[0-9a-f]{40}$/.test(a)) return `/ask/trade/${a}`;
  if (t.chain === "arc" && /^0x[0-9a-f]{40}$/.test(a)) return `/arc/token/${a}`;
  return t.url;
}

const num = (v: unknown) => { const x = Number(v); return v == null || v === "" || !Number.isFinite(x) ? null : x; };
const norm = (s: string) => s.toLowerCase().replace(/^\$/, "").replace(/[^a-z0-9]+/g, "");

/** DexScreener pairs → tokens that match the query (pure, tested). */
export function groupPairs(query: string, pairs: any[], now = Date.now()): DexToken[] {
  const q = query.trim().replace(/^\$/, "");
  const qn = norm(q);
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
  const byToken = new Map<string, { t: DexToken; bestLiq: number; created: number | null }>();
  for (const p of pairs ?? []) {
    const b = p?.baseToken ?? {};
    const addr = String(b.address ?? "");
    const sym = String(b.symbol ?? "");
    const name = String(b.name ?? "");
    const match = isAddr ? addr.toLowerCase() === q.toLowerCase() : norm(sym) === qn || (qn.length >= 3 && norm(name).includes(qn));
    if (!match || !addr) continue;
    const chain = String(p.chainId ?? "");
    const key = `${chain}:${addr.startsWith("0x") ? addr.toLowerCase() : addr}`;
    const liq = num(p.liquidity?.usd) ?? 0;
    const vol = num(p.volume?.h24) ?? 0;
    const tx = (num(p.txns?.h24?.buys) ?? 0) + (num(p.txns?.h24?.sells) ?? 0);
    const created = num(p.pairCreatedAt);
    const info = p.info ?? {};
    const cur = byToken.get(key);
    if (!cur) {
      byToken.set(key, {
        bestLiq: liq, created,
        t: {
          chain, chainName: chainNameOf(chain), address: addr, symbol: sym, name, priceUsd: num(p.priceUsd), change24hPct: num(p.priceChange?.h24),
          volume24hUsd: vol, liquidityUsd: liq, marketCapUsd: num(p.marketCap) ?? num(p.fdv), fdvUsd: num(p.fdv), pairs: 1, topDex: String(p.dexId ?? ""), url: String(p.url ?? ""),
          image: typeof info.imageUrl === "string" ? info.imageUrl : null, ageDays: null, txns24h: tx,
          website: (info.websites ?? []).map((w: any) => w?.url).find((u: unknown) => typeof u === "string") ?? null,
          x: (info.socials ?? []).find((s: any) => s?.type === "twitter")?.url ?? null,
        },
      });
      continue;
    }
    cur.t.pairs++;
    cur.t.volume24hUsd += vol;
    cur.t.liquidityUsd += liq;
    cur.t.txns24h += tx;
    if (created != null && (cur.created == null || created < cur.created)) cur.created = created;
    if (!cur.t.image && typeof info.imageUrl === "string") cur.t.image = info.imageUrl;
    if (liq > cur.bestLiq) {
      cur.bestLiq = liq;
      Object.assign(cur.t, { priceUsd: num(p.priceUsd), change24hPct: num(p.priceChange?.h24), marketCapUsd: num(p.marketCap) ?? num(p.fdv), fdvUsd: num(p.fdv), topDex: String(p.dexId ?? ""), url: String(p.url ?? "") });
    }
  }
  return [...byToken.values()].map(({ t, created }) => ({
    ...t, volume24hUsd: Math.round(t.volume24hUsd * 100) / 100, liquidityUsd: Math.round(t.liquidityUsd),
    ageDays: created ? Math.max(0, Math.round(((now - created) / 86_400_000) * 10) / 10) : null,
  })).sort((a, b) => b.liquidityUsd + b.volume24hUsd - (a.liquidityUsd + a.volume24hUsd));
}

/** Cached 60 s per query; a box-wide per-minute budget keeps us far under DexScreener's 300/min. */
export async function dexSearch(query: string): Promise<{ tokens: DexToken[]; ageS: number }> {
  const q = query.trim().replace(/^\$/, "").slice(0, 80);
  if (!q) return { tokens: [], ageS: 0 };
  const ck = `dexs:v1:${q.toLowerCase()}`;
  try { const hit = await getRedis().get(ck); if (hit) { const j = JSON.parse(hit); return { tokens: j.tokens, ageS: Math.round(Date.now() / 1000 - j.t) }; } } catch { /* fetch */ }
  const minute = Math.floor(Date.now() / 60_000);
  try {
    const n = await getRedis().incr(`dexs:rl:${minute}`);
    if (n === 1) await getRedis().expire(`dexs:rl:${minute}`, 120);
    if (n > Number(process.env.DEXSCREENER_RPM ?? 120)) throw new Error("DEX search is busy — try again in a minute");
  } catch (e) { if (String(e).includes("busy")) throw e; }
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) { logger.warn({ status: res.status }, "dex search: DexScreener error"); throw new Error(res.status === 429 ? "DEX search is rate-limited — try again shortly" : `DEX search failed (HTTP ${res.status})`); }
  const j: any = await res.json();
  const tokens = groupPairs(q, j?.pairs ?? []).slice(0, 12);
  await getRedis().set(ck, JSON.stringify({ tokens, t: Math.floor(Date.now() / 1000) }), "EX", 60).catch(() => {});
  return { tokens, ageS: 0 };
}
