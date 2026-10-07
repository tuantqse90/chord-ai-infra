// Every setting comes from the environment and is read per call, so tests and a late .env edit both count.
const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const config = {
  appName: () => env("APP_NAME", "Tapeline"),
  port: () => num("PORT", 8799),
  nownodesKey: () => env("NOWNODES_API_KEY"),
  /** NOWNodes Solana mainnet. Override only for local work before a key is at hand. */
  solanaRpcUrl: () => env("SOLANA_RPC_URL", "https://sol.nownodes.io"),
  /** NOWNodes Blockfrost-compatible Cardano mainnet. */
  cardanoApiUrl: () => env("CARDANO_API_URL", "https://ada-blockfrost.nownodes.io/api/v0"),
  llmKey: () => env("LLM_API_KEY"),
  llmBaseUrl: () => env("LLM_BASE_URL", "https://api.deepseek.com"),
  llmModel: () => env("LLM_MODEL", "deepseek-flash"),
  /** Chord's public Solana market API, an optional source for "what is trading". "off" disables it. */
  chordApi: () => {
    const v = env("CHORD_API", "https://api.getchord.xyz");
    return v === "off" ? "" : v.replace(/\/$/, "");
  },
  /** Owner-issued Chord API key (nt_live_…, unlimited): sent as X-API-Key on every call to CHORD_API so this server is
   *  never held to the anonymous per-IP limit. Unset = anonymous calls. */
  chordApiKey: () => env("CHORD_API_KEY"),
  treasurySol: () => env("TREASURY_SOL"),
  treasuryAda: () => env("TREASURY_ADA"),
  payMint: () => env("PAY_MINT", USDC_MINT),
  /** Price of one answer, in the pay mint's whole units (USDC) and in ADA. */
  priceUsdc: () => num("PRICE_USDC", 0.1),
  priceAda: () => num("PRICE_ADA", 0.5),
  freeAsks: () => num("FREE_ASKS", 3),
  /** UNLIMITED_ASKS=1: every session asks without limit (owner 06/10: everyone, signed in or guest). Payments still verify. */
  unlimitedAsks: () => env("UNLIMITED_ASKS") === "1",
  /** Chord's Privy app (public id, the one getchord.xyz/ask uses). Unset = no sign-in on the page. */
  privyAppId: () => env("PRIVY_APP_ID"),
  privyClientId: () => env("PRIVY_CLIENT_ID"),
  /** Auto-trade (src/autoTrade.ts): Privy's server API secret, our authorization key (`wallet-auth:<base64 PKCS8 DER P-256>`),
   *  the key quorum people add to their wallet as a session signer and the policy it signs under. Any missing = auto-trade off. */
  privyAppSecret: () => env("PRIVY_APP_SECRET"),
  privyAuthorizationKey: () => env("PRIVY_AUTHORIZATION_PRIVATE_KEY"),
  privySignerQuorumId: () => env("PRIVY_SIGNER_QUORUM_ID"),
  privySignerPolicyId: () => env("PRIVY_SIGNER_POLICY_ID"),
  privyApiUrl: () => env("PRIVY_API_URL", "https://api.privy.io").replace(/\/$/, ""),
  dbPath: () => env("DB_PATH", "data/ask2049.db"),
  /** Chains the index database role can actually read (a narrower role = a shorter list). */
  indexChains: () => env("INDEX_CHAINS", "monad,robinhood,arc,avalanche,base,bnb,solana").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
};

/** Whether a URL points at NOWNodes, so the status page can say which calls really went through it. */
export const isNowNodes = (url: string) => /\.nownodes\.io(\/|$)/i.test(url);

/** A provider's public name from its URL: never the full host (paid endpoints carry an account-specific subdomain). */
export function providerName(url: string): string {
  let host = "";
  try { host = new URL(url).host.toLowerCase(); } catch { return "RPC"; }
  if (host.endsWith("nownodes.io")) return "NOWNodes";
  if (host.endsWith("quiknode.pro")) return "QuickNode";
  if (host.endsWith("helius-rpc.com")) return "Helius";
  if (host.endsWith("drpc.org")) return "dRPC";
  if (host.endsWith("alchemy.com")) return "Alchemy";
  if (host === "api.mainnet-beta.solana.com") return "Solana public RPC";
  if (host.endsWith("blockfrost.io")) return "Blockfrost";
  return "RPC";
}

/** The provider a tool's reads really go to, as shown on the page: "NOWNodes" only when the URL is NOWNodes and a key is set. */
export function viaLabel(via: "solana" | "cardano" | "index" | "trade" | "ext", provider?: string): string {
  if (via === "ext") return provider ?? "Third-party API";
  if (via === "index") return "Chord index";
  if (via === "trade") return "Swap quote";
  const url = via === "solana" ? config.solanaRpcUrl() : config.cardanoApiUrl();
  const chain = via === "solana" ? "Solana" : "Cardano";
  const name = providerName(url);
  return name === "NOWNodes" && !config.nownodesKey() ? `${chain} · NOWNodes (no key)` : `${name} · ${chain}`;
}

/** Headers for every request to Chord's API: a browser User-Agent (Cloudflare refuses bare clients) and the key. */
export const chordHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const key = config.chordApiKey();
  return { "User-Agent": "Mozilla/5.0 (compatible; ask2049)", ...(key ? { "X-API-Key": key } : {}), ...extra };
};
