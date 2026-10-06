// The tools offered to the model this turn: NOWNodes Solana + Cardano always, the index tools when a database is connected.
import { cardanoTools } from "./cardano/tools";
import { dbTools } from "./db/tools";
import { solanaTools } from "./solana/tools";
import type { Tool } from "./types";

export function activeTools(): Tool[] {
  return [...solanaTools, ...cardanoTools, ...dbTools()];
}

export function schemasOf(tools: Tool[]) {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
