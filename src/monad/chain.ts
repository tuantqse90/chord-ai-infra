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
