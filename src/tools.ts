// The tools offered to the model this turn: Solana + Cardano chain reads always, the index tools when a database is
// connected, the swap quote, the agent tools, Nansen's smart money on Monad (when its key is set), and Chord Ask's
// third-party families (each only when its key is set).
import { cardanoTools } from "./cardano/tools";
import { dbTools } from "./db/tools";
import { solanaTools } from "./solana/tools";
import { swapTool } from "./trade/tool";
import { chordTools } from "./chord/adapter";
import { botTools } from "./botTools";
import { nansenTools } from "./nansenTools";
import type { Tool } from "./types";

export function activeTools(): Tool[] {
  return [...solanaTools, ...cardanoTools, ...dbTools(), swapTool, ...botTools, ...nansenTools(), ...chordTools()];
}

export function schemasOf(tools: Tool[]) {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
