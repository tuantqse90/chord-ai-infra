// ask2049: copied from Chord packages/api/src/services/ask/walletTools.test.ts (2026-10-06); imports resolve to the src/chord stand-ins unchanged.
import { describe, expect, it } from "bun:test";
import { formatUnits, toFunctionSelector, type AbiFunction } from "viem";
import { NULL_ROUTER_ABI } from "../../config/contracts";
import {
  WALLET_TOOL_META, WALLET_TOOL_NAMES, WALLET_TOOL_SCHEMAS, buildBalancesAnswer, buildTxAnswer, cleanSymbol, decodeTransfers,
  evalExpression, fmtAmount, formatQ, isWalletTool, methodOf, netFlows, parseChordChain, runCalc, summarizeHoldings,
  type ChainRead, type RawLog, type RawReceipt, type RawTx, type TokenInfo,
} from "./walletTools";

const expr = (e: string) => runCalc({ expression: e }) as { result?: string; value?: number; exact?: boolean; error?: string };

describe("wallet tools: registry rows", () => {
  it("every schema has a META row, a name in the list, and the dispatcher recognises it", () => {
    const names = WALLET_TOOL_SCHEMAS.map((s) => s.function.name);
    expect(names.sort()).toEqual([...WALLET_TOOL_NAMES].sort());
    for (const n of names) {
      expect(WALLET_TOOL_META[n]).toBeDefined();
      expect(isWalletTool(n)).toBe(true);
    }
    expect(WALLET_TOOL_META.wallet_balances.group).toBe("wallet_any");
    expect(WALLET_TOOL_META.chain_tx.group).toBe("wallet_any");
    expect(WALLET_TOOL_META.calc.group).toBe("util");
    // Token symbols are contract text: their tools are untrusted (the addresses travel in `addresses`).
    expect(WALLET_TOOL_META.chain_tx.untrusted).toBe(true);
    expect(isWalletTool("arc_tx")).toBe(false);
  });
  it("model-facing text has no em dashes", () => {
    for (const s of WALLET_TOOL_SCHEMAS) expect(s.function.description.includes("—")).toBe(false);
    for (const m of Object.values(WALLET_TOOL_META)) expect(m.label.includes("—")).toBe(false);
  });
});

describe("parseChordChain", () => {
  it("reads Chord's six chains by id, key or common name", () => {
    expect(parseChordChain("monad")).toBe(143);
    expect(parseChordChain(4663)).toBe(4663);
    expect(parseChordChain("Robinhood Chain")).toBe(4663);
    expect(parseChordChain("RH")).toBe(4663);
    expect(parseChordChain("arc")).toBe(5042);
    expect(parseChordChain("AVAX")).toBe(43114);
    expect(parseChordChain("avalanche c-chain")).toBe(43114);
    expect(parseChordChain("Base")).toBe(8453);
    expect(parseChordChain("bsc")).toBe(56);
    expect(parseChordChain("BNB Chain")).toBe(56);
  });
  it("empty / all = every chain; other chains are refused", () => {
    expect(parseChordChain(undefined)).toBe("all");
    expect(parseChordChain("")).toBe("all");
    expect(parseChordChain("all")).toBe("all");
    expect(parseChordChain("eth")).toBeNull();
    expect(parseChordChain("solana")).toBeNull();
    expect(parseChordChain("arbitrum")).toBeNull();
  });
});

describe("calc: expressions", () => {
  it("precedence and associativity", () => {
    expect(expr("2+3*4").result).toBe("14");
    expect(expr("(2+3)*4").result).toBe("20");
    expect(expr("2^3^2").result).toBe("512"); // right-associative
    expect(expr("10 - 4 - 3").result).toBe("3"); // left-associative
    expect(expr("100 / 10 / 5").result).toBe("2");
    expect(expr("2 ** 10").result).toBe("1024");
    expect(expr("3 × 4 ÷ 2").result).toBe("6");
  });
  it("unary minus binds looser than ^ and works after an operator", () => {
    expect(expr("-2^2").result).toBe("-4");
    expect(expr("2^-1").result).toBe("0.5");
    expect(expr("2*-3").result).toBe("-6");
    expect(expr("-(2+3)*2").result).toBe("-10");
    expect(expr("2*-3^2").result).toBe("-18");
    expect(expr("--5").result).toBe("5");
  });
  it("% after a value is a percent, between two values a remainder", () => {
    expect(expr("200*5%").result).toBe("10");
    expect(expr("5% * 200").result).toBe("10");
    expect(expr("10 % 3").result).toBe("1");
    expect(expr("10.5 % 3").result).toBe("1.5");
    expect(expr("-10 % 3").result).toBe("-1");
  });
  it("exact decimals, suffixes, separators, scientific notation", () => {
    const r = expr("0.1 + 0.2");
    expect(r.result).toBe("0.3");
    expect(r.exact).toBe(true);
    expect(expr("1.5k + 2m").result).toBe("2001500");
    expect(expr("3b / 1,000").result).toBe("3000000");
    expect(expr("1,000,000 / 4").result).toBe("250000");
    expect(expr("1e18 / 1e9").result).toBe("1000000000");
    expect(expr("2.5e-3 * 4").result).toBe("0.01");
    expect(expr("$1,250.50 - $980").result).toBe("270.5");
    expect(expr("0x10 + 1").result).toBe("17");
  });
  it("big integers stay exact", () => {
    expect(expr("123456789012345678901234567890 * 10").result).toBe("1234567890123456789012345678900");
    expect(expr("2^100").result).toBe("1267650600228229401496703205376");
  });
  it("non-terminating and non-integer powers say they are rounded", () => {
    const third = expr("1/3");
    expect(third.exact).toBe(false);
    expect(third.result).toBe("0.333333333333333333333333333333");
    expect(expr("2/3").result).toBe("0.666666666666666666666666666667");
    const root = expr("2^0.5");
    expect(root.exact).toBe(false);
    expect(root.value).toBeCloseTo(1.41421356237, 10);
  });
  it("bad input answers an error, never throws", () => {
    for (const bad of ["", "2+", "(1+2", "1+2)", "abc", "2 3", "1,5", "2(3)", "*5", "5e", "(-8)^0.5"]) {
      const r = expr(bad);
      expect(r.error).toBeDefined();
    }
    expect(expr("1/0").error).toContain("division by zero");
    expect(expr("5 % 0").error).toContain("remainder by zero");
    expect((runCalc({ op: "nope" }) as { error?: string }).error).toContain("op must be one of");
  });
  it("formatQ prints exact terminating decimals and evalExpression reports exactness", () => {
    expect(formatQ(evalExpression("1/8").value)).toEqual({ text: "0.125", exact: true });
    expect(formatQ(evalExpression("-5/2").value)).toEqual({ text: "-2.5", exact: true });
    expect(evalExpression("1/7").exact).toBe(true); // exact rational, just not a terminating decimal
  });
});

describe("calc: named ops", () => {
  it("units: an 18-decimal raw amount converts without float loss", () => {
    const r = runCalc({ op: "units", amount: "1234567890123456789012345", decimals: 18 }) as { result: string; exact: boolean };
    expect(r.result).toBe("1234567.890123456789012345");
    expect(r.exact).toBe(true);
    expect((runCalc({ op: "units", amount: "1.5", decimals: 6, from_unit: "human" }) as { result: string }).result).toBe("1500000");
    expect((runCalc({ op: "units", amount: "21000", from_unit: "gwei", to_unit: "ether" }) as { result: string }).result).toBe("0.000021");
    expect((runCalc({ op: "units", amount: "1e9", from_unit: "wei", to_unit: "gwei" }) as { result: string }).result).toBe("1");
    expect((runCalc({ op: "units", amount: "0x0de0b6b3a7640000", from_unit: "wei" }) as { result: string }).result).toBe("1");
  });
  it("units: too many decimals truncate with a note; decimals are never assumed", () => {
    const r = runCalc({ op: "units", amount: "1.1234567", decimals: 6, from_unit: "human" }) as { result: string; note: string };
    expect(r.result).toBe("1123456");
    expect(r.note).toContain("truncated");
    expect((runCalc({ op: "units", amount: "1000000" }) as { error: string }).error).toContain("decimals is required");
  });
  it("units: a raw amount sent as a JSON number past 2^53 is flagged", () => {
    const r = runCalc({ op: "units", amount: 1e24, decimals: 18 }) as { result: string; note: string };
    expect(r.result).toBe("1000000");
    expect(r.note).toContain("as strings");
  });
  it("pct_change", () => {
    const up = runCalc({ op: "pct_change", from: "80", to: "100" }) as { result: string; results: Record<string, { result: string }> };
    expect(up.result).toBe("25");
    expect(up.results.difference.result).toBe("20");
    expect(up.results.multiple.result).toBe("1.25");
    expect((runCalc({ op: "pct_change", from: 100, to: 80 }) as { result: string }).result).toBe("-20");
    expect((runCalc({ op: "pct_change", from: 0, to: 5 }) as { error: string }).error).toContain("from is 0");
  });
  it("apr_to_apy / apy_to_apr round-trip", () => {
    const apy = runCalc({ op: "apr_to_apy", rate_pct: "10", periods: "monthly" }) as { value: number };
    expect(apy.value).toBeCloseTo(10.4713067441, 9);
    const cont = runCalc({ op: "apr_to_apy", rate_pct: "10", periods: "continuous" }) as { value: number };
    expect(cont.value).toBeCloseTo(10.5170918076, 9);
    const daily = runCalc({ op: "apr_to_apy", rate_pct: 5 }) as { value: number };
    expect(daily.value).toBeCloseTo(5.1267496, 6);
    const apr = runCalc({ op: "apy_to_apr", rate_pct: String(apy.value), periods: 12 }) as { value: number };
    expect(apr.value).toBeCloseTo(10, 8);
  });
  it("compound is exact for whole periods", () => {
    const r = runCalc({ op: "compound", principal: "1000", rate_pct: "1", periods: "12" }) as { result: string; exact: boolean; results: Record<string, { result: string }> };
    expect(r.result).toBe("1126.825030131969720661201");
    expect(r.exact).toBe(true);
    expect(r.results.gain.result).toBe("126.825030131969720661201");
  });
  it("position: long, short, size in USD", () => {
    const long = runCalc({ op: "position", amount: "2", entry: "100", exit: "120" }) as { result: string; results: Record<string, { result: string }> };
    expect(long.result).toBe("40");
    expect(long.results.pnlPct.result).toBe("20");
    expect(long.results.valueUsd.result).toBe("240");
    const short = runCalc({ op: "position", amount: "2", entry: "100", exit: "120", side: "short" }) as { result: string; results: Record<string, { result: string }> };
    expect(short.result).toBe("-40");
    expect(short.results.pnlPct.result).toBe("-20");
    const sized = runCalc({ op: "position", size_usd: "1000", entry: "50", exit: "40" }) as { result: string; results: Record<string, { result: string }> };
    expect(sized.results.amount.result).toBe("20");
    expect(sized.result).toBe("-200");
    expect((runCalc({ op: "position", entry: "1" }) as { error: string }).error).toContain("amount");
  });
});

// ── chain_tx: trimmed from Base tx 0xaa8b8135…dd27 (block 52,091,000, 2026-10-03) and Arc tx 0x1395fe4d…442c ──

const pad = (a: string) => `0x000000000000000000000000${a.slice(2)}`;
const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const XDP = "0x07b3d902783c3c12b077508c3b5c00113d1291d0";
const SIGNER = "0x58648cb429b3f52e06e429ae1018c20bc6e7372c";
const EXEC = "0xb300000b72deaeb607a12d5f54773d1c19c7028d";
const POOL = "0x2df380544b88adb3ad0a94100dcc45fd705aae2d";
const HOP = "0x72554764bbbac473eb0a2f8da9e723ccfdb47a14";
const BASE_LOGS: RawLog[] = [
  { address: BASE_USDC, topics: [T, pad(SIGNER), pad(EXEC)], data: "0x000000000000000000000000000000000000000000000000000000000e75598a", logIndex: "0x26" },
  { address: BASE_USDC, topics: [APPROVAL, pad(EXEC), pad("0x8157a9d65807521fbb8db8f37eeecefdd247e9b1")], data: "0x000000000000000000000000000000000000000000000000000000000e75598a", logIndex: "0x27" },
  { address: BASE_USDC, topics: [T, pad(EXEC), pad(HOP)], data: "0x000000000000000000000000000000000000000000000000000000000e75598a", logIndex: "0x28" },
  { address: XDP, topics: [T, pad(POOL), pad(EXEC)], data: "0x0000000000000000000000000000000000000000000002b628dac441fa78b8a8", logIndex: "0x29" },
  { address: BASE_USDC, topics: [T, pad(HOP), pad(POOL)], data: "0x000000000000000000000000000000000000000000000000000000000e75598a", logIndex: "0x2a" },
  { address: POOL, topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", pad(HOP), pad(EXEC)], data: "0x", logIndex: "0x2b" },
  { address: XDP, topics: [T, pad(EXEC), pad(SIGNER)], data: "0x0000000000000000000000000000000000000000000002b628dac441fa78b8a8", logIndex: "0x2e" },
];
const BASE_TX: RawTx = {
  hash: "0xaa8b81355aafc260f1af6e69fc3788f32af8fedee81f3222f83a36667602dd27", from: SIGNER, to: EXEC, value: "0x0",
  input: "0x810c705b0000", blockNumber: "0x31ad878", blockTimestamp: "0x6ac00dd3", gasPrice: "0x95408d",
};
const BASE_RECEIPT: RawReceipt = { status: "0x1", gasUsed: "0x4db0d", effectiveGasPrice: "0x95408d", l1Fee: "0x15b46a684", logs: BASE_LOGS, contractAddress: null };
const BASE_TOKENS = new Map<string, TokenInfo>([
  [BASE_USDC, { symbol: "USDC", decimals: 6, listed: true }],
  [XDP, { symbol: "XDP", decimals: 18, listed: false }],
]);

const ARC_SIGNER = "0xc6d568af5305f54f5a88d73633a92f440f214fe3";
const ARC_PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const MEMES = "0x01bc751c57ba53bfe593f20f8a09ac20689d48e0";
const ARC_LOGS: RawLog[] = [
  { address: ARC_PM, topics: ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "0xaa9b3cd15289a00674318ae6478fd57b4d2fa0dc7ceab7437b2621bd9d4d8038", pad("0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1")], data: "0x", logIndex: "0x5" },
  { address: "0xfffffffffffffffffffffffffffffffffffffffe", topics: [T, pad(ARC_SIGNER), pad(ARC_PM)], data: "0x000000000000000000000000000000000000000000000000a688906bd8b00000", logIndex: "0x6" },
  { address: "0x3600000000000000000000000000000000000000", topics: [T, pad(ARC_SIGNER), pad(ARC_PM)], data: "0x0000000000000000000000000000000000000000000000000000000000b71b00", logIndex: "0x7" },
  { address: MEMES, topics: [T, pad(ARC_PM), pad(ARC_SIGNER)], data: "0x00000000000000000000000000000000000000000000874ebe44027c748c23f3", logIndex: "0x8" },
];

describe("chain_tx: log decoding", () => {
  it("decodes ERC-20 Transfers and counts the other logs (Base swap)", () => {
    const d = decodeTransfers(BASE_LOGS, 8453);
    expect(d.transfers.length).toBe(5);
    expect(d.otherLogs).toBe(2); // Approval + Swap
    expect(d.transfers[0]).toEqual({ token: BASE_USDC, from: SIGNER, to: EXEC, raw: 242_571_658n, logIndex: 38 });
    const net = netFlows(d.transfers, SIGNER);
    expect(net.get(BASE_USDC)).toBe(-242_571_658n);
    expect(formatUnits(net.get(XDP)!, 18)).toBe("12804.98426824852299588");
    expect(net.size).toBe(2);
  });
  it("drops Arc's 18-decimal native mirror log (the 6-decimal predeploy log is the same move)", () => {
    const d = decodeTransfers(ARC_LOGS, 5042);
    expect(d.mirrorSkipped).toBe(1);
    expect(d.transfers.map((t) => t.token)).toEqual(["0x3600000000000000000000000000000000000000", MEMES]);
    expect(d.transfers[0].raw).toBe(12_000_000n);
    // On another chain the same sentinel would just be a token.
    expect(decodeTransfers(ARC_LOGS, 8453).mirrorSkipped).toBe(0);
  });
  it("reads wrapped-native deposits and NFT transfers", () => {
    const weth = "0x4200000000000000000000000000000000000006";
    const d = decodeTransfers([
      { address: weth, topics: ["0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", pad(SIGNER)], data: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" },
      { address: "0x1111111111111111111111111111111111111111", topics: [T, pad(SIGNER), pad(EXEC), "0x0000000000000000000000000000000000000000000000000000000000000007"], data: "0x" },
    ], 8453);
    expect(d.wraps).toEqual([{ kind: "wrap", account: SIGNER, raw: 10n ** 18n }]);
    expect(d.nftTransfers).toBe(1);
    expect(d.transfers.length).toBe(0);
  });
  it("names the method: common selectors, Chord router entry points, plain transfers", () => {
    expect(methodOf("0x095ea7b3" + "00".repeat(64), "0x1234567890123456789012345678901234567890").name).toBe("approve");
    expect(methodOf("0x3593564c00", null).name).toBe("execute");
    const swapSel = toFunctionSelector(NULL_ROUTER_ABI.find((i) => i.name === "swap") as unknown as AbiFunction);
    expect(swapSel).toBe("0xdc72a437");
    expect(methodOf(swapSel + "00", "0x1b1fee89a381e595fe6536b99ba91f3e16e9601a").name).toBe("swap (Chord router)");
    expect(methodOf("0x", "0x1234567890123456789012345678901234567890")).toEqual({ selector: null, name: "plain transfer (no calldata)" });
    expect(methodOf("0x810c705b00", null)).toEqual({ selector: "0x810c705b", name: null });
  });
});

describe("chain_tx: answer", () => {
  it("builds status, fee with the L1 part, transfers, signer net and the explorer link (Base fixture)", () => {
    const r = buildTxAnswer({ chain: 8453, tx: BASE_TX, receipt: BASE_RECEIPT, blockTs: 0x6ac00dd3, tokens: BASE_TOKENS, listedSymbols: new Set(["usdc", "weth"]), nativeUsd: 2600, nowS: 0x6ac00dd3 + 600 });
    const d = r.data as Record<string, any>;
    expect(d.status).toBe("success");
    expect(d.chain).toBe("Base");
    expect(d.block).toBe(52_091_000);
    expect(d.minutesAgo).toBe(10);
    expect(d.gasUsed).toBe(0x4db0d);
    expect(d.fee).toBe(formatUnits(0x4db0dn * 0x95408dn + 0x15b46a684n, 18));
    expect(d.feeUsd).toBeCloseTo(Number(d.fee) * 2600, 4);
    expect(d.method).toEqual({ selector: "0x810c705b", name: null });
    expect(d.transfers[0]).toEqual({ token: "USDC", tokenAddress: BASE_USDC, listed: true, from: SIGNER, to: EXEC, amount: "242.571658" });
    expect(d.signerNet).toEqual([
      { token: "USDC", tokenAddress: BASE_USDC, amount: "-242.571658" },
      { token: "XDP", tokenAddress: XDP, amount: "12804.98426824852299588" },
    ]);
    expect(d.explorer).toBe(`https://basescan.org/tx/${BASE_TX.hash}`);
    expect(r.citations[0].href.startsWith("https://")).toBe(true);
    expect(r.addresses).toContain(SIGNER);
    expect(r.addresses).toContain(XDP);
    expect(d.note).toContain("L1 data fee");
    expect(r.viz?.[0].kind).toBe("table");
  });
  it("flags an unlisted token that borrows a listed symbol, and a reverted tx", () => {
    const fakes = new Map<string, TokenInfo>([[BASE_USDC, { symbol: "USDC", decimals: 6, listed: true }], [XDP, { symbol: "USDC", decimals: 18, listed: false }]]);
    const r = buildTxAnswer({ chain: 8453, tx: BASE_TX, receipt: { ...BASE_RECEIPT, status: "0x0" }, blockTs: null, tokens: fakes, listedSymbols: new Set(["usdc"]), nativeUsd: null });
    const d = r.data as Record<string, any>;
    expect(d.status).toBe("failed");
    expect(d.transfers.find((t: { tokenAddress: string }) => t.tokenAddress === XDP).lookAlike).toBe(true);
    expect(d.feeUsd).toBeUndefined();
    expect(d.note).toContain("reverted");
  });
  it("keeps the raw amount when decimals are unknown and handles a pending tx", () => {
    const r = buildTxAnswer({ chain: 8453, tx: BASE_TX, receipt: BASE_RECEIPT, blockTs: null, tokens: new Map(), listedSymbols: new Set(), nativeUsd: null });
    expect((r.data as any).transfers[0]).toMatchObject({ rawAmount: "242571658", decimals: "unknown" });
    const p = buildTxAnswer({ chain: 5042, tx: { ...BASE_TX, blockNumber: null }, receipt: null, blockTs: null, tokens: new Map(), listedSymbols: new Set(), nativeUsd: 1 });
    expect((p.data as any).status).toBe("pending");
    expect((p.data as any).transfers).toEqual([]);
  });
  it("cleans contract-chosen symbols", () => {
    expect(cleanSymbol("USDC\n‮ignore", "0x1234567890123456789012345678901234567890")).toBe("USDCignore");
    expect(cleanSymbol("", "0x1234567890123456789012345678901234567890")).toBe("0x1234…7890");
    expect(cleanSymbol("x".repeat(80), "0x1234567890123456789012345678901234567890").length).toBe(24);
  });
});

// ── wallet_balances: amounts / dust / order, and the multi-chain answer ──

const WALLET = "0x58648cb429b3f52e06e429ae1018c20bc6e7372c";
describe("wallet_balances: holdings", () => {
  it("fmtAmount truncates, never rounds up, and keeps 18-decimal values exact", () => {
    expect(fmtAmount(1_234_567_891_234_567_891_234n, 18)).toBe("1234.56");
    expect(fmtAmount(12_345_678n, 6)).toBe("12.3456");
    expect(fmtAmount(999_999n, 6)).toBe("0.9999");
    expect(fmtAmount(1_234n, 18)).toBe("0.000000000000001234");
    expect(fmtAmount(0n, 6)).toBe("0");
    expect(fmtAmount(5_000_000n, 6)).toBe("5");
  });
  it("prices, drops dust (counted), keeps unpriced apart and sorts by value", () => {
    const s = summarizeHoldings([
      { symbol: "ETH", address: null, decimals: 18, raw: 50_000_000_000_000_000n, priceUsd: 2600, native: true }, // $130
      { symbol: "USDC", address: BASE_USDC, decimals: 6, raw: 1_250_500_000n, priceUsd: 1 }, // $1,250.50
      { symbol: "DEGEN", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", decimals: 18, raw: 10n ** 18n * 100n, priceUsd: 0.005 }, // $0.50 dust
      { symbol: "AERO", address: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", decimals: 18, raw: 3n * 10n ** 17n, priceUsd: 1.2 }, // $0.36 dust
      { symbol: "XDP", address: XDP, decimals: 18, raw: 12_804_984_268_248_522_995_880n, priceUsd: null },
      { symbol: "ZERO", address: "0x1111111111111111111111111111111111111111", decimals: 18, raw: 0n, priceUsd: 1 },
    ]);
    expect(s.rows.map((r) => r.symbol)).toEqual(["USDC", "ETH"]);
    expect(s.rows[0].valueUsd).toBe(1251); // whole dollars from $1k
    expect(s.rows[1]).toEqual({ symbol: "ETH", address: null, amount: "0.05", priceUsd: 2600, valueUsd: 130, native: true });
    expect(s.totalUsd).toBe(1381);
    expect(s.dust).toEqual({ count: 2, usd: 0.86 });
    expect(s.unpriced.map((u) => u.symbol)).toEqual(["XDP"]);
    expect(s.unpriced[0].amount).toBe("12804.98");
  });
  it("multi-chain answer: totals, donut by chain, unavailable chains named, Arc counted once", () => {
    const reads: ChainRead[] = [
      { chain: 8453, status: "ok", checked: 528, failedReads: 0, priceSource: "Chord's Base index (24h board)", holdings: [
        { symbol: "USDC", address: BASE_USDC, decimals: 6, raw: 1_000_000_000n, priceUsd: 1 },
        { symbol: "DEGEN", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", decimals: 18, raw: 10n ** 18n, priceUsd: 0.005 },
      ] },
      { chain: 5042, status: "ok", checked: 140, failedReads: 0, priceSource: "Chord's Arc index", holdings: [
        { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6, raw: 250_000_000n, priceUsd: 1 },
      ] },
      { chain: 56, status: "ok", checked: 1053, failedReads: 0, priceSource: "Chord's BNB Chain index (24h board)", holdings: [] },
      { chain: 43114, status: "ok", checked: 266, failedReads: 0, priceSource: null, holdings: [] }, // empty: its missing prices are not a caveat
      { chain: 143, status: "unavailable", reason: "timed out" },
      { chain: 4663, status: "no_rpc", reason: "no RPC configured on this deployment" },
    ];
    const r = buildBalancesAnswer(WALLET, reads);
    const d = r.data as Record<string, any>;
    expect(d.totalUsd).toBe(1250);
    expect(d.chains.map((c: { chain: string }) => c.chain)).toEqual(["Base", "Arc"]);
    expect(d.chains[0].dust).toEqual({ count: 1, usd: 0.01 });
    expect(d.emptyOn).toEqual(["BNB Chain", "Avalanche C-Chain"]);
    expect(d.note).not.toContain("Prices could not be read");
    expect(d.unavailable).toEqual([{ chain: "Monad", reason: "timed out" }, { chain: "Robinhood Chain", reason: "no RPC configured on this deployment" }]);
    expect(d.note).toContain("Could not read: Monad (timed out)");
    expect(d.note).toContain("counted once");
    const kinds = (r.viz ?? []).map((v) => v.kind);
    expect(kinds).toEqual(["table", "donut"]);
    const table = r.viz![0] as { rows: (string | number | null)[][] };
    expect(table.rows[0]).toEqual(["Base", "USDC", "1000", "$1,000"]);
    expect(r.citations.map((c) => c.href)).toEqual([`https://basescan.org/address/${WALLET}`, `https://explorer.arc.io/address/${WALLET}`]);
    expect(r.addresses).toContain(WALLET);
    expect(r.addresses).toContain(BASE_USDC);
  });
  it("one chain: no donut; no chain answered: an error the model repeats", () => {
    const one = buildBalancesAnswer(WALLET, [{ chain: 8453, status: "ok", checked: 10, failedReads: 0, priceSource: null, holdings: [{ symbol: "USDC", address: BASE_USDC, decimals: 6, raw: 5_000_000n, priceUsd: 1 }] }]);
    expect((one.viz ?? []).map((v) => v.kind)).toEqual(["table"]);
    expect((one.data as any).note).toContain("Prices could not be read for Base");
    const none = buildBalancesAnswer(WALLET, [{ chain: 8453, status: "unavailable", reason: "timed out" }]);
    expect((none.data as any).error).toBeDefined();
  });
});
