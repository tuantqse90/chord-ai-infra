// config/chains.ts — the api's view of the chain registry (docs/multichain-plan.md G4).
//
// ask2049: stand-in for Chord's packages/api/src/config/chains.ts holding only what services/ask/walletTools.ts reads
// (rpcUrlsFor, chainDataServed). The env var names are Chord's; every predicate reads process.env PER CALL (tests and
// late .env edits count), never at import.
import { isChainId, type ChainId } from "../shared"; // ask2049: Chord imports these from @nullterminal/shared
import { EVM } from "../../trade/chains"; // ask2049: the public RPC per chain, kept in one place for this app

interface ChainServerConfig {
  id: ChainId;
  /** Env-var prefix of the chain's lanes (RH_*, ARC_*, AVAX_*, …). */
  envPrefix: "MONAD" | "RH" | "ARC" | "AVAX" | "BASE" | "BNB";
}

// ask2049: Chord's CHAIN_SERVER rows also carry engine URL / candle tables / tape + public flags; only the env prefix is used here.
const CHAIN_SERVER: Readonly<Record<ChainId, ChainServerConfig>> = {
  143: { id: 143, envPrefix: "MONAD" },
  4663: { id: 4663, envPrefix: "RH" },
  5042: { id: 5042, envPrefix: "ARC" },
  43114: { id: 43114, envPrefix: "AVAX" },
  8453: { id: 8453, envPrefix: "BASE" },
  56: { id: 56, envPrefix: "BNB" },
};

// ask2049: public RPC per chain from src/trade/chains.ts, used only when neither env var of the chain is set.
const PUBLIC_RPC: Readonly<Record<ChainId, string | null>> = {
  143: EVM.monad.rpc, 4663: EVM.robinhood.rpc, 5042: EVM.arc.rpc, 43114: EVM.avalanche.rpc, 8453: EVM.base.rpc, 56: EVM.bnb.rpc,
};

/** The chain's JSON-RPC ladder for request-path reads: `<PREFIX>_RPC_URL`, then `<PREFIX>_RPC_FALLBACK_URL`
 *  (a different provider on every chain that has one). */
export function rpcUrlsFor(chain: number): string[] {
  if (!isChainId(chain)) return [];
  const p = CHAIN_SERVER[chain].envPrefix;
  const read = (name: string) => process.env[name]?.trim(); // ask2049: Chord reads its parsed `env` first, then process.env
  const urls = [read(`${p}_RPC_URL`), read(`${p}_RPC_FALLBACK_URL`)].filter((u): u is string => !!u);
  // ask2049: Chord answers [] (chain skipped as "no RPC configured"); here an unset chain falls back to its public RPC.
  if (!urls.length && PUBLIC_RPC[chain]) urls.push(PUBLIC_RPC[chain]!);
  return urls;
}

/** Data routes (candles, token pages, /v1/chains/*) answer for this chain. */
export function chainDataServed(chain: number, _internal = false): boolean {
  // ask2049: Chord gates the newer chains on its own tape + public flags (<X>_TRADE_CRAWL, <X>_PUBLIC). Here the chain data
  // is read from Chord's public API, which serves all six chains; a chain it turns dark answers 400 and the caller's
  // price read fails honestly ("Prices could not be read").
  return isChainId(chain);
}
