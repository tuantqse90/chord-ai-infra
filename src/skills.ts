// Skills = Chord Ask's playbooks (src/chord/services/ask/skills.ts, copied): a keyword router picks at most one per question
// before the first model call; the model then sees that playbook, its tools, Chord's always-on core and `more_tools`. With
// Chord's own Arc / Robinhood / LP / chain tools ported over the public API, the playbooks run as written; the few tools a
// playbook names that this app does not have are listed back to the model so it never calls them.
import { CORE_TOOLS, MORE_TOOLS, MORE_TOOLS_DEF, pickSkill as route, SKILL_MAX_CALLS, SKILLS, type Skill, type SkillId } from "./chord/services/ask/skills";
import { BOT_PLAYBOOK } from "./botTools";

export { MORE_TOOLS, MORE_TOOLS_DEF };
export type Playbook = { id: SkillId | "plain_news" | "bots"; title: string; tools: string[]; playbook: string; maxRounds: number; maxCalls: number; heavy?: boolean };

/** Chord's core plus this app's own: Solana reads, any-chain balances, the swap quote. */
export const CORE = [...new Set([...CORE_TOOLS, "sol_token", "sol_wallet", "wallet_balances", "swap_quote", "dex_trending", "sol_tokens", "token_safety"])];
export const GENERAL_MAX_CALLS = 12;

const THIS_APP = `This app: Chord Agents on Monad. Agents tab: paper trading agents (copy Monad wallets, alerts, custom strategies built from words). Each agent gets an ERC-8004 identity on Monad; every fill is hashed and committed to the agent's TrackRecord chain on Monad as it fills; a validator replays the fills and posts its verdict to the ERC-8004 Validation Registry; anyone can rate an agent in the ERC-8004 Reputation Registry. To check a record without trusting this site: the agent page's Track record card (Verify in your browser re-hashes every committed fill and compares the result with the head the TrackRecord contract holds), GET /v1/trust/agents/<id>/fills on this site (not api.getchord.xyz), or scripts/verify.ts in the repo. The Marketplace tab ranks the agents owners listed by a score from their record on Monad (committed fills, validator average, on-chain rating, 7-day paper PnL); anyone can open or copy a listed agent. The Trade tab prices swaps on Monad with Chord's router (also Base, BNB Chain, Avalanche, Robinhood Chain, Arc, and Solana through Jupiter); the person signs in their own wallet. Developers get API keys at /developer.`;
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

// Agents as a service (the tools are still bot_*): building, backtesting and steering copy-trading agents. A bare "agent" is
// also a token kind (AI agent tokens → the DEX playbook), so only "my / trading / copy / paper agent" count.
const BOTS_RE = /\b(bots?|copy[- ]?trad(?:e|er|ing|ers)?|copytrade|backtest|smart traders?|auto[- ]?trad(?:e|er|ing)|(?:my|trading|copy|paper|custom|lp) agents?|agent templates?|(?:build|make|create|start|run|set up) (?:me )?(?:an? |my |my own )?(?:custom )?agent|agents? (?:that|which|to) (?:buys?|sells?|alerts?|snipes?|copies|follows?|dca))\b|sao chép lệnh|copy lệnh|tạo agent|tạo bot/i;
// Classic strategies by name (a bare "RSI" or "MACD" is a market question: only the strategy senses count), and Perpl.
const CLASSIC_RE = /\b(golden cross|death cross|ema cross(?:over)?|ma cross(?:over)?|macd cross(?:over)?|bollinger (?:band )?(?:reversion|breakout|squeeze)|donchian|turtle (?:rule|strategy|breakout)|supertrend|funding carry|grid (?:bot|strategy|trading)|rsi (?:reversion|strategy|mean reversion)|mean reversion strategy|perpl)\b/i;
// Providing liquidity: the LP agent (lp_*) and Chord's Solana LP tape (sol_lp_*), before the agents playbook ("backtest an LP
// agent" is an LP question). A bare "range" is a price range and a bare "liquidity" a token's depth: only their LP senses count.
const LP_RE = /\b(?:lps?|lping|liquidity provid\w*|provid(?:e|ing) liquidity|(?:add|adding|added|pull|pulling|pulled|remov\w*|withdraw\w*) (?:the |my |some )?liquidity|liquidity (?:pools?|positions?|flows?|mining)|dlmm|damm(?: ?v2)?|clmm|concentrated liquidity|impermanent loss|in range|out of range|(?:tight|wide|balanced) ranges?|(?:what|which) range should i|fee apr)\b|cung cấp thanh khoản|rút thanh khoản|vị thế lp|thanh khoản (?:vào|ra)/i;
// Chord's router also picks its LP playbook for yields (APY, lending, Pendle): the LP agent joins only when the question is about
// pools / ranges / liquidity, or follows one.
const LP_WORDS = /\b(?:lps?|lping|liquidity|pools?|ranges?|dlmm|damm|clmm)\b/i;
/** The playbook for this question, or null for the general loop (every tool). `available` names the tools this server has. */
export function pickPlaybook(question: string, history: { role: string; content: string }[] = [], available?: Set<string>): Playbook | null {
  let book: Playbook;
  if ((BOTS_RE.test(question) || CLASSIC_RE.test(question)) && (!available || available.has("agent_backtest"))) {
    return { id: "bots", title: "Trading agents", tools: ["classic_strategies", "classic_backtest", "classic_start", "agent_traders", "agent_backtest", "agent_create", "agent_build", "agent_templates", "agent_backtest_strategy", "agent_list", "agent_status", "agent_pause", "agent_resume", "lp_scan", "lp_range", "lp_backtest", "lp_agent_create", "lp_smart", "lp_copy_backtest", "lp_copy_create", "sol_tape_wallet", "sol_tape_market", "token_safety"], playbook: BOT_PLAYBOOK, maxRounds: 4, maxCalls: 7 };
  } else {
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
