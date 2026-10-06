// Token names from the chain itself: Metaplex metadata accounts (one getMultipleAccounts for many mints) and the Token-2022
// metadata extension. A short list of majors covers the common mints without a call.
import { PublicKey } from "@solana/web3.js";
import { rpc } from "../rpc/solana";

export const KNOWN_MINTS: Record<string, { symbol: string; name: string; decimals: number }> = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Wrapped SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin", decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD", decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter", decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk", decimals: 5 },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat", decimals: 6 },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", name: "Jito Staked SOL", decimals: 9 },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade staked SOL", decimals: 9 },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol: "RAY", name: "Raydium", decimals: 6 },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: "PYTH", name: "Pyth Network", decimals: 6 },
};

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const cache = new Map<string, { symbol: string | null; name: string | null }>();

export function isPubkey(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
export const isSignature = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s);

export function metadataPda(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), new PublicKey(mint).toBuffer()], METAPLEX)[0].toBase58();
}

/** Metaplex Metadata v1: key u8 · update authority 32 · mint 32 · name (u32 len + bytes) · symbol · uri. Strings are NUL-padded. */
export function decodeMetadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  try {
    let o = 1 + 32 + 32;
    const str = () => {
      const len = data.readUInt32LE(o);
      o += 4;
      const s = data.subarray(o, o + len).toString("utf8").replace(/\0+$/g, "").trim();
      o += len;
      return s;
    };
    const name = str(), symbol = str(), uri = str();
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/** Symbols for many mints: majors from the list, the rest from their Metaplex accounts in one getMultipleAccounts (≤100). */
export async function symbolsFor(mints: string[]): Promise<Map<string, { symbol: string | null; name: string | null }>> {
  const out = new Map<string, { symbol: string | null; name: string | null }>();
  const ask: string[] = [];
  for (const m of new Set(mints)) {
    const k = KNOWN_MINTS[m];
    if (k) out.set(m, { symbol: k.symbol, name: k.name });
    else if (cache.has(m)) out.set(m, cache.get(m)!);
    else if (isPubkey(m)) ask.push(m);
  }
  for (let i = 0; i < ask.length; i += 100) {
    const chunk = ask.slice(i, i + 100);
    const res = await rpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [chunk.map(metadataPda), { encoding: "base64" }]).catch(() => null);
    chunk.forEach((m, j) => {
      const acc = res?.value?.[j];
      const md = acc ? decodeMetadata(Buffer.from(acc.data[0], "base64")) : null;
      const v = { symbol: md?.symbol || null, name: md?.name || null };
      cache.set(m, v);
      out.set(m, v);
    });
  }
  return out;
}
