// viem clients for Monad mainnet. Reads (token metadata a list does not carry, registries, the track-record chain) go to
// MONAD_RPC_URL; writes are signed by the operator key (identity registration, fill commits, validation requests) or the
// validator key (validation responses). Keys are read from the environment, never logged.
import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { MONAD_CHAIN_ID, EXPLORER } from "./chain";

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
export const monadRpcUrl = () => env("MONAD_RPC_URL", "https://rpc.monad.xyz");

export const monad = defineChain({
  id: MONAD_CHAIN_ID,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadScan", url: EXPLORER } },
});

let pub: PublicClient | null = null;
let pubUrl = "";
export function publicClient(): PublicClient {
  const url = monadRpcUrl();
  if (!pub || pubUrl !== url) { pub = createPublicClient({ chain: monad, transport: http(url, { timeout: 15_000, retryCount: 2 }) }) as PublicClient; pubUrl = url; }
  return pub;
}

const accountOf = (k: string): PrivateKeyAccount | null => {
  const v = env(k);
  if (!v) return null;
  return privateKeyToAccount((v.startsWith("0x") ? v : `0x${v}`) as Hex);
};
/** The operator: owns the agents' ERC-8004 identities, commits their fills, asks for validations. */
export const operatorAccount = () => accountOf("OPERATOR_PRIVATE_KEY");
/** The validator: replays committed fills and answers validation requests (a different key from the operator). */
export const validatorAccount = () => accountOf("VALIDATOR_PRIVATE_KEY");

export function walletClient(account: PrivateKeyAccount) {
  return createWalletClient({ account, chain: monad, transport: http(monadRpcUrl(), { timeout: 20_000, retryCount: 1 }) });
}
