// The swap chains. Solana goes through Jupiter; the EVM chains go through Chord's router (/v1/meta).
export type TradeChain = "solana" | "base" | "bnb" | "avalanche" | "monad" | "robinhood" | "arc";
export type EvmChain = Exclude<TradeChain, "solana">;
export type EvmDef = {
  id: number; name: string; hex: string;
  /** Native gas token as the zero address; null when the chain has none to trade (Arc: gas is USDC, listed as the predeploy). */
  native: { symbol: string; name: string; decimals: number } | null;
  explorer: string | null; rpc: string | null;
  /** Shown first in the token picker, by symbol, in this order. */
  pin: string[];
};
export const NATIVE = "0x0000000000000000000000000000000000000000";

export const EVM: Record<EvmChain, EvmDef> = {
  base: { id: 8453, name: "Base", hex: "0x2105", native: { symbol: "ETH", name: "Ether", decimals: 18 }, explorer: "https://basescan.org/tx/", rpc: "https://mainnet.base.org", pin: ["USDC", "WETH", "cbBTC", "AERO", "VIRTUAL"] },
  bnb: { id: 56, name: "BNB Chain", hex: "0x38", native: { symbol: "BNB", name: "BNB", decimals: 18 }, explorer: "https://bscscan.com/tx/", rpc: "https://bsc-dataseed.bnbchain.org", pin: ["USDT", "USDC", "WBNB", "BTCB", "ETH", "Cake"] },
  avalanche: { id: 43114, name: "Avalanche", hex: "0xa86a", native: { symbol: "AVAX", name: "Avalanche", decimals: 18 }, explorer: "https://snowtrace.io/tx/", rpc: "https://api.avax.network/ext/bc/C/rpc", pin: ["USDC", "USDt", "WAVAX", "BTC.b", "WETH.e"] },
  monad: { id: 143, name: "Monad", hex: "0x8f", native: { symbol: "MON", name: "Monad", decimals: 18 }, explorer: "https://monadscan.com/tx/", rpc: "https://rpc.monad.xyz", pin: ["USDC", "WMON", "AUSD", "USDT0"] },
  robinhood: { id: 4663, name: "Robinhood Chain", hex: "0x1237", native: { symbol: "ETH", name: "Ether", decimals: 18 }, explorer: "https://robinhoodchain.blockscout.com/tx/", rpc: "https://rpc.mainnet.chain.robinhood.com", pin: ["USDG", "WETH", "NVDA", "TSLA", "SPY"] },
  arc: { id: 5042, name: "Arc", hex: "0x13b2", native: null, explorer: "https://explorer.arc.io/tx/", rpc: "https://rpc.mainnet.arc.io", pin: ["USDC", "EURC", "cirBTC", "WETH"] },
};
export const TRADE_CHAINS: TradeChain[] = ["solana", "base", "bnb", "avalanche", "monad", "robinhood", "arc"];
export const isEvm = (c: string): c is EvmChain => c in EVM;

/** verified: Jupiter's own mark (Solana only); the picker shows it next to the symbol */
export type TradeToken = { address: string; symbol: string; name: string; decimals: number; logoURI: string | null; verified?: boolean };
