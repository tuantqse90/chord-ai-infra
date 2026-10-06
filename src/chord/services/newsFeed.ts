// Market news for the agents (owner 2026-09-24: "lấy news stocks và forex nhanh và mới nhất làm data cho agents").
// One table of headlines from hard-coded vendor feeds, tagged with the tickers / currencies they are about, read by
// `/v1/news` and the Ask tools news_latest / news_search / macro_calendar.
//
// Sources (all polled from the VPS — measured reachable 2026-09-24; FXStreet 403s; FXEmpire's feed serves weeks-old
// items and MarketWatch top stories is mostly lifestyle — both dropped the same day):
//   stocks  Alpaca News WebSocket (Benzinga, real time, symbols tagged by the vendor) — only with ALPACA_KEY_ID +
//           ALPACA_SECRET_KEY · Finnhub general/forex — only with FINNHUB_KEY · CNBC / Yahoo RSS
//   filings SEC EDGAR "current 8-K" Atom (CIK → ticker from sec.gov company_tickers.json)
//   fx      investingLive (ex-ForexLive) RSS
//   cb      Fed · ECB · BoE · BoJ press RSS
//   crypto  CoinDesk · Cointelegraph · Decrypt · The Block · The Defiant · Bitcoin Magazine · CryptoSlate RSS
//           (2026-09-26, measured from the VPS; Blockworks' and DL News' feeds stopped months ago, price-prediction sites left out)
//   cal     ForexFactory weekly calendar JSON (unofficial, polled every 10 min — faster gets the IP blocked)
// Per-ticker Yahoo RSS is fetched on demand when the table knows little about a ticker (newsFor()).
//
// We keep headline + a ≤400-char summary + link, never the article body (vendor terms). Headlines are third-party
// text: the agent treats them as data, and nothing here ever fetches a URL that came out of a feed.
//
// ask2049: the table lives in the app's SQLite file (config.dbPath()) instead of Chord's Postgres, the collector starts on
// the first news / calendar question (services/ask/newsTools) instead of in a worker at boot, and a first read with no
// fresh headline polls the feeds inline under a short deadline (warmNews / warmCalendar). Feeds, parsing, tagging and
// dedupe are Chord's. Changed lines are marked `// ask2049:`.
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite"; // ask2049: replaces getSql from ./analyticsDb (Postgres)
import { mkdirSync } from "node:fs"; // ask2049
import { dirname } from "node:path"; // ask2049
import { config } from "../../config"; // ask2049: DB_PATH
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

export type NewsKind = "stock" | "fx" | "macro" | "filing" | "cb" | "crypto";
export const NEWS_KINDS: NewsKind[] = ["stock", "fx", "macro", "filing", "cb", "crypto"];
export interface NewsItem { id: string; ts: number; source: string; kind: NewsKind; title: string; url: string; summary: string; tickers: string[] }
export interface CalendarEvent { ts: number; title: string; currency: string; impact: string; forecast: string | null; previous: string | null }

const UA = "Mozilla/5.0 (compatible; ChordNews/1.0; +https://getchord.xyz)";
const SEC_UA = "Chord research ops@getchord.xyz"; // SEC asks for a contact in the UA
const RETENTION_DAYS = Number(process.env.NEWS_RETENTION_DAYS) || 30;

interface Feed { source: string; url: string; kind: NewsKind; everyMs: number }
const FEEDS: Feed[] = [
  { source: "investingLive", url: "https://investinglive.com/feed/", kind: "fx", everyMs: 45_000 },
  { source: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", kind: "stock", everyMs: 60_000 },
  { source: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex", kind: "stock", everyMs: 90_000 },
  { source: "SEC 8-K", url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom", kind: "filing", everyMs: 60_000 },
  { source: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", kind: "cb", everyMs: 300_000 },
  { source: "ECB", url: "https://www.ecb.europa.eu/rss/press.html", kind: "cb", everyMs: 300_000 },
  { source: "Bank of England", url: "https://www.bankofengland.co.uk/rss/news", kind: "cb", everyMs: 300_000 },
  { source: "Bank of Japan", url: "https://www.boj.or.jp/en/rss/whatsnew.xml", kind: "cb", everyMs: 600_000 },
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", kind: "crypto", everyMs: 90_000 },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss", kind: "crypto", everyMs: 90_000 },
  { source: "The Block", url: "https://www.theblock.co/rss.xml", kind: "crypto", everyMs: 120_000 },
  { source: "Decrypt", url: "https://decrypt.co/feed", kind: "crypto", everyMs: 120_000 },
  { source: "CryptoSlate", url: "https://cryptoslate.com/feed/", kind: "crypto", everyMs: 120_000 },
  { source: "The Defiant", url: "https://thedefiant.io/api/feed", kind: "crypto", everyMs: 180_000 },
  { source: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", kind: "crypto", everyMs: 180_000 },
];

// ── parsing (RSS 2.0 / Atom / RDF — no XML dependency; these feeds are regular) ──────────────────────
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, " ") // entities that decoded into tags
    .replace(/\s+/g, " ")
    .trim();
}
const tag = (block: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? m[1] : null;
};
export interface RawEntry { title: string; url: string; ts: number; summary: string }
export function parseFeed(xml: string): RawEntry[] {
  const out: RawEntry[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = decodeText(tag(b, "title") ?? "");
    let url = decodeText(tag(b, "link") ?? "");
    if (!url) { const m = /<link[^>]*href="([^"]+)"/i.exec(b); url = m ? m[1].replace(/&amp;/g, "&") : ""; }
    if (!url) { const g = decodeText(tag(b, "guid") ?? ""); if (/^https?:\/\//.test(g)) url = g; }
    const when = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date") ?? "";
    const ts = Date.parse(decodeText(when));
    const summary = decodeText(tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content") ?? "").slice(0, 400);
    if (!title || !/^https?:\/\//.test(url) || !Number.isFinite(ts)) continue;
    out.push({ title: title.slice(0, 300), url: url.slice(0, 600), ts, summary });
  }
  return out;
}

// ── tagging ─────────────────────────────────────────────────────────────────────────────────────────
const FX_WORDS: [RegExp, string][] = [
  [/\b(dollar|greenback|dxy|fomc|the fed|powell|treasur(y|ies)|non-?farm|nfp|us cpi)\b/i, "USD"],
  [/\b(euro|ecb|lagarde|eurozone|euro area)\b/i, "EUR"],
  [/\b(yen|boj|bank of japan|ueda)\b/i, "JPY"],
  [/\b(pound|sterling|cable|boe|bank of england|bailey)\b/i, "GBP"],
  [/\b(swiss franc|snb)\b/i, "CHF"],
  [/\b(aussie|rba)\b/i, "AUD"],
  [/\b(kiwi|rbnz)\b/i, "NZD"],
  [/\b(loonie|boc|bank of canada)\b/i, "CAD"],
  [/\b(yuan|renminbi|pboc)\b/i, "CNY"],
  [/\b(gold|xau)\b/i, "XAU"],
  [/\b(silver|xag)\b/i, "XAG"],
  [/\b(crude|oil|wti|brent|opec)\b/i, "OIL"],
  [/\b(bitcoin|btc)\b/i, "BTC"],
  [/\b(ether|ethereum)\b/i, "ETH"],
];
const CCY = "USD|EUR|JPY|GBP|CHF|AUD|NZD|CAD|CNH|CNY|XAU|XAG";
const PAIR_RE = new RegExp(`\\b(${CCY})\\s?/?\\s?(${CCY})\\b`, "g");

/** Stock aliases: ticker → company word seen in headlines. Built from the Robinhood Chain stock/ETF list (hourly). */
export interface Alias { ticker: string; sym: RegExp | null; name: RegExp | null }
let aliasCache: { at: number; list: Alias[] } | null = null;
const STOP = new Set(["the", "inc", "corp", "corporation", "co", "company", "ltd", "plc", "sa", "nv", "ag", "holdings", "holding", "group", "class", "etf", "trust", "fund", "shares", "technologies", "technology", "platforms", "international", "com"]);
// Company words that are also everyday words — a headline "Target rates…" is not about TGT.
const AMBIGUOUS = /^(target|block|visa|gap|ford|shell|apple|vanguard|ishares|spdr|invesco|proshares|direxion|global|american|united|first|general|new|energy|select|health|real|capital|digital|future|bank|financial|home|power|data)$/i;
// Upper-case words in headlines that are not tickers even when a listed ticker shares them.
const NOT_TICKER = new Set(["CEO", "CFO", "USA", "GDP", "IPO", "ETF", "CPI", "PPI", "PMI", "FED", "ECB", "BOJ", "BOE", "SEC", "FDA", "EPS", "USD", "EUR", "GBP", "JPY", "OIL", "NEW", "NOW", "ALL", "ONE", "ARE", "FOR", "AND", "THE", "OPEN", "LOW", "HIGH", "BIG", "WAR", "API", "AI"]);
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function aliasFromName(name: string): string | null {
  const clean = name.replace(/•.*$/, "").replace(/[.,]/g, " ").replace(/\(.*?\)/g, " ").trim();
  const words = clean.split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  const first = words[0];
  if (!first || first.length < 4 || AMBIGUOUS.test(first)) return null;
  return first;
}
export function buildAlias(ticker: string, name: string): Alias {
  const tk = ticker.toUpperCase();
  // ≥3 letters: bare ticker, case-sensitive (NET ≠ "net"); shorter ones only as $F / (F) / NYSE: F style mentions.
  const sym = NOT_TICKER.has(tk) ? null : tk.length >= 3
    ? new RegExp(`(?<![A-Za-z0-9$])\\$?${esc(tk)}(?![A-Za-z0-9])`)
    : new RegExp(`(?:\\$${esc(tk)}|\\(${esc(tk)}\\)|(?:NYSE|NASDAQ|Nasdaq):\\s?${esc(tk)})(?![A-Za-z0-9])`);
  const a = aliasFromName(name);
  return { ticker: tk, sym, name: a ? new RegExp(`\\b${esc(a)}(?:'s)?\\b`, "i") : null };
}
async function stockAliases(): Promise<Alias[]> {
  if (aliasCache && Date.now() - aliasCache.at < 3_600_000) return aliasCache.list;
  const list: Alias[] = [];
  try {
    // ask2049: Chord reads its own Robinhood Chain token list (./rhTokens, rows tagged stock / etf). Here the list is the stock
    // board from Chord's public API through the ./rhRollup stand-in — every row is a stock; `name` rides along on the wire.
    const { getRhStocks } = await import("./rhRollup");
    const seen = new Set<string>();
    for (const t of (await getRhStocks()).stocks as { symbol: string | null; name?: unknown }[]) {
      const tk = String(t.symbol ?? "").toUpperCase();
      if (!/^[A-Z.]{1,6}$/.test(tk) || seen.has(tk)) continue;
      seen.add(tk);
      list.push(buildAlias(tk, String(t.name ?? "")));
    }
  } catch (e) { logger.debug({ err: String(e) }, "news: stock list unavailable"); }
  if (list.length) aliasCache = { at: Date.now(), list };
  return list;
}
const FX_TAGS = new Set(["USD", "EUR", "JPY", "GBP", "CHF", "AUD", "NZD", "CAD", "CNY", "CNH", "XAU", "XAG", "OIL"]);

// Coins (2026-09-26). A name nobody uses for anything else tags every feed ("Solana ETF" on CNBC); a name that is also a
// word or a planet (Optimism, Jupiter, Cosmos, Avalanche, Tron…), a bare ticker and a $cashtag tag crypto-desk items only.
const COIN_NAMES: [RegExp, string, boolean][] = [
  [/\bsolana\b/i, "SOL", false], [/\bxrp\b/i, "XRP", false], [/\bripple\b/i, "XRP", true], [/\bdogecoin\b/i, "DOGE", false],
  [/\bcardano\b/i, "ADA", false], [/\bchainlink\b/i, "LINK", false], [/\bpolkadot\b/i, "DOT", false], [/\blitecoin\b/i, "LTC", false],
  [/\bhyperliquid\b/i, "HYPE", false], [/\bshiba inu\b/i, "SHIB", false], [/\btoncoin\b/i, "TON", false], [/\bbittensor\b/i, "TAO", false],
  [/\bethena\b/i, "ENA", false], [/\buniswap\b/i, "UNI", false], [/\baave\b/i, "AAVE", false], [/\blido\b/i, "LDO", true],
  [/\bhedera\b/i, "HBAR", false], [/\bfilecoin\b/i, "FIL", false], [/\binjective\b/i, "INJ", false], [/\bcelestia\b/i, "TIA", false],
  [/\bkaspa\b/i, "KAS", false], [/\btron\b/i, "TRX", true], [/\bavalanche\b/i, "AVAX", true], [/\baptos\b/i, "APT", false],
  [/\barbitrum\b/i, "ARB", false], [/\boptimism\b/i, "OP", true], [/\bsui\b/i, "SUI", true], [/\bnear protocol\b/i, "NEAR", false],
  [/\bbnb\b/i, "BNB", false], [/\bpepe\b/i, "PEPE", true], [/\bbonk\b/i, "BONK", true], [/\bdogwifhat\b/i, "WIF", false],
  [/\bpudgy penguins\b/i, "PENGU", false], [/\bondo\b/i, "ONDO", true], [/\bjupiter\b/i, "JUP", true], [/\bmonad\b/i, "MON", true],
  [/\bstellar\b/i, "XLM", true], [/\bcosmos\b/i, "ATOM", true], [/\bpolygon\b/i, "POL", true], [/\btether\b/i, "USDT", false],
  [/\busdc\b/i, "USDC", false], [/\bworld liberty\b/i, "WLFI", false], [/\bzcash\b/i, "ZEC", false], [/\bmonero\b/i, "XMR", false],
  [/\bstarknet\b/i, "STRK", false], [/\beigenlayer\b/i, "EIGEN", false], [/\bpendle\b/i, "PENDLE", false], [/\bSei\b/, "SEI", true],
];
const COIN_TICKERS = "BTC|ETH|SOL|XRP|DOGE|ADA|LINK|DOT|LTC|HYPE|SHIB|TON|TAO|ENA|UNI|AAVE|LDO|HBAR|FIL|INJ|TIA|KAS|TRX|AVAX|APT|ARB|OP|SUI|NEAR|BNB|PEPE|BONK|WIF|PENGU|ONDO|JUP|MON|XLM|ATOM|POL|USDT|USDC|WLFI|ZEC|XMR|STRK|EIGEN|PENDLE|SEI|ETC|BCH|TRUMP|FET|RENDER|PYTH|JTO|CRV|MKR|STX|ICP";
const COIN_TICKER_RE = new RegExp(`(?<![A-Za-z0-9$-])(${COIN_TICKERS})(?![A-Za-z0-9-])`, "g");
const CASHTAG_RE = /(?<![A-Za-z0-9])\$([A-Za-z][A-Za-z0-9]{1,9})(?![A-Za-z0-9])/g;

/** `crypto` = the item came from a crypto desk: bare tickers, cashtags and the ambiguous coin names count too. */
export function tagText(text: string, aliases: Alias[], crypto = false): string[] {
  const out = new Set<string>();
  for (const a of aliases) if ((a.sym && a.sym.test(text)) || (a.name && a.name.test(text))) out.add(a.ticker);
  for (const m of text.matchAll(PAIR_RE)) if (m[1] !== m[2]) { out.add(m[1]); out.add(m[2]); out.add(`${m[1]}/${m[2]}`); }
  for (const [re, t] of FX_WORDS) if (re.test(text)) out.add(t);
  for (const [re, t, deskOnly] of COIN_NAMES) if ((crypto || !deskOnly) && re.test(text)) out.add(t);
  if (crypto) {
    for (const m of text.matchAll(COIN_TICKER_RE)) out.add(m[1]);
    for (const m of text.matchAll(CASHTAG_RE)) { const t = m[1].toUpperCase(); if (!NOT_TICKER.has(t)) out.add(t); }
  }
  return [...out].slice(0, 12);
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────────
const idOf = (url: string, title: string) => createHash("sha1").update(url || title).digest("hex").slice(0, 20);
// Tickers are stored as ",NVDA,EUR/USD," so one LIKE finds them (no array-param binding).
const packTickers = (t: string[]) => (t.length ? `,${t.join(",")},` : "");
const unpackTickers = (s: string | null) => (s ? s.split(",").filter(Boolean) : []);

// ask2049: Chord's news_items table (DDL in analyticsDb.ts) in the SQLite file src/payments.ts uses, opened on first use.
// Same columns: ts = epoch ms, tickers = ",NVDA,EUR/USD,". A second connection to that file is fine under WAL.
let db: Database | null = null;
function newsDb(): Database {
  if (db) return db;
  const path = config.dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`CREATE TABLE IF NOT EXISTS news_items (
    id      TEXT PRIMARY KEY,
    ts      INTEGER NOT NULL,
    source  TEXT NOT NULL,
    kind    TEXT NOT NULL,
    title   TEXT NOT NULL,
    url     TEXT NOT NULL,
    summary TEXT,
    tickers TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_news_ts ON news_items (ts DESC)");
  return db;
}
/** ask2049: tests start from a fresh store (DB_PATH=":memory:"). */
export function _resetNewsDb(): void {
  db?.close();
  db = null;
}

export async function insertNews(items: NewsItem[]): Promise<number> {
  if (!items.length) return 0;
  // ask2049: SQLite upsert, one transaction per batch; `changes` counts the rows that were new (Postgres: RETURNING id).
  const d = newsDb();
  const ins = d.query(`INSERT INTO news_items (id, ts, source, kind, title, url, summary, tickers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`);
  let n = 0;
  d.transaction(() => {
    for (const it of items) n += ins.run(it.id, it.ts, it.source, it.kind, it.title, it.url, it.summary, packTickers(it.tickers)).changes;
  })();
  return n;
}

const rowToItem = (r: any): NewsItem => ({ id: r.id, ts: Number(r.ts), source: r.source, kind: r.kind, title: r.title, url: r.url, summary: r.summary ?? "", tickers: unpackTickers(r.tickers) });

export interface NewsQuery { ticker?: string; q?: string; kind?: NewsKind; sinceMs?: number; limit?: number }
export async function queryNews(o: NewsQuery): Promise<NewsItem[]> {
  const limit = Math.max(1, Math.min(100, o.limit ?? 30));
  const since = o.sinceMs ?? Date.now() - 7 * 86_400_000;
  const tk = o.ticker ? `%,${o.ticker.toUpperCase()},%` : null;
  const q = o.q ? `%${o.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  // ask2049: SQLite — LIKE is case-insensitive for ASCII (Postgres ILIKE) and needs the backslash escape spelled out.
  const rows = newsDb().query(`SELECT id, ts, source, kind, title, url, summary, tickers FROM news_items
    WHERE ts >= ?1
      AND (?2 IS NULL OR tickers LIKE ?2)
      AND (?3 IS NULL OR title LIKE ?3 ESCAPE '\\' OR summary LIKE ?3 ESCAPE '\\')
      AND (?4 IS NULL OR kind = ?4)
    ORDER BY ts DESC LIMIT ?5`).all(since, tk, q, o.kind ?? null, limit);
  return rows.map(rowToItem);
}
/** ask2049: newest stored headline (epoch ms), null when the table is empty — warmNews reads it. */
function newestTs(): number | null {
  const r = newsDb().query("SELECT MAX(ts) AS t FROM news_items").get() as { t: number | null } | null;
  return r?.t == null ? null : Number(r.t);
}

// ── fetchers ──────────────────────────────────────────────────────────────────────────────────────
async function getText(url: string, ua = UA): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}

let secCik: Map<string, string> | null = null;
async function secTickers(): Promise<Map<string, string>> {
  if (secCik) return secCik;
  const redis = getRedis();
  let raw = await redis.get("news:sec:tickers").catch(() => null);
  if (!raw) {
    const j = JSON.parse(await getText("https://www.sec.gov/files/company_tickers.json", SEC_UA)) as Record<string, { cik_str: number; ticker: string }>;
    const m: Record<string, string> = {};
    for (const v of Object.values(j)) if (!m[String(v.cik_str)]) m[String(v.cik_str)] = v.ticker;
    raw = JSON.stringify(m);
    await redis.set("news:sec:tickers", raw, "EX", 86_400).catch(() => {});
  }
  secCik = new Map(Object.entries(JSON.parse(raw) as Record<string, string>));
  setTimeout(() => { secCik = null; }, 86_400_000).unref?.();
  return secCik;
}

async function pollFeed(f: Feed): Promise<number> {
  const xml = await getText(f.url, f.kind === "filing" ? SEC_UA : UA);
  const entries = parseFeed(xml).filter((e) => e.ts > Date.now() - 3 * 86_400_000 && e.ts < Date.now() + 3_600_000);
  const aliases = await stockAliases();
  const cik = f.kind === "filing" ? await secTickers().catch(() => null) : null;
  const items: NewsItem[] = entries.map((e) => {
    let tickers = tagText(`${e.title} ${e.summary}`, aliases, f.kind === "crypto");
    let title = e.title;
    if (f.kind === "filing") {
      // "8-K - NVIDIA CORP (0001045810) (Filer)" → tag by CIK, keep the item even when the company is not a stock we list.
      const m = /\((\d{6,10})\)/.exec(e.title);
      const t = m && cik?.get(String(Number(m[1])));
      tickers = t ? [t.toUpperCase()] : [];
      title = e.title.replace(/\s*\(\d{6,10}\)\s*\(Filer\)\s*$/i, "").trim();
    }
    // An FX-desk headline with no currency / commodity in it (Ifo, PMIs of a country…) is macro.
    const kind: NewsKind = f.kind === "fx" && !tickers.some((t) => FX_TAGS.has(t) || t.includes("/")) ? "macro" : f.kind;
    return { id: idOf(e.url, e.title), ts: e.ts, source: f.source, kind, title, url: e.url, summary: e.summary, tickers };
  });
  return insertNews(items);
}

async function pollFinnhub(): Promise<number> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return 0;
  const aliases = await stockAliases();
  let n = 0;
  for (const cat of ["general", "forex"] as const) {
    const r = await fetch(`https://finnhub.io/api/v1/news?category=${cat}&token=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`finnhub ${r.status}`);
    const arr = (await r.json()) as { datetime: number; headline: string; summary: string; url: string; source: string; related?: string }[];
    n += await insertNews(arr.filter((x) => x.headline && /^https?:\/\//.test(x.url)).map((x) => {
      const tickers = new Set(tagText(`${x.headline} ${x.summary}`, aliases));
      for (const s of (x.related ?? "").split(",")) if (/^[A-Z.]{1,6}$/.test(s.trim())) tickers.add(s.trim());
      return { id: idOf(x.url, x.headline), ts: x.datetime * 1000, source: x.source || "Finnhub", kind: cat === "forex" ? "fx" : "stock", title: x.headline.slice(0, 300), url: x.url.slice(0, 600), summary: (x.summary || "").slice(0, 400), tickers: [...tickers].slice(0, 12) };
    }));
  }
  return n;
}

// Alpaca News: REST backfill on start, then the WebSocket (one connection; reconnect with backoff).
const alpacaKeys = () => (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY ? { id: process.env.ALPACA_KEY_ID, secret: process.env.ALPACA_SECRET_KEY } : null);
function alpacaItem(x: any, aliases: Alias[]): NewsItem | null {
  const url = String(x.url || "");
  const title = String(x.headline || "").trim();
  if (!title) return null;
  const tickers = new Set<string>((x.symbols ?? []).filter((s: unknown) => typeof s === "string" && /^[A-Z.]{1,10}$/.test(s)));
  for (const t of tagText(`${title} ${x.summary ?? ""}`, aliases)) tickers.add(t);
  return { id: idOf(url || `alpaca:${x.id}`, title), ts: Date.parse(x.created_at || x.updated_at) || Date.now(), source: x.source ? `${String(x.source)[0].toUpperCase()}${String(x.source).slice(1)}` : "Benzinga", kind: "stock", title: title.slice(0, 300), url: /^https?:\/\//.test(url) ? url.slice(0, 600) : `https://www.benzinga.com/`, summary: decodeText(String(x.summary || "")).slice(0, 400), tickers: [...tickers].slice(0, 12) };
}
async function alpacaBackfill(): Promise<void> {
  const k = alpacaKeys();
  if (!k) return;
  const r = await fetch("https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc", { headers: { "APCA-API-KEY-ID": k.id, "APCA-API-SECRET-KEY": k.secret }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`alpaca rest ${r.status}`);
  const j = (await r.json()) as { news: any[] };
  const aliases = await stockAliases();
  const n = await insertNews((j.news ?? []).map((x) => alpacaItem(x, aliases)).filter((x): x is NewsItem => !!x));
  logger.info({ added: n }, "news: alpaca backfill");
}
let alpacaState: "off" | "connecting" | "live" | "error" = "off";
function alpacaStream(attempt = 0): void {
  const k = alpacaKeys();
  // ask2049: Alpaca allows ONE news socket per key and Chord production holds it with the same key; a second process only
  // loops on "connection limit exceeded". The REST backfill still runs; the socket needs NEWS_ALPACA_WS=1 (own key only).
  if (!k || process.env.NEWS_ALPACA_WS !== "1") return;
  alpacaState = "connecting";
  const ws = new WebSocket("wss://stream.data.alpaca.markets/v1beta1/news");
  let authed = false;
  ws.onopen = () => ws.send(JSON.stringify({ action: "auth", key: k.id, secret: k.secret }));
  ws.onmessage = async (ev) => {
    let msgs: any[];
    try { msgs = JSON.parse(String(ev.data)); } catch { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      if (m.T === "success" && m.msg === "authenticated" && !authed) { authed = true; ws.send(JSON.stringify({ action: "subscribe", news: ["*"] })); alpacaState = "live"; attempt = 0; logger.info("news: alpaca stream live"); }
      else if (m.T === "error") { logger.warn({ code: m.code, msg: m.msg }, "news: alpaca stream error"); alpacaState = "error"; }
      else if (m.T === "n") {
        const it = alpacaItem(m, await stockAliases());
        if (it) insertNews([it]).then((n) => { if (n) lastInsertAt = Date.now(); }).catch((e) => logger.debug({ err: String(e) }, "news: alpaca insert failed"));
      }
    }
  };
  ws.onclose = () => {
    alpacaState = alpacaState === "error" ? "error" : "connecting";
    const wait = Math.min(300_000, 5_000 * 2 ** Math.min(attempt, 6));
    setTimeout(() => alpacaStream(attempt + 1), wait).unref?.();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
}

let lastInsertAt = 0; // latest arrival, for /v1/news/status

// ForexFactory calendar — last good copy in Redis.
const CAL_KEY = "news:cal:ff:v1";
async function pollCalendar(): Promise<void> {
  const events: CalendarEvent[] = [];
  for (const wk of ["thisweek", "nextweek"]) {
    const r = await fetch(`https://nfs.faireconomy.media/ff_calendar_${wk}.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) { if (wk === "thisweek") throw new Error(`ff ${r.status}`); continue; }
    const arr = (await r.json()) as { title: string; country: string; date: string; impact: string; forecast: string; previous: string }[];
    for (const e of arr) {
      const ts = Date.parse(e.date);
      if (!Number.isFinite(ts)) continue;
      events.push({ ts, title: String(e.title).slice(0, 120), currency: String(e.country).slice(0, 6), impact: String(e.impact), forecast: e.forecast || null, previous: e.previous || null });
    }
  }
  if (events.length) await getRedis().set(CAL_KEY, JSON.stringify(events), "EX", 8 * 86_400);
}
/** The last event time the stored calendar knows. ForexFactory publishes one week at a time (nextweek.json is 404,
 *  checked 2026-09-26), so from Saturday there is nothing past the weekend until Sunday's new week — an empty answer
 *  there means "not published yet", not "nothing scheduled". */
export async function getCalendarCoverageEnd(): Promise<number | null> {
  const raw = await getRedis().get(CAL_KEY).catch(() => null);
  const all = raw ? (JSON.parse(raw) as CalendarEvent[]) : [];
  return all.length ? Math.max(...all.map((e) => e.ts)) : null;
}
export async function getCalendar(o: { days?: number; currency?: string; impact?: string; pastHours?: number } = {}): Promise<CalendarEvent[]> {
  const raw = await getRedis().get(CAL_KEY);
  const all = raw ? (JSON.parse(raw) as CalendarEvent[]) : [];
  const from = Date.now() - (o.pastHours ?? 6) * 3_600_000, to = Date.now() + Math.max(1, Math.min(14, o.days ?? 3)) * 86_400_000;
  const imp = o.impact?.toLowerCase();
  return all.filter((e) => e.ts >= from && e.ts <= to && (!o.currency || e.currency === o.currency.toUpperCase()) && (!imp || imp === "all" || (imp === "high" ? e.impact === "High" : imp === "medium" ? e.impact === "High" || e.impact === "Medium" : true)))
    .sort((a, b) => a.ts - b.ts);
}

/** Latest for a ticker; tops up from Yahoo's per-ticker RSS when the table has little (≤5-min memo per ticker). */
export async function newsFor(ticker: string, hours = 72, limit = 20): Promise<NewsItem[]> {
  const t = ticker.toUpperCase();
  let rows = await queryNews({ ticker: t, sinceMs: Date.now() - hours * 3_600_000, limit });
  if (rows.length < 5 && /^[A-Z.]{1,6}$/.test(t)) {
    const memo = `news:yahoo:${t}`;
    const fresh = await getRedis().set(memo, "1", "EX", 300, "NX").catch(() => null);
    if (fresh) {
      try {
        const xml = await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`);
        const aliases = await stockAliases();
        // Yahoo's per-ticker feed is loose (an Anthropic-IPO piece under NVDA): the ticker is kept only when the text names it.
        const own = aliases.find((x) => x.ticker === t) ?? buildAlias(t, "");
        await insertNews(parseFeed(xml).map((e) => {
          const text = `${e.title} ${e.summary}`;
          const named = (own.sym?.test(text) ?? false) || (own.name?.test(text) ?? false);
          return { id: idOf(e.url, e.title), ts: e.ts, source: "Yahoo Finance", kind: "stock" as const, title: e.title, url: e.url, summary: e.summary, tickers: [...new Set([...(named ? [t] : []), ...tagText(text, aliases)])].slice(0, 12) };
        }));
        rows = await queryNews({ ticker: t, sinceMs: Date.now() - hours * 3_600_000, limit });
      } catch (e) { logger.debug({ err: String(e), t }, "news: yahoo per-ticker failed"); }
    }
  }
  return rows;
}

// ── status + worker ─────────────────────────────────────────────────────────────────────────────────
const sourceStatus = new Map<string, { okAt: number | null; errAt: number | null; err: string | null; added: number }>();
const mark = (s: string, ok: boolean, added = 0, err?: string) => {
  const p = sourceStatus.get(s) ?? { okAt: null, errAt: null, err: null, added: 0 };
  if (ok) { p.okAt = Date.now(); p.added += added; } else { p.errAt = Date.now(); p.err = err ?? "error"; }
  sourceStatus.set(s, p);
  if (added) lastInsertAt = Date.now();
};
export function newsStatus() {
  return { alpaca: alpacaKeys() ? alpacaState : "off (set ALPACA_KEY_ID + ALPACA_SECRET_KEY)", finnhub: process.env.FINNHUB_KEY ? "on" : "off", lastInsertAt: lastInsertAt || null, sources: Object.fromEntries(sourceStatus) };
}

// ask2049: one poll per source at a time, and none sooner than `minGapMs` after the last good one. The first question may
// poll every feed inline (warmNews / warmCalendar) while the staggered timers below are starting; their first round then
// skips what was just fetched instead of asking each vendor twice (ForexFactory blocks IPs that poll it fast).
const lastPollOk = new Map<string, number>();
const pollInflight = new Map<string, Promise<number | void>>();
function pollOnce(name: string, minGapMs: number, fn: () => Promise<number | void>): Promise<number | void> {
  const busy = pollInflight.get(name);
  if (busy) return busy;
  if (Date.now() - (lastPollOk.get(name) ?? 0) < minGapMs) return Promise.resolve(0);
  const p = fn().then((n) => { lastPollOk.set(name, Date.now()); return n; }).finally(() => pollInflight.delete(name));
  pollInflight.set(name, p);
  return p;
}
// ask2049: Chord's `run` inside startNewsFeed, lifted out so the inline warm-up records source status the same way.
async function runMarked(name: string, fn: () => Promise<number | void>): Promise<void> {
  try { const n = await fn(); mark(name, true, typeof n === "number" ? n : 0); }
  catch (e) { mark(name, false, 0, String((e as Error)?.message || e).slice(0, 120)); logger.debug({ err: String(e), name }, "news: poll failed"); }
}
const feedPoll = (f: Feed) => () => pollOnce(f.source, f.everyMs / 2, () => pollFeed(f)); // ask2049
const finnhubPoll = () => pollOnce("Finnhub", 30_000, pollFinnhub); // ask2049
const calendarPoll = () => pollOnce("ForexFactory calendar", 60_000, pollCalendar); // ask2049

let started = false;
export function startNewsFeed(): void {
  if (started || process.env.NEWS_FEED === "0") return;
  started = true;
  const every = (name: string, ms: number, fn: () => Promise<number | void>, offset: number) => {
    const run = () => runMarked(name, fn); // ask2049: body lifted to runMarked
    setTimeout(() => { void run(); setInterval(() => void run(), ms).unref?.(); }, offset).unref?.();
  };
  FEEDS.forEach((f, i) => every(f.source, f.everyMs, feedPoll(f), 2_000 * i)); // ask2049: through pollOnce
  // ask2049: Chord publishes newsStatus() for /v1/news/status from its worker container (utils/jobStatus); one process here.
  every("Finnhub", 60_000, finnhubPoll, 25_000); // ask2049: through pollOnce
  every("ForexFactory calendar", 600_000, calendarPoll, 5_000); // ask2049: through pollOnce
  // ask2049: retention on the SQLite table (Chord: the same DELETE in Postgres).
  every("retention", 6 * 3_600_000, async () => { newsDb().run("DELETE FROM news_items WHERE ts < ?", [Date.now() - RETENTION_DAYS * 86_400_000]); }, 60_000);
  if (alpacaKeys()) { alpacaBackfill().catch((e) => logger.warn({ err: String(e) }, "news: alpaca backfill failed")); alpacaStream(); }
  logger.info({ feeds: FEEDS.length, alpaca: !!alpacaKeys(), finnhub: !!process.env.FINNHUB_KEY }, "news: feed started");
}

// ── ask2049: the first question after boot ──────────────────────────────────────────────────────────────────────────────
// Chord's collector has been running since boot; here it starts with the first question. If the table holds nothing from
// the last FRESH_MS (empty, or this process was down a while), every feed is polled at once and the read waits up to
// `deadlineMs` for them — what lands later is there for the next question. Once per process; NEWS_FEED=0 skips it.
const FRESH_MS = 6 * 3_600_000;
const WARM_MS = 6_000;
let warmNewsRun: Promise<unknown> | null = null;
let warmCalRun: Promise<unknown> | null = null;
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref?.();
    p.then(() => { clearTimeout(t); res(); }, () => { clearTimeout(t); res(); });
  });
}
export function warmNews(deadlineMs = WARM_MS): Promise<void> {
  if (process.env.NEWS_FEED === "0") return Promise.resolve();
  if (!warmNewsRun) {
    const newest = newestTs();
    warmNewsRun = newest != null && newest > Date.now() - FRESH_MS
      ? Promise.resolve()
      : Promise.allSettled([...FEEDS.map((f) => runMarked(f.source, feedPoll(f))), runMarked("Finnhub", finnhubPoll)]);
  }
  return within(warmNewsRun, deadlineMs);
}
export function warmCalendar(deadlineMs = WARM_MS): Promise<void> {
  if (process.env.NEWS_FEED === "0") return Promise.resolve();
  warmCalRun ??= (async () => {
    // The calendar's last good copy sits in the in-memory Redis stand-in, so it is empty after every start.
    if (!(await getRedis().get(CAL_KEY).catch(() => null))) await runMarked("ForexFactory calendar", calendarPoll);
  })();
  return within(warmCalRun, deadlineMs);
}
