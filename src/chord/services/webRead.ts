// The open web for Chord Ask (owner 2026-09-26: "model của mình chưa search web được" — a pasted link got "I can't open
// websites at all"). Two tools:
//   web_read   — fetch one page the person linked (or a search hit) and hand the model its readable text, meta tags and links.
//                No key. Live from the start.
//   web_search — a search API. Needs a key (BRAVE_SEARCH_API_KEY, TAVILY_API_KEY or SERPER_API_KEY); offered to the model
//                only when one is set. Keyless options measured from the VPS 2026-09-26: DuckDuckGo 202 (blocked), Jina
//                401/403 (key), Mojeek 403, Brave HTML 429, Bing RSS answers but localised to the box (Malaysia) and useless
//                ("pearlresearch.ai" → SmartTube) — so no scraper fallback.
//
// SSRF: the URL is chosen by whoever types the question. Only https on port 443, public host names whose DNS answers are
// all public addresses, every redirect re-checked (≤ 4), no cookies or credentials sent. A DNS-rebinding race between our
// lookup and fetch's own is still possible; the https + port-443 rule is what bounds it — nothing inside the compose network
// (redis 6379, engine 3002, postgres 5432, api 3001) or the cloud metadata endpoint (plain http) answers TLS on 443.
//
// Everything a page or a search result says is third-party text: registry marks both tools `untrusted` (addresses in them
// never reach the answer's allowlist, context replay skips them) and the tool note tells the model it is data, not orders.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { getRedis } from "../utils/redis";
import { logger } from "../utils/logger";
import { isPublicHttpsUrl } from "../utils/safeFetchUrl";

const UA = "Mozilla/5.0 (compatible; ChordAsk/1.0; +https://getchord.xyz)";
const MAX_BYTES = 1_500_000;
const TEXT_CAP = 9000;
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);

// ── URL safety ──────────────────────────────────────────────────────────────────────────────────────
/** http → https, strip fragments; null when the URL is not something the server may fetch. */
export function normalizeUrl(raw: string): string | null {
  let s = String(raw ?? "").trim().replace(/[)>\].,;'"]+$/, "");
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === "http:") u.protocol = "https:";
  u.hash = "";
  const out = u.toString();
  return isPublicHttpsUrl(out) ? out : null;
}

/** A resolved address the server may connect to. IPv6 needs its own rules — isPublicHttpsUrl treats a dot-less host as an
 *  internal container name, which refused every site with an AAAA record (live 2026-09-26: docs.arc.network, GitBook). */
export function isPublicIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (v !== 6) return false;
  const mapped = ip.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  if (/^::ffff:|^64:ff9b:/.test(ip)) return false; // hex-form mapped addresses — not worth decoding
  if (ip === "::" || ip === "::1") return false;
  return !/^(fe[89ab]|f[cd]|ff)[0-9a-f]{0,2}:|^2001:db8:|^100::/.test(ip);
}
async function hostIsPublic(host: string): Promise<boolean> {
  if (isIP(host.replace(/^\[|\]$/g, ""))) return isPublicIp(host);
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => isPublicIp(a.address));
  } catch { return false; }
}

// ── page text ───────────────────────────────────────────────────────────────────────────────────────
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

export interface PageRead { url: string; title: string | null; description: string | null; siteName: string | null; xHandle: string | null; text: string; truncated: boolean; links: { text: string; url: string }[] }
const BLOCK = "p, div, h1, h2, h3, h4, h5, h6, li, br, tr, section, article, header, footer, main, nav, aside, blockquote, pre, table, ul, ol, dt, dd, figcaption";
const INLINE_GAP = "a, span, button, td, th, label, strong, em, b, i, small, code";
const SOCIAL = /(^|\.)(x\.com|twitter\.com|t\.me|discord\.gg|discord\.com|github\.com|medium\.com|mirror\.xyz|substack\.com|linkedin\.com|youtube\.com|arxiv\.org|gitbook\.io|notion\.site)$/i;

/** Lines trimmed, repeats once (marquees, menus drawn twice), capped at TEXT_CAP. */
function cleanText(raw: string): { text: string; truncated: boolean } {
  const seen = new Set<string>();
  let text = raw.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length >= 2 && !seen.has(l) && (seen.add(l), true)).join("\n");
  const truncated = text.length > TEXT_CAP;
  if (truncated) text = `${text.slice(0, TEXT_CAP)}…`;
  return { text, truncated };
}
/** Links worth handing over: social, same site, or with a readable label — deduped, ≤ 25. */
function keepLinks(links: { text: string; url: string }[], base: string): { text: string; url: string }[] {
  const host = (() => { try { return new URL(base).hostname; } catch { return ""; } })();
  const seen = new Set<string>();
  return links.filter((l) => {
    const u = l.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(u) || u === base.replace(/\/$/, "")) return false;
    seen.add(u);
    let h = "";
    try { h = new URL(l.url).hostname; } catch { return false; }
    return SOCIAL.test(h) || h === host || h.endsWith(`.${host.replace(/^www\./, "")}`) || l.text.length >= 3;
  }).slice(0, 25).map((l) => ({ text: l.text.slice(0, 80), url: l.url }));
}

// ── pages drawn by JavaScript: the renderer (deploy/renderer, 2026-09-27) ──────────────────────────────
// A single-page app ships a ~1 KB HTML shell (minara.fun: a <title> and one <script>); its text only exists after
// the scripts run. The renderer is headless Chromium on its own Docker network (it cannot reach redis / postgres /
// the engines) that re-checks every request the page makes. Called only for thin pages and Cloudflare-style 403/503.
export const renderEnabled = (): boolean => !!process.env.RENDERER_URL;
export async function renderPage(url: string): Promise<(PageRead & { ms: number }) | null> {
  if (!renderEnabled()) return null;
  try {
    const res = await fetch(`${process.env.RENDERER_URL}/render`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RENDERER_TOKEN ?? ""}` },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(28_000),
    });
    if (!res.ok) { logger.info({ status: res.status }, "web_read: renderer refused"); return null; }
    const j: any = await res.json();
    if (!j?.ok) return null;
    const { text, truncated } = cleanText(String(j.text ?? ""));
    const final = typeof j.url === "string" && normalizeUrl(j.url) ? j.url : url;
    return { url: final, title: j.title ?? null, description: j.description ?? null, siteName: j.siteName ?? null, xHandle: j.xHandle ?? null, text, truncated: truncated || !!j.truncated,
      links: keepLinks(Array.isArray(j.links) ? j.links.map((l: any) => ({ text: String(l.text ?? ""), url: String(l.url ?? "") })) : [], final), ms: Number(j.ms) || 0 };
  } catch (e) {
    logger.info({ err: String(e) }, "web_read: renderer failed");
    return null;
  }
}

/** Readable text of an HTML page: title, description, body text (scripts / styles dropped, repeated lines once), links. */
export async function extractPage(html: string, base: string): Promise<PageRead> {
  let title = "";
  const meta: Record<string, string> = {};
  const buf: string[] = [];
  // Docs sites (GitBook, Mintlify, Docusaurus) put a sidebar of every page before the content: text inside <main> / <article>
  // is kept apart and wins when it has substance (live 2026-09-26: the HIP-3 page returned 9k characters of sidebar).
  const mainBuf: string[] = [];
  let inMain = 0;
  const links: { text: string; url: string }[] = [];
  let skip = 0;
  let a: { url: string; text: string } | null = null;
  const rw = new HTMLRewriter()
    .on("title", { text(t) { title += t.text; } })
    .on("meta", { element(e) { const k = (e.getAttribute("property") ?? e.getAttribute("name") ?? "").toLowerCase(); const v = e.getAttribute("content"); if (k && v && !meta[k]) meta[k] = v; } })
    .on("script, style, noscript, svg, template, head, iframe, canvas", { element(e) { skip++; e.onEndTag(() => { skip--; }); } })
    .on("main, article, [role=main]", { element(e) { inMain++; e.onEndTag(() => { inMain--; }); } })
    .on(BLOCK, { element() { buf.push("\n"); if (inMain) mainBuf.push("\n"); } })
    .on(INLINE_GAP, { element() { buf.push(" "); if (inMain) mainBuf.push(" "); } })
    .on("a[href]", {
      element(e) {
        let href: string | null = null;
        try { href = new URL(e.getAttribute("href") ?? "", base).toString(); } catch { /* bad href */ }
        a = href && /^https?:/.test(href) ? { url: href, text: "" } : null;
        const mine = a;
        e.onEndTag(() => { if (mine) { mine.text = decodeEntities(mine.text).replace(/\s+/g, " ").trim(); links.push(mine); } if (a === mine) a = null; });
      },
    })
    .onDocument({ text(t) { if (skip) return; buf.push(t.text); if (inMain) mainBuf.push(t.text); if (a) a.text += t.text; } });
  await rw.transform(new Response(html)).text();
  const mainText = mainBuf.join("");
  const src = mainText.replace(/\s+/g, " ").trim().length >= 400 ? mainText : buf.join("");
  const { text, truncated } = cleanText(decodeEntities(src));
  const keep = keepLinks(links, base);
  const m = (k: string) => (meta[k] ? decodeEntities(meta[k]).trim() : null);
  return {
    url: base, title: decodeEntities(title).trim() || m("og:title"), description: m("description") ?? m("og:description") ?? m("twitter:description"),
    siteName: m("og:site_name"), xHandle: m("twitter:site") ?? m("twitter:creator"), text, truncated, links: keep,
  };
}

// ── X / Twitter pages ────────────────────────────────────────────────────────────────────────────────
// x.com serves an empty JavaScript shell to readers, so profile and post links go through FxTwitter's public API
// (api.fxtwitter.com — no key; measured 2026-09-26: profile + status with counts, bio, website, article title). Also the
// fallback for x_user while the twitterapi.io credit is out.
const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const X_RESERVED = new Set(["home", "search", "explore", "i", "hashtag", "notifications", "messages", "settings", "intent", "share", "login", "signup", "tos", "privacy"]);
/** x.com/<user> or x.com/<user>/status/<id> → the parts; anything else on x.com → null. */
export function xTarget(url: string): { user: string; status: string | null } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!X_HOSTS.test(u.hostname)) return null;
  const [user, kind, id] = u.pathname.split("/").filter(Boolean);
  if (!user || !/^[A-Za-z0-9_]{1,15}$/.test(user) || X_RESERVED.has(user.toLowerCase())) return null;
  if (kind === "status" && /^\d{5,25}$/.test(id ?? "")) return { user, status: id };
  return kind ? null : { user, status: null };
}
export interface XProfile { handle: string; name: string; bio: string; followers: number | null; following: number | null; posts: number | null; joined: string | null; website: string | null; verified: string | null; url: string }
export async function xProfile(user: string): Promise<XProfile | null> {
  const res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(user)}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const u = ((await res.json()) as any)?.user;
  if (!u?.screen_name) return null;
  return { handle: String(u.screen_name), name: String(u.name ?? ""), bio: String(u.description ?? ""), followers: u.followers ?? null, following: u.following ?? null, posts: u.tweets ?? null,
    joined: u.joined ? new Date(u.joined).toISOString().slice(0, 10) : null, website: u.website?.url ?? null, verified: u.verification?.verified ? String(u.verification.type ?? "verified") : null, url: `https://x.com/${u.screen_name}` };
}
async function readX(url: string, t: { user: string; status: string | null }): Promise<ReadResult> {
  if (!t.status) {
    const p = await xProfile(t.user).catch(() => null);
    if (!p) return { ok: false, url, error: "That X account could not be read (it may not exist or be private)." };
    const text = [`${p.name} (@${p.handle}) on X${p.verified ? ` — verified ${p.verified}` : ""}`, p.bio && `Bio: ${p.bio}`, `Followers: ${p.followers ?? "?"} · following ${p.following ?? "?"} · posts ${p.posts ?? "?"}${p.joined ? ` · joined ${p.joined}` : ""}`, p.website && `Website: ${p.website}`].filter(Boolean).join("\n");
    return { ok: true, url: p.url, title: `${p.name} (@${p.handle})`, description: p.bio || null, siteName: "X", xHandle: `@${p.handle}`, text, truncated: false, links: p.website ? [{ text: "Website", url: p.website }] : [], status: 200, contentType: "application/json", ageS: 0,
      note: "Profile only (via FxTwitter) — recent posts are not in this read; x_search / x_user give posts when X search is up." };
  }
  const res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(t.user)}/status/${t.status}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const tw = res?.ok ? ((await res.json()) as any)?.tweet : null;
  if (!tw) return { ok: false, url, error: "That X post could not be read (deleted, private or X is not answering)." };
  const a = tw.author ?? {};
  const body = [tw.text || tw.raw_text?.text || "", tw.article?.title ? `Article: ${tw.article.title}${tw.article.preview_text ? ` — ${tw.article.preview_text}` : ""}` : "", tw.quote ? `Quoting @${tw.quote.author?.screen_name}: ${tw.quote.text ?? ""}` : ""].filter(Boolean).join("\n");
  const text = `@${a.screen_name} (${a.name}, ${a.followers ?? "?"} followers) posted on ${tw.created_at ? new Date(tw.created_at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?"}:\n${body}\n\n${tw.likes ?? 0} likes · ${tw.retweets ?? 0} reposts · ${tw.replies ?? 0} replies · ${tw.views ?? "?"} views`;
  return { ok: true, url: String(tw.url ?? url), title: `@${a.screen_name} on X`, description: a.description ?? null, siteName: "X", xHandle: `@${a.screen_name}`, text: text.slice(0, TEXT_CAP), truncated: text.length > TEXT_CAP, links: a.website?.url ? [{ text: "Website", url: a.website.url }] : [], status: 200, contentType: "application/json", ageS: 0 };
}

// ── fetch one page ──────────────────────────────────────────────────────────────────────────────────
async function readBody(res: Response): Promise<{ body: string; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { body: "", cut: false };
  const chunks: Uint8Array[] = [];
  let n = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    if (n >= MAX_BYTES) { cut = true; await reader.cancel().catch(() => {}); break; }
  }
  return { body: new TextDecoder().decode(Buffer.concat(chunks)), cut };
}

export type ReadResult = (PageRead & { ok: true; status: number; contentType: string; ageS: number; note?: string }) | { ok: false; url: string; error: string };

/** Fetch a page the person pointed at. Cached 15 min per URL. */
export async function readUrl(raw: string): Promise<ReadResult> {
  const first = normalizeUrl(raw);
  if (!first) return { ok: false, url: String(raw).slice(0, 200), error: "Not a public https web address — can't open it." };
  const ck = `web:read:v1:${sha(first)}`;
  try { const hit = await getRedis().get(ck); if (hit) { const j = JSON.parse(hit); return { ...j, ageS: Math.round(Date.now() / 1000 - j.t) }; } } catch { /* fetch */ }
  const day = new Date().toISOString().slice(0, 10);
  try {
    const n = await getRedis().incr(`web:read:calls:${day}`);
    if (n === 1) await getRedis().expire(`web:read:calls:${day}`, 172_800);
    if (n > Number(process.env.WEB_READ_DAILY ?? 3000)) return { ok: false, url: first, error: "Page reading is paused for today (daily cap)." };
  } catch { /* no redis: still read */ }
  let url = first;
  for (let hop = 0; hop < 5; hop++) {
    const xt = xTarget(url);
    if (xt) {
      const out = await readX(url, xt);
      if (out.ok) await getRedis().set(ck, JSON.stringify({ ...out, t: Math.floor(Date.now() / 1000) }), "EX", 900).catch(() => {});
      return out;
    }
    const u = new URL(url);
    if (!(await hostIsPublic(u.hostname))) return { ok: false, url, error: "That address points at a private network — refused." };
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" }, signal: AbortSignal.timeout(12_000) });
    } catch (e) {
      return { ok: false, url, error: /timeout|abort/i.test(String(e)) ? "The site did not answer within 12 s." : "The site could not be reached." };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      const next = loc ? normalizeUrl(new URL(loc, url).toString()) : null;
      if (!next) return { ok: false, url, error: "The site redirects somewhere that can't be opened." };
      url = next;
      continue;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // A bot wall (Cloudflare and friends answer 403 / 503 to plain fetches) sometimes lets a real browser through.
      if ((res.status === 403 || res.status === 503) && renderEnabled()) {
        const r = await renderPage(url);
        if (r && r.text.length >= 200) {
          const { ms: _ms, ...rp } = r;
          const out = { ok: true as const, ...rp, status: 200, contentType: "text/html", ageS: 0, note: "Read with a browser (a plain fetch was blocked)." };
          await getRedis().set(ck, JSON.stringify({ ...out, t: Math.floor(Date.now() / 1000) }), "EX", 900).catch(() => {});
          return out;
        }
      }
      return { ok: false, url, error: `The site answered HTTP ${res.status}${res.status === 403 || res.status === 503 ? " (it blocks automated readers, often a Cloudflare check)" : ""}.` };
    }
    if (!/html|xml|^text\/|json/.test(ct)) { await res.body?.cancel().catch(() => {}); return { ok: false, url, error: `It is not a web page (${ct.split(";")[0] || "unknown type"}) — only HTML / text can be read.` }; }
    const { body, cut } = await readBody(res);
    let page: PageRead = /html|xml/.test(ct)
      ? await extractPage(body, url)
      : { url, title: null, description: null, siteName: null, xHandle: null, text: body.slice(0, TEXT_CAP), truncated: body.length > TEXT_CAP, links: [] };
    let rendered = false;
    if (/html/.test(ct) && page.text.length < 200 && renderEnabled()) {
      const r = await renderPage(url);
      if (r && r.text.length > page.text.length) {
        page = { url: r.url, title: r.title ?? page.title, description: r.description ?? page.description, siteName: r.siteName ?? page.siteName, xHandle: r.xHandle ?? page.xHandle, text: r.text, truncated: r.truncated, links: r.links.length ? r.links : page.links };
        rendered = true;
      }
    }
    const thin = page.text.length < 200;
    const out = {
      ok: true as const, ...page, status: res.status, contentType: ct.split(";")[0], ageS: 0,
      note: rendered ? `Read with a browser — the site draws its content with JavaScript.${thin ? " Even rendered, it shows little text (an app screen)." : ""}`
        : thin ? "Almost no text in the HTML — the site renders with JavaScript; only its title, description and links were readable." : cut ? "Page was larger than 1.5 MB; read the first part." : undefined,
    };
    await getRedis().set(ck, JSON.stringify({ ...out, t: Math.floor(Date.now() / 1000) }), "EX", 900).catch(() => {});
    return out;
  }
  return { ok: false, url, error: "Too many redirects." };
}

// ── search ──────────────────────────────────────────────────────────────────────────────────────────
export type SearchProvider = "brave" | "tavily" | "serper";
export interface SearchHit { title: string; url: string; snippet: string; published: string | null; host: string }

export function searchProvider(): SearchProvider | null {
  const want = process.env.WEB_SEARCH_PROVIDER as SearchProvider | undefined;
  const has: Record<SearchProvider, boolean> = { brave: !!process.env.BRAVE_SEARCH_API_KEY, tavily: !!process.env.TAVILY_API_KEY, serper: !!process.env.SERPER_API_KEY };
  if (want && has[want]) return want;
  return (["brave", "tavily", "serper"] as const).find((p) => has[p]) ?? null;
}
export const webSearchEnabled = () => searchProvider() != null;

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const clean = (s: unknown) => decodeEntities(String(s ?? "")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
/** Provider JSON → hits (pure, tested). */
export function shapeHits(p: SearchProvider, j: any): SearchHit[] {
  const rows: any[] = p === "brave" ? [...(j?.news?.results ?? []).slice(0, 3), ...(j?.web?.results ?? [])] : p === "tavily" ? j?.results ?? [] : [...(j?.news ?? []).slice(0, 3), ...(j?.organic ?? [])];
  const seen = new Set<string>();
  return rows.map((r) => {
    const url = String(r.url ?? r.link ?? "");
    return { title: clean(r.title).slice(0, 160), url, snippet: clean(r.description ?? r.content ?? r.snippet).slice(0, 400), published: r.page_age ?? r.age ?? r.published_date ?? r.date ?? null, host: hostOf(url) };
  }).filter((h) => h.url.startsWith("https://") && h.title && !seen.has(h.url) && (seen.add(h.url), true));
}

export type Freshness = "day" | "week" | "month" | "year";
export async function searchWeb(q: string, o: { count?: number; freshness?: Freshness } = {}): Promise<{ provider: SearchProvider; hits: SearchHit[]; ageS: number }> {
  const p = searchProvider();
  if (!p) throw new Error("Web search is not configured");
  const query = q.replace(/\s+/g, " ").trim().slice(0, 300);
  const count = Math.max(1, Math.min(10, o.count ?? 8));
  const ck = `web:search:v1:${p}:${sha(`${query}|${count}|${o.freshness ?? ""}`)}`;
  try { const hit = await getRedis().get(ck); if (hit) { const j = JSON.parse(hit); return { provider: p, hits: j.hits, ageS: Math.round(Date.now() / 1000 - j.t) }; } } catch { /* search */ }
  const day = new Date().toISOString().slice(0, 10);
  try {
    const n = await getRedis().incr(`web:search:calls:${day}`);
    if (n === 1) await getRedis().expire(`web:search:calls:${day}`, 172_800);
    if (n > Number(process.env.WEB_SEARCH_DAILY ?? 300)) throw new Error("Web search is paused for today (daily cap)");
  } catch (e) { if (String(e).includes("daily cap")) throw e; }
  let res: Response;
  if (p === "brave") {
    const qs = new URLSearchParams({ q: query, count: String(count), text_decorations: "false", ...(o.freshness ? { freshness: { day: "pd", week: "pw", month: "pm", year: "py" }[o.freshness] } : {}) });
    res = await fetch(`https://api.search.brave.com/res/v1/web/search?${qs}`, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY! }, signal: AbortSignal.timeout(10_000) });
  } else if (p === "tavily") {
    res = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, body: JSON.stringify({ query, max_results: count, search_depth: "basic", ...(o.freshness ? { time_range: o.freshness } : {}) }), signal: AbortSignal.timeout(12_000) });
  } else {
    res = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": process.env.SERPER_API_KEY! }, body: JSON.stringify({ q: query, num: count, ...(o.freshness ? { tbs: { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[o.freshness] } : {}) }), signal: AbortSignal.timeout(10_000) });
  }
  if (!res.ok) {
    logger.warn({ provider: p, status: res.status }, "web search: provider error");
    throw new Error(res.status === 429 ? "Web search is rate-limited — try again shortly" : res.status === 401 || res.status === 403 || res.status === 402 ? "Web search key is not accepted (expired or out of credit)" : `Web search failed (HTTP ${res.status})`);
  }
  const hits = shapeHits(p, await res.json()).slice(0, count);
  await getRedis().set(ck, JSON.stringify({ hits, t: Math.floor(Date.now() / 1000) }), "EX", 900).catch(() => {});
  return { provider: p, hits, ageS: 0 };
}
