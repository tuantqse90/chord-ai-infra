// A fill as the document its agent commits: canonical JSON (keys sorted at every level, no whitespace, numbers as JavaScript
// prints them, absent values as null) whose keccak-256 is the hash appended to the agent's TrackRecord chain. The exact text
// is stored when it is first built and published as is, so anyone re-hashes the bytes they are served — nobody has to
// re-serialize the same way to check it.
import { keccak256, toBytes, type Hex } from "viem";
import type { Fill } from "../bots/types";
import { AGENT_REGISTRY_ID, MONAD_CHAIN_ID } from "../monad/chain";

export const DOC_TYPE = "chord-agent-fill/v1";

/** JSON with sorted keys and no whitespace; undefined becomes null, non-finite numbers become null. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return "null";
}

export const hashDoc = (doc: string): Hex => keccak256(toBytes(doc));

/** The committed document of one filled fill; `seq` is its 1-based place in the agent's chain. */
export function fillDoc(f: Fill, agent: { botId: string; agentId: string }, seq: number): string {
  const s = f.source;
  return canonical({
    type: DOC_TYPE, chainId: MONAD_CHAIN_ID, seq,
    agent: { botId: agent.botId, agentId: agent.agentId, registry: AGENT_REGISTRY_ID },
    fill: { id: f.id, ts: f.ts, side: f.side, token: f.mint, symbol: f.symbol, usd: f.usd, tokenAmount: f.tokenAmount, priceUsd: f.priceUsd, pnlUsd: f.pnlUsd, mode: f.mode },
    source: { via: s.via, wallet: s.wallet || null, tx: s.via === "strategy" ? null : s.tx, ts: s.ts, side: s.side, usd: s.usd, detail: s.detail ?? null },
    quote: f.quote ? { provider: f.quote.provider, route: f.quote.route, priceImpactPct: f.quote.priceImpactPct } : null,
  });
}

/** The chain head a list of hashes builds from the empty chain: head_n = keccak256(head_{n-1} ‖ hash_n). */
export function chainHead(hashes: Hex[], from: Hex = `0x${"0".repeat(64)}`): Hex {
  let head = from;
  for (const h of hashes) head = keccak256(`0x${head.slice(2)}${h.slice(2)}`);
  return head;
}
