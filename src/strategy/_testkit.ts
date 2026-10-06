// Test helpers for the strategy side (offline): a fake HTTP transport that answers by URL, and source trades.
import type { SourceTrade } from "../bots/types";
import type { Fetch } from "./chord";

export type Route = unknown | ((url: string) => unknown);
/** A transport that answers the first route whose key the URL contains (a number = that HTTP status, empty body). Every URL
 *  asked is kept in `calls`. Unrouted URLs answer 599 so a test notices. */
export function fakeFetch(routes: Record<string, Route>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string) => {
    calls.push(input);
    const key = Object.keys(routes).find((k) => input.includes(k));
    if (key === undefined) return new Response("unrouted", { status: 599 });
    let v = routes[key];
    if (typeof v === "function") v = (v as (u: string) => unknown)(input);
    if (typeof v === "number") return new Response("", { status: v });
    if (v instanceof Error) throw v;
    return new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as Fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

export function trade(o: Partial<SourceTrade> & { wallet: string; mint: string; ts: number }): SourceTrade {
  return { tx: `tx${o.ts}${o.wallet.slice(0, 3)}`, side: "buy", symbol: "TOK", usd: 100, priceUsd: 1, via: "tape", ...o };
}
