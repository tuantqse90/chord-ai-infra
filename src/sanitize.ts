// The answer may only name addresses and hashes that a tool returned this turn (or that the person typed). Anything else the
// model writes in that shape is masked: a made-up address in a trading answer is how people lose money.

const PATTERNS = [
  /\b0x[0-9a-fA-F]{40}\b/g, // EVM address
  /\b0x[0-9a-fA-F]{64}\b/g, // EVM tx hash
  /\baddr1[0-9a-z]{50,120}\b/g, // Cardano address
  /\b[0-9a-f]{64}\b/g, // Cardano tx hash
  /\b[1-9A-HJ-NP-Za-km-z]{32,90}\b/g, // Solana address or signature (base58)
];

/** Every address-shaped string inside a value (tool output), collected so the answer may cite it. */
export function collectIds(value: unknown, into = new Set<string>()): Set<string> {
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const re of PATTERNS) for (const m of v.match(re) ?? []) into.add(m.toLowerCase().startsWith("0x") ? m.toLowerCase() : m);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return into;
}

const looksLikeId = (m: string) => /\d/.test(m) && /[A-Za-z]/.test(m); // base58 regex also matches long words; ids mix digits and letters

export function sanitizeAnswer(text: string, allowed: Set<string>): { text: string; masked: number } {
  let masked = 0;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m) => {
      const key = m.toLowerCase().startsWith("0x") ? m.toLowerCase() : m;
      if (allowed.has(key) || !looksLikeId(m)) return m;
      masked++;
      return "(unverified address removed)";
    });
  }
  return { text: out, masked };
}
