// Token amounts as decimal strings ↔ raw integer strings. No floats on the way in: "0.1" USDC is exactly 100000.
export class TradeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function toRaw(human: string | number, decimals: number): string {
  const s = String(human).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new TradeError("amount must be a positive number");
  const [i, f = ""] = s.split(".");
  const raw = BigInt((i || "0") + f.slice(0, decimals).padEnd(decimals, "0"));
  if (raw <= 0n) throw new TradeError("amount must be more than zero");
  return raw.toString();
}

export function fromRaw(raw: string | bigint, decimals: number): string {
  const v = BigInt(raw);
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return f ? `${i}.${f}` : i;
}
