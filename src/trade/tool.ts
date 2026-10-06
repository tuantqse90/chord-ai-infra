// Ask's swap tool: prices a swap on any trade chain and hands the page a card to review and sign. It never executes.
import { ToolInputError, type Tool } from "../types";
import { TradeError } from "./amounts";
import { isEvm, TRADE_CHAINS, type TradeChain } from "./chains";
import { evmQuote, evmToken } from "./evm";
import { solQuote, solTokens } from "./solana";
import { isPubkey } from "../solana/tokens";

async function solMint(q: string): Promise<string> {
  const s = q.trim();
  if (isPubkey(s)) return s;
  const hit = (await solTokens()).find((t) => t.symbol.toLowerCase() === s.toLowerCase());
  if (!hit) throw new ToolInputError(`${q} is not a major Solana token; pass its mint address`);
  return hit.address;
}

export const swapTool: Tool = {
  name: "swap_quote",
  via: "trade",
  label: "Pricing the swap",
  description: "Price a swap the person wants to make, on solana (via Jupiter) or base, bnb, avalanche, monad, robinhood, arc (via Chord's router). Tokens by symbol (majors) or address/mint; amount in whole tokens of the token paid. Returns the expected output, minimum, price impact and route, and puts a swap card on the page; the person reviews and signs in their own wallet. Nothing is executed.",
  parameters: { type: "object", properties: {
    chain: { type: "string", enum: TRADE_CHAINS }, tokenIn: { type: "string", description: "Token paid: symbol or address" },
    tokenOut: { type: "string", description: "Token received: symbol or address" }, amount: { type: "string", description: "Amount of tokenIn, e.g. \"25\"" },
  }, required: ["chain", "tokenIn", "tokenOut", "amount"] },
  async run(a) {
    const chain = String(a.chain ?? "").toLowerCase() as TradeChain;
    if (!(TRADE_CHAINS as string[]).includes(chain)) throw new ToolInputError(`chain must be one of ${TRADE_CHAINS.join(", ")}`);
    try {
      const q = chain === "solana"
        ? await solQuote(await solMint(String(a.tokenIn)), await solMint(String(a.tokenOut)), String(a.amount), 50)
        : await evmQuote(chain as any, (await evmToken(chain as any, String(a.tokenIn))).address, (await evmToken(chain as any, String(a.tokenOut))).address, String(a.amount), 50);
      const card = { chain, tokenIn: q.tokenIn, tokenOut: q.tokenOut, amount: q.amountIn };
      return {
        data: { chain, provider: q.provider, pay: `${q.amountIn} ${q.tokenIn.symbol}`, receive: `${q.amountOut} ${q.tokenOut.symbol}`, minimumReceived: `${q.minAmountOut} ${q.tokenOut.symbol}`,
          priceImpactPct: q.priceImpactPct, route: q.route, feeBps: q.feeBps, slippageBps: q.slippageBps, tokenIn: q.tokenIn.address, tokenOut: q.tokenOut.address,
          note: "Price only. A swap card is on the page: the person reviews it and signs in their own wallet. Nothing has been executed; do not say it was." },
        sources: [],
        summary: `${q.amountIn} ${q.tokenIn.symbol} → ${q.amountOut} ${q.tokenOut.symbol} via ${q.provider}`,
        card,
      };
    } catch (e) {
      if (e instanceof TradeError) throw new ToolInputError(e.message);
      throw e;
    }
  },
};
export const _isEvm = isEvm;
