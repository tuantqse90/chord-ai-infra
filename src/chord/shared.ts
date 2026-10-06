// ask2049: stand-in for the parts of Chord's @nullterminal/shared that the ported Ask tools import (there is no shared package
// here). Values copied from packages/shared/src/chains.ts (CHAIN_REGISTRY, chainMeta, isChainId) and
// packages/shared/src/constants.ts (NULL_TERMINAL) as of 2026-10-06. Only what services/ask/walletTools.ts (and config/chains.ts
// for it) reads lives here; add a symbol when a newly ported module needs it.

// chains.ts — THE chain registry (docs/multichain-plan.md G4, 2026-09-30).
//
// One row per chain the product knows: id, key, name, native/wrapped asset, pricing anchors with
// their REAL on-chain decimals (read via eth_call decimals() on 2026-09-30 — USDT/USDC on BNB Chain
// are 18-dec, never assume 6), explorer. Pure data: no env, no network.

export type ChainKey = "monad" | "robinhood" | "arc" | "avalanche" | "base" | "bnb";

export interface ChainAnchor {
  symbol: string;
  /** lowercase 40-hex */
  address: string;
  /** read on-chain, never defaulted */
  decimals: number;
  /** 1 = a dollar stable priced at $1; null = a rate anchor (price read from the chain's own pools) */
  stableUsd: number | null;
}

export interface ChainMeta {
  id: number;
  key: ChainKey;
  name: string;
  /** Short label for badges ("Monad", "RH", "Arc", "AVAX", "Base", "BNB"). */
  short: string;
  nativeSymbol: string;
  /** Native asset decimals — a chain constant (Arc's native USDC is 18 in native form). */
  nativeDecimals: number;
  /** The ERC-20 the zero address is stored under (WMON / WETH / the Arc USDC predeploy / WAVAX / WBNB). */
  wrappedNative: string;
  anchors: readonly ChainAnchor[];
  explorer: string;
  /** Measured average block time (seconds). */
  blockTimeSec: number;
  /** `live` = public product surface; `dark` = integrating (docs/multichain-plan.md M1–M3). */
  status: "live" | "dark";
}

export const CHAIN_REGISTRY = [
  {
    id: 143, key: "monad", name: "Monad", short: "Monad", nativeSymbol: "MON", nativeDecimals: 18,
    wrappedNative: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    anchors: [
      { symbol: "WMON", address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", decimals: 18, stableUsd: null },
      { symbol: "USDC", address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", decimals: 6, stableUsd: 1 },
    ],
    explorer: "https://monadscan.com", blockTimeSec: 0.3, status: "live",
  },
  {
    id: 4663, key: "robinhood", name: "Robinhood Chain", short: "RH", nativeSymbol: "ETH", nativeDecimals: 18,
    wrappedNative: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    anchors: [
      { symbol: "WETH", address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", decimals: 18, stableUsd: null },
      { symbol: "USDG", address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, stableUsd: 1 },
    ],
    explorer: "https://robinhoodchain.blockscout.com", blockTimeSec: 0.1, status: "live",
  },
  {
    id: 5042, key: "arc", name: "Arc", short: "Arc", nativeSymbol: "USDC", nativeDecimals: 18,
    wrappedNative: "0x3600000000000000000000000000000000000000",
    anchors: [
      { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6, stableUsd: 1 },
    ],
    explorer: "https://explorer.arc.io", blockTimeSec: 0.5, status: "live",
  },
  {
    id: 43114, key: "avalanche", name: "Avalanche C-Chain", short: "AVAX", nativeSymbol: "AVAX", nativeDecimals: 18,
    wrappedNative: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
    anchors: [
      { symbol: "WAVAX", address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", decimals: 18, stableUsd: null },
      { symbol: "USDC", address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6, stableUsd: 1 },
      { symbol: "USDt", address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6, stableUsd: 1 },
      { symbol: "USDC.e", address: "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664", decimals: 6, stableUsd: 1 },
      { symbol: "USDT.e", address: "0xc7198437980c041c805a1edcba50c1ce5db95118", decimals: 6, stableUsd: 1 },
    ],
    explorer: "https://snowtrace.io", blockTimeSec: 1.3, status: "dark",
  },
  {
    id: 8453, key: "base", name: "Base", short: "Base", nativeSymbol: "ETH", nativeDecimals: 18,
    wrappedNative: "0x4200000000000000000000000000000000000006",
    anchors: [
      { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, stableUsd: null },
      { symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, stableUsd: 1 },
      { symbol: "USDbC", address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", decimals: 6, stableUsd: 1 },
      { symbol: "USDT", address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", decimals: 6, stableUsd: 1 },
    ],
    explorer: "https://basescan.org", blockTimeSec: 2, status: "dark",
  },
  {
    id: 56, key: "bnb", name: "BNB Chain", short: "BNB", nativeSymbol: "BNB", nativeDecimals: 18,
    wrappedNative: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    anchors: [
      { symbol: "WBNB", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", decimals: 18, stableUsd: null },
      // BNB Chain's dollar stables are 18-dec (read on-chain 2026-09-30) — a 6-dec assumption is 1e12 off.
      { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18, stableUsd: 1 },
      { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, stableUsd: 1 },
      { symbol: "USD1", address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", decimals: 18, stableUsd: 1 },
      { symbol: "FDUSD", address: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", decimals: 18, stableUsd: 1 },
      { symbol: "BUSD", address: "0xe9e7cea3dedca5984780bafc599bd69add087d56", decimals: 18, stableUsd: 1 },
    ],
    explorer: "https://bscscan.com", blockTimeSec: 0.45, status: "dark",
  },
] as const satisfies readonly ChainMeta[];

/** Every chain id the registry knows. */
export type ChainId = (typeof CHAIN_REGISTRY)[number]["id"];
const CHAIN_IDS: readonly ChainId[] = CHAIN_REGISTRY.map((c) => c.id);

export function isChainId(n: unknown): n is ChainId {
  return typeof n === "number" && (CHAIN_IDS as readonly number[]).includes(n);
}
export function chainMeta(id: number): ChainMeta | undefined {
  return (CHAIN_REGISTRY as readonly ChainMeta[]).find((c) => c.id === id);
}

// ── constants.ts ─────────────────────────────────────────────────────────────────────────────
// NullTerminal Contracts (deployed) — the same proxy addresses on every Chord chain (aligned nonces).
export const NULL_TERMINAL = {
  ROUTER: "0x1b1fee89a381e595fe6536b99ba91f3e16e9601a",
  EXECUTOR: "0x4bd6cc6bfa321971f96db60e64aa9c86ccff2f7e",
  FEE_COLLECTOR: "0x6c66229675fd9ceda9a9b2ea2bd983b3d8255834",
  ADAPTER_REGISTRY: "0x6cf25d2af1a58d7094b0ac253ae616a8e1f2ea3f",
} as const;
