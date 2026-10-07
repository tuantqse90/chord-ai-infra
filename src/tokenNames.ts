// Token names that never go on screen: slurs used as meme names (Jupiter's search for "BONK" returns "Nigga Bonk"). Matched on
// a folded copy of the symbol and the name: lower case, zero-width characters dropped, the usual digit / symbol swaps undone.
// "Niger" / "Nigeria" pass (one g); the rare "snigger" does not, which only drops a token from a list.
const FOLD: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t" };
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/[01!|34@5$7]/g, (c) => FOLD[c] ?? c);

/** stems that are slurs wherever they sit in a word */
const ANYWHERE = /n+i+g{2,}|f+a+g+o+t|k+i+k+e+s?\b|r+e+t+a+r+d|t+r+a+n+n+(?:y|i+e)|w+e+t+b+a+c+k|h+i+t+l+e+r/;
/** short slurs that are other words inside a longer one (spicy, cooney, fagin): only as a whole word */
const WORD = /\b(?:fags?|spics?|chinks?|coons?|gooks?|kikes?|dykes?|beaners?|niggs?)\b/;

export function offensiveName(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => { if (!t) return false; const f = fold(t); return ANYWHERE.test(f) || WORD.test(f) || ANYWHERE.test(f.replace(/[^a-z]/g, "")); });
}
