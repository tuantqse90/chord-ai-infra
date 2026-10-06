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
  treasurySol: () => env("TREASURY_SOL"),
  treasuryAda: () => env("TREASURY_ADA"),
  payMint: () => env("PAY_MINT", USDC_MINT),
  /** Price of one answer, in the pay mint's whole units (USDC) and in ADA. */
  priceUsdc: () => num("PRICE_USDC", 0.1),
  priceAda: () => num("PRICE_ADA", 0.5),
  freeAsks: () => num("FREE_ASKS", 3),
  dbPath: () => env("DB_PATH", "data/ask2049.db"),
};

/** Whether a URL points at NOWNodes, so the status page can say which calls really went through it. */
export const isNowNodes = (url: string) => /\.nownodes\.io(\/|$)/i.test(url);
