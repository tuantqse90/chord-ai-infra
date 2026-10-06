// rhAddresses.ts — the SINGLE registry of Robinhood Chain (4663) addresses.
//
// ask2049: stand-in for Chord's packages/api/src/services/rhAddresses.ts holding only the three addresses
// services/ask/walletTools.ts names in a transaction (PERMIT2, GASLESS_ENTRY_RH, RH_STOCK_ZAP). Values and the
// GASLESS_ENTRY_ADDRESS_RH override copied from that file (2026-10-06).
import { logger } from "../utils/logger";

/** Lowercase 40-hex address shape — the only shape any set in this file accepts. */
const RH_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** Canonical Permit2 (NullRouter-RH permit2() since 2026-08-21, CLAUDE.md). */
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";

const GASLESS_ENTRY_RH_DEFAULT = "0x623f61a2736783f860f84774c85620dc3008b744";
/** GaslessEntry-RH — env override preserved from rhTradeCrawl (GASLESS_ENTRY_ADDRESS_RH). An invalid
 *  override falls back to the deployed address rather than silently emptying the intermediary set. */
export const GASLESS_ENTRY_RH = (() => {
  const raw = process.env.GASLESS_ENTRY_ADDRESS_RH?.trim().toLowerCase();
  if (!raw) return GASLESS_ENTRY_RH_DEFAULT;
  if (RH_ADDRESS_RE.test(raw)) return raw;
  logger.warn({ value: process.env.GASLESS_ENTRY_ADDRESS_RH }, "GASLESS_ENTRY_ADDRESS_RH is not an address — using the deployed default");
  return GASLESS_ENTRY_RH_DEFAULT;
})();
/** RhStockZap (audit-H5 build 2026-08-21, CLAUDE.md) — dest-execution proxy for one-click stock buys. */
export const RH_STOCK_ZAP = "0x66627ce32af8801525930b7c2a1db4905193bb51";
