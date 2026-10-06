// Skills = Chord Ask's playbooks (src/chord/services/ask/skills.ts, copied): a keyword router picks at most one per question
// before the first model call; the model then sees that playbook, its tools, Chord's always-on core and `more_tools`. With
// Chord's own Arc / Robinhood / LP / chain tools ported over the public API, the playbooks run as written; the few tools a
// playbook names that this app does not have are listed back to the model so it never calls them.
import { CORE_TOOLS, MORE_TOOLS, MORE_TOOLS_DEF, pickSkill as route, SKILL_MAX_CALLS, SKILLS, type Skill, type SkillId } from "./chord/services/ask/skills";

export { MORE_TOOLS, MORE_TOOLS_DEF };
export type Playbook = { id: SkillId | "plain_news"; title: string; tools: string[]; playbook: string; maxRounds: number; maxCalls: number; heavy?: boolean };

/** Chord's core plus this app's own: Solana reads, any-chain balances, the swap quote. */
export const CORE = [...new Set([...CORE_TOOLS, "sol_token", "sol_wallet", "wallet_balances", "swap_quote", "dex_trending", "sol_tokens", "token_safety"])];
export const GENERAL_MAX_CALLS = 12;

const THIS_APP = `This app: a few asks are free (unlimited right now), then each ask is paid in USDC on Solana or ADA on Cardano and checked on-chain; agents pay per call with X-Payment. The Trade tab prices swaps (Jupiter on Solana, Chord's router on Base, BNB Chain, Avalanche, Monad, Robinhood Chain, Arc) and the person signs in their own wallet or with their Chord account (email sign-in, same wallet as getchord.xyz). Developers get API keys at /developer.`;
const QUOTE_RE = /\b(arc_quote|rh_quote|chain_quote|bridge_quote)\b/;
const TOOLISH = /\b(?:arc|rh|lp|chain|monad|sol_tape|sol|cg|cgl|llama|hl|derivs|news|x|web|dex|social|pendle|morpho|predict|virtuals|lighter|journal|alert|token|bridge|stock|btc|image|make|backtest|macro|market|earnings|chord|wallet)_[a-z0-9_]+\b/g;

function fromChord(s: Skill): Omit<Playbook, "id"> {
  const extra = s.id === "howto" ? `\n${THIS_APP}` : "";
  const quotes = QUOTE_RE.test(s.playbook) ? `\nSwaps and "how much do I get" on any chain, Solana included: swap_quote (it puts a card on the page; the person signs).` : "";
  return { title: s.title, tools: [...s.tools, ...(quotes ? ["swap_quote"] : [])], playbook: s.playbook + extra + quotes, maxRounds: s.maxRounds ?? 3, maxCalls: s.maxCalls ?? SKILL_MAX_CALLS, heavy: s.heavy };
}

// Chord's router sends "trending on solana" to its own Solana tape; here the DEX family answers it best (the tape is in the
// same playbook): trending / memecoins / new pairs / gainers on a chain → the DEX playbook.
const DEX_SCAN = /\b(trending|hot|memecoins?|memes?|new (?:pairs|tokens|listings|launches)|gainers|losers|movers|pump(?:\.fun|swap)?|degen)\b/i;
const DEX_CHAIN = /\b(solana|sol|base|bnb|bsc|avalanche|avax|monad|ethereum|eth|arbitrum|dex(?:es)?|on[- ]chain)\b/i;
const PLAIN_NEWS_RE = /\b(?:any (?:news|headlines)|what'?s new|whats new|latest news|news today|top headlines)\b|có tin|co tin|tin (?:gì|gi) (?:mới|moi|hot|hôm nay|hom nay)|tin (?:tức|tuc) (?:mới|moi|hôm nay|hom nay)|tin mới|tin moi/i;
// "What does 0x… hold / own / balance" is a wallet question even when Chord's router reads the address as a token.
const HOLDS = /\b(hold|holds|holding|owns?|balances?|portfolio|pnl)\b/i;

/** The playbook for this question, or null for the general loop (every tool). `available` names the tools this server has. */
export function pickPlaybook(question: string, history: { role: string; content: string }[] = [], available?: Set<string>): Playbook | null {
  let book: Playbook;
  const solTape = /\bsolana\b/i.test(question) && /\b(tape|venues?|pumpswap|pump\.fun|raydium|meteora|orca|launchlab)\b/i.test(question);
  if (solTape || (DEX_SCAN.test(question) && DEX_CHAIN.test(question) && !/\b(news|tin|funding|perps?|open interest)\b/i.test(question))) book = { id: "dex", ...fromChord(SKILLS.dex) };
  else if (/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/.test(question) && HOLDS.test(question) && !/\bwho holds\b/i.test(question)) book = { id: "wallet", ...fromChord(SKILLS.wallet) };
  else {
    const r = route(question, history);
    if (!r.skill || !(r.skill.id in SKILLS)) return null;
    const id = r.skill.id as SkillId;
    book = { id, ...fromChord(SKILLS[id]) };
    if (id === "sentiment" && PLAIN_NEWS_RE.test(question)) book = { ...book, id: "plain_news", maxRounds: 1, playbook: `${book.playbook}\nTHIS QUESTION asks for news in general, no asset named: ONE news_latest call, then answer from the headlines.` };
  }
  if (available) {
    const missing = [...new Set(book.playbook.match(TOOLISH) ?? [])].filter((n) => !n.endsWith("_") && !available.has(n));
    if (missing.length) book = { ...book, playbook: `${book.playbook}\nNot in this app (never call them; use the closest tool you have): ${missing.join(", ")}.` };
  }
  return book;
}

/** Tool names a playbook offers (core first, no duplicates). */
export const playbookTools = (p: Playbook): string[] => [...new Set([...CORE, ...p.tools])];

export const budgetLine = (rounds: number) => `BUDGET: at most ${rounds} round${rounds === 1 ? "" : "s"} of lookups. Put every independent lookup in the SAME round (they run at once), never repeat a call you already made, and stop looking once you can answer.`;
