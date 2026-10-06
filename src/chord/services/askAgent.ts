// Types the Chord Ask tool modules import from Chord's askAgent.ts. ask2049 has its own loop (src/agent.ts); only the shapes
// tool results use live here.
export interface Citation { label: string; href: string }
export type Viz =
  | { kind: "table"; title: string; columns: string[]; rows: (string | number | null)[][]; align?: ("l" | "r")[]; links?: (string | null)[]; linkCol?: number;
      posts?: { label: string; sub?: string; items: VizPost[] } }
  | { kind: "line" | "bar"; title: string; x: string[]; series: { name: string; values: (number | null)[] }[]; unit?: "usd" | "pct" | "price" | "n"; stacked?: boolean;
      chart?: { chain: number; address: string; tf?: string } }
  | { kind: "donut"; title: string; slices: { name: string; value: number }[]; unit?: "pct" | "usd" };
export interface VizPost { url: string; name: string; handle: string; avatar: string | null; verified: boolean; followers: number | null; text: string; at: string | null; likes: number | null; reposts: number | null; replies: number | null; views: number | null; media?: VizMedia[] }
export interface VizMedia { type: "photo" | "video" | "gif"; url: string; w: number | null; h: number | null; video: string | null }
export type AssetKind = "crypto" | "token" | "perp" | "stock" | "fx" | "commodity" | "index";
export interface AssetChip {
  feed?: { chain: number; address: string };
  id: string; symbol: string; label: string; price: number | null; change24hPct: number | null; hl: string | null; href: string | null; chain?: number; address?: string; logo?: string; marketCapUsd?: number | null; volume24hUsd?: number | null; liquidityUsd?: number | null; fdvUsd?: number | null; kind?: AssetKind; chainName?: string;
  spotHref?: string; spark?: number[] }
