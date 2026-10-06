// ask2049: ported from Chord packages/api/src/services/ask/walletTools.ts (2026-10-06), unchanged except imports. The modules
// it imports are stand-ins under src/chord/: shared.ts, config/chains.ts (env RPC ladder + public RPC fallback), config/contracts.ts,
// services/rhAddresses.ts, and the token-list / price modules it imports lazily (tokenRegistry, rhTokens, arcTokens, chainTokens,
// rhMarkets, arcRollup, chainRollup), which read Chord's public API instead of Chord's Redis / Postgres (services/chordApi.ts).
// Ask tools that read ANY wallet / ANY transaction on Chord's six chains straight from the chain, plus exact math
// (2026-10-03 tool-parity batch, docs/prompts/ask-tool-parity-2026-10.md):
//   wallet_balances · chain_tx · calc
// Chains: Monad 143 · Robinhood Chain 4663 · Arc 5042 · Avalanche 43114 · Base 8453 · BNB Chain 56. RPC = `rpcUrlsFor(chain)`
// (env ladder `<PREFIX>_RPC_URL` → `<PREFIX>_RPC_FALLBACK_URL`); a chain with no RPC configured is skipped and named.
//
// wallet_balances — the services/appBalances pattern for every chain: ONE viem multicall per chain over Chord's own token
// list (allowFailure, batchSize 8192) + a native getBalance, every chain in parallel under its own 6 s deadline (a slow or
// dead chain answers "unavailable", the rest still answer). Lists: Monad tokenRegistry, Robinhood Chain rhTokens, Arc
// arcTokens, Avalanche / Base / BNB chainTokens (LI.FI, logo-gated) — each unioned with the registry anchors (decimals read
// on-chain). Prices: the same maps /v1/tokens/market serves (Monad market map, RH market map + live overlay, Arc market map)
// and the 24h board of the chain-keyed index (services/chainRollup, only when the chain is public); a held token missing
// from those gets one more look (RH trusted prices, Arc last hourly close, chain-keyed token page) and a stablecoin with no
// print counts at $1 (the web portfolio rule; FX stables excluded). Arc: gas IS USDC — the 18-dec native balance and the
// 6-dec predeploy 0x3600… are the same money, so only the predeploy is read. Holdings under $1 are counted as dust.
//
// chain_tx — any hash: eth_getTransactionByHash on the given chain or on all six in parallel (first hit wins), then the
// receipt + block time: status, from / to (named when it is a Chord contract, Permit2 / Multicall3 or a listed token),
// native value, gas and fee (+ OP-stack L1 fee), 4-byte method, every ERC-20 Transfer in the logs (Arc's 18-dec native
// mirror from 0xff…fe dropped — the predeploy log carries the same move) and the signer's net token flow. Token symbols
// are the token contract's own text (untrusted in the registry); an unlisted token with a listed symbol is a look-alike.
//
// calc — no eval / Function: a tokenizer + shunting-yard over exact rationals (BigInt numerator / denominator), so 0.1 + 0.2
// is 0.3 and an 18-decimal raw amount converts without float loss; only a non-integer power falls back to a double (and
// says so). Named ops: units, pct_change, apr_to_apy, apy_to_apr, compound, position.

import { createPublicClient, erc20Abi, fallback, formatUnits, http, toEventSelector, toFunctionSelector, type AbiFunction, type PublicClient } from "viem";
import { NULL_TERMINAL, chainMeta } from "../../shared"; // ask2049: Chord imports these from @nullterminal/shared
import { chainDataServed, rpcUrlsFor } from "../../config/chains";
import { NULL_ROUTER_ABI } from "../../config/contracts";
import { GASLESS_ENTRY_RH, PERMIT2, RH_STOCK_ZAP } from "../rhAddresses";
import { logger } from "../../utils/logger";
import type { Citation, Viz } from "../askAgent";
import type { ExtToolResult } from "./extHttp";
import type { ToolMeta } from "./registry";

export const WALLET_CHAINS = [143, 4663, 5042, 43114, 8453, 56] as const;
export type WalletChain = (typeof WALLET_CHAINS)[number];

const ZERO = "0x0000000000000000000000000000000000000000";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ARC = 5042;
/** Arc logs every native USDC move twice: 6-dec at the predeploy 0x3600… and 18-dec from this sentinel (services/arcFx). */
const ARC_NATIVE_MIRROR = "0xfffffffffffffffffffffffffffffffffffffffe";
const CHAIN_TIMEOUT_MS = 6_000;
const RPC_CALL_TIMEOUT_MS = 4_000;
const DUST_USD = 1;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const TRANSFER_TOPIC = toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)");
const DEPOSIT_TOPIC = toEventSelector("event Deposit(address indexed dst, uint256 wad)");
const WITHDRAWAL_TOPIC = toEventSelector("event Withdrawal(address indexed src, uint256 wad)");

// ── small helpers ───────────────────────────────────────────────────────────────────────────

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sig5 = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(5)));
/** Whole dollars from $1k, cents below. */
const usdR = (n: number): number => (Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 100) / 100);
const usdFmt = (n: number) => (Math.abs(n) >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const vTable = (title: string, columns: string[], rows: (string | number | null)[][], align?: ("l" | "r")[]): Viz => ({ kind: "table", title, columns, rows, align });
const chainName = (c: number) => chainMeta(c)?.name ?? `chain ${c}`;
/** Token text is chosen by whoever deployed the contract: one line, no control characters, ≤ 24 chars. */
export const cleanSymbol = (s: unknown, addr: string): string => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 24);
  return t || short(addr);
};
const fail = (error: string, note?: string, addresses: string[] = []): ExtToolResult => ({ data: note ? { error, note } : { error }, addresses, citations: [] });

class Deadline extends Error {}
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Deadline(`timed out after ${Math.round(ms / 100) / 10} s`)), Math.max(0, ms)); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// ── chains ──────────────────────────────────────────────────────────────────────────────────

const CHAIN_ALIASES: Readonly<Record<WalletChain, readonly string[]>> = {
  143: ["monad", "mon", "monad mainnet"],
  4663: ["robinhood", "robinhood chain", "rh", "hood", "robinhood mainnet"],
  5042: ["arc", "arc mainnet", "circle arc"],
  43114: ["avalanche", "avax", "avalanche c chain", "c chain", "avalanche mainnet"],
  8453: ["base", "base chain", "base mainnet"],
  56: ["bnb", "bsc", "bnb chain", "bnb smart chain", "binance smart chain", "binance", "bep20"],
};
const CHAIN_ERROR = "chain must be one of Chord's six: monad, robinhood, arc, avalanche, base, bnb (omit it for all six).";

/** "base" / "BSC" / 4663 / "" → a chain id, "all" (empty / all / any), or null (not one of Chord's chains: eth, sol, arb …). */
export function parseChordChain(v: unknown): WalletChain | "all" | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!s || ["all", "any", "every", "all chains", "every chain", "*"].includes(s)) return "all";
  for (const c of WALLET_CHAINS) {
    const m = chainMeta(c);
    if (String(c) === s || CHAIN_ALIASES[c].includes(s) || m?.key === s || m?.name.toLowerCase() === s) return c;
  }
  return null;
}

const clients = new Map<string, PublicClient>();
/** A viem client over the chain's env RPC ladder (read per call — env edits count), or null when none is configured. */
function clientFor(chain: WalletChain): PublicClient | null {
  const urls = rpcUrlsFor(chain);
  if (!urls.length) return null;
  const key = `${chain} ${urls.join(" ")}`;
  const hit = clients.get(key);
  if (hit) return hit;
  const m = chainMeta(chain)!;
  const transport = urls.length > 1
    ? fallback(urls.map((u) => http(u, { timeout: RPC_CALL_TIMEOUT_MS, retryCount: 0 })), { retryCount: 0 })
    : http(urls[0], { timeout: RPC_CALL_TIMEOUT_MS, retryCount: 1 });
  const client = createPublicClient({
    chain: {
      id: chain, name: m.name,
      nativeCurrency: { name: m.nativeSymbol, symbol: m.nativeSymbol, decimals: m.nativeDecimals },
      rpcUrls: { default: { http: urls } },
      contracts: { multicall3: { address: MULTICALL3 } },
    },
    transport,
  }) as PublicClient;
  if (clients.size >= 24) clients.clear();
  clients.set(key, client);
  return client;
}

// ── token lists + prices (reused services) ──────────────────────────────────────────────────

interface Listed { address: string; symbol: string; decimals: number; stable: boolean; name?: string; logoURI?: string | null }

/** Chord's token list for the chain, unioned with the registry anchors (whose decimals were read on-chain). The zero
 *  address is never in it: the native coin is read with getBalance (and not at all on Arc). Decimals are never defaulted. */
async function listedTokens(chain: WalletChain): Promise<Listed[]> {
  let raw: { address: string; symbol: string; decimals: number; tags?: string[]; name?: string; logoURI?: string | null }[];
  if (chain === 143) raw = await (await import("../tokenRegistry")).getTokenList();
  else if (chain === 4663) raw = await (await import("../rhTokens")).getRhTokens();
  else if (chain === 5042) raw = await (await import("../arcTokens")).getArcTokens();
  else raw = await (await import("../chainTokens")).getChainTokens(chain);
  const m = chainMeta(chain)!;
  const out = new Map<string, Listed>();
  for (const a of m.anchors) out.set(a.address.toLowerCase(), { address: a.address.toLowerCase(), symbol: a.symbol, decimals: a.decimals, stable: a.stableUsd === 1 });
  for (const t of raw) {
    const a = String(t.address ?? "").toLowerCase();
    if (!ADDR.test(a) || a === ZERO || out.has(a)) continue;
    const dec = Number(t.decimals);
    if (!Number.isInteger(dec) || dec < 0 || dec > 36) continue;
    const tags = t.tags ?? [];
    out.set(a, { address: a, symbol: cleanSymbol(t.symbol, a), decimals: dec, stable: tags.includes("stablecoin") && !tags.includes("fx"), name: typeof t.name === "string" ? t.name.slice(0, 64) : undefined, logoURI: t.logoURI ?? null });
  }
  return [...out.values()];
}

interface PriceBook { prices: Map<string, number>; nativeUsd: number | null; source: string; stablesOnly?: boolean }

/** The chain's USD prices from Chord's own maps (the ones /v1/tokens/market and the chain boards serve). */
async function priceBook(chain: WalletChain): Promise<PriceBook> {
  const m = chainMeta(chain)!;
  const prices = new Map<string, number>();
  const put = (a: string, p: unknown) => { if (typeof p === "number" && Number.isFinite(p) && p > 0) prices.set(a.toLowerCase(), p); };
  let source: string;
  if (chain === 143) {
    const map = await (await import("../tokenRegistry")).getMarketMap();
    for (const [a, v] of Object.entries(map)) put(a, v.priceUsd);
    source = "Chord's Monad market map";
  } else if (chain === 4663) {
    const R = await import("../rhMarkets");
    for (const [a, v] of Object.entries(R.withLiveRh(await R.getRhMarketMap()))) put(a, v.priceUsd);
    source = "Chord's Robinhood Chain index";
  } else if (chain === ARC) {
    for (const [a, v] of Object.entries(await (await import("../arcRollup")).getArcMarketMap())) put(a, v.priceUsd);
    source = "Chord's Arc index";
  } else {
    if (!chainDataServed(chain, false)) return { prices, nativeUsd: null, source: `stablecoins only (${m.name} index not public)`, stablesOnly: true };
    const board = await (await import("../chainRollup")).chainTokens(chain, { limit: 200, sort: "volume" });
    for (const t of board.tokens) put(t.address, t.priceUsd);
    source = `Chord's ${m.name} index (24h board)`;
  }
  // Arc's gas IS USDC; elsewhere the native coin trades under its wrapped twin.
  const nativeUsd = chain === ARC ? 1 : prices.get(ZERO) ?? prices.get(m.wrappedNative.toLowerCase()) ?? null;
  return { prices, nativeUsd, source };
}

/** One more look for held tokens the price map lacks (they did not trade in the map's window). Mutates the book. */
async function fillMissingPrices(chain: WalletChain, addrs: string[], book: PriceBook): Promise<void> {
  if (!addrs.length || book.stablesOnly) return;
  if (chain === 4663) {
    // ask2049: Chord imports this from ../rhRollup; this app's rhRollup.ts stand-in is shared with other tools, so it is in ../rhMarkets.
    const got = await (await import("../rhMarkets")).getRhTrustedPrices(addrs);
    for (const [a, p] of got) if (p.priceUsd > 0) book.prices.set(a, p.priceUsd);
  } else if (chain === ARC) {
    for (const [a, p] of await (await import("../arcRollup")).getArcLastPrices(addrs)) book.prices.set(a, p);
  } else if (chain === 43114 || chain === 8453 || chain === 56) {
    const R = await import("../chainRollup");
    await Promise.all(addrs.slice(0, 8).map(async (a) => {
      const page = await R.chainToken(chain, a, { hours: 168 }).catch(() => null);
      const last = page?.stats24h.priceUsd ?? [...(page?.series ?? [])].reverse().find((s) => s.priceLast != null && s.priceLast > 0)?.priceLast ?? null;
      if (last && last > 0) book.prices.set(a, last);
    }));
  }
}

// ── wallet_balances ─────────────────────────────────────────────────────────────────────────

export interface RawHolding { symbol: string; address: string | null; decimals: number; raw: bigint; priceUsd: number | null; native?: boolean; name?: string; logoURI?: string | null; stable?: boolean }
export interface HoldingRow { symbol: string; address: string | null; amount: string; priceUsd: number | null; valueUsd: number | null; native?: true }

/** Human amount for display, TRUNCATED (never rounded up): ≥ 1000 keeps 2 decimals, ≥ 1 keeps 4, below 1 keeps 4
 *  significant digits. Exact BigInt path — an 18-decimal raw balance never goes through a float. */
export function fmtAmount(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  let out: string;
  if (i !== "0") {
    const ff = f.slice(0, i.length >= 4 ? 2 : 4).replace(/0+$/, "");
    out = ff ? `${i}.${ff}` : i;
  } else {
    const lead = (f.match(/^0*/) ?? [""])[0].length;
    const ff = f.slice(0, lead + 4).replace(/0+$/, "");
    out = ff ? `0.${ff}` : "0";
  }
  return neg && out !== "0" ? `-${out}` : out;
}

/** Price, value, dust and order for one chain's raw balances. Pure. Dust = priced and worth < $1 (counted, not listed);
 *  unpriced = a balance with no price (listed without a value, not in the total). Rows sorted by value, largest first. */
export function summarizeHoldings(holdings: readonly RawHolding[], dustUsd = DUST_USD): { rows: HoldingRow[]; totalUsd: number; dust: { count: number; usd: number }; unpriced: HoldingRow[] } {
  const priced: { h: RawHolding; v: number }[] = [];
  const unpriced: HoldingRow[] = [];
  let dustCount = 0, dustTotal = 0;
  for (const h of holdings) {
    if (h.raw <= 0n) continue;
    if (h.priceUsd == null || !(h.priceUsd > 0)) {
      unpriced.push({ symbol: h.symbol, address: h.address, amount: fmtAmount(h.raw, h.decimals), priceUsd: null, valueUsd: null, ...(h.native ? { native: true as const } : {}) });
      continue;
    }
    const v = Number(formatUnits(h.raw, h.decimals)) * h.priceUsd;
    if (!(v >= dustUsd)) { dustCount++; dustTotal += Number.isFinite(v) ? v : 0; continue; }
    priced.push({ h, v });
  }
  priced.sort((a, b) => b.v - a.v);
  const rows = priced.map(({ h, v }) => ({ symbol: h.symbol, address: h.address, amount: fmtAmount(h.raw, h.decimals), priceUsd: sig5(h.priceUsd), valueUsd: usdR(v), ...(h.native ? { native: true as const } : {}) }));
  return { rows, totalUsd: usdR(priced.reduce((s, x) => s + x.v, 0)), dust: { count: dustCount, usd: Math.round(dustTotal * 100) / 100 }, unpriced };
}

export type ChainRead =
  | { chain: WalletChain; status: "ok"; holdings: RawHolding[]; checked: number; failedReads: number; priceSource: string | null }
  | { chain: WalletChain; status: "unavailable" | "no_rpc"; reason: string };

export async function readChainBalances(chain: WalletChain, wallet: `0x${string}`): Promise<ChainRead> {
  const client = clientFor(chain);
  if (!client) return { chain, status: "no_rpc", reason: "no RPC configured on this deployment" };
  const t0 = Date.now();
  const left = () => CHAIN_TIMEOUT_MS - (Date.now() - t0);
  // Prices load next to the balance reads under the same deadline; a slow map costs the USD column, not the chain.
  const bookP = within(priceBook(chain), CHAIN_TIMEOUT_MS).catch((e) => {
    logger.debug({ chain, err: String(e).slice(0, 160) }, "ask wallet_balances: prices unavailable");
    return null;
  });
  try {
    const list = await within(listedTokens(chain), left());
    const readNative = chain !== ARC; // Arc: the USDC predeploy in the list IS the gas balance
    const [nativeRaw, results] = await within(Promise.all([
      readNative ? client.getBalance({ address: wallet }) : Promise.resolve(0n),
      list.length
        ? client.multicall({
            contracts: list.map((t) => ({ address: t.address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf" as const, args: [wallet] as const })),
            allowFailure: true,
            batchSize: 8_192,
            multicallAddress: MULTICALL3,
          })
        : Promise.resolve([]),
    ]), left());
    let failed = 0;
    const held: { t: Listed; raw: bigint }[] = [];
    results.forEach((r, i) => {
      if (r.status !== "success" || typeof r.result !== "bigint") { failed++; return; }
      if (r.result > 0n) held.push({ t: list[i], raw: r.result });
    });
    if (list.length && failed === list.length) throw new Error("every token read failed");
    const book = await bookP;
    if (book) {
      const missing = held.filter((h) => !book.prices.has(h.t.address)).map((h) => h.t.address);
      if (missing.length && left() > 300) await within(fillMissingPrices(chain, missing, book), left()).catch(() => {});
    }
    const m = chainMeta(chain)!;
    const holdings: RawHolding[] = [];
    if (readNative && nativeRaw > 0n) holdings.push({ symbol: m.nativeSymbol, address: null, decimals: m.nativeDecimals, raw: nativeRaw, priceUsd: book?.nativeUsd ?? null, native: true });
    for (const h of held) holdings.push({ symbol: h.t.symbol, address: h.t.address, decimals: h.t.decimals, raw: h.raw, priceUsd: book?.prices.get(h.t.address) ?? (h.t.stable ? 1 : null), name: h.t.name, logoURI: h.t.logoURI ?? null, stable: h.t.stable });
    return { chain, status: "ok", holdings, checked: list.length + (readNative ? 1 : 0), failedReads: failed, priceSource: book?.source ?? null };
  } catch (e) {
    logger.debug({ chain, err: String(e).slice(0, 160) }, "ask wallet_balances: chain read failed");
    return { chain, status: "unavailable", reason: e instanceof Deadline ? "timed out" : "the chain's RPC did not answer" };
  }
}

/** The tool answer from per-chain reads. Pure. */
export function buildBalancesAnswer(wallet: string, reads: readonly ChainRead[]): ExtToolResult {
  const many = reads.length > 1;
  const perChainCap = many ? 12 : 25;
  const ok = reads.filter((r): r is Extract<ChainRead, { status: "ok" }> => r.status === "ok");
  const summaries = ok.map((r) => ({ r, s: summarizeHoldings(r.holdings) }));
  const withValue = summaries.filter((x) => x.s.rows.length || x.s.unpriced.length || x.s.dust.count).sort((a, b) => b.s.totalUsd - a.s.totalUsd);
  const empty = summaries.filter((x) => !x.s.rows.length && !x.s.unpriced.length && !x.s.dust.count).map((x) => chainName(x.r.chain));
  const down = reads.filter((r): r is Extract<ChainRead, { status: "unavailable" | "no_rpc" }> => r.status !== "ok");
  const total = usdR(summaries.reduce((s, x) => s + x.s.totalUsd, 0));
  // Pricing caveats only matter where something is held.
  const held = withValue.map((x) => x.r);
  const unpricedChains = held.filter((r) => !r.priceSource).map((r) => chainName(r.chain));
  const stablesOnly = held.filter((r) => r.priceSource?.startsWith("stablecoins only")).map((r) => chainName(r.chain));

  const chains = withValue.map(({ r, s }) => ({
    chain: chainName(r.chain), chainId: r.chain, totalUsd: s.totalUsd,
    holdings: s.rows.slice(0, perChainCap),
    ...(s.rows.length > perChainCap ? { moreHoldings: s.rows.length - perChainCap, moreHoldingsUsd: usdR(s.rows.slice(perChainCap).reduce((t, x) => t + (x.valueUsd ?? 0), 0)) } : {}),
    ...(s.dust.count ? { dust: s.dust } : {}),
    ...(s.unpriced.length ? { unpriced: s.unpriced.slice(0, 8) } : {}),
    tokensChecked: r.checked,
    prices: r.priceSource ?? "unavailable",
  }));
  const allRows = withValue.flatMap(({ r, s }) => s.rows.map((x) => ({ chain: r.chain, x })));
  allRows.sort((a, b) => (b.x.valueUsd ?? 0) - (a.x.valueUsd ?? 0));
  const tableRows = allRows.slice(0, 25);

  const viz: Viz[] = [];
  if (tableRows.length) {
    viz.push(vTable(`${short(wallet)} · holdings${many ? "" : ` on ${chainName(reads[0].chain)}`}`, many ? ["Chain", "Token", "Amount", "USD"] : ["Token", "Amount", "USD"],
      tableRows.map(({ chain, x }) => (many ? [chainMeta(chain)?.short ?? String(chain), x.symbol, x.amount, usdFmt(x.valueUsd ?? 0)] : [x.symbol, x.amount, usdFmt(x.valueUsd ?? 0)])),
      many ? ["l", "l", "r", "r"] : ["l", "r", "r"]));
  }
  const slices = withValue.filter((x) => x.s.totalUsd > 0).map((x) => ({ name: chainName(x.r.chain), value: Math.round(x.s.totalUsd) })).filter((x) => x.value > 0);
  if (slices.length > 1) viz.push({ kind: "donut", title: `${short(wallet)} · value by chain`, slices, unit: "usd" });

  const cite = (withValue.length ? withValue.map((x) => x.r.chain) : ok.map((r) => r.chain)).slice(0, 3);
  const citations: Citation[] = cite.map((c) => ({ label: `${short(wallet)} on ${chainName(c)} explorer`, href: `${chainMeta(c)!.explorer}/address/${wallet}` }));
  const addresses = [wallet.toLowerCase(), ...new Set(withValue.flatMap(({ s }) => [...s.rows, ...s.unpriced].map((x) => x.address).filter((a): a is string => !!a)))].slice(0, 60);

  const notes = [
    "Balances read on-chain just now. Only tokens on Chord's token list for each chain are checked, so an unlisted token, LP positions and staked or lent funds do not show: this is not a full net worth, say so.",
    "Prices are Chord's index / list prices at read time; a stablecoin with no print counts at $1. Holdings under $1 are left out and counted as dust; unpriced holdings have no USD value and are not in the totals.",
    held.some((r) => r.chain === ARC) ? "On Arc the gas balance (native USDC) is the same money as the USDC token: counted once." : null,
    down.length ? `Could not read: ${down.map((d) => `${chainName(d.chain)} (${d.reason})`).join(", ")}. Say those chains are unavailable right now; do not guess them.` : null,
    unpricedChains.length ? `Prices could not be read for ${unpricedChains.join(", ")}: those rows have no USD value.` : null,
    stablesOnly.length ? `${stablesOnly.join(", ")}: only stablecoins are priced (Chord's index for that chain is not public).` : null,
  ].filter(Boolean).join(" ");

  if (!ok.length) {
    return { data: { wallet, error: "No chain answered for this wallet.", unavailable: down.map((d) => ({ chain: chainName(d.chain), reason: d.reason })), note: "Say the balances cannot be read right now; do not guess." }, addresses: [wallet.toLowerCase()], citations: [] };
  }
  return {
    data: {
      wallet, source: "on-chain balances (each chain's RPC), priced by Chord",
      totalUsd: total,
      chains,
      ...(empty.length ? { emptyOn: empty } : {}),
      ...(down.length ? { unavailable: down.map((d) => ({ chain: chainName(d.chain), reason: d.reason })) } : {}),
      note: notes,
    },
    addresses, citations, viz,
  };
}

async function walletBalances(args: Record<string, any>): Promise<ExtToolResult> {
  const w = String(args.wallet ?? args.address ?? "").trim();
  if (!ADDR.test(w)) return fail("wallet must be a 0x address (40 hex characters).", "Ask for the full address; Solana and other non-EVM wallets are not covered.");
  const pick = parseChordChain(args.chain);
  if (pick === null) return fail(CHAIN_ERROR);
  const chains: WalletChain[] = pick === "all" ? [...WALLET_CHAINS] : [pick];
  const wallet = w.toLowerCase() as `0x${string}`;
  const reads = await Promise.all(chains.map((c) => readChainBalances(c, wallet).catch((): ChainRead => ({ chain: c, status: "unavailable", reason: "read failed" }))));
  return buildBalancesAnswer(wallet, reads);
}

// ── chain_tx ────────────────────────────────────────────────────────────────────────────────

export interface RawLog { address: string; topics: string[]; data: string; logIndex?: string | number | null }
export interface RawTx { hash: string; from: string; to: string | null; value: string; input: string; blockNumber: string | null; blockTimestamp?: string; gasPrice?: string }
export interface RawReceipt { status?: string | null; gasUsed: string; effectiveGasPrice?: string | null; l1Fee?: string | null; logs: RawLog[]; contractAddress?: string | null }
export interface DecodedTransfer { token: string; from: string; to: string; raw: bigint; logIndex: number | null }
export interface DecodedWrap { kind: "wrap" | "unwrap"; account: string; raw: bigint }

const topicAddr = (t: string) => `0x${t.slice(-40)}`.toLowerCase();
const hexBig = (h: string | null | undefined): bigint => { try { return h && h !== "0x" ? BigInt(h) : 0n; } catch { return 0n; } };
const hexNum = (h: string | number | null | undefined): number | null => (h == null ? null : typeof h === "number" ? h : Number(hexBig(h)));

/** ERC-20 Transfers (3 topics + one uint256 word), wrapped-native deposits / withdrawals, NFT transfers counted. Arc's
 *  18-dec native mirror log is dropped (the 6-dec predeploy log next to it is the same move). Pure. */
export function decodeTransfers(logs: readonly RawLog[], chain: number): { transfers: DecodedTransfer[]; wraps: DecodedWrap[]; nftTransfers: number; mirrorSkipped: number; otherLogs: number } {
  const wrapped = chainMeta(chain)?.wrappedNative.toLowerCase();
  const transfers: DecodedTransfer[] = [];
  const wraps: DecodedWrap[] = [];
  let nft = 0, mirror = 0, other = 0;
  for (const l of logs) {
    const addr = String(l.address ?? "").toLowerCase();
    const t0 = String(l.topics?.[0] ?? "").toLowerCase();
    if (t0 === TRANSFER_TOPIC) {
      if (chain === ARC && addr === ARC_NATIVE_MIRROR) { mirror++; continue; }
      if (l.topics.length === 4) { nft++; continue; }
      if (l.topics.length === 3 && /^0x[0-9a-fA-F]{64}$/.test(l.data)) {
        transfers.push({ token: addr, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), raw: BigInt(l.data), logIndex: hexNum(l.logIndex ?? null) });
        continue;
      }
    } else if ((t0 === DEPOSIT_TOPIC || t0 === WITHDRAWAL_TOPIC) && addr === wrapped && l.topics.length === 2 && /^0x[0-9a-fA-F]{64}$/.test(l.data)) {
      wraps.push({ kind: t0 === DEPOSIT_TOPIC ? "wrap" : "unwrap", account: topicAddr(l.topics[1]), raw: BigInt(l.data) });
      continue;
    }
    other++;
  }
  return { transfers, wraps, nftTransfers: nft, mirrorSkipped: mirror, otherLogs: other };
}

/** Net token flow of one address across the transfers (+ in, − out), tokens with a zero net dropped. Pure. */
export function netFlows(transfers: readonly DecodedTransfer[], who: string): Map<string, bigint> {
  const w = who.toLowerCase();
  const net = new Map<string, bigint>();
  for (const t of transfers) {
    if (t.from === t.to) continue;
    if (t.to === w) net.set(t.token, (net.get(t.token) ?? 0n) + t.raw);
    if (t.from === w) net.set(t.token, (net.get(t.token) ?? 0n) - t.raw);
  }
  for (const [k, v] of net) if (v === 0n) net.delete(k);
  return net;
}

const METHOD_SIGNATURES = [
  "function transfer(address,uint256)", "function approve(address,uint256)", "function transferFrom(address,address,uint256)",
  "function deposit()", "function withdraw(uint256)", "function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "function multicall(bytes[])", "function multicall(uint256,bytes[])", "function aggregate3((address,bool,bytes)[])",
  "function execute(bytes,bytes[],uint256)", "function execute(bytes,bytes[])",
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
  "function exactInput((bytes,address,uint256,uint256))", "function exactInput((bytes,address,uint256,uint256,uint256))",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "function swapExactETHForTokens(uint256,address[],address,uint256)",
  "function swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)",
];
let methodTable: { generic: Map<string, string>; router: Map<string, string> } | null = null;
function methods() {
  if (methodTable) return methodTable;
  const generic = new Map<string, string>();
  for (const s of METHOD_SIGNATURES) { const sel = toFunctionSelector(s); if (!generic.has(sel)) generic.set(sel, s.slice(9, s.indexOf("("))); }
  const router = new Map<string, string>();
  for (const item of NULL_ROUTER_ABI as readonly { type: string; name?: string }[]) if (item.type === "function" && item.name) router.set(toFunctionSelector(item as unknown as AbiFunction), item.name);
  methodTable = { generic, router };
  return methodTable;
}

/** 4-byte selector of the calldata and its name when it is a common function or a Chord router entry point. Pure. */
export function methodOf(input: string, to: string | null): { selector: string | null; name: string | null } {
  const data = String(input ?? "0x").toLowerCase();
  if (data.length < 10) return { selector: null, name: data === "0x" || data === "" ? "plain transfer (no calldata)" : null };
  const sel = data.slice(0, 10);
  const t = methods();
  if (to && to.toLowerCase() === NULL_TERMINAL.ROUTER && t.router.has(sel)) return { selector: sel, name: `${t.router.get(sel)} (Chord router)` };
  return { selector: sel, name: t.generic.get(sel) ?? t.router.get(sel) ?? null };
}

/** Chord's own contracts and the common infrastructure on a chain, by address. */
function knownContract(chain: number, addr: string): string | null {
  const a = addr.toLowerCase();
  if (a === NULL_TERMINAL.ROUTER) return "Chord router";
  if (a === NULL_TERMINAL.FEE_COLLECTOR) return "Chord fee collector";
  if (a === NULL_TERMINAL.ADAPTER_REGISTRY) return "Chord adapter registry";
  if (chain === 4663 && a === GASLESS_ENTRY_RH) return "Chord gasless entry";
  if (chain === 4663 && a === RH_STOCK_ZAP) return "Chord stock zap";
  if (a === PERMIT2) return "Permit2";
  if (a === MULTICALL3.toLowerCase()) return "Multicall3";
  return null;
}

export interface TokenInfo { symbol: string; decimals: number | null; listed: boolean }

/** The tool answer for one found transaction. Pure: every network read is done by the caller. */
export function buildTxAnswer(p: {
  chain: number; tx: RawTx; receipt: RawReceipt | null; blockTs: number | null; tokens: ReadonlyMap<string, TokenInfo>;
  listedSymbols: ReadonlySet<string>; nativeUsd: number | null; nowS?: number;
}): ExtToolResult {
  const m = chainMeta(p.chain)!;
  const hash = p.tx.hash.toLowerCase();
  const from = p.tx.from.toLowerCase();
  const to = p.tx.to ? p.tx.to.toLowerCase() : null;
  const nowS = p.nowS ?? Math.floor(Date.now() / 1000);
  const r = p.receipt;
  const status = !p.tx.blockNumber ? "pending" : !r ? "unknown (receipt not available)" : hexBig(r.status ?? "0x1") === 1n ? "success" : "failed";
  const dec = decodeTransfers(r?.logs ?? [], p.chain);
  const info = (a: string): TokenInfo => p.tokens.get(a) ?? { symbol: short(a), decimals: null, listed: false };
  const amount = (raw: bigint, a: string): string | null => { const d = info(a).decimals; return d == null ? null : formatUnits(raw, d); };
  const lookAlike = (a: string) => { const i = info(a); return !i.listed && p.listedSymbols.has(i.symbol.toLowerCase()); };
  const transfers = dec.transfers.slice(0, 25).map((t) => {
    const i = info(t.token);
    const amt = amount(t.raw, t.token);
    return {
      token: i.symbol, tokenAddress: t.token, listed: i.listed, ...(lookAlike(t.token) ? { lookAlike: true } : {}),
      from: t.from, to: t.to, ...(amt != null ? { amount: amt } : { rawAmount: t.raw.toString(), decimals: "unknown" }),
    };
  });
  const net = netFlows(dec.transfers, from);
  const signerNet = [...net.entries()].slice(0, 12).map(([a, v]) => ({ token: info(a).symbol, tokenAddress: a, ...(info(a).decimals != null ? { amount: formatUnits(v, info(a).decimals!) } : { rawAmount: v.toString() }) }));
  const gasUsed = r ? hexBig(r.gasUsed) : null;
  const price = r?.effectiveGasPrice ? hexBig(r.effectiveGasPrice) : hexBig(p.tx.gasPrice);
  const l1 = r?.l1Fee ? hexBig(r.l1Fee) : 0n;
  const feeWei = gasUsed != null ? gasUsed * price + l1 : null;
  const fee = feeWei != null ? formatUnits(feeWei, m.nativeDecimals) : null;
  const valueWei = hexBig(p.tx.value);
  const toName = to ? knownContract(p.chain, to) ?? (p.tokens.get(to)?.listed ? `${p.tokens.get(to)!.symbol} token contract` : null) : null;
  const method = methodOf(p.tx.input, to);
  const created = r?.contractAddress ? String(r.contractAddress).toLowerCase() : null;
  const explorer = `${m.explorer}/tx/${hash}`;
  const tokenAddrs = [...new Set(dec.transfers.map((t) => t.token))];
  const parties = [...new Set(dec.transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO);
  const addresses = [...new Set([from, ...(to ? [to] : []), ...(created ? [created] : []), ...tokenAddrs, ...parties])].slice(0, 60);
  const notes = [
    "Decoded straight from the chain's receipt. Token symbols are the token contracts' own text (anyone can name a token USDC): listed = on Chord's token list for this chain; lookAlike = an unlisted token using a listed token's symbol, call it out.",
    status === "failed" ? "The transaction reverted: the fee was paid, its token moves did not happen." : null,
    status === "pending" ? "Not mined yet: no receipt, fee or transfers." : null,
    "Amounts are not priced here; for swaps on Arc or Robinhood Chain, arc_tx / rh_tx add USD per leg.",
    fee != null && p.nativeUsd != null ? `feeUsd uses today's ${m.nativeSymbol} price, not the price at the time.` : null,
    l1 > 0n ? "The fee includes the L1 data fee." : null,
    p.chain === ARC ? "Arc gas and value are native USDC (18 decimals); the matching 6-decimal USDC Transfer logs are the same money." : null,
  ].filter(Boolean).join(" ");
  const data = {
    found: true, source: `${m.name} RPC (transaction + receipt)`,
    chain: m.name, chainId: p.chain, tx: hash, status,
    ...(p.tx.blockNumber ? { block: hexNum(p.tx.blockNumber) } : {}),
    ...(p.blockTs ? { time: new Date(p.blockTs * 1000).toISOString().replace(".000Z", "Z"), minutesAgo: Math.max(0, Math.round((nowS - p.blockTs) / 60)) } : {}),
    from, to, ...(toName ? { toName } : {}), ...(created ? { contractCreated: created } : {}),
    value: formatUnits(valueWei, m.nativeDecimals), nativeSymbol: m.nativeSymbol,
    method,
    ...(gasUsed != null ? { gasUsed: Number(gasUsed) } : {}),
    ...(fee != null ? { fee, ...(p.nativeUsd != null ? { feeUsd: Math.round(Number(fee) * p.nativeUsd * 10_000) / 10_000 } : {}) } : {}),
    transfers,
    ...(dec.transfers.length > transfers.length ? { moreTransfers: dec.transfers.length - transfers.length } : {}),
    ...(signerNet.length ? { signerNet } : {}),
    ...(dec.wraps.length ? { wraps: dec.wraps.slice(0, 6).map((w) => ({ kind: w.kind, account: w.account, amount: formatUnits(w.raw, m.nativeDecimals) })) } : {}),
    ...(dec.nftTransfers ? { nftTransfers: dec.nftTransfers } : {}),
    otherLogs: dec.otherLogs,
    explorer,
    note: notes,
  };
  const viz: Viz[] = transfers.length
    ? [vTable(`${m.name} tx ${short(hash)} · token transfers`, ["Token", "From", "To", "Amount"], transfers.slice(0, 15).map((t) => [t.token, t.from === from ? "signer" : short(t.from), t.to === from ? "signer" : short(t.to), "amount" in t ? t.amount : "raw"]), ["l", "l", "l", "r"])]
    : [];
  return { data, addresses, citations: [{ label: `Transaction on ${new URL(m.explorer).host}`, href: explorer }], viz };
}

/** symbol() / decimals() for tokens not on the list, one multicall (allowFailure). Unreadable = null. */
async function readTokenMeta(client: PublicClient, addrs: string[]): Promise<Map<string, { symbol: string | null; decimals: number | null }>> {
  const out = new Map<string, { symbol: string | null; decimals: number | null }>();
  if (!addrs.length) return out;
  const res = await client.multicall({
    contracts: addrs.flatMap((a) => [
      { address: a as `0x${string}`, abi: erc20Abi, functionName: "symbol" as const },
      { address: a as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
    ]),
    allowFailure: true,
    batchSize: 8_192,
    multicallAddress: MULTICALL3,
  });
  addrs.forEach((a, i) => {
    const s = res[i * 2], d = res[i * 2 + 1];
    const decimals = d?.status === "success" && Number.isInteger(Number(d.result)) && Number(d.result) <= 36 ? Number(d.result) : null;
    out.set(a, { symbol: s?.status === "success" ? String(s.result) : null, decimals });
  });
  return out;
}

async function chainTx(args: Record<string, any>): Promise<ExtToolResult> {
  const raw = String(args.tx ?? args.hash ?? "").trim();
  if (!TX_HASH.test(raw)) return fail("tx must be a 0x transaction hash (66 characters).", "Ask for the full hash; do not guess one.");
  const hash = raw.toLowerCase() as `0x${string}`;
  const pick = parseChordChain(args.chain);
  if (pick === null) return fail(CHAIN_ERROR);
  const chains: WalletChain[] = pick === "all" ? [...WALLET_CHAINS] : [pick];
  const withRpc = chains.filter((c) => clientFor(c));
  const noRpc = chains.filter((c) => !clientFor(c)).map(chainName);
  if (!withRpc.length) return fail(`No RPC is configured for ${noRpc.join(", ")} on this deployment.`, "Say the chain cannot be read right now; do not guess.");

  type Look = { c: WalletChain; tx: RawTx | null; err: string | null };
  const lookup = async (c: WalletChain): Promise<Look> => {
    try {
      const tx = await within(clientFor(c)!.request({ method: "eth_getTransactionByHash", params: [hash] }), CHAIN_TIMEOUT_MS);
      return { c, tx: (tx ?? null) as unknown as RawTx | null, err: null };
    } catch (e) {
      return { c, tx: null, err: e instanceof Deadline ? "timed out" : "RPC error" };
    }
  };
  // The first chain that has the hash answers; a slow chain only costs time when no chain has it.
  const looks = await new Promise<Look[]>((resolve) => {
    const got: Look[] = [];
    for (const c of withRpc) void lookup(c).then((l) => { got.push(l); if ((l.tx && l.tx.hash) || got.length === withRpc.length) resolve([...got]); });
  });
  const hit = looks.find((l) => l.tx && l.tx.hash);
  if (!hit) {
    const couldNot = [...looks.filter((l) => l.err).map((l) => `${chainName(l.c)} (${l.err})`), ...noRpc.map((n) => `${n} (no RPC configured)`)];
    return {
      data: {
        found: false, tx: hash, chainsChecked: looks.filter((l) => !l.err).map((l) => chainName(l.c)),
        ...(couldNot.length ? { couldNotCheck: couldNot } : {}),
        note: `No transaction with this hash on ${looks.filter((l) => !l.err).map((l) => chainName(l.c)).join(", ") || "the chains that answered"}. It may be on another chain (Chord reads Monad, Robinhood Chain, Arc, Avalanche, Base and BNB Chain) or dropped. Say so; do not guess.`,
      },
      addresses: [], citations: [],
    };
  }
  const chain = hit.c;
  const client = clientFor(chain)!;
  const tx = hit.tx!;
  const mined = !!tx.blockNumber;
  const [receipt, blockTs, listed, book] = await Promise.all([
    mined ? within(client.request({ method: "eth_getTransactionReceipt", params: [hash] }), 5_000).then((x) => (x ?? null) as unknown as RawReceipt | null).catch(() => null) : Promise.resolve(null),
    !mined ? Promise.resolve(null)
      : tx.blockTimestamp ? Promise.resolve(Number(hexBig(tx.blockTimestamp)))
      : within(client.request({ method: "eth_getBlockByNumber", params: [tx.blockNumber as `0x${string}`, false] }), 5_000).then((b) => (b ? Number(hexBig(b.timestamp)) : null)).catch(() => null),
    within(listedTokens(chain), 4_000).catch(() => [] as Listed[]),
    within(priceBook(chain), 4_000).catch(() => null),
  ]);
  const listedMap = new Map(listed.map((t) => [t.address, t] as const));
  const tokens = new Map<string, TokenInfo>();
  for (const t of listed) tokens.set(t.address, { symbol: t.symbol, decimals: t.decimals, listed: true });
  const dec = decodeTransfers(receipt?.logs ?? [], chain);
  const unknown = [...new Set(dec.transfers.map((t) => t.token))].filter((a) => !listedMap.has(a)).slice(0, 40);
  if (unknown.length) {
    const meta = await within(readTokenMeta(client, unknown), 3_500).catch(() => new Map<string, { symbol: string | null; decimals: number | null }>());
    for (const a of unknown) { const x = meta.get(a); tokens.set(a, { symbol: cleanSymbol(x?.symbol, a), decimals: x?.decimals ?? null, listed: false }); }
  }
  return buildTxAnswer({ chain, tx, receipt, blockTs, tokens, listedSymbols: new Set(listed.map((t) => t.symbol.toLowerCase())), nativeUsd: book?.nativeUsd ?? (chain === ARC ? 1 : null) });
}

// ── calc: exact rationals ──────────────────────────────────────────────────────────────────

export class CalcError extends Error {}
interface Q { n: bigint; d: bigint }
const MAX_EXPR = 400;
const MAX_TOKENS = 200;
// ≈ 5k decimal digits. Past this a power falls back to a double: gcd on 100k-bit operands costs seconds.
const MAX_BITS = 16_384;
const MAX_TEXT = 120;

const babs = (x: bigint) => (x < 0n ? -x : x);
const gcd = (a: bigint, b: bigint): bigint => { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a; };
function q(n: bigint, d: bigint = 1n): Q {
  if (d === 0n) throw new CalcError("division by zero");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}
const ONE = q(1n), ZERO_Q = q(0n), HUNDRED = q(100n);
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q) => { if (b.n === 0n) throw new CalcError("division by zero"); return q(a.n * b.d, a.d * b.n); };
const neg = (a: Q): Q => ({ n: -a.n, d: a.d });
const isInt = (a: Q) => a.d === 1n;
const cmp = (a: Q, b: Q) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
const bits = (x: bigint) => babs(x).toString(16).length * 4;
const pow10 = (k: number) => 10n ** BigInt(k);
/** Truncated remainder (the sign of the dividend), like JS %. */
const mod = (a: Q, b: Q) => { if (b.n === 0n) throw new CalcError("remainder by zero"); const t = (a.n * b.d) / (a.d * b.n); return sub(a, mul(b, q(t))); };

/** Exact decimal (or 0x hex integer) text → rational. Accepts 1,000,000 thousands separators, 1e18, and k / m / b / t. */
export function parseDecimal(text: string): Q {
  const s = text.trim();
  const hex = /^(-?)0x([0-9a-f]+)$/i.exec(s);
  if (hex) return q((hex[1] ? -1n : 1n) * BigInt(`0x${hex[2]}`));
  const m = /^([+-]?)(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?([kmbt])?$/i.exec(s);
  if (!m) throw new CalcError(`not a number: "${s.slice(0, 40)}"`);
  const [, sign, intPart = "", frac1, frac2, exp, suffix] = m;
  const frac = frac1 ?? frac2 ?? "";
  let n = BigInt((intPart.replace(/,/g, "") || "0") + frac);
  let d = pow10(frac.length);
  const e = exp ? Number(exp) : 0;
  if (Math.abs(e) > 1000) throw new CalcError("exponent too large");
  const sfx = suffix ? { k: 3, m: 6, b: 9, t: 12 }[suffix.toLowerCase() as "k" | "m" | "b" | "t"] : 0;
  const shift = e + sfx;
  if (shift >= 0) n *= pow10(shift); else d *= pow10(-shift);
  return q(sign === "-" ? -n : n, d);
}

function toNumber(a: Q): number { return Number(roundSig(a, 20)); }
function fromNumber(x: number): Q {
  if (!Number.isFinite(x)) throw new CalcError("result is too large or not a real number");
  return parseDecimal(String(x).replace("+", ""));
}

/** a^b: exact for an integer exponent while the result stays under MAX_BITS, else a double (ctx.inexact). */
function power(a: Q, b: Q, ctx: { inexact: boolean }): Q {
  if (isInt(b) && babs(b.n) <= 1_000_000n) {
    const e = b.n;
    if (e === 0n) return ONE;
    if (a.n === 0n) { if (e < 0n) throw new CalcError("division by zero"); return ZERO_Q; }
    const est = Math.max(bits(a.n), bits(a.d)) * Number(babs(e));
    if (est <= MAX_BITS) {
      const k = babs(e);
      const r = q(a.n ** k, a.d ** k);
      return e < 0n ? div(ONE, r) : r;
    }
  }
  const x = Math.pow(toNumber(a), toNumber(b));
  if (!Number.isFinite(x)) throw new CalcError(Number.isNaN(x) ? "not a real number (negative base with a fractional power)" : "result is too large");
  ctx.inexact = true;
  return fromNumber(x);
}

/** `sig` significant digits, half-up, plain notation for 1e-7 ≤ |x| < 1e21, scientific outside. */
export function roundSig(a: Q, sig: number): string {
  if (a.n === 0n) return "0";
  const s = a.n < 0n ? "-" : "";
  const num = babs(a.n), den = a.d;
  let e = num.toString().length - den.toString().length; // 10^e ≤ num/den < 10^(e+1) after the fix below
  const ge = (k: number) => (k >= 0 ? num >= den * pow10(k) : num * pow10(-k) >= den);
  if (!ge(e)) e--;
  const shift = sig - 1 - e;
  const N = shift >= 0 ? num * pow10(shift) : num;
  const D = shift >= 0 ? den : den * pow10(-shift);
  let digits = (2n * N + D) / (2n * D);
  if (digits >= pow10(sig)) { digits /= 10n; e++; }
  const ds = digits.toString().padStart(sig, "0");
  if (e >= 21 || e < -7) {
    const mant = `${ds[0]}${ds.length > 1 ? `.${ds.slice(1)}` : ""}`.replace(/\.?0+$/, "");
    return `${s}${mant}e${e >= 0 ? "+" : ""}${e}`;
  }
  let out: string;
  if (e >= 0) {
    const ip = ds.slice(0, e + 1).padEnd(e + 1, "0");
    const fp = ds.slice(e + 1).replace(/0+$/, "");
    out = fp ? `${ip}.${fp}` : ip;
  } else {
    out = `0.${"0".repeat(-e - 1)}${ds}`.replace(/0+$/, "");
  }
  return s + out;
}

/** The exact decimal when the denominator is 2^a·5^b and the text is short, else 30 significant digits. */
export function formatQ(a: Q): { text: string; exact: boolean } {
  let d = a.d, twos = 0, fives = 0;
  while (d % 2n === 0n) { d /= 2n; twos++; }
  while (d % 5n === 0n) { d /= 5n; fives++; }
  if (d === 1n) {
    const k = Math.max(twos, fives);
    const scaled = a.n * (pow10(k) / a.d);
    const neg_ = scaled < 0n;
    const digits = babs(scaled).toString().padStart(k + 1, "0");
    const ip = digits.slice(0, digits.length - k), fp = k ? digits.slice(digits.length - k) : "";
    const text = `${neg_ ? "-" : ""}${ip}${fp ? `.${fp}` : ""}`;
    if (text.length <= MAX_TEXT) return { text, exact: true };
  }
  return { text: roundSig(a, 30), exact: false };
}

type Tok = { k: "num"; v: Q } | { k: "op"; op: string } | { k: "(" } | { k: ")" };

export function tokenize(src: string): Tok[] {
  const s = src.replace(/[×✕]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/\*\*/g, "^").replace(/[$_]/g, "");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if ("+-*/^%".includes(c)) { out.push({ k: "op", op: c }); i++; continue; }
    if (c === "(") { out.push({ k: "(" }); i++; continue; }
    if (c === ")") { out.push({ k: ")" }); i++; continue; }
    const m = /^(?:0x[0-9a-f]+|(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d*)?(?:e[+-]?\d+)?[kmbt]?|\.\d+(?:e[+-]?\d+)?[kmbt]?)(?![0-9a-z.,])/i.exec(s.slice(i));
    if (!m) throw new CalcError(`unexpected "${s.slice(i, i + 12)}" at position ${i + 1}`);
    out.push({ k: "num", v: parseDecimal(m[0]) });
    i += m[0].length;
    if (out.length > MAX_TOKENS) throw new CalcError("expression too long");
  }
  return out;
}

const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, mod: 2, neg: 3, "^": 4 };
const RIGHT_ASSOC = new Set(["^", "neg"]);

/** Shunting-yard → RPN → exact evaluation. `%` after a value = ÷100 (200*5% = 10); `%` between two values = remainder.
 *  Unary minus binds looser than ^ (-2^2 = -4, 2^-1 = 0.5). No identifiers, no implicit multiplication. */
export function evalExpression(src: string): { value: Q; exact: boolean } {
  const text = String(src ?? "").trim();
  if (!text) throw new CalcError("empty expression");
  if (text.length > MAX_EXPR) throw new CalcError("expression too long");
  const toks = tokenize(text);
  const outQ: (Q | string)[] = [];
  const ops: string[] = [];
  let prev: "start" | "operand" | "operator" | "(" = "start";
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === "num") {
      if (prev === "operand") throw new CalcError("two numbers in a row: missing operator");
      outQ.push(t.v); prev = "operand"; continue;
    }
    if (t.k === "(") {
      if (prev === "operand") throw new CalcError('missing operator before "("');
      ops.push("("); prev = "("; continue;
    }
    if (t.k === ")") {
      if (prev !== "operand") throw new CalcError('nothing before ")"');
      while (ops.length && ops[ops.length - 1] !== "(") outQ.push(ops.pop()!);
      if (!ops.length) throw new CalcError('unbalanced ")"');
      ops.pop(); prev = "operand"; continue;
    }
    let op = t.op;
    if ((op === "-" || op === "+") && prev !== "operand") {
      if (op === "-") ops.push("neg");
      prev = "operator"; continue;
    }
    if (prev !== "operand") throw new CalcError(`"${op}" has nothing on its left`);
    if (op === "%") {
      const next = toks[i + 1];
      if (!next || next.k === ")" || next.k === "op") { outQ.push("pct"); prev = "operand"; continue; }
      op = "mod";
    }
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top === "(") break;
      if (PREC[top] > PREC[op] || (PREC[top] === PREC[op] && !RIGHT_ASSOC.has(op))) outQ.push(ops.pop()!);
      else break;
    }
    ops.push(op); prev = "operator";
  }
  if (prev !== "operand") throw new CalcError("the expression ends with an operator");
  while (ops.length) { const o = ops.pop()!; if (o === "(") throw new CalcError('unbalanced "("'); outQ.push(o); }
  const ctx = { inexact: false };
  const st: Q[] = [];
  for (const x of outQ) {
    if (typeof x !== "string") { st.push(x); continue; }
    if (x === "neg" || x === "pct") {
      const a = st.pop();
      if (!a) throw new CalcError("malformed expression");
      st.push(x === "neg" ? neg(a) : div(a, HUNDRED));
      continue;
    }
    const b = st.pop(), a = st.pop();
    if (!a || !b) throw new CalcError("malformed expression");
    st.push(x === "+" ? add(a, b) : x === "-" ? sub(a, b) : x === "*" ? mul(a, b) : x === "/" ? div(a, b) : x === "mod" ? mod(a, b) : power(a, b, ctx));
    if (bits(st[st.length - 1].n) + bits(st[st.length - 1].d) > MAX_BITS * 2) throw new CalcError("result is too large");
  }
  if (st.length !== 1) throw new CalcError("malformed expression");
  return { value: st[0], exact: !ctx.inexact };
}

const out = (v: Q, exactPath = true) => { const f = formatQ(v); return { result: f.text, value: Number(roundSig(v, 12)), exact: exactPath && f.exact }; };

/** A numeric argument: a JSON number or text (an expression is fine: "1.5k", "1e18", "2/3"). */
function numArg(args: Record<string, any>, key: string, warn: string[]): Q | null {
  const v = args[key];
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new CalcError(`${key} is not a finite number`);
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) warn.push(`${key} arrived as a JSON number above 2^53 and may already have lost digits; pass big raw amounts as strings.`);
    return fromNumber(v);
  }
  const e = evalExpression(String(v));
  return e.value;
}
const need = (x: Q | null, key: string): Q => { if (!x) throw new CalcError(`${key} is required`); return x; };

const UNIT_DECIMALS: Record<string, number | "token"> = { raw: 0, wei: 0, base: 0, gwei: 9, ether: 18, eth: 18, human: "token", token: "token", units: "token", decimal: "token" };
const PERIODS: Record<string, number | "continuous"> = { yearly: 1, annual: 1, annually: 1, quarterly: 4, monthly: 12, weekly: 52, daily: 365, hourly: 8760, continuous: "continuous" };

function periodsArg(args: Record<string, any>, def: number, warn: string[]): number | "continuous" {
  const v = args.periods;
  if (v == null || v === "") return def;
  const key = String(v).trim().toLowerCase();
  if (key in PERIODS) return PERIODS[key];
  const n = numArg(args, "periods", warn)!;
  if (!isInt(n) || n.n <= 0n || n.n > 1_000_000n) throw new CalcError("periods must be a whole number of compounding periods per year (365 = daily) or daily / weekly / monthly / continuous");
  return Number(n.n);
}

/** The calc tool, pure and synchronous. */
export function runCalc(args: Record<string, any>): Record<string, unknown> {
  const op = String(args.op ?? (args.expression != null ? "expr" : "")).trim().toLowerCase() || "expr";
  const warn: string[] = [];
  const withWarn = (o: Record<string, unknown>) => (warn.length ? { ...o, note: [o.note, ...warn].filter(Boolean).join(" ") } : o);
  try {
    switch (op) {
      case "expr": case "expression": case "eval": {
        const expression = String(args.expression ?? args.expr ?? "");
        const r = evalExpression(expression);
        const o = out(r.value, r.exact);
        return withWarn({ op: "expr", input: { expression: expression.slice(0, 200) }, ...o, ...(o.exact ? {} : { note: r.exact ? "The exact value does not terminate: rounded to 30 significant digits." : "A non-integer power was computed in floating point: about 15 significant digits are reliable." }) });
      }
      case "units": {
        const amount = need(numArg(args, "amount", warn), "amount");
        const fromU = String(args.from_unit ?? "raw").trim().toLowerCase();
        const fd = UNIT_DECIMALS[fromU];
        if (fd === undefined) throw new CalcError(`from_unit must be one of raw, human, wei, gwei, ether`);
        const defTo = fd === "token" ? "raw" : fromU === "raw" ? "human" : fromU === "ether" || fromU === "eth" ? "wei" : "ether";
        const toU = String(args.to_unit ?? defTo).trim().toLowerCase();
        const td = UNIT_DECIMALS[toU];
        if (td === undefined) throw new CalcError(`to_unit must be one of raw, human, wei, gwei, ether`);
        let tokenDec: number | null = null;
        if (fd === "token" || td === "token") {
          const d = Number(args.decimals);
          if (args.decimals == null || args.decimals === "" || !Number.isInteger(d) || d < 0 || d > 36) throw new CalcError("decimals is required for raw ↔ human (the token's decimals: 6 for USDC, 18 for most tokens); never assume it");
          tokenDec = d;
        }
        const fromDec = fd === "token" ? tokenDec! : fd;
        const toDec = td === "token" ? tokenDec! : td;
        let v = div(mul(amount, q(pow10(fromDec))), q(pow10(toDec)));
        let note: string | undefined;
        if (toDec === 0 && !isInt(v)) {
          const exact = formatQ(v).text;
          v = q(v.n / v.d);
          note = `${exact} is not a whole number of ${toU} units: truncated (the amount has more decimals than the unit allows).`;
        }
        return withWarn({ op: "units", input: { amount: String(args.amount).slice(0, 80), from_unit: fromU, to_unit: toU, ...(tokenDec != null ? { decimals: tokenDec } : {}) }, ...out(v), ...(note ? { note } : {}) });
      }
      case "pct_change": {
        const from = need(numArg(args, "from", warn), "from"), to = need(numArg(args, "to", warn), "to");
        if (from.n === 0n) throw new CalcError("from is 0: a percentage change from zero is undefined");
        const diff = sub(to, from);
        const pct = mul(div(diff, from.n < 0n ? neg(from) : from), HUNDRED);
        return withWarn({ op: "pct_change", input: { from: String(args.from), to: String(args.to) }, ...out(pct), results: { changePct: out(pct), difference: out(diff), multiple: out(div(to, from)) } });
      }
      case "apr_to_apy": {
        const apr = need(numArg(args, "rate_pct", warn), "rate_pct");
        const n = periodsArg(args, 365, warn);
        const ctx = { inexact: false };
        const r = div(apr, HUNDRED);
        const apy = n === "continuous" ? (ctx.inexact = true, fromNumber(Math.expm1(toNumber(r)))) : sub(power(add(ONE, div(r, q(BigInt(n)))), q(BigInt(n)), ctx), ONE);
        const pct = mul(apy, HUNDRED);
        return withWarn({ op: "apr_to_apy", input: { rate_pct: String(args.rate_pct), periods: n }, ...out(pct, !ctx.inexact), note: `APY % with ${n === "continuous" ? "continuous" : `${n}×/year`} compounding of the APR; assumes the rate stays constant all year.` });
      }
      case "apy_to_apr": {
        const apy = need(numArg(args, "rate_pct", warn), "rate_pct");
        const n = periodsArg(args, 365, warn);
        const y = toNumber(div(apy, HUNDRED));
        if (!(y > -1)) throw new CalcError("APY must be above -100%");
        const apr = n === "continuous" ? Math.log1p(y) : Math.expm1(Math.log1p(y) / n) * n;
        return withWarn({ op: "apy_to_apr", input: { rate_pct: String(args.rate_pct), periods: n }, ...out(fromNumber(apr * 100), false), note: "APR % that compounds to this APY (floating point, ~15 significant digits)." });
      }
      case "compound": {
        const p = need(numArg(args, "principal", warn), "principal");
        const rate = need(numArg(args, "rate_pct", warn), "rate_pct");
        const k = need(numArg(args, "periods", warn), "periods");
        if (cmp(k, ZERO_Q) < 0) throw new CalcError("periods must not be negative");
        const ctx = { inexact: false };
        const fin = mul(p, power(add(ONE, div(rate, HUNDRED)), k, ctx));
        const gain = sub(fin, p);
        return withWarn({ op: "compound", input: { principal: String(args.principal), rate_pct: String(args.rate_pct), periods: String(args.periods) }, ...out(fin, !ctx.inexact), results: { final: out(fin, !ctx.inexact), gain: out(gain, !ctx.inexact), ...(p.n !== 0n ? { gainPct: out(mul(div(gain, p), HUNDRED), !ctx.inexact) } : {}) }, note: "rate_pct is the rate per period; the same rate every period, no withdrawals or fees." });
      }
      case "position": {
        const side = String(args.side ?? "long").toLowerCase() === "short" ? "short" : "long";
        const entry = numArg(args, "entry", warn);
        const exit = numArg(args, "exit", warn) ?? numArg(args, "price", warn);
        let amount = numArg(args, "amount", warn);
        const size = numArg(args, "size_usd", warn);
        if (!amount && size && entry) { if (entry.n === 0n) throw new CalcError("entry is 0"); amount = div(size, entry); }
        if (!amount) throw new CalcError("amount (units held) or size_usd with entry is required");
        if (!entry && !exit) throw new CalcError("give entry and/or exit (or price)");
        const results: Record<string, unknown> = { amount: out(amount) };
        let primary: Q;
        if (entry) results.costUsd = out(mul(amount, entry));
        if (exit) results.valueUsd = out(mul(amount, exit));
        if (entry && exit) {
          const sign = side === "short" ? q(-1n) : ONE;
          const pnl = mul(mul(sub(exit, entry), amount), sign);
          results.pnlUsd = out(pnl);
          if (entry.n !== 0n) results.pnlPct = out(mul(mul(sub(div(exit, entry), ONE), HUNDRED), sign));
          primary = pnl;
        } else primary = mul(amount, (exit ?? entry)!);
        return withWarn({ op: "position", input: { side, ...(args.amount != null ? { amount: String(args.amount) } : {}), ...(args.size_usd != null ? { size_usd: String(args.size_usd) } : {}), ...(entry ? { entry: String(args.entry) } : {}), ...(exit ? { exit: String(args.exit ?? args.price) } : {}) }, ...out(primary), results, note: "Before fees, funding and slippage. pnlPct is the move on the position's notional (no leverage)." });
      }
      default:
        throw new CalcError(`op must be one of expr, units, pct_change, apr_to_apy, apy_to_apr, compound, position`);
    }
  } catch (e) {
    if (e instanceof CalcError) return { op, error: e.message, note: "Fix the input and call calc again; do not compute it by hand." };
    if (e instanceof RangeError) return { op, error: "the numbers are too large to compute", note: "Use smaller inputs." };
    throw e;
  }
}

// ── registry exports ────────────────────────────────────────────────────────────────────────

export const WALLET_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "wallet_balances",
      description: "What ANY 0x wallet holds right now on Chord's six chains (Monad, Robinhood Chain, Arc, Avalanche, Base, BNB Chain), read on-chain: per chain the native coin and every token on Chord's token list with a balance, its price and USD value, sorted by value, with totals per chain and overall; holdings under $1 are counted as dust. Only tokens on Chord's lists are checked (an unlisted token, LP or staked funds do not show): say so. No chain = all six. Use for 'what does wallet 0x… hold', 'my balances', 'how much USDC does this address have on Base', 'portfolio value of 0x…'. For trading PnL use the *_wallet_pnl / chain_wallet tools.",
      parameters: { type: "object", properties: {
        wallet: { type: "string", description: "0x address (40 hex characters)" },
        chain: { type: "string", description: "optional: monad, robinhood, arc, avalanche, base or bnb; omit to read all six" },
      }, required: ["wallet"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chain_tx",
      description: "Decode ANY transaction hash on Chord's six chains (Monad, Robinhood Chain, Arc, Avalanche, Base, BNB Chain) straight from the chain: status (success / failed / pending), block and time, from, to (named when it is Chord's router or a listed token), native value, gas used and fee, the 4-byte method, every ERC-20 Transfer in its logs (token, from, to, amount) and the signer's net token flow, with an explorer link. Give chain when known; otherwise all six are tried. Use when the person pastes a tx hash: 'what happened in 0x…', 'did my swap go through', 'why did this fail', 'what did this tx send'. For priced swap legs on Arc / Robinhood Chain, arc_tx / rh_tx add USD per leg.",
      parameters: { type: "object", properties: {
        tx: { type: "string", description: "0x… 32-byte transaction hash (66 characters)" },
        chain: { type: "string", description: "optional: monad, robinhood, arc, avalanche, base or bnb" },
      }, required: ["tx"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "calc",
      description: "Exact math, so you never compute in your head. op=expr (default): an expression with + - * / ^ and parentheses, decimals, 1e18, 1.5k / 2m / 3b, `5%` = 0.05 (200*5% = 10), `a % b` = remainder. Named ops: units (amount between raw ↔ human with the token's decimals, or wei / gwei / ether), pct_change (from → to: % change, difference, multiple), apr_to_apy / apy_to_apr (rate_pct, periods per year: 365, 12, daily, continuous), compound (principal, rate_pct per period, periods), position (amount or size_usd, entry, exit; side long / short → cost, value, PnL $ and %). Returns the exact result as a string plus a rounded number. Pass big raw amounts as strings. Use for ANY arithmetic in an answer: sums, % moves, unit conversion, yield compounding, position PnL.",
      parameters: { type: "object", properties: {
        op: { type: "string", enum: ["expr", "units", "pct_change", "apr_to_apy", "apy_to_apr", "compound", "position"], description: "default expr" },
        expression: { type: "string", description: "op=expr: e.g. (1250.5 - 980) / 980 * 100" },
        amount: { type: "string", description: "units: the amount to convert (raw integers as a string); position: units held" },
        decimals: { type: "number", description: "units: the token's decimals (6 for USDC, 18 for most tokens) when raw ↔ human" },
        from_unit: { type: "string", enum: ["raw", "human", "wei", "gwei", "ether"], description: "units: default raw" },
        to_unit: { type: "string", enum: ["raw", "human", "wei", "gwei", "ether"], description: "units: default human (raw in) / raw (human in)" },
        from: { type: "string", description: "pct_change: starting value" },
        to: { type: "string", description: "pct_change: ending value" },
        rate_pct: { type: "string", description: "apr_to_apy / apy_to_apr: the annual rate in %; compound: the rate per period in %" },
        periods: { type: "string", description: "apr_to_apy / apy_to_apr: compounding periods per year (365, 52, 12, daily, weekly, monthly, hourly, continuous; default 365); compound: number of periods" },
        principal: { type: "string", description: "compound: starting amount" },
        entry: { type: "string", description: "position: entry price" },
        exit: { type: "string", description: "position: exit or current price" },
        size_usd: { type: "string", description: "position: USD size at entry (instead of amount)" },
        side: { type: "string", enum: ["long", "short"], description: "position: default long" },
      }, required: [] },
    },
  },
];

export const WALLET_TOOL_META: Record<string, ToolMeta> = {
  // Token symbols are the contracts' own text (untrusted); the wallet / token / party addresses travel in `addresses`.
  wallet_balances: { group: "wallet_any", label: "Reading the wallet's balances on each chain", untrusted: true, timeoutMs: 15_000 },
  chain_tx: { group: "wallet_any", label: "Reading the transaction on-chain", untrusted: true, timeoutMs: 18_000 },
  // Every number in an answer should come from here: more than the default 3 calls per turn.
  calc: { group: "util", label: "Calculating", maxCalls: 8 },
};

export const WALLET_TOOL_NAMES = ["wallet_balances", "chain_tx", "calc"] as const;
export const isWalletTool = (name: string): boolean => (WALLET_TOOL_NAMES as readonly string[]).includes(name);

/** Runs one tool of this module. Never throws: bad input or a failure is an `{ error, note }` answer. */
export async function runWalletTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  try {
    switch (name) {
      case "wallet_balances": return await walletBalances(args ?? {});
      case "chain_tx": return await chainTx(args ?? {});
      case "calc": return { data: runCalc(args ?? {}), addresses: [], citations: [] };
      default: return fail(`unknown tool ${name}`);
    }
  } catch (e) {
    logger.warn({ tool: name, err: String(e).slice(0, 200) }, "ask wallet tool failed");
    return fail(`${name} failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`, "Say the data is unavailable right now; do not guess numbers.");
  }
}

