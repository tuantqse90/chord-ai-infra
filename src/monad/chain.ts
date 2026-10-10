// Monad mainnet (chain 143): the addresses the agents and the trust layer use. EVM addresses are compared in lower case.
export const MONAD_CHAIN_ID = 143;
export const EXPLORER = "https://monadscan.com";

export const NATIVE = "0x0000000000000000000000000000000000000000";
export const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
export const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

/** ERC-8004 canonical registries on Monad (github.com/erc-8004/erc-8004-contracts). */
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const AGENT_REGISTRY_ID = `eip155:${MONAD_CHAIN_ID}:${IDENTITY_REGISTRY}`;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s: unknown): s is string => typeof s === "string" && ADDR.test(s);
export const lower = (s: string) => s.toLowerCase();
export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** What a wallet pays with or is paid in on Monad: a swap whose token is one of these is not a trade the agents copy. */
const QUOTE_SYMBOLS = new Set(["USDC", "AUSD", "USDT0", "USDT", "WMON", "MON"]);
const quoteAddrs = new Set([NATIVE, WMON, USDC]);
export function addQuoteToken(addr: string): void { quoteAddrs.add(lower(addr)); }
export const isQuoteToken = (addr: string, symbol?: string | null): boolean => quoteAddrs.has(lower(addr)) || (symbol != null && QUOTE_SYMBOLS.has(symbol.toUpperCase()));
export const QUOTE_SYMBOL_LIST = [...QUOTE_SYMBOLS];

/** Monad majors by address (from Chord's token list): a strategy may name these by symbol, and they print by symbol. */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [WMON]: { symbol: "WMON", decimals: 18 },
  [USDC]: { symbol: "USDC", decimals: 6 },
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": { symbol: "AUSD", decimals: 6 },
  "0xe7cd86e13ac4309349f30b3435a9d337750fc82d": { symbol: "USDT0", decimals: 6 },
  "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242": { symbol: "WETH", decimals: 18 },
  "0x0555e30da8f98308edb960aa94c0db47230d2b9c": { symbol: "WBTC", decimals: 8 },
  "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b": { symbol: "cbBTC", decimals: 8 },
  "0x1b68626dca36c7fe922fd2d55e4f631d962de19c": { symbol: "shMON", decimals: 18 },
  "0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081": { symbol: "gMON", decimals: 18 },
  "0xa3227c5969757783154c60bf0bc1944180ed81b9": { symbol: "sMON", decimals: 18 },
  "0x350035555e10d9afaf1566aaebfced5ba6c27777": { symbol: "CHOG", decimals: 18 },
};
