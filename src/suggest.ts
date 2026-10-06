// Suggested questions for the home page, from live data, as Chord Ask builds them (web ChordAskPage marketSuggestions /
// buildSuggestions): Hyperliquid perps for Crypto, trade.xyz for Macro, Chord's Arc board for Trending / Tokens / Holders /
// Trade, Robinhood Chain stocks for Stocks; plus this app's Solana, Chains and Payments sets. Each suggestion is the line
// shown (`text`, after an optional token pill) and the question asked (`q`). Sources are cached 60 s.
import { chordHeaders, config } from "./config";

export type Pill = { symbol: string; name: string | null; logo: string | null };
export type Suggestion = { pill?: Pill; text: string; q: string };
export const CATS = ["crypto", "macro", "stocks", "trending", "solana", "picks", "tokens", "holders", "wallets", "trade", "chains", "payments", "chord"] as const;
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
const pct1 = (v: number) => `${Math.abs(v).toFixed(0)}%`;
const signed = (v: number | null | undefined, d = 1) => (v == null ? "" : `${v >= 0 ? "up" : "down"} ${Math.abs(v).toFixed(d)}%`);
const cleanStock = (n: string | null | undefined) => (n ?? "").replace(/\s*•\s*Robinhood Token$/i, "").trim();
const pillOf = (r: any): Pill => ({ symbol: r.symbol, name: r.name && r.name !== r.symbol ? cleanStock(r.name) : null, logo: r.logoURI ?? null });

function marketSuggestions(cat: "crypto" | "macro", hlm: HlMarket[], xyz: XyzRow[]): Suggestion[] {
  if (cat === "crypto") {
    const byCoin = (c: string) => hlm.find((m) => m.name === c);
    const btc = byCoin("BTC"), eth = byCoin("ETH");
    const liquid = hlm.filter((m) => m.volume24h > 5e6 && m.change24hPct != null);
    const mover = [...liquid].sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))[0];
    const hotFunding = [...liquid].sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))[0];
    const out: Suggestion[] = [];
    if (btc && eth) out.push({ text: `BTC is ${signed(btc.change24hPct)} and ETH ${signed(eth.change24hPct)} today. Trend, support and resistance for both?`, q: "Quick read on BTC and ETH today: trend, key support and resistance." });
    out.push({ text: "Which memecoins are hot this week — DOGE, PEPE, BONK, WIF — and what are the risks?", q: "Which memecoins are hottest this week (DOGE, PEPE, BONK, WIF…)? Any setups worth watching, and what are the risks?" });
    if (mover) { const n = mover.name.replace(/^k(?=[A-Z])/, ""); out.push({ text: `${n} is ${signed(mover.change24hPct)} in 24h on Hyperliquid. What is behind it, and is it stretched?`, q: `${n} is ${signed(mover.change24hPct)} in 24h. What is behind the move, and is it stretched?` }); }
    if (hotFunding) { const y = (hotFunding.funding * 100 * 24 * 365).toFixed(0); out.push({ text: `Funding on ${hotFunding.name} is ${y}% a year. Who is paying, and is a squeeze likely?`, q: `Funding on ${hotFunding.name} is ${y}% a year. Who is paying, is it crowded, and is a squeeze likely?` }); }
    out.push({ text: "Which coins have the most crowded longs or shorts across exchanges right now?", q: "Which coins have the most crowded longs or shorts across Binance, Bybit, OKX and Hyperliquid right now?" });
    return out;
  }
  const x = (c: string) => xyz.find((r) => r.coin === c);
  const gold = x("GOLD"), oil = x("CL"), jpy = x("JPY"), ndx = x("XYZ100");
  const out: Suggestion[] = [];
  out.push({ text: `Gold is ${gold ? `${signed(gold.change24hPct)} at $${Math.round(gold.mark).toLocaleString("en-US")}` : "moving"}. Should I buy now — where are support and resistance?`, q: "Analyze gold (XAU/USD) and FX today: DXY, EUR/USD, USD/JPY. Is gold a buy here — where are support and resistance?" });
  out.push({ text: "How are markets today — risk-on or risk-off across gold, oil, the dollar, Nasdaq and BTC?", q: "How are markets today? Gold, oil, the dollar, the Nasdaq and BTC — risk-on or risk-off, and why?" });
  if (jpy) out.push({ text: `USD/JPY at ${jpy.mark.toFixed(2)} — how close is intervention, and what would move it this week?`, q: `USD/JPY is at ${jpy.mark.toFixed(2)}. How close is Japan to intervening, and what on the calendar could move it this week?` });
  if (oil) out.push({ text: `WTI oil is ${signed(oil.change24hPct)} at $${oil.mark.toFixed(2)}. What is driving it?`, q: `WTI crude is ${signed(oil.change24hPct)} at $${oil.mark.toFixed(2)}. What is driving it, and where are the levels?` });
  out.push({ text: "What's on the economic calendar this week, and which releases matter for the dollar?", q: "What's on the economic calendar this week, and which releases matter most for the US dollar and gold?" });
  if (ndx) out.push({ text: "Which big companies report earnings in the next two weeks?", q: "Which large US companies report earnings in the next two weeks, and what is expected?" });
  return out;
}

const STATIC: Partial<Record<Cat, Suggestion[]>> = {
  picks: [
    { text: "What looks good on Arc today? Show the picks board and why", q: "What looks good on Arc today? Show the picks board and why" },
    { text: "Bearish setups right now — what is being distributed?", q: "Bearish setups on Arc right now — what is being distributed?" },
    { text: "How accurate have the picks been this week?", q: "How accurate have the picks been this week?" },
    { text: "Any setups on Robinhood Chain memes today?", q: "Any bullish or bearish setups on Robinhood Chain tokens in today's picks?" },
    { text: "What is everyone on Chord looking at today?", q: "What is everyone on Chord looking at today?" },
    { text: "Show my journal and how my positions are doing", q: "Show my journal and how my positions are doing" },
  ],
  wallets: [
    { text: "Which wallets are winning on Arc this week?", q: "Which wallets are winning on Arc this week?" },
    { text: "Show the top wallets over the last 24 hours and what they trade", q: "Show the top wallets on Arc over the last 24 hours and what they trade" },
    { text: "Are the best wallets on Arc degens or bluechip traders?", q: "Are the best wallets on Arc degens or bluechip traders?" },
    { text: "What does wallet 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9 hold on Solana, and what did it do recently?", q: "What does wallet 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9 hold, and what did it do recently?" },
    { text: "Who is winning on Robinhood Chain stocks this week?", q: "Which wallets are winning on Robinhood Chain this week, and what do they trade?" },
    { text: "What does 0x4200000000000000000000000000000000000006 hold across chains?", q: "What does 0x4200000000000000000000000000000000000006 hold on Base, BNB Chain, Avalanche, Monad, Robinhood Chain and Arc?" },
  ],
  chains: [
    { text: "Top tokens on Base in the last 24 hours, with their buy share", q: "Top tokens on Base in the last 24 hours, with their buy share" },
    { text: "Compare DEX volume on Base, BNB Chain and Avalanche over the last 3 days", q: "Compare DEX volume on Base, BNB Chain and Avalanche over the last 3 days" },
    { text: "What were the 5 most traded tokens on BNB Chain in the last 24 hours?", q: "What were the 5 most traded tokens on BNB Chain in the last 24 hours?" },
    { text: "What traded most on Avalanche today?", q: "What traded most on Avalanche today?" },
    { text: "Latest WMON trades on Monad", q: "Latest WMON trades on Monad (0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A)" },
  ],
  payments: [
    { text: "Did a Solana transaction pay a wallet at least 9 USDC?", q: "Did Solana transaction 5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf pay 4azvt8Lo1pDmxhJ5FEJsAGX3fa1FwB51pgeA36ziaj41 at least 9 USDC?" },
    { text: "Explain a Solana transaction, step by step", q: "Explain Solana transaction 5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf" },
    { text: "How do payments for asks work here?", q: "How do I pay for more asks here, and how is the payment checked?" },
  ],
  chord: [
    { text: "How does Chord handle custody? Who holds my keys?", q: "How does Chord handle custody? Who holds my keys?" },
    { text: "What are Chord's fees on Arc?", q: "What are Chord's fees on Arc?" },
    { text: "How do I get USDC onto Arc to trade?", q: "How do I get USDC onto Arc to trade?" },
    { text: "How do tokenized stocks on Robinhood Chain work — NAV, hours, gas?", q: "How do tokenized stocks on Robinhood Chain work on Chord — NAV, trading hours, gas?" },
    { text: "Is there a Chord token?", q: "Is there a Chord token?" },
    { text: "Where does the data in these answers come from?", q: "Where does the data in these answers come from?" },
  ],
};

async function build(cat: Cat): Promise<Suggestion[]> {
  if (STATIC[cat]) return STATIC[cat]!;
  if (cat === "crypto") return marketSuggestions("crypto", await hlMarkets(), []);
  if (cat === "macro") return marketSuggestions("macro", [], await xyzMarkets());
  if (cat === "stocks") {
    const live = ((await chord("/v1/rh/stocks")).stocks ?? []).filter((r: any) => r.symbol && r.volume24h > 0);
    const byVol = [...live].sort((a, b) => b.volume24h - a.volume24h);
    const mover = [...live].filter((r) => r.change24hPct != null).sort((a, b) => Math.abs(b.change24hPct) - Math.abs(a.change24hPct))[0];
    const gap = [...live].filter((r) => r.basisPct != null).sort((a, b) => Math.abs(b.basisPct) - Math.abs(a.basisPct))[0];
    const out: Suggestion[] = [];
    if (byVol[0]) out.push({ pill: pillOf(byVol[0]), text: `leads Robinhood Chain with ${fmtUsd(byVol[0].volume24h)} today. Who is buying, and is it above NAV?`, q: `${byVol[0].symbol} leads Robinhood Chain with ${fmtUsd(byVol[0].volume24h)} traded today. Who is buying, and is it trading above or below NAV?` });
    if (mover && mover !== byVol[0]) out.push({ pill: pillOf(mover), text: `is ${mover.change24hPct >= 0 ? "up" : "down"} ${pct1(mover.change24hPct)} on-chain in 24h. News, flow and where it could stop?`, q: `${mover.symbol} is ${mover.change24hPct >= 0 ? "up" : "down"} ${pct1(mover.change24hPct)} on Robinhood Chain in 24h. What's the news, the flow, and where could it stop?` });
    if (gap && gap !== byVol[0] && gap !== mover) out.push({ pill: pillOf(gap), text: `trades ${Math.abs(gap.basisPct).toFixed(1)}% ${gap.basisPct >= 0 ? "above" : "below"} NAV. Why, and who is on the other side?`, q: `${gap.symbol} trades ${Math.abs(gap.basisPct).toFixed(1)}% ${gap.basisPct >= 0 ? "above" : "below"} its NAV on Robinhood Chain. Why, and who is on the other side?` });
    if (byVol[1]) out.push({ pill: pillOf(byVol[1]), text: "buy $100 with USDG — what do I get and at what impact?", q: `Swap 100 USDG for ${byVol[1].symbol} on Robinhood Chain — what do I get and at what price impact?` });
    out.push({ text: "Which stocks are moving on Robinhood Chain, and how much trades outside US hours?", q: "Which stocks are moving on Robinhood Chain today, and how much of the volume trades outside US market hours?" });
    out.push({ text: "Which big US stocks are the top movers today?", q: "Which big US stocks are the top gainers and losers today?" });
    return out;
  }
  if (cat === "trending") {
    const rows = ((await chord("/v1/arc/trending?limit=8")).tokens ?? []).filter((r: any) => r.symbol).slice(0, 5);
    const out: Suggestion[] = rows.map((r: any) => {
      const c = r.change1hPct;
      const move = c == null ? "is busy this hour" : c >= 0 ? `is up ${pct1(c)} in the last hour` : `is down ${pct1(c)} in the last hour`;
      const tail = c == null ? "What's going on?" : c >= 0 ? "What's behind the move, and is it thin?" : "Is this selling or just churn?";
      return { pill: pillOf(r), text: `${move} on ${fmtUsd(r.volNow ?? r.volume24h)} of volume. ${tail}`, q: `${r.symbol} ${move} on Arc on ${fmtUsd(r.volNow ?? r.volume24h)} of volume. ${tail}` };
    });
    out.push({ text: "What's trending on Arc right now, and which of it is actually routable?", q: "What's trending on Arc right now, and which of it is actually routable?" });
    return out;
  }
  if (cat === "solana") {
    const out: Suggestion[] = [
      { text: "What's trending on Solana DEXes right now, and which of it is thin?", q: "What memecoins are trending on Solana DEXes right now, and which of them have thin liquidity?" },
      { text: "New Solana pairs in the last hour with real liquidity", q: "What new pairs launched on Solana in the last hour with at least $20k of liquidity?" },
      { text: "Who holds BONK? Is supply concentrated?", q: "Who holds BONK (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263)? Is supply concentrated?" },
      { text: "Does JUP still have a mint or freeze authority?", q: "Does JUP (JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN) still have a mint or freeze authority?" },
      { text: "Swap 5 USDC for SOL — what do I get?", q: "Swap 5 USDC for SOL on Solana — what do I get and through which route?" },
    ];
    return out;
  }
  const top = ((await chord("/v1/arc/tokens?limit=8&sort=volume&includeUnlisted=1")).tokens ?? []).filter((r: any) => r.symbol);
  if (cat === "tokens") {
    const out: Suggestion[] = top.slice(0, 4).map((r: any, i: number) => i === 0
      ? { pill: pillOf(r), text: "leads Arc by volume today. How does its buy/sell split and trader count look?", q: `${r.symbol} leads Arc by volume today. How does its buy/sell split and trader count look?` }
      : { pill: pillOf(r), text: `did ${fmtUsd(r.volume24h)} today. Is that buying or selling, and on which venues?`, q: `${r.symbol} did ${fmtUsd(r.volume24h)} on Arc today. Is that buying or selling, and on which venues?` });
    out.push({ text: "Top tokens on Arc by volume today", q: "Top tokens on Arc by volume today" });
    out.push({ text: "Biggest gainers and losers on Arc over 24h", q: "Biggest gainers and losers on Arc over 24h" });
    return out;
  }
  if (cat === "holders") {
    const out: Suggestion[] = top.slice(0, 4).map((r: any) => ({ pill: pillOf(r), text: "who holds it, and how concentrated is the top 10?", q: `Who holds ${r.symbol} on Arc, and how concentrated is the top 10?` }));
    out.push({ text: "Which of today's top tokens has the broadest holder base?", q: "Which of today's top tokens on Arc has the broadest holder base?" });
    return out;
  }
  // trade
  const routable = top.filter((r: any) => r.routable !== false).slice(0, 3);
  const out: Suggestion[] = routable.map((r: any, i: number) => i === 0
    ? { pill: pillOf(r), text: "how much do I get for 100 USDC, and through which venues?", q: `How much ${r.symbol} do I get for 100 USDC on Arc, and through which venues?` }
    : { pill: pillOf(r), text: "what does 250 USDC buy right now, and what's the price impact?", q: `What does 250 USDC buy in ${r.symbol} on Arc right now, and what's the price impact?` });
  out.push({ text: "Swap 25 USDC for ETH on Base — route and impact?", q: "Swap 25 USDC for ETH on Base — what do I get, through which route, and at what impact?" });
  out.push({ text: "How does a swap here work — who signs, and what's the fee?", q: "How does a swap work in this app — who signs, and what's the fee?" });
  return out;
}

/** The suggestions for one category; a failed source gives the static fallback line instead of nothing. */
export async function suggestions(cat: Cat): Promise<Suggestion[]> {
  try {
    return await build(cat);
  } catch {
    return [{ text: "The live data for this list did not load. Ask anything instead.", q: "What's moving in crypto today?" }];
  }
}
