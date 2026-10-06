// Chord Ask's tool families as ask2049 tools. Each family keeps Chord's contract (OpenAI schemas, registry rows, a runner
// that answers {data, addresses, citations}); this file maps that onto ask2049's Tool: citations become sources, the
// addresses a family vouches for go to the answer's allow list, and third-party text (untrusted families) never adds
// addresses on its own. Families appear only when their key is set (CoinGlass, X, web search, Elfa).
import type { Tool, ToolResult } from "../types";
import type { ToolMeta } from "./services/ask/registry";
import type { ExtToolResult } from "./services/ask/extHttp";
import { EXT_TOOL_META, EXT_TOOL_SCHEMAS, extToolOffered, runExtTool } from "./services/ask/extTools";

type Schema = { type: "function"; function: { name: string; description: string; parameters: any } };
export type Family = { schemas: readonly Schema[]; meta: Record<string, ToolMeta>; offered: (name: string) => boolean; run: (name: string, args: Record<string, any>) => Promise<ExtToolResult> };

/** Who answers, by registry group (shown on each lookup step on the page). */
const PROVIDER: Record<string, string> = {
  dexscan: "GeckoTerminal · DexScreener", safety: "GoPlus", lighter: "Lighter", yield: "Pendle · Morpho", predict: "Polymarket · Kalshi",
  launchpad: "Virtuals · pools.fun", solana: "Jupiter", stocks: "Nasdaq", btc: "mempool.space", social: "Elfa", wallet_any: "Public RPC", util: "Calculator",
  coingecko: "CoinGecko", coinglass: "CoinGlass", defillama: "DefiLlama", markets: "Market data", hl: "Hyperliquid", derivs: "Exchange APIs",
  dex: "DexScreener", news: "News feeds", x: "X", web: "Web",
};

const families: Family[] = [{ schemas: EXT_TOOL_SCHEMAS as unknown as Schema[], meta: EXT_TOOL_META, offered: extToolOffered, run: runExtTool }];
/** Families ported later register here (market data, news / X / web, wallets). */
export function registerFamily(f: Family): void { families.push(f); }

const summaryOf = (name: string, r: ExtToolResult): string => {
  const d = r.data as any;
  if (d && typeof d === "object" && d.error) return String(d.error).slice(0, 140);
  const rows = Array.isArray(d) ? d.length : Array.isArray(d?.rows) ? d.rows.length : Array.isArray(d?.items) ? d.items.length : null;
  return rows != null ? `${rows} row${rows === 1 ? "" : "s"}` : `${name.replace(/_/g, " ")} read`;
};

function toTool(f: Family, s: Schema): Tool {
  const name = s.function.name;
  const meta = f.meta[name];
  return {
    name, via: "ext", provider: PROVIDER[meta?.group ?? ""] ?? "Third-party API", label: meta?.label ?? name,
    description: s.function.description, parameters: s.function.parameters,
    untrusted: !!meta?.untrusted, timeoutMs: meta?.timeoutMs, group: meta?.group,
    async run(args): Promise<ToolResult> {
      const r = await f.run(name, args);
      return {
        data: r.data,
        sources: r.citations.filter((c) => /^https?:\/\//.test(c.href)).map((c) => ({ kind: "web" as const, id: c.href, label: c.label, url: c.href })),
        summary: summaryOf(name, r),
        addresses: r.addresses,
        viz: r.viz,
      };
    },
  };
}

/** Every Chord tool this server can offer now (keys checked at call time). */
export function chordTools(): Tool[] {
  const out: Tool[] = [];
  const seen = new Set<string>();
  for (const f of families) for (const s of f.schemas) {
    const n = s.function.name;
    if (seen.has(n) || !f.offered(n)) continue;
    seen.add(n);
    out.push(toTool(f, s));
  }
  return out;
}
