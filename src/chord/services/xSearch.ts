// X (Twitter) search for Chord Ask (owner 2026-09-25: "tích hợp vào luôn, coi nó là harness") via twitterapi.io.
// Two reads: advanced search (Top or Latest, cashtags + operators, `since_time:<unix>`) and a user's profile +
// last posts. Everything returned is THIRD-PARTY text: the agent treats it as data, never instructions, and its
// addresses are never quotable (askAgent UNTRUSTED_ADDR_TOOLS) — CT is where scam contracts get posted.
//
// Ops: TWITTERAPI_IO_KEY (unset = tools answer "not enabled"). The free tier allows ONE request per 5 s per key,
// so every call goes through one Redis gate (`xs:gate`, X_SEARCH_MIN_INTERVAL_MS, default 5200) shared by all
// requests; results are cached 10 min (`xs:v1:*`), and a day cap (`xs:calls:{day}`, X_SEARCH_DAILY_CALLS, 1500)
// bounds the bill. Paid twitterapi.io credit lifts the QPS limit — then lower the interval.
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";

const BASE = "https://api.twitterapi.io";
const key = () => process.env.TWITTERAPI_IO_KEY || "";
export const xSearchEnabled = () => !!key();
const minInterval = () => { const v = Number(process.env.X_SEARCH_MIN_INTERVAL_MS); return Number.isFinite(v) && v >= 0 ? v : 5200; };
const dailyCap = () => { const v = Number(process.env.X_SEARCH_DAILY_CALLS); return Number.isFinite(v) && v > 0 ? v : 1500; };
const CACHE_S = 600;

async function waitGate(maxWaitMs = 20_000): Promise<boolean> {
  const r = getRedis();
  const until = Date.now() + maxWaitMs;
  for (;;) {
    try { if ((await r.set("xs:gate", "1", "PX", Math.max(1, minInterval()), "NX")) === "OK") return true; } catch { return true; }
    if (Date.now() > until) return false;
    await new Promise((res) => setTimeout(res, 300));
  }
}

// 402 = the twitterapi.io account is out of credit (2026-09-26: the free credit ran out after ~70 calls). One hour off
// instead of a failed paid call per question, and a message the model relays in one line — never "lỗi (402)".
const UNAVAILABLE = "X search is unavailable right now. Say so in one short line — no error codes, no reasons about accounts or providers — and answer from the other tools.";
async function xget<T = any>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const ck = `xs:v1:${path}?${qs}`;
  try { const hit = await getRedis().get(ck); if (hit) return JSON.parse(hit) as T; } catch { /* fetch */ }
  try { if (await getRedis().get("xs:off")) throw new Error(UNAVAILABLE); } catch (e) { if (String(e).includes("unavailable")) throw e; }
  const day = new Date().toISOString().slice(0, 10);
  try {
    const n = await getRedis().incr(`xs:calls:${day}`);
    if (n === 1) await getRedis().expire(`xs:calls:${day}`, 3 * 86_400);
    if (n > dailyCap()) throw new Error("X search has used today's budget");
  } catch (e) { if (/budget/.test(String(e))) throw e; }
  if (!(await waitGate())) throw new Error("X search is busy — try again in a moment");
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { "X-API-Key": key(), Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("X search is rate-limited — try again in a moment");
  if (res.status === 402 || /credits? is not enough|recharge/i.test(String(body?.message ?? body?.msg ?? ""))) {
    // 10 minutes, not an hour: after a recharge X search comes back within minutes (2026-09-27, new key installed empty).
    await getRedis().set("xs:off", "402", "EX", 600).catch(() => {});
    logger.warn({ path }, "x search: provider out of credit — off for 10 minutes");
    throw new Error(UNAVAILABLE);
  }
  if (!res.ok || body?.status === "error") throw new Error(`X search failed (${res.status}${body?.msg ? `: ${String(body.msg).slice(0, 80)}` : ""})`);
  await getRedis().set(ck, JSON.stringify(body), "EX", CACHE_S).catch(() => {});
  return body as T;
}

/** A picture or video of a post (board #130). `url` = the picture, or the video's poster frame, on pbs.twimg.com; `video` = an
 *  mp4 on video.twimg.com (video / gif), else null. For the page only — the model reads the types. */
export interface XMedia { type: "photo" | "video" | "gif"; url: string; w: number | null; h: number | null; video: string | null }
export interface XPost {
  id: string; url: string;
  /** Line breaks kept (blank lines collapse to one), up to TEXT_CAP characters. */
  text: string; createdAt: string; likes: number; reposts: number; replies: number; quotes: number; views: number;
  /** `avatar` is for the page only (askAgent strips it from what the model reads): a twimg.com https URL or null. */
  author: { userName: string; name: string; followers: number; verified: boolean; avatar: string | null };
  isReply: boolean;
  media: XMedia[];
}
/** Longest post text kept. X long posts run to 25k characters; the feed folds anything past a few lines. */
export const TEXT_CAP = 2_000;
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
/** An https URL on exactly `host`, or null. */
function httpsOn(u: unknown, host: RegExp): string | null {
  if (typeof u !== "string" || u.length > 400) return null;
  try { const url = new URL(u); return url.protocol === "https:" && host.test(url.hostname) ? url.href : null; } catch { return null; }
}
/** The mp4 the feed plays: the best variant at or under ~1 Mbit/s (a phone on a chat page), else the smallest. */
function pickMp4(variants: unknown): string | null {
  const mp4 = (Array.isArray(variants) ? variants : [])
    .map((v: any) => ({ url: v?.content_type === "video/mp4" ? httpsOn(v?.url, /^video\.twimg\.com$/) : null, rate: Number(v?.bitrate) || 0 }))
    .filter((v): v is { url: string; rate: number } => !!v.url)
    .sort((a, b) => a.rate - b.rate);
  if (!mp4.length) return null;
  return [...mp4].reverse().find((v) => v.rate <= 1_000_000)?.url ?? mp4[0].url;
}
/** Pictures / video / gifs of a post from twitterapi.io's `extendedEntities.media` (at most 4, X's own limit). */
export function mediaOf(t: any): XMedia[] {
  const list = t?.extendedEntities?.media ?? t?.extended_entities?.media ?? t?.entities?.media;
  if (!Array.isArray(list)) return [];
  const out: XMedia[] = [];
  for (const m of list.slice(0, 4)) {
    const type = m?.type === "photo" ? "photo" : m?.type === "video" ? "video" : m?.type === "animated_gif" ? "gif" : null;
    const url = httpsOn(m?.media_url_https ?? m?.media_url, /^pbs\.twimg\.com$/);
    if (!type || !url) continue;
    out.push({ type, url, w: num(m?.original_info?.width ?? m?.sizes?.large?.w), h: num(m?.original_info?.height ?? m?.sizes?.large?.h), video: type === "photo" ? null : pickMp4(m?.video_info?.variants) });
  }
  return out;
}
/** Post text as X shows it: line breaks kept, runs of spaces folded, at most one blank line. */
export const tidyText = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const toIso = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : s; };
// X sends post text HTML-escaped ("💜 &amp; 🔄", "CA&gt;&gt;") — the page printed the entities and "Follow &amp; RT" slipped
// past the bait filter (owner screenshot 2026-10-04). One pass, so "&amp;lt;" stays "&lt;".
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s: string): string => s.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g, (m, dec, hex, name) => {
  if (name) return ENTITIES[name];
  const cp = parseInt(dec ?? hex, dec ? 10 : 16);
  return cp > 31 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
});
/** A profile picture the page may load: https on X's image hosts only, at 96 px (the API hands out the 48 px `_normal`). */
export function avatarUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 300) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || !/^(pbs|abs)\.twimg\.com$/.test(url.hostname)) return null;
    return url.href.replace(/_normal(\.\w{3,4})$/, "_x96$1");
  } catch { return null; }
}
export function cleanPost(t: any): XPost {
  const a = t?.author ?? {};
  return {
    id: String(t?.id ?? ""), url: String(t?.url ?? t?.twitterUrl ?? ""),
    text: tidyText(decodeEntities(String(t?.text ?? "").replace(/https:\/\/t\.co\/\w+/g, ""))).slice(0, TEXT_CAP).trimEnd(),
    createdAt: toIso(String(t?.createdAt ?? "")),
    likes: Number(t?.likeCount) || 0, reposts: Number(t?.retweetCount) || 0, replies: Number(t?.replyCount) || 0, quotes: Number(t?.quoteCount) || 0, views: Number(t?.viewCount) || 0,
    author: { userName: String(a.userName ?? ""), name: decodeEntities(String(a.name ?? "")), followers: Number(a.followers) || 0, verified: !!(a.isBlueVerified || a.isVerified), avatar: avatarUrl(a.profilePicture) },
    isReply: !!t?.isReply,
    media: mediaOf(t),
  };
}

// Giveaways, "drop your address", like-and-RT bait, cashtag shill lists, brand-new tiny accounts, bots.
// Address bait is written a dozen ways (measured 2026-10-04 on a real "$SOL … KOL OR alpha" Top page: 20 of 20 posts were
// bait and the first version kept 10): "Drop $SOL addresses", "Drop your Solana $Sol Address", "Leave your $SOL address",
// "Send $sol address", "drop $sol addy", "I will send $100 to 10 people". "drop" without "your" only takes tickers before
// the noun — "a drop in active wallets" is analysis.
const SPAM_RE = /\b(giveaway|give ?away|airdrop(ping)? to|drop ((your|ur|ya) ([$#]?\w+ ){0,2}|([$#]\w+ ){0,2})(wallets?|address(es)?|addys?)|(comment|reply with) (your|ur) ([$#]?\w+ ){0,2}(wallets?|address(es)?|addy)|leave (your|ur) ([$#]?\w+ ){0,2}(address(es)?|addy)|(drop|comment) (your|ur) [$#]?(sol|eth|evm)|send ((me|us) )?((your|ur) )?[$#]?(sol|solana|eth|evm|btc|bnb|sui) (wallet )?(address(es)?|addy)|(send|sent|sending|give|giving) \$[\d,.]+k? to \d+|like ?(\+|&|and) ?(rt|retweet|repost)|rt ?(\+|&|and) ?follow|follow ?(\+|&|and) ?(rt|retweet)|tag \d+ friends?|dm (me )?for (promo|collab)|100x gem|next 1000x)\b/i;
// Claim bait (owner screenshot 2026-10-04: a "$SOL KOL alpha" search came back as eight of these): "CLAIM 700,000 $MONA
// STEP 1: 💜 & 🔄", "$MARS AIRDROP $100K REWARD POOL", "airdrop is live! Ready to claim". A number-and-ticker claim, a prize
// pool next to "airdrop", "ready to claim", or like-and-repost written as emoji. Kept narrow on purpose: "the airdrop is
// live" alone is news.
const CLAIM_RE = /\bclaim [\d][\d,.]* ?[kmb]? ?\$[a-z]\w*|\bairdrop\b.{0,40}\breward pool\b|\breward pool\b.{0,40}\bairdrop\b|\bready to claim\b/i;
const EMOJI_BAIT_RE = /(?:💜|❤️|❤|♥️|🩷|💙|💚|💟)\s*(?:\+|&|and)\s*(?:🔄|🔁|♻️)|(?:🔄|🔁|♻️)\s*(?:\+|&|and)\s*(?:💜|❤️|❤|♥️|🩷|💙|💚|💟)|\b(?:wallets?|address(?:es)?|addy)\W{0,8}(?:👇|⬇)/i;
export function isSpam(p: XPost, raw?: any): boolean {
  // The patterns read words separated by spaces: text keeps its line breaks now ("Submit Your \n$SOL\n Wallet Address").
  const flat = p.text.replace(/\s+/g, " ");
  if (SPAM_RE.test(flat) || CLAIM_RE.test(flat) || EMOJI_BAIT_RE.test(flat)) return true;
  if (raw?.author?.isAutomated) return true;
  if ((flat.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) ?? []).length >= 6) return true; // a list of tickers is a shill post
  if (p.author.followers < 50) return true;
  return false;
}
/** Engagement with a reach bonus — ranks what the crowd actually saw. */
export const postScore = (p: XPost) => p.likes + 2 * p.reposts + 1.5 * p.replies + 2 * p.quotes + Math.log10(1 + p.author.followers) * 3;
/** At most `max` posts per account, order kept: one account's five posts are one voice, not five (the same screenshot had
 *  one handle on four of eight rows). Not for a `from:` search — there one account is the point. */
export function capPerAuthor<T extends { author: { userName: string } }>(posts: T[], max = 2): T[] {
  const n = new Map<string, number>();
  return posts.filter((p) => { const k = p.author.userName.toLowerCase(); const c = (n.get(k) ?? 0) + 1; n.set(k, c); return c <= max; });
}

/** Top-level terms of an X query: a "quoted phrase" or a (bracketed group) stays one term. Pure — exported for tests. */
export function topTerms(q: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0, quote = false;
  for (const ch of q) {
    if (quote) { cur += ch; if (ch === '"') quote = false; continue; }
    if (ch === '"') { quote = true; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
/** Operators that filter the whole search, not one alternative of it — X binds them to the alternative they sit in. */
const GLOBAL_OP = /^-?(?:min_faves|min_retweets|min_replies|lang|filter|since|until|since_time|until_time|since_id|max_id|within_time):\S+$/i;
const isGlobal = (t: string) => GLOBAL_OP.test(t) || /^-\S/.test(t);
const isSubjectish = (t: string) => /^[$#@][A-Za-z0-9_]/.test(t) || /^(?:from|to):/i.test(t);
/**
 * Board #128: OR is X's LOOSEST operator — the model writes `$SOL staking OR ETF OR ETFs` meaning "$SOL, about staking or
 * ETFs", X reads ($SOL staking) OR ETF OR ETFs and the feed fills with NEAR / PEPE / real-estate ETF posts (seen live
 * 04/10). When the first alternative is a subject plus a word and every other alternative is ONE plain word or phrase,
 * the subject is pulled out and ANDed with a bracketed group: `$SOL (staking OR ETF OR ETFs)`. Any other OR query keeps
 * its meaning, written out (`(a b) OR (c d)`). Filters (min_faves:, lang:, -word …) apply to the whole search. Pure.
 */
export function normalizeQuery(q: string): string {
  const terms = topTerms(q.trim());
  if (!terms.some((t) => t === "OR")) return terms.join(" ");
  const filters = terms.filter(isGlobal);
  const alts: string[][] = [[]];
  for (const t of terms) { if (isGlobal(t)) continue; if (t === "OR") alts.push([]); else alts[alts.length - 1].push(t); }
  const clean = alts.filter((a) => a.length);
  let expr: string;
  if (clean.length < 2) expr = clean.flat().join(" ");
  else {
    const [first, ...others] = clean;
    const last = first[first.length - 1];
    if (first.length >= 2 && !isSubjectish(last) && others.every((a) => a.length === 1 && !isSubjectish(a[0]))) {
      expr = `${first.slice(0, -1).join(" ")} (${[last, ...others.map((a) => a[0])].join(" OR ")})`;
    } else {
      expr = clean.map((a) => (a.length > 1 ? `(${a.join(" ")})` : a[0])).join(" OR ");
    }
  }
  return [expr, ...filters].filter(Boolean).join(" ");
}
/** min_faves / min_retweets / min_replies of a query — applied to the posts on our side too: twitterapi.io returned posts
 *  with 0 likes for a `min_faves:50` search (board #128). Pure. */
export function engagementFloor(q: string): { likes: number; reposts: number; replies: number } {
  const n = (op: string) => { const m = new RegExp(`(?:^|\\s)${op}:(\\d{1,9})(?=\\s|$)`, "i").exec(q); return m ? Number(m[1]) : 0; };
  return { likes: n("min_faves"), reposts: n("min_retweets"), replies: n("min_replies") };
}
export const meetsFloor = (p: Pick<XPost, "likes" | "reposts" | "replies">, f: { likes: number; reposts: number; replies: number }): boolean =>
  p.likes >= f.likes && p.reposts >= f.reposts && p.replies >= f.replies;

/** The search string X gets. A query with a top-level OR goes in brackets: X binds `since_time:` (and `-filter:replies`)
 *  to the LAST alternative only, so `$SOL staking OR ETF` came back with 16-day-old posts under a "top 24h" title
 *  (seen live 2026-10-04, once the feed printed each post's age). The query is normalized first (normalizeQuery). */
export function buildQuery(query: string, sinceUnix: number, replies = false): string {
  const core = normalizeQuery(query.trim().slice(0, 200));
  return `${topTerms(core).includes("OR") ? `(${core})` : core} since_time:${sinceUnix}${replies ? "" : " -filter:replies"}`;
}
/** Inside the window: posted at or after `sinceUnix` (a minute of slack). A post whose time cannot be read stays. */
export const inWindow = (p: { createdAt: string }, sinceUnix: number): boolean => { const t = Date.parse(p.createdAt); return !Number.isFinite(t) || t >= (sinceUnix - 60) * 1000; };

export async function searchPosts(query: string, opts: { mode?: "top" | "latest"; hours?: number; replies?: boolean } = {}) {
  const hours = Math.max(1, Math.min(168, opts.hours ?? 24));
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const q = buildQuery(query, since, opts.replies);
  const body = await xget<{ tweets?: any[] }>("/twitter/tweet/advanced_search", { query: q, queryType: opts.mode === "latest" ? "Latest" : "Top" });
  const raw = Array.isArray(body.tweets) ? body.tweets : [];
  const all = raw.map((t) => ({ p: cleanPost(t), raw: t }));
  const notSpam = all.filter((x) => !isSpam(x.p, x.raw)).map((x) => x.p);
  // The window is checked here too (the brackets above are X's side of it). A post that is only a picture or a video stays
  // (board #130 — the feed draws it); one with neither text nor media left (a bare link) has nothing to show.
  const inside = notSpam.filter((p) => (p.text || p.media.length) && inWindow(p, since));
  const floor = engagementFloor(q);
  const kept = inside.filter((p) => meetsFloor(p, floor));
  return { query: q, hours, fetched: all.length, spamDropped: all.length - notSpam.length, belowFloorDropped: inside.length - kept.length, posts: kept };
}

/** Posts per hour from a Latest page: n posts over the span between the newest and the oldest (pure — tested). */
export function velocity(posts: { createdAt: string }[]): number | null {
  const ts = posts.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 3) return null;
  const spanH = (ts[ts.length - 1] - ts[0]) / 3_600_000;
  return spanH > 0 ? Math.round((ts.length / spanH) * 10) / 10 : null;
}

export async function userPosts(userName: string) {
  const u = userName.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
  if (!u) return null;
  const [info, last] = await Promise.all([
    xget<any>("/twitter/user/info", { userName: u }).catch((e) => { logger.debug({ err: String(e) }, "x user info failed"); return null; }),
    xget<any>("/twitter/user/last_tweets", { userName: u }),
  ]);
  const d = info?.data ?? {};
  const tweets = (last?.data?.tweets ?? last?.tweets ?? []) as any[];
  return {
    user: { userName: d.userName ?? u, name: d.name ?? null, followers: d.followers ?? null, verified: !!(d.isBlueVerified || d.isVerified), bio: typeof d.description === "string" ? d.description.slice(0, 200) : null, createdAt: d.createdAt ? toIso(d.createdAt) : null, avatar: avatarUrl(d.profilePicture) },
    posts: tweets.slice(0, 20).map(cleanPost),
  };
}
