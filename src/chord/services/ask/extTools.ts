// ask2049 copy of Chord's services/ask/extTools.ts: the third-party tool families in one place. Same contract as Chord
// (schemas, registry rows, a runner per family); src/chord/adapter.ts turns them into ask2049 tools.
// Not here: solTapeTools (Chord's Solana box is reachable only over Chord's WireGuard) and walletTools until its chain config is wired.
import type { ToolMeta } from "./registry";
import type { ExtToolResult } from "./extHttp";
import { DEX_TOOL_META, DEX_TOOL_SCHEMAS, isDexTool, runDexTool } from "./dexTools";
import { LIGHTER_TOOL_META, LIGHTER_TOOL_SCHEMAS, isLighterTool, runLighterTool } from "./lighterTools";
import { YIELD_TOOL_META, YIELD_TOOL_SCHEMAS, isYieldTool, runYieldTool } from "./yieldTools";
import { PREDICT_TOOL_META, PREDICT_TOOL_SCHEMAS, isPredictTool, runPredictTool } from "./predictTools";
import { LAUNCH_TOOL_META, LAUNCH_TOOL_SCHEMAS, isLaunchTool, runLaunchTool } from "./launchTools";
import { SOLANA_TOOL_META, SOLANA_TOOL_SCHEMAS, isSolanaTool, runSolanaTool } from "./solanaTools";
import { MARKET_EXTRA_TOOL_META, MARKET_EXTRA_TOOL_SCHEMAS, isMarketExtraTool, runMarketExtraTool } from "./marketExtraTools";
import { ELFA_TOOL_META, ELFA_TOOL_SCHEMAS, elfaConfigured, isElfaTool, runElfaTool } from "./elfaTools";

const FAMILIES: { is: (n: string) => boolean; run: (n: string, a: Record<string, any>) => Promise<ExtToolResult> }[] = [
  { is: isDexTool, run: runDexTool }, { is: isLighterTool, run: runLighterTool }, { is: isYieldTool, run: runYieldTool },
  { is: isPredictTool, run: runPredictTool }, { is: isLaunchTool, run: runLaunchTool }, { is: isSolanaTool, run: runSolanaTool },
  { is: isMarketExtraTool, run: runMarketExtraTool }, { is: isElfaTool, run: runElfaTool },
];

export const EXT_TOOL_SCHEMAS = [
  ...DEX_TOOL_SCHEMAS, ...LIGHTER_TOOL_SCHEMAS, ...YIELD_TOOL_SCHEMAS, ...PREDICT_TOOL_SCHEMAS, ...LAUNCH_TOOL_SCHEMAS,
  ...SOLANA_TOOL_SCHEMAS, ...MARKET_EXTRA_TOOL_SCHEMAS, ...ELFA_TOOL_SCHEMAS,
];
export const EXT_TOOL_META: Record<string, ToolMeta> = {
  ...DEX_TOOL_META, ...LIGHTER_TOOL_META, ...YIELD_TOOL_META, ...PREDICT_TOOL_META, ...LAUNCH_TOOL_META,
  ...SOLANA_TOOL_META, ...MARKET_EXTRA_TOOL_META, ...ELFA_TOOL_META,
};

export const isExtTool = (name: string): boolean => FAMILIES.some((f) => f.is(name));

/** Elfa bills every call: hidden until a key or a funded x402 wallet is set. */
export const extToolOffered = (name: string): boolean => (isElfaTool(name) ? elfaConfigured() : true);

/** Runs one tool of these families; a thrown error becomes an answer the model can repeat instead of a broken turn. */
export async function runExtTool(name: string, args: Record<string, any>): Promise<ExtToolResult> {
  const fam = FAMILIES.find((f) => f.is(name));
  if (!fam) return { data: { error: `unknown tool ${name}` }, addresses: [], citations: [] };
  try {
    return await fam.run(name, args ?? {});
  } catch (e) {
    return { data: { error: String((e as Error)?.message ?? e).slice(0, 160), note: "The source did not answer just now. Say the data is unavailable; do not guess numbers." }, addresses: [], citations: [] };
  }
}
