// Suggested questions for the home page, from live data: Chord's Monad market map, token list and top-wallets board for
// Monad / Tokens / Wallets / Trade, this app's agents for Agents, Hyperliquid perps for Crypto and trade.xyz for Macro.
// Each suggestion is the line shown (`text`, after an optional token pill) and the question asked (`q`). Sources are
// cached 60 s.
import { chordHeaders, config } from "./config";

export type Pill = { symbol: string; name: string | null; logo: string | null };
export type Suggestion = { pill?: Pill; text: string; q: string };
export const CATS = ["monad", "agents", "tokens", "wallets", "trade", "crypto", "macro"] as const;
export type Cat = (typeof CATS)[number];

const HL = "https://api.hyperliquid.xyz/info";
const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>, ttl = 60_000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const chord = (path: string) => cached(`chord:${path}`, async () => {
  const r = await fetch(`${config.chordApi() || "https://api.getchord.xyz"}${path}`, { headers: chordHeaders(), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json() as Promise<any>;
});
const hl = (body: object) => cached(`hl:${JSON.stringify(body)}`, async () => {
  const r = await fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json() as Promise<any>;
});

type HlMarket = { name: string; volume24h: number; change24hPct: number | null; funding: number };
type XyzRow = { coin: string; mark: number; change24hPct: number | null };
async function hlMarkets(): Promise<HlMarket[]> {
  const [meta, ctxs] = await hl({ type: "metaAndAssetCtxs" });
  return meta.universe.map((u: any, i: number) => {
    const c = ctxs[i] ?? {}, mark = Number(c.markPx ?? 0), prev = Number(c.prevDayPx ?? 0);
    return { name: u.name, volume24h: Number(c.dayNtlVlm ?? 0), change24hPct: prev > 0 ? (mark / prev - 1) * 100 : null, funding: Number(c.funding ?? 0), delisted: !!u.isDelisted };
  }).filter((m: any) => !m.delisted);
}
async function xyzMarkets(): Promise<XyzRow[]> {
  const [meta, ctxs] = await hl({ type: "metaAndAssetCtxs", dex: "xyz" });
  return meta.universe.map((u: any, i: number) => { const m = Number(ctxs[i]?.markPx ?? 0), p = Number(ctxs[i]?.prevDayPx ?? 0); return { coin: String(u.name).replace(/^xyz:/, ""), mark: m, change24hPct: p > 0 ? (m / p - 1) * 100 : null }; });
}

const fmtUsd = (v?: number | null) => (v == null || !Number.isFinite(v) ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(2)}`);
const pct1 = (v: number) => `${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.abs(v).toFixed(0)}%`;
const signed = (v: number | null | undefined, d = 1) => (v == null ? "" : `${v >= 0 ? "up" : "down"} ${Math.abs(v).toFixed(d)}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function marketSuggestions(cat: "crypto" | "macro", hlm: HlMarket[], xyz: XyzRow[]): Suggestion[] {
  if (cat === "crypto") {
    const byCoin = (c: string) => hlm.find((m) => m.name === c);
    const btc = byCoin("BTC"), eth = byCoin("ETH"), mon = byCoin("MON");
    const liquid = hlm.filter((m) => m.volume24h > 5e6 && m.change24hPct != null);
    const mover = [...liquid].sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))[0];
    const hotFunding = [...liquid].sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))[0];
    const out: Suggestion[] = [];
    if (btc && eth) out.push({ text: `BTC is ${signed(btc.change24hPct)} and ETH ${signed(eth.change24hPct)} today. Trend, support and resistance for both?`, q: "Quick read on BTC and ETH today: trend, key support and resistance." });
    if (mon && mon.change24hPct != null) out.push({ text: `MON perps are ${signed(mon.change24hPct)} on Hyperliquid on ${fmtUsd(mon.volume24h)} traded. Who is positioned, and is it crowded?`, q: `MON perps are ${signed(mon.change24hPct)} on Hyperliquid on ${fmtUsd(mon.volume24h)} traded in 24h. What are funding and open interest saying, and is it crowded?` });
    if (mover) { const n = mover.name.replace(/^k(?=[A-Z])/, ""); out.push({ text: `${n} is ${signed(mover.change24hPct)} in 24h on Hyperliquid. What is behind it, and is it stretched?`, q: `${n} is ${signed(mover.change24hPct)} in 24h. What is behind the move, and is it stretched?` }); }
    if (hotFunding) { const y = (hotFunding.funding * 100 * 24 * 365).toFixed(0); out.push({ text: `Funding on ${hotFunding.name} is ${y}% a year. Who is paying, and is a squeeze likely?`, q: `Funding on ${hotFunding.name} is ${y}% a year. Who is paying, is it crowded, and is a squeeze likely?` }); }
    out.push({ text: "Which coins have the most crowded longs or shorts across exchanges right now?", q: "Which coins have the most crowded longs or shorts across Binance, Bybit, OKX and Hyperliquid right now?" });
    return out;
  }
  const x = (c: string) => xyz.find((r) => r.coin === c);
  const gold = x("GOLD"), oil = x("CL"), jpy = x("JPY"), ndx = x("XYZ100");
  const out: Suggestion[] = [];
  out.push({ text: `Gold is ${gold ? `${signed(gold.change24hPct)} at $${Math.round(gold.mark).toLocaleString("en-US")}` : "moving"}. Where are support and resistance?`, q: "Analyze gold (XAU/USD) and FX today: DXY, EUR/USD, USD/JPY. Where are support and resistance for gold?" });
  out.push({ text: "Risk-on or risk-off today across gold, oil, the dollar, Nasdaq and BTC?", q: "How are markets today? Gold, oil, the dollar, the Nasdaq and BTC: risk-on or risk-off, and why?" });
  if (jpy) out.push({ text: `USD/JPY is at ${jpy.mark.toFixed(2)}. How close is intervention, and what could move it this week?`, q: `USD/JPY is at ${jpy.mark.toFixed(2)}. How close is Japan to intervening, and what on the calendar could move it this week?` });
  if (oil) out.push({ text: `WTI oil is ${signed(oil.change24hPct)} at $${oil.mark.toFixed(2)}. What is driving it?`, q: `WTI crude is ${signed(oil.change24hPct)} at $${oil.mark.toFixed(2)}. What is driving it, and where are the levels?` });
  out.push({ text: "What's on the economic calendar this week, and which releases matter for the dollar?", q: "What's on the economic calendar this week, and which releases matter most for the US dollar and gold?" });
  if (ndx) out.push({ text: "Which big companies report earnings in the next two weeks?", q: "Which large US companies report earnings in the next two weeks, and what is expected?" });
  return out;
}

// ── Monad (Chord's market map × token list, and its on-chain top-wallets board) ─────────────────────────────────────────
type MonadRow = { address: string; symbol: string; name: string | null; logo: string | null; tags: string[]; priceUsd: number; change24hPct: number | null; volume24hUsd: number };
type TopWallet = { wallet: string; pnlUsd: number; volumeUsd: number; trades: number; topToken?: { symbol?: string } | null };
const NATIVE = "0x0000000000000000000000000000000000000000";
// Dollar and euro stables, and MON's wrapped / staked forms (they move with MON): kept out of the movers and token lines.
const STABLE = /usd|eur|gho|dai/i;
const MON_LIKE = (sym: string) => sym !== "MON" && /mon$/i.test(sym);
async function monadRows(): Promise<MonadRow[]> {
  const [list, market] = await Promise.all([chord("/v1/tokens?chain=143"), chord("/v1/tokens/market?chain=143")]);
  const map = (market?.market ?? {}) as Record<string, { priceUsd?: number; change24h?: number; volume24h?: number }>;
  return ((list?.tokens ?? []) as any[])
    .map((t) => {
      const m = map[String(t.address).toLowerCase()] ?? {};
      return { address: t.address, symbol: t.symbol, name: t.name && t.name !== t.symbol ? t.name : null, logo: t.logoURI ?? null, tags: t.tags ?? [], priceUsd: m.priceUsd ?? NaN, change24hPct: m.change24h ?? null, volume24hUsd: m.volume24h ?? 0 };
    })
    .filter((r) => r.symbol && Number.isFinite(r.priceUsd) && r.volume24hUsd > 0)
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
}
const pill = (r: MonadRow): Pill => ({ symbol: r.symbol, name: r.name, logo: r.logo });
/** Tokens that trade on their own: not a stable, not MON or one of its wrapped / staked forms. */
const traded = (rows: MonadRow[]) => rows.filter((r) => r.symbol !== "MON" && r.symbol !== "WMON" && !MON_LIKE(r.symbol) && !STABLE.test(r.symbol));
const topWallets = async (window: "24h" | "7d", limit: number): Promise<TopWallet[]> =>
  ((await chord(`/v1/smart-money/top?window=${window}&source=onchain&chain=143&limit=${limit}`))?.wallets ?? []) as TopWallet[];
const pnlLine = (w: TopWallet) => `${w.pnlUsd >= 0 ? "up" : "down"} ${fmtUsd(Math.abs(w.pnlUsd))}`;

async function monad(): Promise<Suggestion[]> {
  const [rows, wallets] = await Promise.all([monadRows(), topWallets("24h", 3).catch(() => [] as TopWallet[])]);
  const out: Suggestion[] = [];
  const mon = rows.find((r) => r.address === NATIVE) ?? rows.find((r) => r.symbol === "WMON");
  if (mon) {
    const move = mon.change24hPct == null ? `did ${fmtUsd(mon.volume24hUsd)}` : `is ${signed(mon.change24hPct, 2)} on ${fmtUsd(mon.volume24hUsd)} traded`;
    out.push({ pill: { ...pill(mon), symbol: "MON" }, text: `${move} on Monad DEXes today. Who is buying, and where?`, q: `MON ${move} on Monad DEXes today. Who is buying, and on which venues?` });
  }
  const mover = traded(rows).filter((r) => r.volume24hUsd >= 5_000 && r.change24hPct != null).sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))[0];
  if (mover) {
    const c = mover.change24hPct!;
    const tail = c >= 0 ? "Real buying, or a few wallets?" : "Selling, or just thin liquidity?";
    out.push({ pill: pill(mover), text: `is ${c >= 0 ? "up" : "down"} ${pct1(c)} in 24h on ${fmtUsd(mover.volume24hUsd)} of volume. ${tail}`, q: `${mover.symbol} is ${c >= 0 ? "up" : "down"} ${pct1(c)} on Monad in 24h on ${fmtUsd(mover.volume24hUsd)} of volume. ${tail} Who are its top traders?` });
  }
  const w = wallets[0];
  if (w) out.push({ text: `The top-ranked Monad wallet today is ${pnlLine(w)} on ${fmtUsd(w.volumeUsd)} traded${w.topToken?.symbol ? `, mostly ${w.topToken.symbol}` : ""}. What is it doing?`, q: `What has Monad wallet ${w.wallet} traded today, and what is its PnL by token?` });
  out.push({ text: "Top tokens on Monad by volume today, with their 24h move", q: "Top tokens on Monad by volume today, with their 24h move" });
  out.push({ text: "Which Monad memecoins have real volume today?", q: "Which memecoins on Monad have real volume today, and how thin are they?" });
  return out;
}

async function tokens(): Promise<Suggestion[]> {
  const top = traded(await monadRows()).slice(0, 4);
  const out: Suggestion[] = top.map((r, i) => i === 0
    ? { pill: pill(r), text: `leads Monad's non-stable tokens with ${fmtUsd(r.volume24hUsd)} traded today. Who is buying?`, q: `${r.symbol} leads Monad's non-stable tokens with ${fmtUsd(r.volume24hUsd)} traded today. Who is buying, and is it a few wallets?` }
    : { pill: pill(r), text: `did ${fmtUsd(r.volume24hUsd)} today${r.change24hPct != null ? `, ${signed(r.change24hPct)}` : ""}. Who trades it most?`, q: `${r.symbol} did ${fmtUsd(r.volume24hUsd)} on Monad today. Who are its top traders this week, and are they still holding?` });
  out.push({ text: "Biggest gainers and losers on Monad over 24h", q: "Biggest gainers and losers on Monad over 24h" });
  return out;
}

async function wallets(): Promise<Suggestion[]> {
  const [day, rows] = await Promise.all([topWallets("24h", 3), monadRows().catch(() => [] as MonadRow[])]);
  const out: Suggestion[] = day.map((w) => ({ text: `${short(w.wallet)} is ${pnlLine(w)} today on ${fmtUsd(w.volumeUsd)} traded. What does it trade?`, q: `What has Monad wallet ${w.wallet} traded today, and what is its PnL by token?` }));
  out.push({ text: "Which wallets are winning on Monad this week?", q: "Which wallets are winning on Monad this week, and what do they trade?" });
  const lead = traded(rows)[0];
  if (lead) out.push({ pill: pill(lead), text: "who are its top traders this week, and are they still holding?", q: `Who are the top traders of ${lead.symbol} on Monad this week, and are they still holding?` });
  if (day[0]) out.push({ text: `What does ${short(day[0].wallet)} hold on Monad right now?`, q: `What does ${day[0].wallet} hold on Monad right now?` });
  return out;
}

async function trade(): Promise<Suggestion[]> {
  const top = traded(await monadRows().catch(() => [] as MonadRow[])).slice(0, 2);
  const out: Suggestion[] = [{ text: "Swap 10 USDC for MON on Monad: what do I get, and through which venues?", q: "Swap 10 USDC for MON on Monad: what do I get, and through which venues?" }];
  top.forEach((r, i) => out.push(i === 0
    ? { pill: pill(r), text: "how much do I get for 100 USDC on Monad, and at what impact?", q: `How much ${r.symbol} do I get for 100 USDC on Monad, and at what price impact?` }
    : { pill: pill(r), text: "what does 250 USDC buy on Monad right now?", q: `What does 250 USDC buy in ${r.symbol} on Monad right now, and through which venues?` }));
  out.push({ text: "Sell 1,000 MON for USDC: what is the price impact?", q: "Swap 1000 MON for USDC on Monad: what do I get and at what price impact?" });
  out.push({ text: "How does a swap here work: who signs, and what's the fee?", q: "How does a swap work in this app: who signs, and what's the fee?" });
  return out;
}

// Agents: each line maps to the agents playbook (traders, backtest, build, templates, how a record is checked).
const AGENTS: Suggestion[] = [
  { text: "Who are the best Monad traders to copy right now?", q: "Who are the best Monad traders to copy right now?" },
  { text: "Backtest copying the top 3 Monad traders over the last 7 days", q: "Backtest a copy-trading agent that copies the top 3 Monad traders over the last 7 days, $20 a trade." },
  { text: "Build an agent that buys $20 when 3 smart wallets buy the same token within an hour", q: "Build me an agent that buys $20 when 3 smart wallets buy the same token on Monad within an hour, and sells at +30% or -15%." },
  { text: "What agent templates can I start?", q: "What agent templates can I start, and how did each do over the last days?" },
  { text: "How do I check a trading agent's record on Monad myself?", q: "How do I check a trading agent's record on Monad myself, without trusting this site?" },
];

async function build(cat: Cat): Promise<Suggestion[]> {
  switch (cat) {
    case "monad": return monad();
    case "agents": return AGENTS;
    case "tokens": return tokens();
    case "wallets": return wallets();
    case "trade": return trade();
    case "crypto": return marketSuggestions("crypto", await hlMarkets(), []);
    case "macro": return marketSuggestions("macro", [], await xyzMarkets());
  }
}

/** The suggestions for one category; a failed source gives the static fallback line instead of nothing. */
export async function suggestions(cat: Cat): Promise<Suggestion[]> {
  try {
    const s = await build(cat);
    if (s.length) return s;
  } catch { /* the line below */ }
  return [{ text: "The live data for this list did not load. Ask anything instead.", q: "What's moving on Monad today?" }];
}
