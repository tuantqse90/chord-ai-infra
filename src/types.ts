// What every tool hands back: the data the model reads, the sources the answer may cite, and a one-line summary for the
// step list on the page.
export type Source = {
  kind: "account" | "tx" | "token" | "ada-address" | "ada-tx" | "index" | "web";
  id: string;
  label: string;
  url: string | null;
};
/** `card`: a swap the page can open for review (tool swap_quote); the person signs in their own wallet. */
/** `addresses`: ids the tool vouches for (the answer may quote them); `viz`: tables / charts the page may draw. */
export type ToolResult = { data: unknown; sources: Source[]; summary: string; card?: unknown; addresses?: string[]; viz?: unknown[]; assets?: unknown[]; chipCandidates?: unknown[] };
export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
export type Tool = {
  name: string;
  /** Which backend answers; the page shows the provider actually configured (viaLabel), never a fixed name. */
  via: "solana" | "cardano" | "index" | "trade" | "ext";
  /** For via "ext": the third-party source named on the page (CoinGecko, Hyperliquid, …). */
  provider?: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  /** `ctx.session`: who is asking (the X-Session or API-key session), for tools that keep per-person state; `ctx.question`: the
   *  person's message this turn (tools that act, like starting an agent, check the person asked for it). */
  run: (args: Record<string, any>, ctx?: { session?: string; question?: string }) => Promise<ToolResult>;
  /** Third-party text (posts, token names, headlines): addresses inside it are not added to the answer's allow list. */
  untrusted?: boolean;
  timeoutMs?: number;
  group?: string;
};

export class ToolInputError extends Error {}

export const solscan = {
  account: (a: string) => `https://solscan.io/account/${a}`,
  tx: (s: string) => `https://solscan.io/tx/${s}`,
  token: (m: string) => `https://solscan.io/token/${m}`,
};
export const cardanoscan = {
  address: (a: string) => `https://cardanoscan.io/address/${a}`,
  tx: (h: string) => `https://cardanoscan.io/transaction/${h}`,
};
export const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
