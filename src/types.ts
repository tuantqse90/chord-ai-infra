// What every tool hands back: the data the model reads, the sources the answer may cite, and a one-line summary for the
// step list on the page.
export type Source = {
  kind: "account" | "tx" | "token" | "ada-address" | "ada-tx" | "index";
  id: string;
  label: string;
  url: string | null;
};
export type ToolResult = { data: unknown; sources: Source[]; summary: string };
export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
export type Tool = {
  name: string;
  /** Which backend answers; the page shows the provider actually configured (viaLabel), never a fixed name. */
  via: "solana" | "cardano" | "index";
  label: string;
  description: string;
  parameters: JsonSchema;
  run: (args: Record<string, any>) => Promise<ToolResult>;
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
