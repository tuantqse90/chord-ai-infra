// Agents view: Solana copy-trader, alert, LP and custom agents in paper mode, backtests on real history, the live public board.
// API: /v1/agents* (alias of /v1/bots*, ask2049-notes/bots-contract.md + PROMPT-agents-wow.md). Every request carries X-Session;
// every server string is escaped. Screens: Home (live hero, action tape over SSE, smart money right now, leaderboard, marketplace,
// templates, my agents) · Create (copy / alert / LP, trader or pool picker, backtest) · Builder (custom agents, builder.js, loaded
// lazily) · Detail (live over SSE, public read-only from the board; the owner publishes it to the marketplace from here).
// Marketplace copies: free = one click; priced = 402 (x402) → terms → the person's Solana wallet pays USDC → the copy is retried
// with X-PAYMENT and the server reads the payment through NOWNodes.
// Hash routes: #agents · #agents/mine · #agents/leaderboard · #agents/market · #agents/new · #agents/new/alert · #agents/new/lp · #agents/build ·
// #agents/build/<templateId> · #agents/<id> · #agents/public/<id>. #bots/… opens the same screens (rewritten to #agents/…).
// Visible copy says "agent"; code identifiers still say bot. Copy is terminal-dense: labels of two words, numbers carry the screen,
// explanations / notes / risk sit behind a closed (i) popover (info(), details.ag-i) or a "Notes" toggle, full sentences in titles.
// every agent's avatar: the Agents mascot (mascot.js), type = antenna tip + colour, copying = side-eye, the id picks its face
const { agentAvatar } = await import(`./mascot.js${new URL(import.meta.url).search}`);
const av = (b, size) => agentAvatar({ id: b?.id ?? "", type: b?.type, params: b?.params ?? (b?.mode ? { mode: b.mode } : {}) }, size, { decorative: true });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SOLSCAN = { tx: "https://solscan.io/tx/", acct: "https://solscan.io/account/", token: "https://solscan.io/token/" };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_WALLETS = 10, MAX_MINTS = 20, MAX_BOTS = 5;
const NUMF = new Set(["usd", "maxTok", "maxOpen", "slip", "minLiq", "stop", "minUsd"]);

// ── icons (same 24px stroke set as app.js) ──────────────────────────────────────────────────────────────────────────────
const I = {
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-3.8-5.9"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bot: '<rect x="5" y="8" width="14" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5v14l11-7Z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trophy: '<path d="M8 4h8v6a4 4 0 0 1-8 0Z"/><path d="M8 6H4.5a3.5 3.5 0 0 0 3.7 4M16 6h3.5a3.5 3.5 0 0 1-3.7 4M12 14v4M8 20h8"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>',
  spin: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  blocks: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>',
  fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  tag: '<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.4 1.4 0 0 1 0 2l-7.1 7.1a1.4 1.4 0 0 1-2 0Z"/><circle cx="8.2" cy="8.2" r="1.6"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10.5h18M16.5 15h1.5M6 6l9-3 1 3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
};
const svg = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] ?? ""}</svg>`;
const ic = (n, sw) => `<i class="b-i${n === "spin" ? " b-spin" : ""}">${svg(n, sw)}</i>`;

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const MINUS = "−";
const N = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const toMs = (t) => { const n = N(t); return n == null ? null : n < 1e12 ? n * 1000 : n; }; // the contract does not say s or ms
const short = (s, a = 4, b = 4) => { s = String(s ?? ""); return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
const int = (x) => { const n = N(x); return n == null ? "0" : Math.round(n).toLocaleString("en-US"); };
const plural = (n, w) => `${int(n)} ${w}${N(n) === 1 ? "" : "s"}`;
function usd(x) {
  const n = N(x); if (n == null) return "—";
  const a = Math.abs(n), s = n < 0 ? MINUS : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1000) return `${s}$${Math.round(a).toLocaleString("en-US")}`;
  if (a > 0 && a < 0.01) return `${s}<$0.01`;
  return `${s}$${a.toFixed(2)}`;
}
const signed = (x) => { const n = N(x); return n == null ? "—" : n > 0 ? `+${usd(n)}` : usd(n); };
const cls = (x) => { const n = N(x); return n == null || n === 0 ? "" : n > 0 ? "b-up" : "b-down"; };
const pct = (x) => { const n = N(x); if (n == null) return "—"; const v = n * 100; return `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`; };
const signedPct = (x) => { const n = N(x); return n == null ? "—" : `${n > 0 ? "+" : n < 0 ? MINUS : ""}${pct(Math.abs(n))}`; };
const compact = (x) => { const n = N(x); if (n == null) return "—"; const a = Math.abs(n); return a >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`; };
const SUB = "₀₁₂₃₄₅₆₇₈₉";
function price(x) {
  const p = N(x); if (p == null) return "—";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(p >= 100 ? 2 : 3)}`;
  if (p <= 0) return "$0";
  const zeros = Math.floor(-Math.log10(p)); // 0.0000123 → 4 zeros after the point
  if (zeros >= 4) return `$0.0${String(zeros).split("").map((d) => SUB[d]).join("")}${Math.round(p * 10 ** (zeros + 3))}`;
  return `$${p.toPrecision(4)}`;
}
function qty(x) {
  const n = N(x); if (n == null) return "—";
  const a = Math.abs(n);
  return a >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : a >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : a ? n.toPrecision(3) : "0";
}
function ago(t) {
  const ms = toMs(t); if (ms == null) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 10 ? "just now" : s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
const age = (t) => { const ms = toMs(t); if (ms == null) return "—"; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const dur = (sec) => { const s = N(sec); if (s == null) return "—"; return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h` : `${(s / 86400).toFixed(1)}d`; };
const daysLabel = (d) => (Number(d) === 1 ? "24 hours" : `${int(d)} days`);
const dayTag = (d) => (Number(d) === 1 ? "24h" : `${int(d)}d`);
/** { hm: "14:03:21", day: "Oct 6" | null when today } */
function when(t) {
  const ms = toMs(t); if (ms == null) return { hm: "—", day: null };
  const d = new Date(ms);
  return { hm: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), day: d.toDateString() === new Date().toDateString() ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
}
const fullTime = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const imgOf = (o) => { const u = o?.image ?? o?.logo ?? o?.logoURI ?? null; return /^https:\/\//.test(String(u ?? "")) || /^\/[^/]/.test(String(u ?? "")) ? String(u) : null; };
// Token pictures: a Solana mint goes through this site's /v1/logo/solana/<mint> (Jupiter's icon, else Chord's); a third-party
// picture that fails falls back to it; the monogram underneath (two letters on the mint's own hue) shows while the picture
// loads and stays when it fails. app.js swaps / drops the images (img[data-tl] load and error, caught on the document).
const CHORD_SOL = /^https:\/\/api\.getchord\.xyz\/v1\/logo\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[?#].*)?$/;
const hueOf = (s) => { let h = 7; for (const ch of String(s ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (sym) => (String(sym ?? "").replace(/^\$/, "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
/** pictures that failed once on this page: a repaint draws the monogram (or the fallback) at once, no new request.
 *  Caught on window, before app.js's document listener swaps the src or drops the image. */
const FAILED = new Set();
addEventListener("error", (e) => { const img = e.target; if (img instanceof HTMLImageElement && img.hasAttribute("data-tl")) { const s = img.getAttribute("src"); if (s) FAILED.add(s); } }, true);
function tokLogo(symbol, img, size = "", mint = null) {
  const m = (typeof mint === "string" && B58.test(mint) ? mint : null) ?? CHORD_SOL.exec(String(img ?? ""))?.[1] ?? null;
  const own = m ? LOGO(m) : null;
  let src = img && !CHORD_SOL.test(String(img)) ? img : own;
  let alt = own && src !== own ? own : null;
  if (alt && FAILED.has(alt)) alt = null;
  if (src && FAILED.has(src)) { src = alt; alt = null; }
  return `<span class="tlogo b-tl${size ? ` ${size}` : ""}" style="--mh:${hueOf(m ?? symbol)}"><b>${esc(initials(symbol))}</b>${src ? `<img data-tl src="${esc(src)}"${alt ? ` data-alt="${esc(alt)}"` : ""} alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}
/** a pool's two tokens, the second tucked under the first */
const pairLogo = (r, size = "") => `<span class="b-pair">${tokLogo(r.tokenSymbol ?? r.pair, null, size, r.token)}${tokLogo(r.quoteSymbol ?? "?", null, size, r.quote)}</span>`;
const rows = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === "object") : []); // drop malformed rows instead of failing the screen
const symOf = (s, mint) => (s ? String(s) : short(mint));
const STATUS = { running: "Running", paused: "Paused", stopped: "Stopped", error: "Error" };
const statusHtml = (s) => `<span class="b-st ${STATUS[s] ? s : ""}"><i></i>${esc(STATUS[s] ?? s ?? "Unknown")}</span>`;
const badge = (mode) => `<span class="b-badge${mode === "live" ? " live" : ""}">${mode === "live" ? "LIVE" : "PAPER"}</span>`;
const tile = (k, v, sub = "", c = "") => `<div class="b-tile"><small>${esc(k)}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
/** a tile whose label carries a chip (est.) */
const tileH = (kHtml, v, sub = "", c = "") => `<div class="b-tile"><small>${kHtml}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
const errBox = (msg, act) => `<div class="b-errbox">${ic("alert")}<span>${esc(msg)}</span>${act ? `<button type="button" class="b-btn" data-act="${act}">Try again</button>` : ""}</div>`;
const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
/** "4 s ago" / "3 min ago" (the live parts of the page tick every second through <time data-at>) */
function agoS(t) {
  const ms = toMs(t); if (ms == null) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}
/** "12s" / "4m" / "3h" / "2d": the terminal clock (time[data-at][data-c] ticks every second on Home, the full time in its title) */
function agoC(t) {
  const ms = toMs(t); if (ms == null) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const agoCTag = (t) => { const ms = toMs(t); return ms == null ? "—" : `<time data-at="${ms}" data-c="1" title="${esc(fullTime(ms))}">${agoC(ms)}</time>`; };
/** notes, methodology and long explanations: a small (i) that opens a popover, closed by default (its host is position: relative) */
const info = (html, label = "Notes") => (html ? `<details class="ag-i"><summary aria-label="${esc(label)}" title="${esc(label)}">${svg("info", 2)}</summary><div class="ag-ip">${html}</div></details>` : "");
const noteList = (ns) => (ns.length > 1 ? `<ul>${ns.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ns.length ? `<p>${esc(ns[0])}</p>` : "");
const PAPER = `<em class="ag-pp" title="Paper mode: nothing is sent">PAPER</em>`;
const secs = (x) => { const n = N(x); return n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)} s`; };
/** a value that is already in percent (−21 = −21 %) */
const pctPts = (x) => { const n = N(x); if (n == null) return "—"; const a = Math.abs(n); return `${n > 0 ? "+" : n < 0 ? MINUS : ""}${a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toFixed(a >= 100 ? 0 : 1)}%`; };
const aprTxt = (x) => { const n = N(x); return n == null ? "—" : `${n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n >= 100 ? 0 : 1)}%`; };
/** a pool price (quote per token), no $ sign; tiny values keep 4 significant digits with the zeros counted */
function pnum(x) {
  const p = N(x); if (p == null) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(p >= 100 ? 2 : 4);
  if (p <= 0) return "0";
  const zeros = Math.floor(-Math.log10(p));
  if (zeros >= 4) return `0.0${String(zeros).split("").map((d) => SUB[d]).join("")}${Math.round(p * 10 ** (zeros + 3))}`;
  return String(+p.toPrecision(4));
}
const LOGO = (mint) => `/v1/logo/solana/${encodeURIComponent(mint)}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** server text says "bot"; a person reads "agent" */
const agentWords = (s) => String(s ?? "").replace(/\bbots\b/g, "agents").replace(/\bbot\b/g, "agent").replace(/\bBot\b/g, "Agent");
function flashEl(el, up) { if (!el || reduced()) return; el.classList.remove("ag-fu", "ag-fd"); void el.offsetWidth; el.classList.add(up ? "ag-fu" : "ag-fd"); }
/** count from the value the element shows to `to`, flashing green / red on the way (no motion when the person asked for less) */
function countUp(el, to, fmt, { flash = true } = {}) {
  if (!el) return;
  const from = N(el.dataset.v), v = N(to);
  el.dataset.v = v == null ? "" : String(v);
  cancelAnimationFrame(el._raf);
  if (from == null || v == null || from === v || reduced()) { el.innerHTML = fmt(v); return; }
  if (flash) flashEl(el, v > from);
  const t0 = performance.now(), d = 700;
  const step = (t) => { const k = Math.min(1, (t - t0) / d), e = 1 - (1 - k) ** 3; el.innerHTML = fmt(k < 1 ? from + (v - from) * e : v); if (k < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}
function toast(msg) {
  let t = $("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
  t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2800);
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
let D = null, root = null;
const freshForm = () => ({ type: "copy", name: "", days: 7, more: false, wallets: [], mints: [], usd: "20", maxTok: "", maxOpen: "10", slip: "1", minLiq: "20000", stop: "",
  mirror: true, safety: true, btDays: 7, bt: null, btKey: null, btErr: null, btBusy: false, btAll: false, minUsd: "1000", hook: "", busy: false });
const freshLp = () => ({ path: "pool", sort: "fees", dex: "", scans: {}, pool: null, ranges: {}, preset: "balanced", custom: "", amount: "500", oor: "30", maxDay: "4",
  exodus: true, drop: "", stop: "", safety: true, days: 3, bt: null, btKey: null, btErr: null, btBusy: false });
const S = { screen: null, vis: false, bots: null, botsErr: null, det: null, traders: {}, f: freshForm(), lp: freshLp(), tick: null, ctrl: null, live: "off", posT: null, timers: [] };
/** the home screen's data (kept across visits so a return paints at once, then refreshes) */
const H = { stats: null, statsErr: null, smart: null, smartErr: null, smartPrev: null, win: "today", boards: {}, boardErr: null, moves: {}, tpls: undefined, tplAt: 0,
  sparks: new Map(), sparkAt: 0, prev: new Map() };
/** the live action tape (SSE /v1/agents/feed) */
const F = { items: [], keys: new Set(), pending: [], paused: false, live: "off", ctrl: null, skips: true, fresh: new Set(), open: new Set() };
const session = () => (typeof D?.session === "function" ? D.session() : D?.session) ?? "";
const vis = () => !!root && !root.hidden && document.visibilityState === "visible";

const ERR = {
  too_many_bots: `You already have ${MAX_BOTS} agents. Delete one to start another.`,
  live_not_enabled: "Live mode is not switched on yet. Agents run in paper mode.",
  not_found: "This agent does not exist any more.",
};
function errText(status, j) {
  if (j?.error && ERR[j.error]) return ERR[j.error];
  if (j?.message) return String(j.message);
  if (status === 404) return ERR.not_found;
  if (status === 409) return ERR.too_many_bots;
  if (status === 429) return "Too many requests. Wait a few seconds and try again.";
  if (status >= 500) return `The server failed (${status}). Try again in a moment.`;
  if (status === 422 && j?.error === "short_history") return "This pool has too little price history to backtest. Try a shorter window or another pool.";
  return typeof j?.error === "string" ? j.error.replace(/_/g, " ") : `Request failed (${status}).`;
}
async function api(path, { method = "GET", body, signal } = {}) {
  let r;
  try {
    r = await fetch(path, { method, signal, headers: { "X-Session": session(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error("Connection lost. Check your network and try again.");
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(errText(r.status, j)), { status: r.status });
  if (j == null) throw new Error("The server sent an answer this page cannot read.");
  return j;
}
/** the status and body as they came (the marketplace reads 402 and 409 answers instead of throwing on them) */
async function apiRaw(path, { method = "GET", body, headers = {} } = {}) {
  let r;
  try {
    r = await fetch(path, { method, headers: { "X-Session": session(), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("Connection lost. Check your network and try again."); }
  return { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
}

// ── entry points ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** deps: { showView(v), session: string | () => string, icon?(name) }. Renders into <section id="botsv">. */
export function initBots(deps) {
  D = deps ?? {};
  root = $("botsv");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  root.innerHTML = `<div class="b-wrap">
    <header class="b-head">
      <div class="b-ttl"><h1>Agents</h1>${PAPER}${info("Solana agents trading on paper right now: every fill is priced by a real Jupiter quote and nothing is sent. Watch them act, copy a winner in one click.", "About agents")}</div>
      <div class="b-nav">
        <button type="button" class="b-btn ag-navb" data-go="board">${ic("trophy")}Leaderboard</button>
        <button type="button" class="b-btn ag-navb" data-go="mine">My agents<span class="ag-cnt" id="agMineCnt"></span></button>
        <button type="button" class="b-new" data-go="create">${ic("plus", 2.2)}New agent</button>
      </div>
    </header>
    <div id="bMain"></div>
  </div>`;
  root.addEventListener("click", onClick);
  root.addEventListener("pointerover", onTapeHover);
  root.addEventListener("pointerout", onTapeHover);
  root.addEventListener("touchstart", (e) => { if (e.target.closest?.("#agTape")) pauseTape(true); else if (F.touch && !e.target.closest?.("#agNewN")) resumeTape(); }, { passive: true });
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("keydown", onKey);
  // an open (i) popover closes on a click outside it, or on Escape
  document.addEventListener("click", (e) => { root.querySelectorAll("details.ag-i[open]").forEach((d) => { if (!d.contains(e.target)) d.removeAttribute("open"); }); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") root.querySelectorAll("details.ag-i[open]").forEach((d) => d.removeAttribute("open")); });
  root.addEventListener("pointermove", onChartMove);
  root.addEventListener("pointerleave", (e) => { if (e.target.classList?.contains("b-plot") && document.activeElement !== e.target) hidePt(e.target); }, true);
  root.addEventListener("focusout", (e) => { if (e.target.classList?.contains("b-plot")) hidePt(e.target); });
  S.vis = !root.hidden;
  new MutationObserver(onVisibility).observe(root, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (vis()) refreshCurrent(); });
  window.addEventListener("popstate", onPop);
  window.addEventListener("hashchange", onPop); // a pasted #agents/… link in an open tab (popstate usually fires first: then a no-op)
}

/** Open the view. opts: { screen: "home" | "mine" | "board" | "create" | "build" | "detail", id?, pub?, type?: "copy" | "alert" | "lp",
 *  prefill?: CopyParams & AlertParams & { name, type }, template?, strategy?, explanation?, text? (build) } or a hash tail ("new", "new/lp",
 *  "build", "build/<templateId>", "leaderboard", "mine", "<id>", "public/<id>"). "mine" and "board" are the home screen scrolled to that part.
 *  No opts: the #agents… / #bots… hash, else the last screen. */
export function openBots(opts) {
  if (!root) return;
  S.vis = true;
  D.showView?.("bots");
  const o = typeof opts === "string" ? fromHash(`#agents/${opts}`) : opts ?? fromHash(location.hash);
  if (o?.prefill) applyPrefill(o.prefill);
  seedHistory(o);
  if (o) go(o.screen ?? "home", o);
  else if (S.screen) resume();
  else go("home");
}

function fromHash(h) {
  const m = /^#(bots|agents)(?:\/(.*))?$/.exec(h || "");
  if (!m) return null;
  const rest = m[2] ?? "";
  if (!rest) return { screen: "home" };
  if (rest === "mine") return { screen: "mine" };
  if (rest === "new" || rest === "create") return { screen: "create" };
  if (rest === "new/alert") return { screen: "create", type: "alert" };
  if (rest === "new/lp") return { screen: "create", type: "lp", lppath: "pool" };
  if (rest === "new/lpcopy") return { screen: "create", type: "lp", lppath: "copy" };
  if (rest === "new/copy") return { screen: "create", type: "copy" };
  if (rest === "build") return { screen: "build" };
  const bm = /^build\/(.+)$/.exec(rest);
  if (bm) return { screen: "build", template: decodeURIComponent(bm[1]) };
  if (rest === "leaderboard" || rest === "board") return { screen: "board" };
  if (rest === "market" || rest === "marketplace") return { screen: "market" };
  const pm = /^public\/(.+)$/.exec(rest);
  return pm ? { screen: "detail", id: decodeURIComponent(pm[1]), pub: true } : { screen: "detail", id: decodeURIComponent(rest) };
}
/** #agents/… is the address of every screen; builder.js and older links still say #bots/…, rewritten here.
 *  A screen change pushes a history entry (Back / Forward walk the screens), in-screen state (a form's type, the template
 *  loaded in the builder, a detail falling back to its public view) replaces the entry. Each entry we push remembers the
 *  screen it came from (state.from) and the scroll of the screen it left (state.y), so Back lands where the person was. */
const normHash = (h) => (String(h ?? "").startsWith("#bots") ? `#agents${h.slice(5)}` : String(h ?? ""));
const hereUrl = (h) => location.pathname + location.search + h;
const isAg = (h) => /^#(agents|bots)(\/|$)/.test(h ?? "");
let curHash = null; // the hash this view last rendered (a popstate for it is a no-op)
function nav(h, mode = "push") {
  h = normHash(h);
  curHash = h;
  try {
    const now = location.hash, st = history.state && typeof history.state === "object" ? history.state : {};
    if (normHash(now) === h) { if (now !== h) history.replaceState(st, "", hereUrl(h)); return; }
    if (mode === "replace") { history.replaceState(st, "", hereUrl(h)); return; }
    if (isAg(now) && root) history.replaceState({ ...st, y: root.scrollTop }, "", hereUrl(now));
    history.pushState({ ag: 1, from: isAg(now) ? normHash(now) : null }, "", hereUrl(h));
  } catch {}
}
/** in-screen state: the address changes, no new entry (builder.js calls this too) */
const setHash = (h) => nav(h, "replace");
/** a deep link opened in a fresh tab: put the Agents home under it, so Back from it stays on the site */
function seedHistory(o) {
  if (S.screen || !o || !["detail", "create", "build"].includes(o.screen) || history.state != null || !isAg(location.hash)) return;
  try { const h = normHash(location.hash); history.replaceState({ ag: 1, from: null }, "", hereUrl("#agents")); history.pushState({ ag: 1, from: "#agents" }, "", hereUrl(h)); } catch {}
}
/** Back / Forward (and a pasted #agents/… link): render the screen of the address, without pushing */
function onPop() {
  const h = location.hash;
  if (!isAg(h)) return; // chat / trade: app.js renders those
  if (normHash(h) === curHash && !root.hidden) return;
  const o = fromHash(h); if (!o) return;
  openBots({ ...o, pop: true, y: N(history.state?.y) });
}
/** where the crumb goes: the screen this entry came from (history.back), else the fallback screen */
const BACK_LABEL = [[/^#agents$/, "Agents"], [/^#agents\/(leaderboard|board)$/, "Leaderboard"], [/^#agents\/mine$/, "My agents"], [/^#agents\/(market|marketplace)$/, "Marketplace"], [/^#agents\/(new|create)/, "New agent"], [/^#agents\/build/, "Builder"]];
function crumbHtml(fallback, label) {
  const from = typeof history.state?.from === "string" ? history.state.from : null;
  const l = from ? BACK_LABEL.find(([re]) => re.test(from))?.[1] ?? "Back" : label;
  return `<div class="b-crumb"><button type="button" data-act="back" data-to="${esc(fallback)}">${ic("back")}${esc(l)}</button></div>`;
}
function goBack(fallback) {
  if (typeof history.state?.from === "string" && isAg(history.state.from)) { history.back(); return; }
  go(fallback || "home");
}

function onVisibility() {
  const v = !root.hidden;
  if (v === S.vis) return;
  S.vis = v;
  if (!v) { stopAll(); curHash = null; } // app.js moved the address to the view it opened (its own history entry)
  else resume();
}
function resume() {
  if (!S.screen) return go("home");
  go(S.screen, S.screen === "detail" ? { id: S.det?.id, pub: S.det?.pub } : {});
}
function refreshCurrent() {
  if (S.screen === "home") { loadStats(true); loadLb(true); loadMarket(); loadSmart(true); loadBots(true); if (!F.ctrl) startFeed(); }
  else if (S.screen === "detail" && S.det) { loadDetail(true); if (!S.det.pub && !S.ctrl) startLive(); }
}
function stopAll() { S.lcView?.destroy?.(); S.lcView = null; stopLive(); stopFeed(); S.timers.forEach(clearInterval); S.timers = []; clearInterval(S.tick); S.tick = null; clearTimeout(S.posT); if (MK.pay && !MK.pay.busy) closePay(true); }
const every = (ms, fn) => S.timers.push(setInterval(() => { if (vis()) fn(); }, ms));

function go(screen, o = {}) {
  stopAll();
  if (screen === "mine" || screen === "board" || screen === "market") { o = { ...o, focus: screen }; screen = "home"; }
  if (screen === "detail" && !o.id) screen = "home";
  S.screen = screen;
  root.querySelector(".b-wrap")?.classList.toggle("ag-wide", screen === "home");
  const main = $("bMain"), mode = o.replace ? "replace" : "push";
  if (screen === "home") {
    nav(o.focus === "board" ? "#agents/leaderboard" : o.focus === "mine" ? "#agents/mine" : o.focus === "market" ? "#agents/market" : "#agents", mode);
    main.innerHTML = homeHtml();
    paintKpis(); paintTape(); paintSmart(); paintLb(); paintMarket(); paintTpls(); paintMine();
    loadStats(); loadSmart(); loadLb(); loadMarket(); loadTpls(); loadBots();
    startFeed();
    every(10_000, () => { loadStats(true); loadBots(true); });
    every(15_000, () => { loadLb(true); loadMarket(); });
    every(30_000, () => loadSmart(true));
    every(1000, tickAgo);
    if (o.pop && o.y != null) restoreY(o.y);
    else if (o.focus) requestAnimationFrame(() => $(o.focus === "board" ? "agBoardS" : o.focus === "market" ? "mkS" : "agMineS")?.scrollIntoView({ block: "start" }));
    else root.scrollTop = 0;
    return;
  }
  if (screen === "create") {
    if (o.type === "copy" || o.type === "alert" || o.type === "lp") S.f.type = o.type;
    if (o.lppath === "copy" || o.lppath === "pool") S.lp.path = o.lppath;
    nav(createHash(), mode);
    main.innerHTML = createHtml();
    paintSel(); paintGo();
    if (S.f.type === "copy") loadTraders();
    if (S.f.type === "lp") lpPathStart();
  } else if (screen === "build") {
    nav(o.template ? `#agents/build/${encodeURIComponent(o.template)}` : "#agents/build", mode);
    main.innerHTML = `<div id="bBuild" class="bb-host"><div class="b-skel" style="height:44px;width:40%"></div><div class="b-skel" style="height:220px;margin-top:18px"></div></div>`;
    openBuilder(o);
  } else if (screen === "detail") {
    S.det = { id: String(o.id), pub: !!o.pub, data: null, err: null, confirm: false, busy: null, msg: null, nFills: 50, nEv: 40, fresh: new Set(),
      mk: { listing: undefined, open: false, busy: null, f: null } };
    nav(o.pub ? `#agents/public/${encodeURIComponent(o.id)}` : `#agents/${encodeURIComponent(o.id)}`, mode);
    main.innerHTML = `${crumbHtml(o.pub ? "board" : "mine", o.pub ? "Leaderboard" : "My agents")}<div id="bDet"></div>`;
    paintDetail(); loadDetail();
    if (!o.pub) startLive();
    S.tick = setInterval(() => vis() && loadDetail(true), o.pub ? 15_000 : 30_000);
  }
  if (o.pop && o.y != null) restoreY(o.y); else root.scrollTop = 0;
}
/** Back to a screen: its scroll comes back as its parts load (unless the person scrolls first) */
function restoreY(y) {
  let set = null;
  const put = () => { if (set != null && Math.abs(root.scrollTop - set) > 4) return; root.scrollTop = y; set = root.scrollTop; };
  requestAnimationFrame(put);
  for (const ms of [250, 700, 1500]) setTimeout(put, ms);
}

// ── Builder (builder.js, loaded on first use; it also explains custom bots' strategies on cards and detail) ───────────────
let BM = null, BMp = null;
const builderMod = () => (BMp ??= import(`./builder.js${new URL(import.meta.url).search}`).then((m) => (BM = m)).catch((e) => { BMp = null; throw e; }));
async function openBuilder(o) {
  let m;
  try { m = await builderMod(); }
  catch { const el = $("bBuild"); if (el && S.screen === "build") el.innerHTML = errBox("The builder failed to load. Check your connection.", "retry-build"); return; }
  const el = $("bBuild");
  if (!el || S.screen !== "build") return;
  m.renderBuilder(el, {
    session, api, setHash, crumb: () => crumbHtml("mine", "My agents"),
    onCreated: (bot) => { S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)]; go("detail", { id: bot.id }); },
    ui: { esc, usd, signed, cls, pct, int, plural, daysLabel, toMs, rows, N, tile, errBox, equityHtml, fillsTable, replayTag, walletsReadChip },
    route: { template: o.template ?? null, strategy: o.strategy ?? null, explanation: o.explanation ?? null, text: o.text ?? null },
  });
  if (o.strategy) requestAnimationFrame(() => $("bbEd")?.scrollIntoView({ block: "start" })); // a ready strategy: land on its blocks
}
const stratOf = (b) => (b?.type === "custom" && b.params?.strategy && typeof b.params.strategy === "object" ? b.params.strategy : null);
/** custom bots: the action decides whether the bot holds positions (buy / sell) or only reports matches (alert / webhook) */
const trades = (b) => b?.type === "copy" || b?.type === "lp" || (b?.type === "custom" && !["alert", "webhook"].includes(stratOf(b)?.action?.type));
/** plain lines for a custom bot: the server's when it sends them, else builder.js explains the strategy (loads it once, then repaints) */
function explainOf(b) {
  const x = b.params?.explanation ?? b.explanation;
  if (Array.isArray(x) && x.some((s) => typeof s === "string" && s)) return x.filter((s) => typeof s === "string" && s);
  if (BM) { try { return BM.explain(stratOf(b)); } catch { return []; } }
  builderMod().then(() => { if (S.screen === "home") paintMine(); else if (S.screen === "detail") paintHero(); }).catch(() => {});
  return [];
}
/** "Trigger: when …" → the block name set apart */
const xlHtml = (x) => { const m = /^(Trigger|Filters|Action|Exits|Limits):\s*/.exec(x); return m ? `<b>${m[1]}</b> ${esc(x.slice(m[0].length))}` : esc(x); };
const typeShort = (b) => ({ copy: "Copy trader", custom: "Custom", lp: "LP" })[b.type] ?? "Alert";
const typeLabel = (b) => `${typeShort(b)} agent`;
const typeIcon = (b) => ({ copy: "users", custom: "blocks", lp: "drop" })[b.type] ?? "bell";

// ── Home: live hero · action tape · smart money right now · leaderboard · templates · my agents ───────────────────────────
function homeHtml() {
  const wins = [["today", "Today"], ["7d", "7 days"], ["all", "All time"]];
  return `<div class="ag-home">
    <section class="ag-hero ag-load" id="agHero" aria-label="Agents right now"></section>
    <p class="ag-proof" id="agProof"></p>
    <div class="ag-row">
      <section class="ag-panel ag-tapep" aria-labelledby="agTapeH">
        <header class="ag-ph"><h2 id="agTapeH">Live tape</h2><span class="ag-live" id="agLive"></span>
          <button type="button" class="ag-tgl" data-act="skips" aria-pressed="${F.skips}" title="Skipped trades show the safety filters at work">${F.skips ? "Hide skips" : "Show skips"}</button></header>
        <div class="ag-tapew"><button type="button" class="ag-newn" id="agNewN" data-act="flush" hidden></button><ol class="ag-tape${F.skips ? "" : " ag-noskip"}" id="agTape"></ol></div>
      </section>
      <section class="ag-panel ag-smartp" aria-labelledby="agSmartH">
        <header class="ag-ph"><h2 id="agSmartH" title="Tokens the day's smart traders bought in the last 15 minutes">Smart money</h2><small id="agSmartM"></small></header>
        <div class="ag-smh" aria-hidden="true"><span>Token</span><span title="Smart wallets that bought">Wallets</span><span title="Price move since the first smart buy, and USD bought">Move</span></div>
        <div class="ag-smartl" id="agSmart"></div>
      </section>
    </div>
    <section class="ag-sec" id="agBoardS" aria-labelledby="agBoardH">
      <header class="ag-sh"><h2 id="agBoardH">Leaderboard</h2><div class="b-seg sm" role="tablist" aria-label="Window">${wins.map(([v, l]) => `<button type="button" role="tab" data-win="${v}" class="${H.win === v ? "on" : ""}" aria-selected="${H.win === v}">${l}</button>`).join("")}</div></header>
      <div id="agBoard"></div>
    </section>
    <section class="ag-sec" id="mkS" aria-labelledby="mkH">
      <header class="ag-sh"><h2 id="mkH">Marketplace</h2><span id="mkM"></span><div class="b-seg sm" role="tablist" aria-label="Sort listings">${MK_SORTS.map(([v, l]) => `<button type="button" role="tab" data-mksort="${v}" class="${MK.sort === v ? "on" : ""}" aria-selected="${MK.sort === v}">${l}</button>`).join("")}</div></header>
      <div id="mkList"></div>
    </section>
    <section class="ag-sec" id="agTplS" aria-labelledby="agTplH" hidden>
      <header class="ag-sh"><h2 id="agTplH">Templates</h2>${info("Paper agents with tested defaults. One click starts one; Edit opens it in the builder first. The number on each card is the server's replay of the template over recent days.")}</header>
      <div id="agTpl"></div>
    </section>
    <section class="ag-sec" id="agMineS" aria-labelledby="agMineH">
      <header class="ag-sh"><h2 id="agMineH">My agents</h2><small id="agMineN"></small>${info(`Up to ${MAX_BOTS} agents, kept on this browser's session. Paper only: nothing is sent.`)}<span class="ag-shb"><button type="button" class="b-btn sm" data-go="build">${ic("blocks")}Build</button><button type="button" class="b-btn sm" data-go="create">${ic("plus", 2.2)}New agent</button></span></header>
      <div id="bMine"></div>
    </section>
  </div>`;
}
function tickAgo() { root.querySelectorAll("time[data-at]").forEach((t) => { const s = t.dataset.c ? agoC(Number(t.dataset.at)) : agoS(Number(t.dataset.at)); if (t.textContent !== s) t.textContent = s; }); }
const mineIds = () => new Set((S.bots ?? []).map((b) => b.id));

// hero: four numbers that count when they change, and one line of proof
async function loadStats() {
  try { H.stats = await api("/v1/agents/stats"); H.statsErr = null; } catch (e) { H.statsErr = e.message; }
  if (S.screen === "home") paintKpis();
}
function paintKpis() {
  const el = $("agHero"); if (!el) return;
  if (!el.dataset.ready) {
    el.dataset.ready = "1";
    const sp = (k) => `<span class="ag-ksp" data-k="${k}"></span>`;
    el.innerHTML = `<div class="ag-kpi"><small><i class="ag-dot" aria-hidden="true"></i>Live</small><b><span data-k="live">—</span><em class="ag-ks" data-k="liveS" title="agents on the board"></em></b>${sp("liveSp")}</div>
      <div class="ag-kpi"><small title="Trades mirrored in the last 24 hours">Trades 24h</small><b><span data-k="trades">—</span></b>${sp("tradesSp")}<span class="ag-ksub" data-k="tradesS" title="skipped by safety filters">&nbsp;</span></div>
      <div class="ag-kpi"><small title="Paper PnL of all agents together, last 24 hours">PnL 24h</small><b><span data-k="pnl">—</span></b>${sp("pnlSp")}</div>
      <button type="button" class="ag-kpi ag-best" data-k="bestT" disabled><small>Best today</small><b><span data-k="best">—</span><em data-k="bestP"></em></b>${sp("bestSp")}</button>`;
  }
  const s = H.stats, k = (n) => el.querySelector(`[data-k="${n}"]`);
  if (s && s !== H.histOf) { H.histOf = s; keepStats(s); }
  paintHeroSparks();
  el.classList.toggle("ag-load", !s);
  if (s) {
    countUp(k("live"), s.live, int);
    k("liveS").textContent = `/${int(s.agents)}`;
    countUp(k("trades"), s.trades24h, int);
    k("tradesS").textContent = `${int(s.skips24h)} skipped`;
    const p = k("pnl"); p.className = cls(s.pnl24hUsd); countUp(p, s.pnl24hUsd, signed);
    const b = s.best && typeof s.best === "object" ? s.best : null, bp = N(b?.pnlUsd), inv = N(b?.investedUsd);
    const bv = k("best"); bv.className = cls(bp); countUp(bv, bp, signed);
    const pe = k("bestP"); pe.textContent = b && inv ? signedPct(bp / inv) : ""; pe.className = cls(bp);
    const bt = k("bestT");
    bt.title = b ? b.name || "Untitled agent" : "No trades yet today";
    bt.disabled = !b?.id;
    if (b?.id) { bt.dataset.open = b.id; if (mineIds().has(b.id)) delete bt.dataset.pub; else bt.dataset.pub = "1"; bt.setAttribute("aria-label", `Best agent today: ${b.name ?? ""}, open it`); }
  }
  paintProof();
}
// The hero's micro sparklines: the stats this browser has seen (a sample at most every 30 s, the last 24 h, kept in
// localStorage), and the best agent's own equity from the board.
const HIST_KEY = "ag_stats_hist_v1", DAY_MS = 864e5;
function readHist() {
  let h = []; try { h = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]"); } catch {}
  const now = Date.now();
  return Array.isArray(h) ? h.filter((y) => y && N(y.t) != null && now - y.t < DAY_MS) : [];
}
function keepStats(s) {
  let h = readHist();
  const now = Date.now(), x = { t: now, live: N(s.live), trades: N(s.trades24h), pnl: N(s.pnl24hUsd) };
  if (h.length && now - h[h.length - 1].t < 30_000) h[h.length - 1] = { ...x, t: h[h.length - 1].t }; else h.push(x);
  H.hist = h;
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-3000))); } catch {}
}
function microSpark(vals, signedColour) {
  const v = vals.map(N).filter((x) => x != null);
  if (v.length < 2) return `<svg class="ag-ms" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><line class="ag-z" x1="0" x2="100" y1="10" y2="10"/></svg>`;
  let lo = Math.min(...v), hi = Math.max(...v);
  if (lo === hi) { lo -= 1; hi += 1; }
  const X = (i) => (i / (v.length - 1)) * 100, Y = (x) => 2 + (1 - (x - lo) / (hi - lo)) * 16;
  const last = v[v.length - 1], col = signedColour ? (last > 0 ? "var(--hi)" : last < 0 ? "var(--bad)" : "var(--muted-fg)") : "var(--purple)";
  return `<svg class="ag-ms" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label="from ${esc(String(v[0]))} to ${esc(String(last))}"><path d="${v.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(2)},${Y(x).toFixed(2)}`).join("")}" style="stroke:${col}"/></svg>`;
}
const spanTxt = (ms) => (ms >= DAY_MS - 3600_000 ? "24h" : ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000) ? ` ${Math.floor((ms % 3600_000) / 60_000)}m` : ""}` : `${Math.max(1, Math.round(ms / 60_000))}m`);
function paintHeroSparks() {
  const el = $("agHero"); if (!el) return;
  const h = (H.hist ??= readHist()), span = h.length > 1 ? spanTxt(h[h.length - 1].t - h[0].t) : "";
  const put = (k, html, cap, title) => { const x = el.querySelector(`[data-k="${k}"]`); if (x) { x.innerHTML = html; x.title = cap ? `${title} (${cap})` : title; } };
  const seen = span ? `What this browser saw over the last ${span}` : "Fills in as this page stays open";
  put("liveSp", microSpark(h.map((x) => x.live), false), span, seen);
  put("tradesSp", microSpark(h.map((x) => x.trades), false), span, seen);
  put("pnlSp", microSpark(h.map((x) => x.pnl), true), span, seen);
  const best = H.stats?.best?.id ? (H.boards.today ?? []).find((b) => b.id === H.stats.best.id) : null;
  const eq = Array.isArray(best?.spark) ? best.spark : [];
  put("bestSp", microSpark(eq, true), eq.length > 1 ? "equity" : "", "The best agent's equity on the board");
}
/** the proof line: the fastest reaction today, and the latest real example from the tape */
function paintProof() {
  const pr = $("agProof"); if (!pr) return;
  const s = H.stats, f = N(s?.fastestReactionS);
  const ex = F.items.find((it) => it.kind === "fill" && N(it.reactionS) != null && it.trigger);
  const exTitle = ex ? `${symOf(ex.symbol, ex.mint)}, ${secs(ex.reactionS)} after ${String(ex.trigger).replace(/^followed wallet\s+/i, "")} · ${ex.agent.name || "Untitled agent"}` : "";
  const exHtml = ex ? `<button type="button" class="ag-pex" data-open="${esc(ex.agent.id)}"${mineIds().has(ex.agent.id) ? "" : ' data-pub="1"'} title="${esc(exTitle)}" aria-label="${esc(`Latest fill: ${exTitle}`)}"><span class="ag-bd ${ex.side === "sell" ? "sell" : "buy"}">${ex.side === "sell" ? "SELL" : "BUY"}</span><span class="ag-pext"><b>${esc(symOf(ex.symbol, ex.mint))}</b> <b class="ag-rx">${secs(ex.reactionS)}</b></span><span class="ag-pexa">${agoCTag(ex.at)}</span></button>` : "";
  pr.innerHTML = s ? `${f != null ? `<span class="ag-pf" title="Fastest reaction today: seconds from the followed wallet's trade to the agent's fill">Fastest <b>${secs(f)}</b></span>` : ""}${exHtml}<span class="ag-upd" title="Updated">${ic("clock")}${agoCTag(s.updatedAt ?? Date.now())}</span>${H.statsErr ? `<span class="b-warnt">${esc(H.statsErr)}</span>` : ""}`
    : H.statsErr ? `<span class="b-warnt">${esc(H.statsErr)}</span><button type="button" class="b-btn sm" data-act="retry-stats">Try again</button>` : "";
}

// live action tape: SSE /v1/agents/feed (backlog, then one item per action), newest on top, hover or touch pauses
const TAPE_MAX = 60;
const fkey = (i) => [i.at, i.agent?.id, i.kind, i.mint ?? "", i.side ?? "", i.usd ?? "", i.msg ?? ""].join("|");
/** a copy LP agent's "Could not read <wallet>'s LP events" is its own retry note (its log keeps it), not a public alert */
const quietEvent = (i) => i.kind === "event" && /^\s*could not read\b/i.test(String(i.msg ?? ""));
const okItem = (i) => !!i && typeof i === "object" && !!i.agent && typeof i.agent === "object" && ["fill", "skip", "event"].includes(i.kind) && !quietEvent(i);
const LIVE_TXT = { on: "Live", paused: "Paused", connecting: "Connecting…", retry: "Reconnecting…", off: "Offline" };
function paintLive() {
  const el = $("agLive"); if (!el) return;
  const st = F.paused && F.live === "on" ? "paused" : F.live;
  el.className = `ag-live ${st}`; el.textContent = LIVE_TXT[st];
}
function setFeedLive(s) { F.live = s; paintLive(); if (s === "on" && !F.items.length) paintTape(); }
function startFeed() { stopFeed(); const ctrl = new AbortController(); F.ctrl = ctrl; F.paused = false; F.pending = []; feedLoop(ctrl); }
function stopFeed() { F.ctrl?.abort(); F.ctrl = null; F.live = "off"; F.paused = false; }
async function feedLoop(ctrl) {
  let wait = 1000;
  while (!ctrl.signal.aborted) {
    setFeedLive(wait > 1000 ? "retry" : "connecting");
    let pause = 1000;
    // watchdog: no answer in 15 s, or nothing at all (the server pings every 20 s) for 45 s = a dead connection, reconnect
    const att = new AbortController(), cut = () => att.abort();
    ctrl.signal.addEventListener("abort", cut, { once: true });
    let dog = setTimeout(cut, 15_000);
    const pet = () => { clearTimeout(dog); dog = setTimeout(cut, 45_000); };
    try {
      const r = await fetch("/v1/agents/feed", { headers: { Accept: "text/event-stream" }, signal: att.signal });
      if (!r.ok || !r.body) throw new Error(String(r.status));
      setFeedLive("on"); wait = 1000; pet();
      await readSse(r.body, onFeed, pet); // the server closes the stream after ~30 min: reconnect in a second
    } catch {
      if (ctrl.signal.aborted) return;
      pause = wait; wait = Math.min(wait * 2, 30_000);
    } finally { clearTimeout(dog); ctrl.signal.removeEventListener("abort", cut); }
    if (ctrl.signal.aborted) return;
    setFeedLive("retry");
    await sleep(pause, ctrl.signal);
  }
}
function onFeed(ev, raw) {
  if (ev !== "backlog" && ev !== "item") return;
  let d; try { d = JSON.parse(raw); } catch { return; }
  if (ev === "backlog") {
    const list = rows(d).filter(okItem);
    addOld(list);
    if (!list.length && !F.items.length) seedTape(); // the server keeps its backlog in memory: right after a restart it is empty
    return;
  }
  if (!okItem(d)) return;
  const k = fkey(d); if (F.keys.has(k)) return;
  F.keys.add(k);
  if (F.paused) { F.pending.unshift(d); if (F.pending.length > 200) F.pending.length = 200; paintNewN(); return; }
  insertTape([d]);
}
/** older items (backlog, seed): merged by time, no animation */
function addOld(list) {
  for (const it of list) { const k = fkey(it); if (!F.keys.has(k)) { F.items.push(it); F.keys.add(k); } }
  F.items.sort((a, b) => (N(b.at) ?? 0) - (N(a.at) ?? 0));
  trimTape(); paintTape();
}
/** an empty backlog: the latest fills of the board's agents, mapped the way the server maps them for the feed */
let seeding = false;
async function seedTape() {
  if (seeding) return;
  seeding = true;
  try {
    const board = H.boards.today ?? rows((await api("/v1/agents/board?window=today")).agents);
    const top = board.filter((b) => b.id && N(b.stats?.trades) + N(b.stats?.skipped) > 0).slice(0, 6);
    const lists = await Promise.all(top.map((b) => api(`/v1/agents/public/${encodeURIComponent(b.id)}`).then((j) => rows(j.fills).slice(0, 30).map((f) => fillItem(f, j.bot ?? b))).catch(() => [])));
    if (S.screen === "home") addOld(lists.flat().filter(okItem));
  } catch {}
  seeding = false;
}
function fillItem(f, b) {
  const src = f.source && typeof f.source === "object" ? f.source : null, ts = toMs(f.ts), sts = toMs(src?.ts);
  const trigger = src?.wallet ? `followed wallet ${short(src.wallet)} ${src.side === "sell" ? "sold" : "bought"}${N(src.usd) ? ` $${Math.round(N(src.usd)).toLocaleString("en-US")}` : ""}` : null;
  return { at: ts, agent: { id: b.id, name: b.name, type: b.type }, kind: f.status === "filled" ? "fill" : "skip", side: f.side, symbol: f.symbol, mint: f.mint, usd: f.usd, pnlUsd: f.pnlUsd,
    reason: f.reason, trigger, reactionS: ts != null && sts != null && ts >= sts ? Math.round((ts - sts) / 100) / 10 : null };
}
function trimTape() { if (F.items.length > TAPE_MAX) F.items.length = TAPE_MAX; F.keys = new Set([...F.items, ...F.pending].map(fkey)); }
function insertTape(list) {
  for (const it of [...list].sort((a, b) => (N(a.at) ?? 0) - (N(b.at) ?? 0))) { // oldest first, so the newest lands on top
    F.items.unshift(it);
    F.fresh.add(fkey(it));
  }
  trimTape();
  paintTape();
}
function paintNewN() { const b = $("agNewN"); if (b) { const n = F.pending.length; b.hidden = !n; b.textContent = `${int(n)} new`; } paintLive(); }
function paintTape() {
  const el = $("agTape"); if (!el) return;
  paintNewN();
  if (!F.items.length) {
    el.innerHTML = F.live === "on" ? `<li class="ag-tnone">Waiting for the next action</li>`
      : `<li class="ag-tsk"><div class="b-skel"></div></li>`.repeat(6);
    return;
  }
  // BUY / SELL rows are the stars; a run of skips folds into one quiet line with its reasons counted (click to open it)
  const groups = [];
  for (const it of F.items) { if (it.kind === "skip" && Array.isArray(groups[groups.length - 1])) groups[groups.length - 1].push(it); else groups.push(it.kind === "skip" ? [it] : it); }
  const fresh = (it) => F.fresh.delete(fkey(it));
  const top = el.scrollTop;
  el.innerHTML = groups.map((g) => (!Array.isArray(g) ? tapeRow(g, fresh(g)) : g.length === 1 ? tapeRow(g[0], fresh(g[0])) : skipGroup(g, g.map(fresh).some(Boolean)))).join("");
  paintProof();
  el.scrollTop = top;
}
/** "liquidity $1,334 is below the bot's $20,000 minimum" → "liquidity under $20k": the check that said no, without the value */
const short$ = (x) => { const m = /^([\d.,]+)\s*([KMB])?$/i.exec(String(x).trim()); if (!m) return x; const n = Number(m[1].replace(/,/g, "")) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1); return !Number.isFinite(n) ? x : n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${n}`; };
function skipWhy(r) {
  const t = String(r ?? "").trim();
  const m = /^(liquidity|market cap|volume(?: 24h)?|fdv|holders)\b.*?(?:needs at least|below the (?:bot|agent)'s|minimum of|at least)\s*\$?(\d[\d.,]*(?:\s?[KMB](?![A-Za-z]))?)/i.exec(t);
  if (m) return `${m[1].toLowerCase()} under ${/holders/i.test(m[1]) ? "" : "$"}${short$(m[2])}`;
  if (/mint.authority/i.test(t)) return "mint authority";
  if (/freeze.authority/i.test(t)) return "freeze authority";
  if (/no jupiter quote|not tradable/i.test(t)) return "no Jupiter quote";
  return agentWords(t.replace(/^safety(?: unchecked)?:\s*/i, "").split(/[:(]|\s\$?\d/)[0].replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, (w) => w.replace(/Usd$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()).trim().slice(0, 32)) || "a filter";
}
/** the terse form for a table cell or a chip: "liq < $20k", "mcap < $50M" */
const terse = (w) => String(w).replace(/^liquidity\b/, "liq").replace(/^market cap\b/, "mcap").replace(/^volume(?: 24h)?\b/, "vol").replace(/ under /, " < ");
const skipShort = (r) => terse(skipWhy(r));
function skipGroup(g, fresh) {
  const k = fkey(g[g.length - 1]), open = F.open.has(k);
  const n = new Map(); for (const it of g) { const w = skipWhy(it.reason); n.set(w, (n.get(w) ?? 0) + 1); }
  const why = [...n].sort((a, b) => b[1] - a[1]), [w0, c0] = why[0];
  const all = why.map(([w, c]) => `${w} ×${c}`).join(", ");
  return `<li class="ag-skg${open ? " open" : ""}${fresh ? " ag-in" : ""}"><button type="button" class="ag-skb" data-act="skg" data-k="${esc(k)}" aria-expanded="${open}" title="${esc(`${int(g.length)} skipped by safety filters: ${all}`)}">
      <span class="ag-skn"><b>${int(g.length)}</b> skipped</span><span class="ag-skw">${esc(terse(w0))}<i>×${int(c0)}</i>${why.length > 1 ? `<i class="ag-skm">+${int(why.length - 1)}</i>` : ""}</span>
      <span class="ag-tt">${agoCTag(g[0].at)}</span><i class="ag-skc" aria-hidden="true">${svg("arrow", 2.2)}</i></button>
    ${open ? `<ol class="ag-skl">${g.map((it) => tapeRow(it, false)).join("")}</ol>` : ""}</li>`;
}
/** an event's message cut to its first clause (the full text is in the row's title) */
const brief = (m) => { const t = agentWords(m).trim(), c = t.split(/\.\s|;\s|\s\(/)[0]; return c.length > 34 ? `${c.slice(0, 32).replace(/\s+\S*$/, "")}…` : c; };
/** one line: badge · picture · token · size · reaction · PnL · age; the agent and what triggered it sit in the row's title */
function tapeRow(it, fresh) {
  const k = it.kind, sell = it.side === "sell", ev = k === "event", own = mineIds().has(it.agent.id);
  const bd = k === "skip" ? `<span class="ag-bd skip">SKIP</span>` : ev ? `<span class="ag-bd ${it.level === "error" ? "err" : "warn"}">${it.level === "error" ? "ERROR" : "NOTE"}</span>` : `<span class="ag-bd ${sell ? "sell" : "buy"}">${sell ? "SELL" : "BUY"}</span>`;
  const sym = ev ? null : symOf(it.symbol, it.mint);
  const logo = ev ? `<span class="tlogo b-tl ag-tev">${ic("alert")}</span>` : tokLogo(sym ?? "?", null, "", it.mint);
  const rx = N(it.reactionS), pnl = N(it.pnlUsd), name = it.agent.name || "Untitled agent";
  const what = k === "skip" ? `skipped: ${agentWords(it.reason || "a filter")}` : ev ? agentWords(it.msg) : it.trigger || (sell ? "closed the position" : "opened a position");
  const mid = ev ? `<span class="ag-tw">${esc(brief(it.msg))}</span>` : `<b class="ag-sym">${esc(sym)}</b>${k === "skip" ? `<span class="ag-tw">${esc(skipShort(it.reason))}</span>` : ""}`;
  const anim = fresh ? ` ag-in${k === "fill" ? (sell ? " ag-ins" : " ag-inb") : ""}` : "";
  return `<li class="ag-tr ${k}${anim}" data-open="${esc(it.agent.id)}"${own ? "" : ' data-pub="1"'} title="${esc(`${name} · ${what}`)}">
    ${av(it.agent, 20)}${bd}${logo}
    <span class="ag-t1">${mid}</span>
    <span class="ag-tu">${ev || N(it.usd) == null ? "" : usd(it.usd)}</span>
    <span class="ag-rx">${k === "fill" && rx != null ? secs(rx) : ""}</span>
    <span class="ag-tp ${cls(pnl)}">${k === "fill" && pnl != null ? signed(pnl) : ""}</span>
    <span class="ag-tt">${agoCTag(it.at)}</span>
  </li>`;
}
function onTapeHover(e) {
  if (e.pointerType !== "mouse") return;
  const w = e.target.closest?.(".ag-tapew"); if (!w) return;
  if (e.type === "pointerover") pauseTape(false);
  else if (!w.contains(e.relatedTarget)) resumeTape();
}
function pauseTape(touch) { if (F.paused) return; F.paused = true; F.touch = touch; paintLive(); }
function resumeTape() {
  if (!F.paused) return;
  F.paused = false; F.touch = false;
  const p = F.pending; F.pending = [];
  if (p.length) insertTape(p);
  const el = $("agTape"); if (el) el.scrollTop = 0;
  paintNewN();
}

// smart money right now: tokens the day's smart traders bought in the last 15 minutes
async function loadSmart() {
  try { const j = await api("/v1/agents/smart-now"); H.smartPrev = H.smart; H.smart = j; H.smartErr = null; } catch (e) { H.smartErr = e.message; }
  if (S.screen === "home") paintSmart();
}
function paintSmart() {
  const el = $("agSmart"), m = $("agSmartM"); if (!el) return;
  const d = H.smart;
  if (m) m.innerHTML = d ? `<span title="Window">${int(d.windowMin ?? 15)}m</span> · ${agoCTag(d.updatedAt ?? Date.now())}` : "15m";
  if (!d) { el.innerHTML = H.smartErr ? `<div class="ag-pad">${errBox(H.smartErr, "retry-smart")}</div>` : `<div class="ag-skr"><div class="b-skel"></div></div>`.repeat(5); return; }
  const toks = rows(d.tokens).filter((t) => typeof t.mint === "string" && B58.test(t.mint));
  if (!toks.length) { el.innerHTML = `<div class="ag-none" title="Rechecked every 30 seconds">No smart buys in ${int(d.windowMin ?? 15)}m</div>`; return; }
  const fresh = H.smartShown !== d; H.smartShown = d;
  const prev = fresh && H.smartPrev ? new Map(rows(H.smartPrev.tokens).map((t) => [t.mint, t])) : null;
  el.innerHTML = toks.map((t) => smartRow(t, prev ? prev.get(t.mint) ?? null : undefined)).join("") + (H.smartErr ? `<p class="b-warnt ag-pad">${esc(H.smartErr)}</p>` : "");
}
/** p: the same token in the previous answer (undefined = nothing to compare, null = a token that just showed up) */
function smartRow(t, p) {
  const label = t.symbol ? String(t.symbol) : short(t.mint), mv = N(t.movePct), w = N(t.wallets);
  const wf = p && N(p.wallets) != null && N(p.wallets) !== w ? (w > N(p.wallets) ? "ag-fu" : "ag-fd") : "";
  return `<div class="ag-sm${p === null ? " ag-in" : ""}">
    ${tokLogo(label, imgOf(t), "ag-lg", t.mint)}
    <span class="ag-smn"><a href="${SOLSCAN.token}${encodeURIComponent(t.mint)}" target="_blank" rel="noopener" title="${esc(`${label} · ${t.mint}`)}"><b class="${t.symbol ? "" : "mono"}">${esc(label)}</b></a><small title="Since the first smart buy">${agoCTag(t.firstBuyAt)}</small></span>
    <span class="ag-smw" title="${esc(plural(w, "smart wallet"))}"><b class="${wf}">${int(w)}</b></span>
    <span class="ag-smv" title="Price move since the first smart buy · USD bought"><b class="${cls(mv)}">${pctPts(mv)}</b><small>${usd(t.usdIn)}</small></span>
    <button type="button" class="b-btn sm ag-launch" data-smart="${esc(t.mint)}" aria-label="Launch an agent on ${esc(label)}" title="Launch an agent on ${esc(label)}">${ic("plus", 2.2)}</button>
  </div>`;
}
/** Strategy v1 has no per-token narrowing for a confluence trigger: an agent on one token is a price trigger on that mint, with the
 *  confluence template's filters, size, exits and limits, and the smart buyers kept as a filter. */
function smartStrategy(t) {
  const label = t.symbol ? String(t.symbol) : short(t.mint);
  const w = Math.min(3, Math.max(1, Math.round(N(t.wallets) ?? 1)));
  return {
    version: 1, name: `Smart money on ${label}`.slice(0, 40),
    description: `${plural(t.wallets, "smart trader")} bought ${label} in the last ${int(H.smart?.windowMin ?? 15)} minutes. Buys when it rises 5% within 15 minutes while smart buyers are still in.`.slice(0, 500),
    trigger: { type: "price", mint: t.mint, op: "change_pct", value: 5, windowMin: 15 },
    filters: [{ field: "smartBuyers1h", op: ">=", value: w }, { field: "liquidityUsd", op: ">=", value: 30000 }, { safety: "no_mint_authority" }, { safety: "no_freeze_authority" }],
    action: { type: "buy", usd: 20 },
    exits: { takeProfitPct: 100, stopLossPct: 30, trailingPct: 25, maxHoldMin: 1440 },
    limits: { maxOpenPositions: 5, dailyBudgetUsd: 100 },
  };
}

// leaderboard: /v1/agents/board?window=…, rank moves kept per window in sessionStorage
const WIN_LABEL = { today: "Today", "7d": "7 days", all: "All time" };
async function loadLb() {
  const w = H.win;
  try { const j = await api(`/v1/agents/board?window=${encodeURIComponent(w)}`); const list = rows(j.agents).filter((b) => typeof b.id === "string"); H.boards[w] = list; H.boardErr = null; trackRanks(w, list); }
  catch (e) { H.boardErr = e.message; }
  if (S.screen === "home" && H.win === w) paintLb();
  if (S.screen === "home" && w === "today") paintHeroSparks();
}
function trackRanks(w, list) {
  const key = `ag_rank_${w}`, order = list.map((b) => b.id);
  let prev = null; try { prev = JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch {}
  let moves = prev && typeof prev.moves === "object" && prev.moves ? prev.moves : {};
  if (Array.isArray(prev?.order) && prev.order.join() !== order.join()) { // the order changed: moves are against the last different order
    moves = {};
    const was = new Map(prev.order.map((id, i) => [id, i]));
    order.forEach((id, i) => { const p = was.get(id); moves[id] = p == null ? "new" : p - i; });
  }
  H.moves[w] = moves;
  try { sessionStorage.setItem(key, JSON.stringify({ order, moves })); } catch {}
}
function paintLb() {
  const el = $("agBoard"); if (!el) return;
  root.querySelectorAll("[data-win]").forEach((b) => { const on = b.dataset.win === H.win; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  const list = H.boards[H.win];
  if (!list) { el.innerHTML = H.boardErr ? errBox(H.boardErr, "retry-lb") : `<div class="ag-lb">${`<div class="ag-skr"><div class="b-skel"></div></div>`.repeat(5)}</div>`; return; }
  if (!list.length) { el.innerHTML = `<div class="b-none">No agents on the board yet</div>`; return; }
  const mine = mineIds(), all = H.win === "all";
  // a phone shows the top 10 (the page stays short), "Show all" opens the rest
  const cut = narrow() && !H.lbAll && list.length > LB_PHONE ? LB_PHONE : list.length, rest = list.slice(3, cut);
  const more = narrow() && list.length > LB_PHONE ? `<button type="button" class="b-more" data-act="lb-all" aria-expanded="${!!H.lbAll}">${H.lbAll ? `Top ${LB_PHONE}` : `Show all ${int(list.length)}`}</button>` : "";
  // the top three as podium cards, the rest a tight table
  el.innerHTML = `<div class="ag-pod">${list.slice(0, 3).map((b, i) => podCard(b, i, mine.has(b.id))).join("")}</div>
    ${rest.length ? `<div class="ag-lb ag-lbr"><div class="ag-lh"><span>#</span><span>Agent</span><span class="b-n" title="PnL ${esc(WIN_LABEL[H.win].toLowerCase())}">PnL</span><span class="b-n">${all ? "Realized" : "All-time"}</span><span>Equity</span><span class="b-n">Win</span><span class="b-n">Trades</span><span class="b-n">Copies</span><span></span></div>
    ${rest.map((b, i) => lbRow(b, i + 3, mine.has(b.id))).join("")}${more}</div>` : ""}${H.boardErr ? `<p class="b-warnt">${esc(H.boardErr)}</p>` : ""}`;
}
const LB_PHONE = 10;
/** the home column is phone-wide (the same 640 px the layout's container queries use) */
const narrow = () => (root.querySelector(".ag-home")?.clientWidth || root.clientWidth || innerWidth) <= 640;
const rankMove = (mv) => (mv === "new" ? `<i class="ag-mv new">NEW</i>` : N(mv) > 0 ? `<i class="ag-mv up" title="Up ${mv} since the last update">▲${mv}</i>` : N(mv) < 0 ? `<i class="ag-mv down" title="Down ${-mv} since the last update">▼${-mv}</i>` : "");
/** the board's PnL flashes green / red when it moved since the last paint */
function pnlFlash(b) {
  const pnl = N(b.pnl), pk = `lb:${H.win}:${b.id}`, was = H.prev.get(pk);
  H.prev.set(pk, pnl);
  return was != null && pnl != null && Math.abs(was - pnl) >= 0.005 ? (pnl > was ? " ag-fu" : " ag-fd") : "";
}
const tplChips = (b) => `${b.type === "lp" ? `<em class="ag-chip lp">LP</em>` : ""}${b.template && !(b.type === "lp" && /^lp( agent)?$/i.test(String(b.template).trim())) ? `<em class="ag-chip">${esc(b.template)}</em>` : b.type === "lp" ? "" : `<em class="ag-chip">${esc(typeShort(b))}</em>`}`;
const metaOf = (b) => [isLpCopy(b) ? lpCopySub(b) : b.template || typeShort(b), b.mode === "live" ? "Live" : "Paper", `${age(b.createdAt)} old`, b.status === "running" ? "" : STATUS[b.status] ?? b.status].filter(Boolean).join(" · ");
const stChips = (b) => `${b.mode === "live" ? `<em class="ag-chip live">LIVE</em>` : ""}${b.status && b.status !== "running" ? `<em class="ag-chip st">${esc(STATUS[b.status] ?? b.status)}</em>` : ""}`;
function podCard(b, i, own) {
  const st = b.stats ?? {}, all = H.win === "all", pnl = N(b.pnl), second = all ? N(st.realizedUsd) : N(b.pnlAll), fl = pnlFlash(b);
  return `<article class="ag-pc r${i + 1}" role="button" tabindex="0" data-open="${esc(b.id)}"${own ? "" : ' data-pub="1"'} aria-label="${esc(`Rank ${i + 1}: ${b.name || "Untitled agent"}`)}">
    <header class="ag-pch"><span class="ag-prk">${i + 1}</span>${rankMove(H.moves[H.win]?.[b.id])}${av(b, 40)}<span class="ag-pcs">${tplChips(b)}</span></header>
    <b class="ag-pnm" title="${esc(`${b.name || "Untitled agent"} · ${metaOf(b)}`)}">${esc(b.name || "Untitled agent")}${own ? ` <em class="b-you">YOU</em>` : ""}</b>
    <small class="ag-pmt"><span title="Age">${esc(age(b.createdAt))}</span>${stChips(b)}</small>
    <div class="ag-pv"><span class="ag-pbig ${cls(pnl)}"><span class="ag-fv${fl}">${signed(pnl)}</span></span><small>PnL</small></div>
    <span class="ag-psp">${sparkSvg(b.spark, true)}</span>
    <div class="ag-pst"><span><small>Win</small><b>${pct(st.winRate)}</b></span><span><small>Trades</small><b>${int(st.trades)}</b></span><span><small>${all ? "Realized" : "All-time"}</small><b class="${cls(second)}">${signed(second)}</b></span><span><small>Copies</small><b>${int(b.copies)}</b></span></div>
    ${own ? `<span class="ag-pyou">${ic("check")}Yours</span>` : `<button type="button" class="b-btn sm ag-copy" data-copy="${esc(b.id)}" title="Copy this agent">${ic("copy")}Copy</button>`}
  </article>`;
}
function lbRow(b, i, own) {
  const st = b.stats ?? {}, mv = H.moves[H.win]?.[b.id], all = H.win === "all";
  const arrow = rankMove(mv);
  const pnl = N(b.pnl), second = all ? N(st.realizedUsd) : N(b.pnlAll), fl = pnlFlash(b);
  return `<div class="ag-lr${i < 3 ? " top" : ""}" role="button" tabindex="0" data-open="${esc(b.id)}"${own ? "" : ' data-pub="1"'} aria-label="${esc(`Rank ${i + 1}: ${b.name || "Untitled agent"}`)}">
    <span class="ag-rk"><b>${i + 1}</b>${arrow}</span>
    <span class="ag-ln" title="${esc(`${b.name || "Untitled agent"} · ${metaOf(b)}`)}">${av(b, narrow() ? 24 : 32)}<b><span>${esc(b.name || "Untitled agent")}</span>${b.type === "lp" ? `<em class="ag-chip lp">LP</em>` : ""}${stChips(b)}${own ? `<em class="b-you">YOU</em>` : ""}<small class="ag-age">${esc(age(b.createdAt))}</small></b></span>
    <span class="b-n ag-pw ${cls(pnl)}" data-k="PnL"><span class="ag-fv${fl}">${signed(pnl)}</span></span>
    <span class="ag-xs"><span class="b-n ag-pa ${cls(second)}" data-k="${all ? "Realized" : "All-time"}">${signed(second)}</span><span class="b-n ag-x" data-k="Win">${pct(st.winRate)}</span><span class="b-n ag-x" data-k="Trades">${int(st.trades)}</span><span class="b-n ag-x" data-k="Copies">${int(b.copies)}</span></span>
    <span class="ag-sp">${sparkSvg(b.spark, i < 3)}</span>
    <span class="ag-cp">${own ? "" : `<button type="button" class="b-btn sm ag-copy ag-icb" data-copy="${esc(b.id)}" title="Copy this agent" aria-label="${esc(`Copy ${b.name || "this agent"}`)}">${ic("copy")}</button>`}</span>
  </div>`;
}
function sparkSvg(a, big) {
  const v = (Array.isArray(a) ? a : []).map(N).filter((x) => x != null);
  if (v.length < 2) return `<span class="ag-spn">—</span>`;
  let lo = Math.min(...v, 0), hi = Math.max(...v, 0);
  if (lo === hi) { lo -= 1; hi += 1; }
  const W = 100, Ht = 30, X = (i) => (i / (v.length - 1)) * W, Y = (x) => 2 + (1 - (x - lo) / (hi - lo)) * (Ht - 4);
  const d = v.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(2)},${Y(x).toFixed(2)}`).join("");
  const last = v[v.length - 1], col = last > 0 ? "var(--hi)" : last < 0 ? "var(--bad)" : "var(--muted-fg)";
  return `<svg class="ag-spk${big ? " lg" : ""}" viewBox="0 0 ${W} ${Ht}" preserveAspectRatio="none" role="img" aria-label="Equity ${signed(v[0])} to ${signed(last)}"><line class="ag-z" x1="0" x2="${W}" y1="${Y(0).toFixed(2)}" y2="${Y(0).toFixed(2)}"/><path d="${d}" style="stroke:${col}"/></svg>`;
}
/** names stop at 40 characters: cut at a word, not inside one */
function copyName(n) {
  const full = `Copy of ${String(n).trim()}`;
  if (full.length <= 40) return full;
  const cut = full.slice(0, 39);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24)).replace(/[\s·,.-]+$/, "")}…`;
}
/** Copy an agent: free ones (and free listings) at once; a priced listing answers 402 and the terms open (openPay). */
async function copyAgent(id, btn, title) {
  if (!id || btn?.disabled) return;
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = btn.classList.contains("ag-icb") ? ic("spin") : `${ic("spin")}Copying…`; }
  const restore = () => { if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = label; } };
  try {
    const src = Object.values(H.boards).flat().find((b) => b?.id === id);
    const lst = Object.values(MK.lists).flat().find((l) => l?.id === id);
    const n = title ?? lst?.title ?? src?.name ?? null, name = n ? copyName(n) : null;
    const r = await apiRaw(`/v1/agents/${encodeURIComponent(id)}/copy`, { method: "POST", body: name ? { name } : {} });
    if (r.status === 402 && r.json?.x402Version) { restore(); return openPay(id, r.json, name, btn); }
    if (!r.ok) throw new Error(errText(r.status, r.json));
    copied(r.json, "Copied. It runs on paper in My agents now.");
  } catch (e) {
    toast(e.message);
    restore();
  }
}
function copied(j, msg) {
  const bot = j?.bot ?? j;
  if (!bot?.id) throw new Error("The copy was made but the answer had no id. Check My agents.");
  S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)];
  MK.lists = {}; // its copies (and sales) moved
  toast(msg);
  go("detail", { id: bot.id });
}

// launch in 10 seconds: the template gallery (/v1/agents/templates, else the builder's /v1/strategies/templates; neither = hidden)
const TICON = { confluence: "users", wallet_trade: "copy", new_token: "flag", price: "chart", schedule: "clock", lp_event: "drop" };
async function loadTpls() {
  if (H.tpls !== undefined && Date.now() - H.tplAt < 300_000) return paintTpls();
  let list = null;
  for (const p of ["/v1/agents/templates", "/v1/strategies/templates"]) {
    try { const j = await api(p); list = rows(Array.isArray(j) ? j : j?.templates).filter((x) => x.strategy && typeof x.strategy === "object" && !Array.isArray(x.strategy)); break; } catch {}
  }
  H.tpls = list?.length ? list : null; H.tplAt = Date.now();
  if (S.screen === "home") paintTpls();
}
/** a replay's window as it really ran: the new-token board keeps 24 h, so a 3-day replay covers the last 24 h */
const replayTag = (days, coveredH) => { const ch = N(coveredH); return ch != null && N(days) != null && ch < N(days) * 24 ? `replay · last ${ch % 24 === 0 ? dayTag(ch / 24) : `${int(ch)}h`}` : `replay ${dayTag(days)}`; };
/** "13/20 wallets read" when the replay could not read every followed wallet (the unread ones in the title) */
function walletsReadChip(x) {
  const un = Array.isArray(x?.unreadWallets) ? x.unreadWallets.filter((w) => typeof w === "string") : [], rd = N(x?.walletsRead);
  if (!un.length || rd == null) return "";
  return `<em class="ag-chip ag-wr" title="${esc(`Not read in this replay: ${un.join(", ")}`)}">${int(rd)}/${int(rd + un.length)} wallets read</em>`;
}
function paintTpls() {
  const s = $("agTplS"), el = $("agTpl"); if (!s || !el) return;
  s.hidden = !H.tpls;
  if (H.tpls) el.innerHTML = `<div class="ag-tpls">${H.tpls.map(tplCard).join("")}</div>`;
}
function tplCard(t, i) {
  const st = t.strategy, id = String(t.id ?? i), icon = TICON[st?.trigger?.type] ?? "blocks", run = N(t.running), hl = t.headline && typeof t.headline === "object" ? t.headline : null;
  const size = st?.action?.type === "buy" ? N(st.action.usd) : null, title = t.title ?? st.name ?? "Template";
  let wr = N(hl?.winRate); if (wr != null && wr > 1) wr /= 100;
  // the server's replay of the template: PnL on its trade size, or the number of alerts for an alert-only template
  const rp = hl ? `<em class="ag-rp" title="${esc(N(hl.coveredHours) != null && N(hl.coveredHours) < N(hl.days) * 24 ? `The server's replay of this template: ${daysLabel(hl.days)} asked, the last ${int(hl.coveredHours)} hours covered` : `The server's replay of this template over the last ${daysLabel(hl.days)}`)}">${esc(replayTag(hl.days, hl.coveredHours))}</em>${walletsReadChip(hl)}` : "";
  const hlTxt = !hl ? "" : !["buy", "sell"].includes(st?.action?.type) ? `<b>${int(hl.signals ?? hl.trades)}</b> ${N(hl.signals ?? hl.trades) === 1 ? "alert" : "alerts"}${rp}`
    : !N(hl.trades) ? `<b>0</b> trades${rp}`
    : `<b class="${cls(hl.pnlUsd)}">${signed(hl.pnlUsd)}</b>${rp}<span class="ag-thm">${wr != null ? `${pct(wr)} win · ` : ""}${size ? `${Number.isInteger(size) ? `$${size.toLocaleString("en-US")}` : usd(size)}/trade` : plural(hl.trades, "trade")}</span>`;
  const line = t.oneLine ?? t.line ?? st.description ?? "";
  const notes = `${line ? `<p>${esc(line)}</p>` : ""}${t.risk ? `<p class="ag-ipr">${ic("alert")}<span>${esc(t.risk)}</span></p>` : ""}`;
  return `<div class="ag-tc">
    <div class="ag-tch"><span class="bb-tic">${ic(icon)}</span><b title="${esc(title)}">${esc(title)}</b>${t.risk ? `<i class="ag-trf" title="${esc(`Risk: ${t.risk}`)}" aria-hidden="true">${ic("alert")}</i>` : ""}${run ? `<span class="ag-run" title="${esc(`${int(run)} running`)}"><i aria-hidden="true"></i>${int(run)}</span>` : ""}${info(notes, `About ${title}`)}</div>
    ${hl ? `<p class="ag-thl">${hlTxt}</p>` : ""}
    <div class="ag-tcf"><button type="button" class="b-btn ag-go" data-tstart="${esc(id)}" title="Start a paper agent with these defaults">${ic("play")}Start</button><button type="button" class="b-btn" data-tbuild="${esc(id)}" title="Open in the builder">${ic("blocks")}Edit</button></div>
  </div>`;
}
const tplOf = (id) => (H.tpls ?? []).find((t, i) => String(t.id ?? i) === id) ?? null;
async function startTpl(id, btn) {
  const t = tplOf(id); if (!t || btn?.disabled) return;
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `${ic("spin")}Starting…`; }
  try {
    // templateId: the gallery's "N running" counts the agents started from it
    const params = { strategy: t.strategy, ...(t.id != null ? { templateId: String(t.id) } : {}) };
    const j = await api("/v1/agents", { method: "POST", body: { type: "custom", name: String(t.title ?? t.strategy.name ?? "Agent").slice(0, 40), mode: "paper", params } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)];
    toast(`${bot.name || "Your agent"} runs on paper now.`);
    go("detail", { id: bot.id });
  } catch (e) {
    toast(e.message);
    if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// ── Marketplace: listed agents (/v1/agents/market); copy free in one click, or pay in USDC (x402) from the person's wallet ──
const MK_SORTS = [["pnl", "Top PnL"], ["copies", "Most copied"], ["new", "New"]];
const MK = { sort: "pnl", lists: {}, err: null, ready: null, pay: null, payTimer: null, paySig: "" };
const usdcAmt = (x) => { const n = N(x) ?? 0; return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }); };
const priceTxt = (p) => (N(p) > 0 ? `$${usdcAmt(p)} USDC` : "Free");
const shareTxt = (p) => (N(p) > 0 ? `${+N(p).toFixed(2)}% share` : "No share");
const copiesTxt = (n) => `${int(n)} ${N(n) === 1 ? "copy" : "copies"}`;
const earnTxt = (e) => (e && typeof e === "object" ? `<span title="${esc(`Earned on paper from ${copiesTxt(e.fromCopies)}`)}">Earned <b>${usd(N(e.paperUsd) ?? 0)}</b> ${PAPER}</span>` : "");
async function loadMarket() {
  const s = MK.sort;
  try { const j = await api(`/v1/agents/market?sort=${encodeURIComponent(s)}`); MK.lists[s] = rows(j.listings).filter((l) => typeof l.id === "string"); MK.ready = j.nownodes?.ready ?? null; MK.err = null; }
  catch (e) { MK.err = e.message; }
  if (S.screen === "home" && MK.sort === s) paintMarket();
}
function paintMarket() {
  const el = $("mkList"); if (!el) return;
  root.querySelectorAll("[data-mksort]").forEach((b) => { const on = b.dataset.mksort === MK.sort; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  const m = $("mkM");
  if (m) m.innerHTML = MK.ready === false ? `<em class="ag-chip" title="Paid copies are verified through NOWNodes, whose key is not set on this server yet">Free only</em>${info("Paid copies are verified through NOWNodes, whose key is not set on this server yet: free copies only for now.")}`
    : info("Paid copies settle in USDC on Solana, verified through NOWNodes. Profit shares are paper: tracked, never charged.");
  const list = MK.lists[MK.sort];
  if (!list) { el.innerHTML = MK.err ? errBox(MK.err, "mk-retry") : `<div class="mk-grid">${`<div class="mk-c mk-sk"><div class="b-skel" style="height:34px;width:70%"></div><div class="b-skel" style="height:40px"></div><div class="b-skel" style="height:44px"></div></div>`.repeat(3)}</div>`; return; }
  if (!list.length) { el.innerHTML = `<div class="b-none" title="Open one of your agents after its first hour of live history and publish it, free or priced in USDC.">Nothing listed yet</div>`; return; }
  el.innerHTML = `<div class="mk-grid">${list.map(mkCard).join("")}</div>${MK.err ? `<p class="b-warnt">${esc(MK.err)}</p>` : ""}`;
}
/** the listing's own 3-day replay at publish (refreshed hourly) */
function hlTxt(l) {
  const h = l.headline && typeof l.headline === "object" ? l.headline : null, lp = l.agent?.type === "lp";
  const tag = `<em class="ag-rp" title="${esc(`The listing's own replay over the last ${daysLabel(h?.days ?? 3)}, refreshed hourly`)}">replay ${esc(h ? dayTag(h.days) : "3d")}</em>`;
  if (!h) return `${tag}<span class="mk-dim">pending</span>`;
  if (!N(h.trades)) return `${tag}<span class="mk-dim">0 ${lp ? "moves" : "trades"}</span>`;
  let wr = N(h.winRate); if (wr != null && wr > 1) wr /= 100;
  return `${tag}<b class="${cls(h.pnlUsd)}">${signed(h.pnlUsd)}</b> <span title="invested">/ ${usd(h.investedUsd)}</span> · ${plural(h.trades, lp ? "move" : "trade")}${wr != null ? ` · ${pct(wr)} win` : ""}`;
}
function mkCard(l) {
  const a = l.agent && typeof l.agent === "object" ? l.agent : {}, mine = l.mine === true || mineIds().has(l.id), priced = N(l.priceUsdc) > 0, pnl = N(l.pnlUsd);
  return `<article class="mk-c${mine ? " mine" : ""}" role="button" tabindex="0" data-open="${esc(l.id)}"${mine ? "" : ' data-pub="1"'} aria-label="${esc(`${l.title}, open the agent`)}">
    <div class="mk-ch">${av(a, 40)}
      <span class="mk-cn"><b title="${esc(`${l.title}${l.pitch ? ` · ${l.pitch}` : ""}`)}">${esc(l.title)}</b><small title="${esc(`by ${l.creator ?? l.payTo} · ${a.template || typeShort(a)} · ${age(a.createdAt)} live`)}"><span class="mono">${esc(l.creator ?? short(l.payTo))}</span> · ${esc(age(a.createdAt))}</small></span>
      <span class="mk-px${priced ? "" : " free"}">${priceTxt(l.priceUsdc)}</span></div>
    <div class="mk-pl"><span class="mk-pv"><small>PnL ${PAPER}</small><b class="${cls(pnl)}">${signed(pnl)}</b></span>${sparkSvg(l.spark, true)}</div>
    <p class="mk-hl">${hlTxt(l)}</p>
    <div class="mk-tm"><span>${copiesTxt(l.copies)}</span><span${N(l.profitSharePct) > 0 ? ' class="mk-share" title="Of profitable closes, paper"' : ""}>${shareTxt(l.profitSharePct)}</span>${a.status && a.status !== "running" ? `<span>${esc(STATUS[a.status] ?? a.status)}</span>` : ""}</div>
    ${N(l.profitSharePct) > 0 ? `<p class="mk-earn">${earnTxt(l.earnings)}</p>` : ""}
    <div class="mk-cf">${mine ? `<span class="mk-you">${ic("check")}Yours</span>` : `<button type="button" class="b-btn ag-go mk-copy" data-mkcopy="${esc(l.id)}">${ic("copy")}${priced ? `Copy · ${priceTxt(l.priceUsdc)}` : "Copy free"}</button>`}</div>
  </article>`;
}

// x402: the 402 answer's terms → the person's Solana wallet pays (server-prepared USDC transfer, signed here, relayed through
// NOWNodes, the same path the Trade view uses) → the copy is repeated with X-PAYMENT until NOWNodes sees the payment confirmed
const WEB3 = "https://esm.sh/@solana/web3.js@1.98.0?bundle";
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const cancelled = (e) => e?.code === 4001 || /user rejected|rejected the request|denied|exited|cancel/i.test(e?.message ?? "");
const PV = () => window.askPrivy?.state ?? null;
const solExts = () => [["Phantom", window.phantom?.solana], ["Solflare", window.solflare], ["Backpack", window.backpack]].filter(([, p]) => p && typeof p.signTransaction === "function");
/** what can pay right now: the Chord account's Solana wallet, then browser extensions (connected or not yet) */
function payWallets() {
  const out = [], pv = PV();
  if (pv?.authenticated && pv.sol) out.push({ id: "privy", label: "Chord wallet", addr: pv.sol });
  for (const [name, p] of solExts()) out.push({ id: name, label: name, prov: p, addr: p.isConnected === false ? null : p.publicKey?.toString?.() ?? null });
  return out;
}
const txLink = (sig) => `<a href="${SOLSCAN.tx}${encodeURIComponent(sig)}" target="_blank" rel="noopener">${esc(short(sig, 6, 6))} ↗</a>`;
function openPay(id, body, name, back) {
  const t = body.terms && typeof body.terms === "object" ? body.terms : {}, acc = rows(body.accepts)[0] ?? {};
  const units = N(acc.maxAmountRequired), dec = N(acc.extra?.decimals) ?? 6;
  closePay(true);
  MK.pay = { id, name, back: back ?? document.activeElement, title: t.title ?? "this agent", price: N(t.priceUsdc) ?? (units != null ? units / 10 ** dec : null), share: N(t.profitSharePct) ?? 0,
    payTo: String(t.payTo ?? acc.payTo ?? ""), ready: body.nownodes?.ready !== false, lane: body.nownodes?.message ?? null, wallet: null, steps: [], cur: null, busy: false, sig: null, done: false };
  let el = $("mkDlg");
  if (!el) { el = document.createElement("div"); el.id = "mkDlg"; el.className = "mk-ov"; root.append(el); }
  el.hidden = false;
  MK.paySig = "";
  paintPay();
  requestAnimationFrame(() => el.querySelector('[data-mk="pay"]:not(:disabled),[data-mk="signin"]:not(:disabled),[data-mk="create"],[data-mk="close"]')?.focus());
  clearInterval(MK.payTimer); // a sign-in, a new Solana wallet or an unlocked extension shows up here without a click
  MK.payTimer = setInterval(() => { if (MK.pay && !MK.pay.busy) paintPayFoot(); }, 1500);
}
function closePay(quiet) {
  const P = MK.pay;
  if (P?.busy && !quiet) return;
  clearInterval(MK.payTimer); MK.payTimer = null;
  MK.pay = null;
  const el = $("mkDlg"); if (el) { el.hidden = true; el.innerHTML = ""; }
  if (!quiet && P?.back?.isConnected) P.back.focus();
}
const stepHtml = (s) => `<li class="${s.state}">${ic(s.state === "done" ? "check" : s.state === "bad" ? "alert" : "spin")}<span>${s.html}</span></li>`;
function paintSteps() { const el = $("mkSteps"), P = MK.pay; if (el && P) { el.innerHTML = P.steps.map(stepHtml).join(""); el.hidden = !P.steps.length; } }
function payStep(P, html) {
  const s = { state: "now", html };
  P.steps.push(s); P.cur = s; paintSteps();
  return { done: (h) => { s.state = "done"; if (h) s.html = h; if (P.cur === s) P.cur = null; paintSteps(); } };
}
function paintPay() {
  const el = $("mkDlg"), P = MK.pay; if (!el || !P) return;
  const to = P.payTo ? `<a class="mono" href="${SOLSCAN.acct}${encodeURIComponent(P.payTo)}" target="_blank" rel="noopener" title="${esc(P.payTo)}">${esc(short(P.payTo))}</a>` : "—";
  el.innerHTML = `<div class="mk-dlg" role="dialog" aria-modal="true" aria-labelledby="mkDlgH">
    <header class="mk-dh"><div><small>Copy</small><h2 id="mkDlgH">${esc(P.title)}</h2></div><button type="button" class="mk-x" data-mk="close" aria-label="Close"${P.busy ? " disabled" : ""}>${ic("x")}</button></header>
    <div class="mk-rc" aria-label="Terms">
      <div class="mk-rl"><span>Agent</span><b>${esc(P.title)}</b></div>
      <div class="mk-rl"><span>Paid to</span><b>${to}</b></div>
      <div class="mk-rl"><span>Network</span><b>Solana · USDC · x402</b></div>
      <div class="mk-rl"><span>Profit share</span><b>${P.share > 0 ? `${+P.share.toFixed(2)}% ${PAPER}` : "None"}</b></div>
      <div class="mk-rt"><span>Total, once</span><b>${priceTxt(P.price)}</b></div>
    </div>
    <details class="ag-notes mk-rn"><summary>Terms</summary><ul>
      <li>You get a paper copy in My agents, running from the moment the payment is verified.</li>
      <li>NOWNodes reads the payment on Solana. One payment buys one copy, within 15 minutes of its block.</li>
      ${P.share > 0 ? "<li>The profit share accrues to the creator's payout wallet on paper: tracked, never charged.</li>" : ""}
      <li>Agents pay the same way: <span class="mono">POST /v1/agents/${esc(P.id)}/copy</span> answers 402 (x402); send the USDC, then repeat it with <span class="mono">X-PAYMENT: solana:&lt;signature&gt;</span>.</li>
    </ul></details>
    ${P.ready ? "" : `<div class="b-banner bad" title="${esc(`${P.lane || "NOWNodes key not set: payments cannot be verified on this server yet, so do not pay."} Nothing was charged.`)}">${ic("alert")}<span>Payments off · do not pay</span></div>`}
    <ol class="mk-steps" id="mkSteps"${P.steps.length ? "" : " hidden"}>${P.steps.map(stepHtml).join("")}</ol>
    <div class="mk-df" id="mkFoot"></div>
  </div>`;
  MK.paySig = "";
  paintPayFoot();
}
/** the wallet part of the dialog; repainted only when what can pay changed (a repaint would drop the keyboard focus) */
function paintPayFoot() {
  const el = $("mkFoot"), P = MK.pay; if (!el || !P) return;
  const ws = payWallets(), pv = PV();
  const sig = JSON.stringify([ws.map((w) => [w.id, w.addr]), !!pv?.authenticated, P.wallet, P.busy, P.sig, P.done]);
  if (sig === MK.paySig) return;
  MK.paySig = sig;
  if (P.done) { el.innerHTML = ""; return; }
  if (P.sig) { // paid, but the copy did not go through: the same payment can still buy it
    el.innerHTML = `<button type="button" class="b-cta" data-mk="redeem"${P.busy ? " disabled" : ""}>${P.busy ? `${ic("spin")}Checking the payment…` : "Retry the copy with this payment"}</button><p class="mk-dn" title="It buys this copy for 15 minutes after its block">Paid ${txLink(P.sig)}</p>`;
    return;
  }
  if (!ws.some((w) => w.id === P.wallet)) P.wallet = ws[0]?.id ?? null;
  const w = ws.find((x) => x.id === P.wallet);
  if (!w) {
    el.innerHTML = pv?.authenticated
      ? `<button type="button" class="b-cta" data-mk="create"${P.busy ? " disabled" : ""}>${ic("wallet")}Create your Solana wallet</button><p class="mk-dn" title="Your Chord account has no Solana wallet yet. It takes a second; then fund it with USDC and a little SOL for fees.">No Solana wallet yet</p>`
      : `<button type="button" class="b-cta" data-mk="signin"${P.ready ? "" : " disabled"}>${ic("wallet")}Connect a Solana wallet</button><p class="mk-dn" title="Sign in with your Chord account, or install Phantom, Solflare or Backpack, to pay in USDC.">Chord, Phantom, Solflare or Backpack</p>`;
    return;
  }
  el.innerHTML = `${ws.length > 1 ? `<div class="b-seg sm mk-ws" role="radiogroup" aria-label="Pay from">${ws.map((x) => `<button type="button" role="radio" data-mkw="${esc(x.id)}" class="${x.id === P.wallet ? "on" : ""}" aria-checked="${x.id === P.wallet}"${P.busy ? " disabled" : ""}>${esc(x.label)}</button>`).join("")}</div>` : ""}
    <button type="button" class="b-cta" data-mk="pay"${P.busy || !P.ready ? " disabled" : ""}>${P.busy ? `${ic("spin")}Paying…` : `${ic("wallet")}Pay ${priceTxt(P.price)} and copy`}</button>
    <p class="mk-dn" title="Your wallet signs; this app never holds keys or funds.">${w.addr ? `${esc(w.label)} <span class="mono">${esc(short(w.addr))}</span>` : `${esc(w.label)} · connect first`}</p>`;
}
async function payPost(path, body) {
  const r = await apiRaw(path, { method: "POST", body });
  if (!r.ok) throw new Error(errText(r.status, r.json));
  return r.json;
}
async function signWithExt(prov, b64) {
  const web3 = await import(WEB3);
  const tx = web3.VersionedTransaction.deserialize(b64ToBytes(b64));
  return bytesToB64((await prov.signTransaction(tx)).serialize());
}
/** run one payment phase; a failure marks the step it happened in */
async function payRun(P, fn) {
  if (P.busy) return;
  P.busy = true; P.cur = null; paintPay();
  try { await fn(); }
  catch (e) {
    const msg = cancelled(e) ? "You cancelled in the wallet. Nothing was sent." : esc(e?.message ?? String(e));
    if (P.cur) { P.cur.state = "bad"; P.cur.html = msg; } else P.steps.push({ state: "bad", html: msg });
  } finally {
    P.busy = false; P.cur = null;
    if (MK.pay === P) paintPay();
  }
}
function payGo() {
  const P = MK.pay; if (!P || !P.ready) return;
  const w = payWallets().find((x) => x.id === P.wallet); if (!w) return;
  return payRun(P, async () => {
    P.steps = [];
    let s = payStep(P, "Connecting the wallet");
    let addr = w.addr;
    if (w.prov && !addr) { await w.prov.connect(); addr = w.prov.publicKey?.toString?.() ?? null; }
    if (!addr) throw new Error("The wallet did not share its address.");
    s.done(`Paying from ${esc(w.label)} <span class="mono">${esc(short(addr))}</span>`);
    s = payStep(P, "Preparing the USDC transfer");
    const built = await payPost(`/v1/agents/${encodeURIComponent(P.id)}/copy/pay-tx`, { wallet: addr });
    s.done(`${priceTxt(built.amountUsdc ?? P.price)} to <span class="mono">${esc(short(P.payTo))}</span> prepared${built.createsPayoutAccount ? ", with the creator's USDC account (about 0.002 SOL rent, paid by your wallet)" : ""}`);
    s = payStep(P, "Confirm in your wallet");
    const signed = w.id === "privy" ? bytesToB64(await window.askPrivy.signSol(b64ToBytes(built.transaction))) : await signWithExt(w.prov, built.transaction);
    s.done("Signed in your wallet");
    s = payStep(P, "Sending through NOWNodes");
    const sent = await payPost(`/v1/agents/${encodeURIComponent(P.id)}/copy/pay-send`, { transaction: signed });
    P.sig = sent.signature;
    s.done(`Sent through NOWNodes ${txLink(P.sig)}`);
    await redeemPay(P);
  });
}
/** repeat the copy with X-PAYMENT until NOWNodes sees the payment confirmed (402 payment_pending meanwhile) */
async function redeemPay(P) {
  const s = payStep(P, "Waiting for the payment to confirm, read through NOWNodes");
  for (let i = 0; i < 40 && MK.pay === P; i++) {
    const r = await apiRaw(`/v1/agents/${encodeURIComponent(P.id)}/copy`, { method: "POST", body: P.name ? { name: P.name } : {}, headers: { "X-PAYMENT": `solana:${P.sig}` } });
    if (r.status === 201) {
      s.done("Payment verified. Copy created.");
      P.done = true;
      closePay(true);
      copied(r.json, "Paid and copied. It runs on paper in My agents now.");
      return;
    }
    if (r.status === 402 && r.json?.error === "payment_pending") { await sleep(2000); continue; }
    throw new Error(errText(r.status, r.json));
  }
  if (MK.pay === P) throw new Error("The payment has not confirmed after 80 seconds.");
}
async function payCreateWallet() {
  const P = MK.pay; if (!P) return;
  await payRun(P, async () => { await window.askPrivy.ensureSol(); });
}
function paySignIn() {
  const b = document.getElementById("signInBtn");
  if (b && !b.hidden) { b.click(); return; }
  toast("Sign-in is not set up on this server. Install Phantom, Solflare or Backpack to pay.");
}

// publish (detail page of my agent): the form, my listing's banner with edit / unlist; a public visitor sees the terms and Copy
async function loadListing(det) {
  try {
    const j = await api(`/v1/agents/${encodeURIComponent(det.id)}/listing`);
    if (S.det !== det) return;
    det.mk.listing = j.listing && typeof j.listing === "object" ? j.listing : null;
  } catch { if (det.mk.listing === undefined) det.mk.listing = null; }
  if (S.det !== det) return;
  paintHead();
  if (!det.mk.open) paintMk(); // never under the person's typing
}
function paintMk() {
  const el = $("bdMk"), det = S.det; if (!el || !det?.data) return;
  const m = det.mk, l = m.listing;
  if (!det.pub && m.open) { el.innerHTML = mkFormHtml(det.data.bot, l); paintMkSum(); return; }
  el.innerHTML = l ? mkBanner(l, det.pub) : "";
}
function mkBanner(l, pub) {
  const busy = S.det?.mk?.busy;
  const bits = [priceTxt(l.priceUsdc), shareTxt(l.profitSharePct), copiesTxt(l.copies), N(l.sales?.count) ? `${int(l.sales.count)} paid · ${priceTxt(l.sales.usdc)}` : ""].filter(Boolean);
  return `<div class="mk-ban">
    <span class="b-ico">${ic("tag")}</span>
    <div class="mk-bt"><b>Listed<em>${esc(l.title)}</em></b><small>${bits.map(esc).join(" · ")}</small>${N(l.profitSharePct) > 0 ? `<small>${earnTxt(l.earnings)}</small>` : ""}</div>
    <div class="mk-bb">${pub ? "" /* Copy sits in the header, next to Fork */
      : `<button type="button" class="b-btn" data-act="mk-open"${busy ? " disabled" : ""}>Edit listing</button><button type="button" class="b-btn danger" data-act="mk-unlist"${busy ? " disabled" : ""}>${busy === "unlist" ? `${ic("spin")}Unlisting…` : "Unlist"}</button>`}</div>
  </div>`;
}
const mkIn = (k, v, { ph = "", mode = "text", max = 0, pre = "", suf = "", mono = false } = {}) =>
  `<span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-mkf="${k}"${mono ? ' class="mono"' : ""} inputmode="${mode}" autocomplete="off" spellcheck="false"${max ? ` maxlength="${max}"` : ""} value="${esc(v)}" placeholder="${esc(ph)}">${suf ? `<i>${suf}</i>` : ""}</span>`;
function mkFormHtml(b, l) {
  const f = S.det.mk.f, busy = S.det.mk.busy === "save";
  const ageMs = Date.now() - (toMs(b.createdAt) ?? Date.now()), young = !l && ageMs < 3_600_000;
  const chord = !!PV()?.sol && f.wallet === PV().sol;
  return `<section class="mk-form" aria-labelledby="mkFormH">
    <div class="b-sech ag-ih"><h3 id="mkFormH">${l ? "Edit listing" : "Publish"}</h3>${info("Anyone can copy a listed agent. A paid copy sends USDC on Solana straight to your payout wallet, verified through NOWNodes. The profit share is paper: tracked as what you would earn, never charged.", "About listings")}</div>
    ${young ? `<div class="b-banner" title="An agent needs 1 hour of live history first">${ic("clock")}<span>Listable in ${int(Math.ceil((3_600_000 - ageMs) / 60_000))} min</span></div>` : ""}
    <div class="mk-fg">
      <label class="b-field mk-w"><span>Title</span>${mkIn("title", f.title, { ph: "e.g. Smart money memes, fast exits", max: 48 })}<small data-mkn="title">${f.title.length}/48</small>${mkErrSlot("title")}</label>
      <label class="b-field mk-w"><span>Pitch</span><span class="b-in mk-ta"><textarea data-mkf="pitch" rows="3" maxlength="280" placeholder="What it does and why, in a sentence or two">${esc(f.pitch)}</textarea></span><small data-mkn="pitch">${f.pitch.length}/280</small>${mkErrSlot("pitch")}</label>
      <label class="b-field"><span>Price</span>${mkIn("price", f.price, { ph: "0", mode: "decimal", pre: "$", suf: "USDC" })}<small title="0 lists it free, up to 100">0 = free · ≤100</small>${mkErrSlot("price")}</label>
      <label class="b-field"><span>Profit share</span>${mkIn("share", f.share, { ph: "0", mode: "decimal", suf: "%" })}<small title="0 to 30, of every copy's profitable closes, paper">0–30% · paper</small>${mkErrSlot("share")}</label>
      <label class="b-field mk-w"><span>Payout wallet</span>${mkIn("wallet", f.wallet, { ph: "Solana address that receives the USDC", mono: true })}<small title="${chord ? "Your Chord Solana wallet, filled in for you" : "A Solana address you control, exactly as written"}">${chord ? "Chord wallet" : "Solana address"}</small>${mkErrSlot("wallet")}</label>
    </div>
    <p class="mk-sum" id="mkSum"></p>
    <p class="b-msg" id="mkMsg"></p>
    <div class="mk-fb"><button type="button" class="b-btn ag-go" data-act="mk-save"${young || busy ? " disabled" : ""}>${busy ? `${ic("spin")}${l ? "Saving…" : "Publishing…"}` : l ? "Save listing" : "Publish listing"}</button><button type="button" class="b-btn" data-act="mk-cancel"${busy ? " disabled" : ""}>Cancel</button></div>
  </section>`;
}
/** one field of the publish form: its problem in a few words, or null */
function mkFieldErr(k, f) {
  const v = String(f[k] ?? "");
  if (k === "title") return !v.trim() ? "needs a title" : v.trim().length > 48 ? "48 characters at most" : null;
  if (k === "pitch") return v.trim().length > 280 ? "280 characters at most" : null;
  if (k === "wallet") return B58.test(v.trim()) ? null : v.trim() ? "not a Solana address" : "needs a Solana address";
  return fieldErr("mk", k, v);
}
const mkErrSlot = (k) => { const f = S.det?.mk?.f, m = f && f[k] !== "" ? mkFieldErr(k, f) : null; return `<small class="bb-err" data-mkerr="${k}">${esc(m ?? "")}</small>`; };
function mkShowErr(input, k) {
  const m = mkFieldErr(k, S.det.mk.f), slot = root.querySelector(`[data-mkerr="${k}"]`);
  if (slot) slot.textContent = m ?? "";
  input.closest(".b-in")?.classList.toggle("bb-bad", !!m);
}
/** the deal in one line, as a copier will see it: only values that pass the checks, an invalid one is named as such */
function paintMkSum() {
  const el = $("mkSum"), f = S.det?.mk?.f; if (!el || !f) return;
  const pBad = mkFieldErr("price", f), sBad = mkFieldErr("share", f), p = numIn(f.price) ?? 0, sh = numIn(f.share) ?? 0;
  const w = mkFieldErr("wallet", f) ? "your payout wallet" : short(f.wallet.trim());
  const price = pBad ? `<b class="b-down">Invalid price</b>` : p > 0 ? `<b>${priceTxt(p)}</b> once → <span class="mono">${esc(w)}</span>` : "<b>Free</b> copies";
  const share = sBad ? ` · <b class="b-down">Invalid share</b>` : sh > 0 ? ` · <b>${+sh.toFixed(2)}%</b> of profitable closes ${PAPER}` : "";
  el.innerHTML = price + share;
}
function mkCheck(f) {
  const t = f.title.trim(), p = numIn(f.price) ?? 0, sh = numIn(f.share) ?? 0, w = f.wallet.trim();
  if (!t) return "Give the listing a title.";
  if (t.length > 48) return "The title is longer than 48 characters.";
  if (f.pitch.trim().length > 280) return "The pitch is longer than 280 characters.";
  if (!Number.isFinite(p) || p < 0 || p > 100 || (p > 0 && p < 0.01)) return "The price is 0 (free) or 0.01 to 100 USDC.";
  if (!Number.isFinite(sh) || sh < 0 || sh > 30) return "The profit share is 0 to 30%.";
  if (!B58.test(w)) return "The payout wallet must be a Solana address.";
  return null;
}
function mkMsg(text, bad) { const el = $("mkMsg"); if (el) { el.textContent = text; el.className = `b-msg${bad ? " bad" : ""}`; } }
function mkOpen() {
  const det = S.det; if (!det?.data || det.pub) return;
  const l = det.mk.listing, b = det.data.bot, sp = stratOf(b);
  det.mk.f = { title: l?.title ?? String(b.name ?? "").slice(0, 48), pitch: l?.pitch ?? String(sp?.description ?? "").slice(0, 280), price: l ? String(l.priceUsdc) : "1", share: l ? String(l.profitSharePct) : "10", wallet: l?.payTo ?? PV()?.sol ?? "" };
  det.mk.open = true;
  paintHead(); paintMk();
  requestAnimationFrame(() => { $("bdMk")?.scrollIntoView({ block: "nearest" }); if (!document.activeElement?.closest?.(".mk-form")) root.querySelector('[data-mkf="title"]')?.focus(); });
}
async function mkSave() {
  const det = S.det, m = det?.mk; if (!m?.f || m.busy) return;
  const f = m.f, bad = mkCheck(f);
  if (bad) return mkMsg(bad, true);
  const was = !!m.listing;
  m.busy = "save"; paintMk();
  let err = null;
  try {
    const j = await api(`/v1/agents/${encodeURIComponent(det.id)}/listing`, { method: "POST", body: { title: f.title.trim(), pitch: f.pitch.trim(), priceUsdc: numIn(f.price) ?? 0, profitSharePct: numIn(f.share) ?? 0, payoutWallet: f.wallet.trim() } });
    if (S.det !== det) return;
    m.listing = j.listing ?? null; m.open = false; MK.lists = {};
    toast(was ? "Listing saved." : "Listed on the marketplace.");
  } catch (e) { err = e.message; }
  m.busy = null;
  if (S.det !== det) return;
  paintHead(); paintMk();
  if (err) mkMsg(err, true);
}
async function mkUnlist() {
  const det = S.det, m = det?.mk; if (!m?.listing || m.busy) return;
  m.busy = "unlist"; paintMk();
  try {
    await api(`/v1/agents/${encodeURIComponent(det.id)}/listing`, { method: "DELETE" });
    if (S.det !== det) return;
    m.listing = null; MK.lists = {};
    toast("Unlisted. Copies already made keep running.");
  } catch (e) { toast(e.message); }
  m.busy = null;
  if (S.det === det) { paintHead(); paintMk(); }
}

// ── My agents (live: PnL counts and flashes on change, last action ticks, running dot pulses, mini equity line) ───────────
async function loadBots(quiet) {
  try { const j = await api("/v1/agents"); S.bots = rows(j.bots).filter((b) => b.id); S.botsErr = null; }
  catch (e) { S.botsErr = e.message; }
  const c = $("agMineCnt"); if (c) c.textContent = S.bots?.length ? String(S.bots.length) : "";
  if (S.screen !== "home") return;
  if (!quiet || S.bots) paintMine();
  const ids = (S.bots ?? []).map((b) => b.id).sort().join();
  if (ids !== H.mineSig) { H.mineSig = ids; if (H.boards[H.win]) paintLb(); } // YOU badges, no Copy on my own rows
  if (S.bots?.some(trades) && Date.now() - H.sparkAt > 30_000) loadSparks();
}
async function loadSparks() {
  H.sparkAt = Date.now();
  const list = (S.bots ?? []).filter(trades).slice(0, MAX_BOTS);
  await Promise.all(list.map(async (b) => {
    try { const j = await api(`/v1/agents/${encodeURIComponent(b.id)}`); H.sparks.set(b.id, sparkFrom(rows(j.fills), j.bot ?? b)); } catch {}
  }));
  if (S.screen === "home" && list.length) paintMine();
}
/** the same equity line the board draws: running realized PnL at each close, the open PnL as the last point */
function sparkFrom(fills, b) {
  const closes = fills.filter((f) => f.status === "filled" && N(f.pnlUsd) != null).sort((a, c) => (toMs(a.ts) ?? 0) - (toMs(c.ts) ?? 0));
  let run = 0;
  const pts = [0, ...closes.map((f) => (run += N(f.pnlUsd)))];
  pts.push(run + (N(b.stats?.unrealizedUsd) ?? 0));
  return pts.slice(-40);
}
const totOf = (b) => Math.round(((N(b.stats?.realizedUsd) ?? 0) + (N(b.stats?.unrealizedUsd) ?? 0)) * 100) / 100;
function paintMine() {
  const el = $("bMine"); if (!el) return;
  placeMine();
  const n = $("agMineN"); if (n) n.textContent = S.bots?.length ? `${S.bots.length}/${MAX_BOTS}` : "";
  if (S.botsErr && !S.bots) { el.innerHTML = errBox(S.botsErr, "retry-bots"); return; }
  if (!S.bots) { el.innerHTML = `<div class="b-cards">${`<div class="b-card b-skc"><div class="b-skel" style="height:34px;width:62%"></div><div class="b-skel" style="height:30px;width:44%"></div><div class="b-skel" style="height:46px"></div></div>`.repeat(2)}</div>`; return; }
  if (!S.bots.length) {
    el.innerHTML = `<div class="b-none ag-mempty"><span>No agents yet</span>
      <span class="ag-ebtns"><button type="button" class="b-btn sm ag-go" data-go="create" data-type="copy">${ic("users")}Copy trader</button><button type="button" class="b-btn sm" data-go="create" data-type="lp">${ic("drop")}LP</button><button type="button" class="b-btn sm" data-go="create" data-type="alert">${ic("bell")}Alert</button><button type="button" class="b-btn sm" data-go="build">${ic("blocks")}Build</button></span></div>`;
    return;
  }
  el.innerHTML = `${S.botsErr ? `<p class="b-warnt">${esc(S.botsErr)}</p>` : ""}<div class="b-cards">${S.bots.map(cardHtml).join("")}</div>`;
  for (const b of S.bots) { // live PnL: count from the last value shown, flash green / red
    if (!trades(b)) continue;
    const v = totOf(b), k = `me:${b.id}`, was = H.prev.get(k);
    H.prev.set(k, v);
    if (was == null || was === v) continue;
    const e = el.querySelector(`[data-pnl="${CSS.escape(b.id)}"]`);
    if (e) { e.dataset.v = String(was); e.innerHTML = signed(was); countUp(e, v, signed); }
  }
}
/** on a phone, a person with agents finds them right under the hero; otherwise My agents closes the page */
function placeMine() {
  const sec = $("agMineS"), home = sec?.parentElement, proof = $("agProof"); if (!sec || !home || !proof) return;
  const up = narrow() && !!S.bots?.length;
  if (up && proof.nextElementSibling !== sec) proof.after(sec);
  else if (!up && home.lastElementChild !== sec) home.append(sec);
}
const fig = (k, v) => `<span><small>${esc(k)}</small><b>${v}</b></span>`;
function cardHtml(b) {
  const st = b.stats ?? {}, p = b.params ?? {}, custom = b.type === "custom", copy = trades(b), lp = b.type === "lp";
  const nw = p.wallets?.length ?? 0, nm = p.mints?.length ?? 0;
  const tot = totOf(b), sp = H.sparks.get(b.id);
  const sub = lp ? (isLpCopy(b) ? lpCopySub(b) : `pool ${short(p.pool)}`) : custom ? (BM && stratOf(b) ? BM.summary(stratOf(b)) : "Custom") : copy ? plural(nw, "wallet") : [nw && plural(nw, "wallet"), nm && plural(nm, "token")].filter(Boolean).join(", ") || "nothing watched";
  const xl = custom ? explainOf(b) : [];
  const body = custom && !copy
    ? `<div class="b-pnl">${int(st.trades)}<small>${N(st.trades) === 1 ? "match" : "matches"}</small></div>`
    : copy
    ? `<div class="ag-cpl"><div class="b-pnl ${cls(tot)}"><span class="ag-fv" data-pnl="${esc(b.id)}" data-v="${tot}">${signed(tot)}</span><small>PnL</small></div>${sp ? sparkSvg(sp, true) : ""}</div>
       <div class="b-figs">${fig("Realized", `<span class="${cls(st.realizedUsd)}">${signed(st.realizedUsd ?? 0)}</span>`)}${fig("Open PnL", `<span class="${cls(st.unrealizedUsd)}">${signed(st.unrealizedUsd ?? 0)}</span>`)}${fig(lp ? "Deposited" : "Invested", usd(st.investedUsd ?? 0))}${fig(lp ? "Moves" : "Trades", int(st.trades))}${fig("Open", int(st.openPositions))}${fig("Win", pct(st.winRate))}</div>`
    : `<div class="b-pnl">${int(st.trades)}<small>${N(st.trades) === 1 ? "match" : "matches"}</small></div>
       <div class="b-figs">${fig("Wallets", int(nw))}${fig("Tokens", int(nm))}${fig("Min size", usd(p.minUsd ?? 1000))}${fig("Webhook", p.webhook ? "On" : "Off")}</div>`;
  return `<div class="b-card" role="button" tabindex="0" data-open="${esc(b.id)}" aria-label="Open ${esc(b.name || "agent")}"${xl.length ? ` title="${esc(xl.join("\n"))}"` : ""}>
    <div class="b-ch">${av(b, 40)}<span class="b-cn"><b>${esc(b.name || "Untitled agent")}</b><small title="${esc(typeLabel(b))}">${esc(sub)}</small></span>${badge(b.mode)}</div>
    ${body}
    ${b.status === "error" && b.error ? `<div class="b-cerr">${esc(b.error)}</div>` : ""}
    <div class="b-cf">${statusHtml(b.status)}<span title="Last action">${st.lastEventAt ? agoCTag(st.lastEventAt) : "—"}</span></div>
  </div>`;
}
function syncListBot(bot) { if (S.bots && bot?.id) S.bots = S.bots.map((x) => (x.id === bot.id ? bot : x)); }

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAME_PH = { copy: "Optional, e.g. Top 3 smart traders", alert: "Optional, e.g. Whale watch", lp: "Optional, e.g. SI-SOL balanced" };
const FORM = { copy: () => copyFormHtml(), alert: () => alertFormHtml(), lp: () => lpFormHtml() };
function createHtml() {
  const f = S.f, tb = (t, icon, label) => `<button type="button" role="tab" data-type="${t}" class="${f.type === t ? "on" : ""}">${ic(icon)}${label}</button>`;
  return `${crumbHtml("mine", "My agents")}
    <div class="b-c2"><h2>New agent</h2><div class="b-seg bb-seg3" id="bTypeSeg" role="tablist" aria-label="Agent type">${tb("copy", "users", "Copy trader")}${tb("alert", "bell", "Alert")}${tb("lp", "drop", "LP")}<button type="button" role="tab" data-go="build" class="bb-segb" title="Build your own">${ic("blocks")}Build</button></div></div>
    <label class="b-field b-namef"><span>Name</span><span class="b-in"><input data-f="name" maxlength="48" autocomplete="off" placeholder="${NAME_PH[f.type] ?? NAME_PH.copy}" value="${esc(f.name)}"></span></label>
    <div id="bForm">${(FORM[f.type] ?? FORM.copy)()}</div>`;
}
// field checks while typing: a number field never drops a minus sign, it says what is wrong instead
/** "-5" / "−5" / "5k"-free: the typed text as a number, null when empty, NaN when not a number */
const numIn = (v) => { const t = String(v ?? "").trim().replace(/^[−–]/, "-"); return t === "" ? null : /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN; };
/** [min, max, whole, optional, message for out of range] */
const FCHK = {
  f: { usd: [1, 1000, false, false, "$1 to $1,000"], maxTok: [0, Infinity, false, true], maxOpen: [1, Infinity, true, true, "1 or more"], slip: [0.01, 50, false, true, "0.01 to 50%"],
    minLiq: [0, Infinity, false, true], stop: [0.01, Infinity, false, true, "above $0, or empty"], minUsd: [0, Infinity, false, true] },
  lp: { amount: [10, 10000, false, false, "$10 to $10,000"], oor: [5, 1440, true, true, "5 to 1,440 min"], maxDay: [0, 24, true, true, "0 to 24"], drop: [5, 95, false, true, "5 to 95%, or empty"],
    stop: [0.01, Infinity, false, true, "above $0, or empty"], custom: [1, 90, false, true, "±1 to 90%"] },
  mk: { price: [0, 100, false, true, "0 (free) or 0.01 to 100"], share: [0, 30, false, true, "0 to 30%"] },
};
function fieldErr(store, k, v) {
  const c = FCHK[store]?.[k]; if (!c) return null;
  const [min, max, whole, opt, msg] = c, n = numIn(v);
  if (n == null) return opt ? null : "needs a value";
  if (Number.isNaN(n)) return "must be a number";
  if (n < 0) return "must be 0 or more";
  if (whole && !Number.isInteger(n)) return "a whole number";
  if (store === "mk" && k === "price" && n > 0 && n < 0.01) return msg;
  if (n < min || n > max) return msg ?? `${min} or more`;
  return null;
}
/** the error under a field, and its box marked, as the person types */
function showFieldErr(input, store, k) {
  const msg = fieldErr(store, k, input.value), slot = root.querySelector(`[data-ferr="${store}:${k}"]`);
  if (slot) slot.textContent = msg ?? "";
  input.closest(".b-in")?.classList.toggle("bb-bad", !!msg);
}
/** keep digits, one point and a leading minus (a minus is never dropped: the check names it) */
const numOnly = (v, whole) => { let t = String(v).replace(/−|–/g, "-").replace(whole ? /[^0-9-]/g : /[^0-9.-]/g, ""); t = t.replace(/(?!^)-/g, ""); return whole ? t : t.replace(/(\..*)\./g, "$1"); };
/** store "lp" binds the input to S.lp (data-lp) instead of the copy / alert form (data-f) */
const field = (k, label, { pre = "", suf = "", hint = "", tip = "", ph = "", id = "", wide = false, mode = "decimal", store = "f" } = {}) =>
  `<label class="b-field${wide ? " wide" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><span>${label}${hint ? `<small class="b-fh">${hint}</small>` : ""}</span><span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-${store}="${k}"${id ? ` id="${id}"` : ""} inputmode="${mode}" autocomplete="off" spellcheck="false" value="${esc(S[store][k])}" placeholder="${esc(ph)}">${suf ? `<i>${suf}</i>` : ""}</span><small class="bb-err" data-ferr="${store}:${k}">${esc(fieldErr(store, k, S[store][k]) ?? "")}</small></label>`;
const tog = (k, label, hint, store = "f") => `<button type="button" class="b-tog" role="switch" aria-checked="${S[store][k]}" data-${store === "lp" ? "lptog" : "tog"}="${k}" title="${esc(hint)}"><span class="b-sw"></span><span><b>${label}</b></span></button>`;
/** a step: its number and a title of three words at most; what the step does sits behind (i) */
const stepHead = (n, title, sub) => `<div class="b-sh"><span class="b-num">${n}</span><div><h3>${title}</h3></div>${info(esc(sub), `About: ${title.replace(/&amp;/g, "&")}`)}</div>`;
/** the start box: PAPER, the full paper note behind (i), the form's message, the button */
const startBox = (note, cta) => `<div class="b-start"><div class="b-stn">${PAPER}<span class="b-msg" id="bMsg"></span>${info(esc(note), "Paper mode")}</div><button type="button" class="b-cta" data-act="create" id="bGo">${cta}</button></div>`;
const seg = (attr, vals, cur) => `<div class="b-seg sm">${vals.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
const DAY_OPTS = [[1, "24h"], [3, "3d"], [7, "7d"]];
const defMaxTok = () => { const u = N(S.f.usd); return u > 0 ? `Default ${usd(u * 3)}` : "Default 3× per trade"; };

function copyFormHtml() {
  const f = S.f;
  return `<section class="b-step">${stepHead(1, "Wallets", "Top Solana smart traders by realized profit. Pick up to 10, or add any wallet.")}
      <div class="b-bar">${seg("days", DAY_OPTS, f.days)}<button type="button" class="b-btn sm" data-act="top3">Add top 3</button><span class="b-seln" id="bSelN"></span></div>
      <div id="bTraders">${tradersHtml()}</div>
      <div class="b-add"><input id="bAddW" class="mono" placeholder="Add a wallet: paste a Solana address" spellcheck="false" autocomplete="off" aria-label="Add a wallet"><button type="button" class="b-btn" data-act="addw">Add</button></div>
      <p class="b-hint" id="bAddMsg"></p>
      <div class="b-chips" id="bChips"></div>
    </section>
    <section class="b-step">${stepHead(2, "Size &amp; safety", "Caps apply to every mirrored trade.")}
      <div class="b-grid">
        ${field("usd", "Per trade", { pre: "$", hint: "1–1,000", tip: "USDC per mirrored buy, 1 to 1,000" })}
        ${field("maxTok", "Max per token", { pre: "$", id: "bMaxTok", ph: defMaxTok(), tip: "Adds to a held token stop here" })}
        ${field("maxOpen", "Max open", { ph: "10", mode: "numeric", tip: "Max open positions: new buys wait above this" })}
        ${field("slip", "Slippage", { suf: "%", ph: "1", tip: "Per fill, on the Jupiter quote" })}
        ${field("minLiq", "Min liquidity", { pre: "$", ph: "20000", tip: "Thinner tokens are skipped" })}
        ${field("stop", "Daily stop", { pre: "$", ph: "Off", tip: "Daily loss stop: pauses the agent after this loss in a day" })}
      </div>
      <div class="b-togs">
        ${tog("mirror", "Mirror sells", "When a followed wallet sells a token the agent holds, the agent sells all of it.")}
        ${tog("safety", "Safety check", "Skip tokens whose mint or freeze authority is still live.")}
      </div>
    </section>
    <section class="b-step">${stepHead(3, "Backtest", "Replay the picked wallets' real trades with these rules. Prices come from each trade's own swap.")}
      <div class="b-bar">${seg("btdays", DAY_OPTS, f.btDays)}<button type="button" class="b-btn pri" data-act="bt" id="bBtBtn">${ic("chart")}Run backtest</button></div>
      <div id="bBt">${btHtml()}</div>
    </section>
    ${startBox("Paper mode: fills are priced by a real Jupiter quote at the moment the followed wallet trades; nothing is sent. Live mode signs from your own wallet under limits. Coming soon.", "Start agent")}`;
}
function alertFormHtml() {
  return `<section class="b-step">${stepHead(1, "Watch", "Wallets, tokens, or both.")}
      <div class="b-lbl">Wallets</div>
      <div class="b-add"><input id="bAddW" class="mono" placeholder="Paste a Solana wallet address" spellcheck="false" autocomplete="off" aria-label="Add a wallet"><button type="button" class="b-btn" data-act="addw">Add</button></div>
      <p class="b-hint" id="bAddMsg"></p>
      <div class="b-chips" id="bChips"></div>
      <div class="b-lbl">Tokens</div>
      <div class="b-add"><input id="bAddM" class="mono" placeholder="Paste a token mint address" spellcheck="false" autocomplete="off" aria-label="Add a token"><button type="button" class="b-btn" data-act="addm">Add</button></div>
      <p class="b-hint" id="bAddMMsg"></p>
      <div class="b-chips" id="bMints"></div>
    </section>
    <section class="b-step">${stepHead(2, "Alert when", "A trade by a watched wallet, or in a watched token, at or above this size.")}
      <div class="b-grid two">
        ${field("minUsd", "Min trade size", { pre: "$", ph: "1000", hint: "Default $1,000" })}
        ${field("hook", "Webhook", { ph: "https://… (optional)", mode: "url", tip: "Each match is also sent here. https only." })}
      </div>
    </section>
    <div class="b-start"><div class="b-stn"><em class="ag-pp" title="Alerts never trade">NO TRADES</em><span class="b-msg" id="bMsg"></span>${info("Alerts never trade. Matches show in the agent's log here.", "Alert agent")}</div><button type="button" class="b-cta" data-act="create" id="bGo">Start alert</button></div>`;
}
function paintForm() {
  const seg = $("bTypeSeg"); if (!seg) return;
  seg.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("on", b.dataset.type === S.f.type));
  const nm = root.querySelector('input[data-f="name"]'); if (nm) nm.placeholder = NAME_PH[S.f.type] ?? NAME_PH.copy;
  $("bForm").innerHTML = (FORM[S.f.type] ?? FORM.copy)();
  setHash(createHash());
  paintSel(); paintGo();
  if (S.f.type === "copy") loadTraders();
  if (S.f.type === "lp") lpPathStart();
}
const createHash = () => (S.f.type === "alert" ? "#agents/new/alert" : S.f.type === "lp" ? (S.lp.path === "copy" ? "#agents/new/lpcopy" : "#agents/new/lp") : "#agents/new");
// LP has two paths: pick a pool (this file), or copy smart LPs (lpcopy.js, loaded on first use, its own data-lc-* subtree)
let LC = null, LCp = null;
const lpCopyMod = () => (LCp ??= import(`./lpcopy.js${new URL(import.meta.url).search}`).then((m) => (LC = m)).catch((e) => { LCp = null; throw e; }));
const lcUi = () => ({ esc, usd, signed, cls, int, tile, errBox, equityHtml });
function lpPathStart() {
  if (S.lp.path !== "copy") { S.lcView?.destroy?.(); S.lcView = null; loadScan(); if (S.lp.pool) loadRange(S.lp.pool.pool); return; }
  const host = $("lcHost"); if (!host) return;
  S.lcView?.destroy?.(); S.lcView = null;
  lpCopyMod().then((m) => {
    if (!host.isConnected || S.screen !== "create" || S.lp.path !== "copy") return;
    S.lcView = m.renderLpCopyCreate(host, { api, session, ui: lcUi(), onCreated: (bot) => { S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)]; go("detail", { id: bot.id }); } });
  }).catch(() => { if (host.isConnected) host.innerHTML = errBox("The LP copy form failed to load. Check your connection.", "lc-reload"); });
}
/** an LP agent that copies smart LP wallets (params.mode "copy", or a public view whose params are redacted but carries lp.copy) */
const isLpCopy = (b, lp) => b?.type === "lp" && (b.params?.mode === "copy" || !!lp?.copy);
/** how many wallets a copy LP agent follows: its own list, else the top N of the smart-LP board */
const lpCopyN = (b) => { const p = b?.params ?? {}; const n = Array.isArray(p.wallets) && p.wallets.length ? p.wallets.length : N(p.smartLps?.top ?? p.wallets?.smartLps?.top); return n; };
const lpCopySub = (b) => { const n = lpCopyN(b); return n ? `Copies ${int(n)} smart LP${n === 1 ? "" : "s"}` : "Copies smart LPs"; };

// traders picker
async function loadTraders(force) {
  const d = S.f.days, c = S.traders[d];
  if (c?.list && !force && Date.now() - c.at < 120_000) return paintTraders();
  if (c?.loading) return;
  S.traders[d] = { ...(c ?? {}), loading: true, err: null };
  paintTraders();
  try { const j = await api(`/v1/agents/traders?days=${d}`); S.traders[d] = { list: rows(j.traders).filter((t) => typeof t.wallet === "string"), at: Date.now() }; }
  catch (e) { S.traders[d] = { ...(S.traders[d] ?? {}), loading: false, err: e.message }; }
  if (S.f.days === d) paintTraders();
}
function paintTraders() { const el = $("bTraders"); if (el) el.innerHTML = tradersHtml(); }
function tradersHtml() {
  const c = S.traders[S.f.days];
  if (!c || (!c.list && !c.err)) return `<div class="b-tbl">${`<div class="b-skrow"><div class="b-skel"></div></div>`.repeat(5)}</div>`;
  if (c.err && !c.list) return errBox(c.err, "traders-retry");
  if (!c.list.length) return `<div class="b-none" title="Try 7d, or add a wallet below">No smart traders in this window</div>`;
  const rows = S.f.more ? c.list : c.list.slice(0, 10);
  return `<div class="b-tbl b-trs${c.loading ? " b-dim" : ""}"><div class="b-th"><span></span><span>Wallet</span><span class="b-n">Score</span><span class="b-n">Realized</span><span class="b-n">ROI</span><span class="b-n">Win</span><span class="b-n">Trades</span><span>Best</span></div>
    ${rows.map(trRow).join("")}
    ${c.list.length > 10 ? `<button type="button" class="b-more" data-act="more">${S.f.more ? "Top 10" : `All ${c.list.length}`}</button>` : ""}</div>
    ${c.err ? `<p class="b-warnt">${esc(c.err)}</p>` : ""}`;
}
function trRow(t) {
  const on = S.f.wallets.includes(t.wallet), dis = !on && S.f.wallets.length >= MAX_WALLETS, bt = t.bestToken;
  return `<label class="b-tr${on ? " on" : ""}${dis ? " dis" : ""}"><input type="checkbox" data-w="${esc(t.wallet)}"${on ? " checked" : ""}${dis ? " disabled" : ""} aria-label="Follow ${esc(short(t.wallet))}"><span class="b-box">${svg("check", 3)}</span>
    <span class="b-tw"><span><span class="mono">${esc(short(t.wallet))}</span><a href="${SOLSCAN.acct}${encodeURIComponent(t.wallet)}" target="_blank" rel="noopener" title="Open on Solscan" aria-label="Open on Solscan">${ic("ext")}</a></span><small title="${esc(`${plural(t.tokens, "token")} traded · median hold ${dur(t.medianHoldS)} · last trade ${ago(t.lastTrade)}`)}">${int(t.tokens)} tok · ${dur(t.medianHoldS)} hold · ${esc(agoC(t.lastTrade))}</small></span>
    <span class="b-tstats"><span class="b-n" data-k="Score">${compact(t.score)}</span><span class="b-n ${cls(t.realizedPnlUsd)}" data-k="PnL">${signed(t.realizedPnlUsd)}</span><span class="b-n ${cls(t.roi)}" data-k="ROI">${signedPct(t.roi)}</span><span class="b-n" data-k="Win">${pct(t.winRate)}</span><span class="b-n" data-k="Trades">${int(t.trades)}</span></span>
    <span class="b-best">${bt ? `${tokLogo(bt.symbol, imgOf(bt), "sm", bt.mint)}<b>${esc(bt.symbol ?? "?")}</b><small class="${cls(bt.realizedPnlUsd)}">${signed(bt.realizedPnlUsd)}</small>` : `<small>—</small>`}</span></label>`;
}

// selection (wallets for both types, mints for alerts)
const chip = (v, kind) => `<span class="b-chip"><span class="mono">${esc(short(v))}</span><button type="button" data-${kind}="${esc(v)}" aria-label="Remove ${esc(short(v))}">×</button></span>`;
function paintSel() {
  const f = S.f;
  const n = $("bSelN"); if (n) { n.textContent = `${f.wallets.length}/${MAX_WALLETS}`; n.title = "Wallets picked"; }
  const ch = $("bChips"); if (ch) ch.innerHTML = f.wallets.map((w) => chip(w, "rm")).join("");
  const mc = $("bMints"); if (mc) mc.innerHTML = f.mints.map((m) => chip(m, "rmm")).join("");
  root.querySelectorAll("input[data-w]").forEach((inp) => {
    const on = f.wallets.includes(inp.dataset.w), dis = !on && f.wallets.length >= MAX_WALLETS;
    inp.checked = on; inp.disabled = dis;
    const row = inp.closest(".b-tr"); row?.classList.toggle("on", on); row?.classList.toggle("dis", dis);
  });
  paintGo(); stale();
}
function hint(id, msg, bad = true) { const el = $(id); if (el) { el.textContent = msg; el.className = `b-hint${bad && msg ? " bad" : ""}`; } }
function addAddr(inputId, msgId, list, max, what) {
  const inp = $(inputId); if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  if (!B58.test(v)) return hint(msgId, `That is not a Solana ${what} address (base58, 32 to 44 characters).`);
  if (list.includes(v)) return hint(msgId, "Already in the list.");
  if (list.length >= max) return hint(msgId, `Up to ${max} per agent.`);
  list.push(v); inp.value = ""; hint(msgId, "");
  paintSel();
}
function toggleWallet(w, on) {
  const f = S.f;
  if (on && !f.wallets.includes(w)) { if (f.wallets.length >= MAX_WALLETS) { hint("bAddMsg", `Up to ${MAX_WALLETS} wallets per agent.`); paintSel(); return; } f.wallets.push(w); }
  if (!on) f.wallets = f.wallets.filter((x) => x !== w);
  paintSel();
}

// params from the form
function copyParams() {
  const f = S.f;
  if (!f.wallets.length) return { err: "Pick at least one wallet to follow." };
  const per = N(f.usd);
  if (per == null || per < 1 || per > 1000) return { err: "Per trade must be between $1 and $1,000." };
  const p = { wallets: [...f.wallets], usdPerTrade: per, mirrorSells: f.mirror, safety: f.safety, dailyLossStopUsd: null };
  if (f.maxTok !== "") { const v = N(f.maxTok); if (v == null || v < per) return { err: "Max per token must be at least the amount per trade." }; p.maxPerTokenUsd = v; }
  if (f.maxOpen !== "") { const v = N(f.maxOpen); if (v == null || v < 1 || !Number.isInteger(v)) return { err: "Max open positions must be a whole number, 1 or more." }; p.maxOpenPositions = v; }
  if (f.slip !== "") { const v = N(f.slip); if (v == null || v < 0.01 || v > 50) return { err: "Slippage must be between 0.01% and 50%." }; p.slippageBps = Math.round(v * 100); }
  if (f.minLiq !== "") { const v = N(f.minLiq); if (v == null || v < 0) return { err: "Min liquidity must be $0 or more." }; p.minLiquidityUsd = v; }
  if (f.stop !== "") { const v = N(f.stop); if (v == null || v <= 0) return { err: "Daily loss stop must be above $0, or empty for none." }; p.dailyLossStopUsd = v; }
  return { params: p };
}
function alertParams() {
  const f = S.f;
  if (!f.wallets.length && !f.mints.length) return { err: "Add at least one wallet or token to watch." };
  const p = {};
  if (f.wallets.length) p.wallets = [...f.wallets];
  if (f.mints.length) p.mints = [...f.mints];
  if (f.minUsd !== "") { const v = N(f.minUsd); if (v == null || v < 0) return { err: "Min trade size must be $0 or more." }; p.minUsd = v; }
  const h = f.hook.trim();
  if (h) { let u = null; try { u = new URL(h); } catch {} if (!u || u.protocol !== "https:") return { err: "The webhook must be a full https:// address." }; p.webhook = u.href; } else p.webhook = null;
  return { params: p };
}
const btKeyNow = () => JSON.stringify([copyParams().params ?? null, S.f.btDays]);
function stale() { const el = $("bStale"); if (el && S.f.bt) el.hidden = btKeyNow() === S.f.btKey; }

function paintGo() {
  const f = S.f, b = $("bGo"), msg = $("bMsg");
  const ready = f.type === "copy" ? f.wallets.length > 0 : f.type === "lp" ? !!S.lp.pool : f.wallets.length + f.mints.length > 0;
  if (b) { b.disabled = f.busy || !ready; b.innerHTML = f.busy ? `${ic("spin")}Starting…` : ({ copy: "Start agent", lp: "Start LP agent" })[f.type] ?? "Start alert"; }
  if (msg && !msg.classList.contains("bad")) msg.textContent = ready ? "" : ({ copy: "Pick a wallet first", lp: "Pick a pool first" })[f.type] ?? "Add a wallet or token";
  const lb = $("lpBtBtn");
  if (lb) { lb.disabled = S.lp.btBusy || !S.lp.pool; lb.innerHTML = S.lp.btBusy ? `${ic("spin")}Replaying prices…` : `${ic("chart")}Run backtest`; }
  const bb = $("bBtBtn");
  if (bb) { bb.disabled = f.btBusy || !f.wallets.length; bb.innerHTML = f.btBusy ? `${ic("spin")}Replaying trades…` : `${ic("chart")}Run backtest`; }
}
function setMsg(text, bad) { const el = $("bMsg"); if (el) { el.textContent = text; el.className = `b-msg${bad ? " bad" : ""}`; } }

async function runBacktest() {
  const f = S.f;
  const { params, err } = copyParams();
  if (err) return setMsg(err, true);
  setMsg("", false);
  f.btBusy = true; f.btErr = null; paintBt();
  const key = JSON.stringify([params, f.btDays]);
  try {
    const bt = await api("/v1/agents/backtest", { method: "POST", body: { params, days: f.btDays } });
    f.bt = bt; f.btKey = key; f.btAll = false;
  } catch (e) { f.btErr = e.message; }
  f.btBusy = false;
  if (S.f === f) paintBt();
}
function paintBt() { const el = $("bBt"); if (el) el.innerHTML = btHtml(); paintGo(); stale(); }
function btHtml() {
  const f = S.f;
  if (!f.bt) {
    if (f.btBusy) return `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p>${ic("spin")}Replaying ${plural(f.wallets.length, "wallet")} · ${dayTag(f.btDays)}…</p></div>`;
    if (f.btErr) return errBox(f.btErr, "bt");
    return `<div class="b-none">${f.wallets.length ? "No run yet" : "Pick wallets first"}</div>`;
  }
  const bt = f.bt, r = N(bt.realizedUsd) ?? 0, u = N(bt.unrealizedUsd) ?? 0, tot = r + u, dd = Math.abs(N(bt.maxDrawdownUsd) ?? 0);
  const fills = rows(bt.fills).sort((a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0));
  const shown = f.btAll ? fills : fills.slice(0, 25);
  const notes = Array.isArray(bt.notes) ? bt.notes.filter((n) => typeof n === "string" && n) : [];
  return `<div class="b-btres${f.btBusy ? " b-dim" : ""}">
    ${f.btErr ? `<div class="b-banner bad">${ic("alert")}<span>${esc(f.btErr)}</span></div>` : ""}
    <p class="b-stale" id="bStale" hidden>${ic("alert")}Settings changed · run again</p>
    <div class="b-bth ag-ih"><em class="ag-rp">${esc(replayTag(bt.days, bt.coveredHours))}</em>${walletsReadChip(bt)}<span>${plural(bt.wallets?.length ?? 0, "wallet")} · ${usd(bt.usdPerTrade)}/trade</span>${info(noteList(notes))}</div>
    <div class="b-tiles b-t5">${tile("PnL", signed(tot), `realized ${signed(r)} · open ${signed(u)}`, cls(tot))}${tile("Win rate", pct(bt.winRate))}${tile("Trades", int(bt.trades), `${int(bt.buys)} buy · ${int(bt.sells)} sell · ${int(bt.skipped)} skip`)}${tile("Drawdown", dd ? `${MINUS}${usd(dd)}` : "$0.00", "", dd ? "b-down" : "")}${tile("Invested", usd(bt.investedUsd ?? 0))}</div>
    ${equityHtml(bt.equity, "Equity")}
    ${fills.length ? `<div class="b-sech"><h3>Fills</h3><small>${int(fills.length)}</small></div>${fillsTable(shown, null, fills.length > shown.length ? `<button type="button" class="b-more" data-act="bt-all">All ${int(fills.length)}</button>` : "")}` : `<div class="b-none">No trades in this window</div>`}
  </div>`;
}

async function createBot() {
  const f = S.f;
  if (f.busy) return;
  const built = f.type === "copy" ? copyParams() : f.type === "lp" ? lpParams() : alertParams();
  if (built.err) return setMsg(built.err, true);
  setMsg("", false);
  f.busy = true; paintGo();
  try {
    const body = { type: f.type, params: built.params, ...(f.name.trim() ? { name: f.name.trim() } : {}), ...(f.type === "copy" || f.type === "lp" ? { mode: "paper" } : {}) };
    const j = await api("/v1/agents", { method: "POST", body });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)];
    S.f = { ...freshForm(), days: f.days, btDays: f.btDays };
    if (f.type === "lp") S.lp = { ...freshLp(), scans: S.lp.scans, ranges: S.lp.ranges, sort: S.lp.sort, dex: S.lp.dex };
    go("detail", { id: bot.id });
  } catch (e) {
    f.busy = false;
    if (S.f === f) { paintGo(); setMsg(e.message, true); }
  }
}

function applyPrefill(p) {
  const f = S.f;
  if (p.type === "copy" || p.type === "alert") f.type = p.type;
  if (typeof p.name === "string") f.name = p.name.slice(0, 48);
  const addrs = (a) => (Array.isArray(a) ? [...new Set(a.map((x) => String(x ?? "").trim()).filter((x) => B58.test(x)))] : null);
  const ws = addrs(p.wallets); if (ws) f.wallets = ws.slice(0, MAX_WALLETS);
  const ms = addrs(p.mints); if (ms) f.mints = ms.slice(0, MAX_MINTS);
  const set = (k, v) => { if (N(v) != null) f[k] = String(N(v)); };
  set("usd", p.usdPerTrade); set("maxTok", p.maxPerTokenUsd); set("maxOpen", p.maxOpenPositions); set("minLiq", p.minLiquidityUsd); set("stop", p.dailyLossStopUsd); set("minUsd", p.minUsd);
  if (N(p.slippageBps) != null) f.slip = String(N(p.slippageBps) / 100);
  if (typeof p.mirrorSells === "boolean") f.mirror = p.mirrorSells;
  if (typeof p.safety === "boolean") f.safety = p.safety;
  if (typeof p.webhook === "string") f.hook = p.webhook;
  if (N(p.days) != null && [1, 3, 7].includes(N(p.days))) f.days = f.btDays = N(p.days);
  f.bt = null; f.btKey = null;
}

// ── Detail ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadDetail(quiet) {
  const det = S.det; if (!det) return;
  try {
    let j;
    try { j = await api(det.pub ? `/v1/agents/public/${encodeURIComponent(det.id)}` : `/v1/agents/${encodeURIComponent(det.id)}`); }
    catch (e) {
      // someone else's #agents/<id> link (the owner's address): not this session's agent, so open its public, read-only view
      if (det.pub || e?.status !== 404 || det.data) throw e;
      j = await api(`/v1/agents/public/${encodeURIComponent(det.id)}`);
      if (S.det !== det) return;
      det.pub = true; stopLive();
      clearInterval(S.tick); S.tick = setInterval(() => vis() && loadDetail(true), 15_000);
      setHash(`#agents/public/${encodeURIComponent(det.id)}`);
    }
    if (S.det !== det) return;
    if (!j?.bot) throw new Error("The server sent an agent without its details.");
    const byTs = (a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0);
    det.data = { bot: j.bot, positions: rows(j.positions), fills: rows(j.fills).sort(byTs), events: rows(j.events).sort(byTs), lp: j.lp && typeof j.lp === "object" ? j.lp : null };
    det.err = null;
    if (!det.pub) syncListBot(j.bot);
    if (j.bot.type !== "alert") loadListing(det); // its marketplace listing (terms, copies, paper earnings), if any
    else det.mk.listing = null;
  } catch (e) {
    if (S.det !== det) return;
    if (quiet && det.data) return;
    det.err = e.message;
  }
  paintDetail();
}
function paintDetail() {
  const det = S.det, el = $("bDet"); if (!el || !det) return;
  if (!det.data) {
    el.innerHTML = det.err ? errBox(det.err, "retry-det") : `<div class="b-skel" style="height:54px;width:55%"></div><div class="b-skel" style="height:120px;margin-top:18px"></div><div class="b-skel" style="height:220px;margin-top:18px"></div>`;
    return;
  }
  const copy = trades(det.data.bot), lp = det.data.bot.type === "lp", lpc = isLpCopy(det.data.bot, det.data.lp);
  // the publish form survives the 30 s refresh untouched (with the caret where it was)
  const keep = !det.pub && det.mk.open ? $("bdMk") : null, ae = keep?.contains(document.activeElement) ? document.activeElement : null;
  const sel = ae && "selectionStart" in ae ? [ae.selectionStart, ae.selectionEnd] : null;
  el.innerHTML = `<div id="bdHead"></div><div id="bdMk"></div>${copy && !lp && !det.pub ? `<div id="bdExec"></div>` : ""}<div id="bdHero"></div>
    ${copy && !lp ? `<section class="b-sec"><div class="b-sech"><h3>Open positions</h3><small id="bdPosN"></small></div><div id="bdPos"></div></section>` : ""}
    ${lpc ? "" : `<section class="b-sec"><div class="b-sech"><h3>${copy ? "Fills" : "Matches"}</h3><small id="bdFillsN"></small></div><div id="bdFills"></div></section>`}
    <section class="b-sec"><div class="b-sech"><h3>Log</h3></div><div id="bdLog"></div></section>`;
  paintHead(); paintHero(); paintPos(); paintFills(); paintLog(); mountExec();
  if (keep) { $("bdMk").replaceWith(keep); if (ae) { ae.focus({ preventScroll: true }); if (sel) try { ae.setSelectionRange(sel[0], sel[1]); } catch {} } }
  else paintMk();
}
// Sign & execute on NOWNodes (execute.js): one mounted module per open agent, the same node re-attached across the 30 s repaints
function mountExec() {
  const det = S.det, host = $("bdExec"); if (!host || !det?.data || det.pub) return;
  if (S.exec?.id === det.id && S.exec.el) { host.replaceWith(S.exec.el); return; }
  S.exec?.api?.destroy?.();
  const el = document.createElement("div"); el.id = "bdExec"; host.replaceWith(el);
  S.exec = { id: det.id, el, api: null };
  import(`./execute.js${new URL(import.meta.url).search}`).then((m) => { if (S.exec?.el === el) S.exec.api = m.mountExecute(el, { botId: det.id, session: D.session }); }).catch(() => {});
}
const LIVE = { on: "Live", connecting: "Connecting…", retry: "Reconnecting…", off: "Offline" };
const liveTag = () => `<span class="b-live ${S.live}" id="bdLive">${LIVE[S.live]}</span>`;
function setLive(s) { S.live = s; const el = $("bdLive"); if (el) { el.className = `b-live ${s}`; el.textContent = LIVE[s]; } }
function paintHead() {
  const el = $("bdHead"), det = S.det; if (!el || !det?.data) return;
  const b = det.data.bot;
  const fork = stratOf(b) ? `<button type="button" class="b-btn" data-act="fork" title="Open a copy of this strategy in the builder">${ic("fork")}Fork</button>` : "";
  let ctl;
  if (det.pub) {
    // the board's Copy: free at once, a priced listing answers 402 and its terms open (openPay)
    const l = det.mk.listing, priced = N(l?.priceUsdc) > 0, own = mineIds().has(b.id) || l?.mine === true;
    const copyB = own ? "" : `<button type="button" class="b-btn ag-go" data-copy="${esc(b.id)}" title="Copy this agent">${ic("copy")}${priced ? `Copy · ${priceTxt(l.priceUsdc)}` : "Copy"}</button>`;
    ctl = `${fork}${copyB}<span class="b-ro" title="Read-only: copy it to run your own">${ic("eye")}Read-only</span>`;
  }
  else if (det.confirm) ctl = `<span class="b-confirm">Delete with history?</span><button type="button" class="b-btn danger" data-act="del-yes"${det.busy ? " disabled" : ""}>${det.busy === "del" ? `${ic("spin")}Deleting…` : "Delete"}</button><button type="button" class="b-btn" data-act="del-no"${det.busy ? " disabled" : ""}>Keep</button>`;
  else {
    const run = b.status === "running", dis = det.busy ? " disabled" : "";
    const label = det.busy === "pause" ? "Pausing…" : det.busy === "resume" ? "Resuming…" : run ? "Pause" : "Resume";
    const pub = b.type !== "alert" && det.mk.listing === null && !det.mk.open ? `<button type="button" class="b-btn" data-act="mk-open">${ic("tag")}Publish</button>` : "";
    ctl = `${fork}${pub}<button type="button" class="b-btn" data-act="${run ? "pause" : "resume"}"${dis}>${ic(det.busy ? "spin" : run ? "pause" : "play")}${label}</button><button type="button" class="b-btn danger" data-act="del"${dis}>${ic("trash")}Delete</button>`;
  }
  el.innerHTML = `<div class="b-dh">${av(b, 64)}
      <div class="b-dt"><h2>${esc(b.name || "Untitled agent")}</h2><div class="b-meta"><span>${typeShort(b)}</span>${badge(b.mode)}${statusHtml(b.status)}<span title="${esc(`Started ${ago(b.createdAt)}`)}">${esc(agoC(b.createdAt))}</span>${det.pub ? "" : liveTag()}</div></div>
      <div class="b-ctl">${ctl}</div></div>
    ${b.error ? `<div class="b-banner bad">${ic("alert")}<span>${esc(b.error)}</span></div>` : ""}
    ${det.msg ? `<div class="b-banner bad">${ic("alert")}<span>${esc(det.msg)}</span></div>` : ""}`;
}
const addrChip = (a, kind) => `<a class="b-chip ln" href="${kind === "token" ? SOLSCAN.token : SOLSCAN.acct}${encodeURIComponent(a)}" target="_blank" rel="noopener" title="${esc(a)}"><span class="mono">${esc(short(a))}</span>${ic("ext")}</a>`;
function paintHero() {
  const el = $("bdHero"), det = S.det; if (!el || !det?.data) return;
  const b = det.data.bot, st = b.stats ?? {}, p = b.params ?? {}, sp = stratOf(b), red = p.redacted === true;
  if (isLpCopy(b, det.data.lp)) return paintLpCopyHero(el, b, det, red);
  if (b.type === "lp") { el.innerHTML = lpHeroHtml(b, det.data.lp) + (red ? LOCKED : ""); return; }
  const last = tile("Last event", st.lastEventAt ? esc(agoC(st.lastEventAt)) : "—");
  const tradesTile = tile("Trades", int(st.trades), `${int(st.buys)} buy · ${int(st.sells)} sell · ${int(st.skipped)} skip`);
  const pnlBig = (inv, tot) => `<div class="b-big"><small>Total PnL</small><b class="${cls(tot)}">${signed(tot)}</b><span>${inv ? `<span class="${cls(tot)}">${signedPct(tot / inv)}</span> <span title="invested">/ ${usd(inv)}</span>` : "—"}</span></div>`;
  if (b.type === "custom") {
    const xl = explainOf(b), lim = sp?.limits ?? {}, ws = Array.isArray(sp?.trigger?.wallets?.list) ? sp.trigger.wallets.list : [];
    const r = N(st.realizedUsd) ?? 0, u = N(st.unrealizedUsd) ?? 0, tot = r + u, inv = N(st.investedUsd) ?? 0;
    el.innerHTML = `<div class="b-hero">
        ${trades(b) ? `${pnlBig(inv, tot)}
        <div class="b-tiles b-t6">${tile("Realized", signed(r), "", cls(r))}${tile("Unrealized", signed(u), "", cls(u))}${tile("Win rate", pct(st.winRate))}${tradesTile}${tile("Open", `${int(st.openPositions)}${N(lim.maxOpenPositions) != null ? `<em class="ag-of">/${int(lim.maxOpenPositions)}</em>` : ""}`)}${last}</div>`
        : `<div class="b-big"><small>Matches</small><b>${int(st.trades)}</b><span>${sp?.action?.type === "webhook" ? "→ webhook" : "→ log"}</span></div>
        <div class="b-tiles b-t6">${tile("Matches", int(st.trades))}${tile("Skipped", int(st.skipped))}${last}</div>`}
      </div>
      ${red ? LOCKED : `${ws.length ? `<div class="b-params"><span class="b-pk">Following</span>${ws.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      ${xl.length ? `<div class="b-rules bb-xs">${sp && BM ? `<span class="bb-xsum">${esc(BM.summary(sp))}</span>` : ""}<details class="ag-notes bb-xdd"><summary>Rules</summary><ol class="bb-xd">${xl.map((x) => `<li>${xlHtml(x)}</li>`).join("")}</ol></details></div>` : sp ? "" : `<div class="b-none">No strategy attached</div>`}`}`;
  } else if (b.type === "copy") {
    const r = N(st.realizedUsd) ?? 0, u = N(st.unrealizedUsd) ?? 0, tot = r + u, inv = N(st.investedUsd) ?? 0;
    const per = N(p.usdPerTrade);
    const rules = [per != null && [`${usd(per)}/trade`, "Per mirrored buy"], per != null && [`${usd(N(p.maxPerTokenUsd) ?? per * 3)}/token`, "Max per token"], [`${int(p.maxOpenPositions ?? 10)} open max`, "Max open positions"],
      [`${+((N(p.slippageBps) ?? 100) / 100).toFixed(2)}% slip`, "Slippage"], [`liq ≥ ${usd(p.minLiquidityUsd ?? 20000)}`, "Min liquidity"], [p.safety === false ? "safety off" : "safety on", "Mint / freeze authority check"],
      [p.mirrorSells === false ? "holds sells" : "mirrors sells", "When a followed wallet sells"], [N(p.dailyLossStopUsd) ? `stop ${usd(p.dailyLossStopUsd)}/day` : "no daily stop", "Daily loss stop"]].filter(Boolean);
    el.innerHTML = `<div class="b-hero">
        ${pnlBig(inv, tot)}
        <div class="b-tiles b-t6">${tile("Realized", signed(r), "", cls(r))}${tile("Unrealized", signed(u), "", cls(u))}${tile("Win rate", pct(st.winRate))}${tradesTile}${tile("Open", `${int(st.openPositions)}<em class="ag-of">/${int(p.maxOpenPositions ?? 10)}</em>`)}${last}</div>
      </div>
      ${red ? LOCKED : `${p.wallets?.length ? `<div class="b-params"><span class="b-pk">Following</span>${p.wallets.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      <div class="b-rules">${rules.map(([x, t]) => `<span title="${esc(t)}">${esc(x)}</span>`).join("")}</div>`}`;
  } else {
    const hookHost = (() => { try { return new URL(p.webhook).host; } catch { return null; } })();
    el.innerHTML = `<div class="b-hero">
        <div class="b-big"><small>Matches</small><b>${int(st.trades)}</b><span>≥ ${usd(p.minUsd ?? 1000)}</span></div>
        <div class="b-tiles b-t6">${tile("Wallets", int(p.wallets?.length ?? 0))}${tile("Tokens", int(p.mints?.length ?? 0))}${tile("Min size", usd(p.minUsd ?? 1000))}${tile("Webhook", p.webhook ? "On" : "Off", !det.pub && hookHost ? esc(hookHost) : "")}${tile("Skipped", int(st.skipped))}${last}</div>
      </div>
      ${red ? LOCKED : `${p.wallets?.length ? `<div class="b-params"><span class="b-pk">Wallets</span>${p.wallets.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      ${p.mints?.length ? `<div class="b-params"><span class="b-pk">Tokens</span>${p.mints.map((m) => addrChip(m, "token")).join("")}</div>` : ""}`}`;
  }
}
/** a copy LP agent: its PnL, then lpcopy.js draws the wallets it copies, each copied move next to the wallet's own, positions */
function paintLpCopyHero(el, b, det, red) {
  const st = b.stats ?? {}, r = N(st.realizedUsd) ?? 0, u = N(st.unrealizedUsd) ?? 0, tot = r + u, inv = N(st.investedUsd) ?? 0, n = lpCopyN(b);
  el.innerHTML = `<div class="b-hero">
      <div class="b-big"><small>Total PnL</small><b class="${cls(tot)}">${signed(tot)}</b><span>${inv ? `<span class="${cls(tot)}">${signedPct(tot / inv)}</span> <span title="deposited">/ ${usd(inv)}</span>` : "—"}</span></div>
      <div class="b-tiles b-t6">${tile("Realized", signed(r), "", cls(r))}${tile("Unrealized", signed(u), "", cls(u))}${tile("Copies", n ? `${int(n)} LP${n === 1 ? "" : "s"}` : "—")}${tile("Moves", int(st.trades))}${tile("Open", int(st.openPositions))}${tile("Skipped", int(st.skipped))}</div>
    </div>${red ? LOCKED : ""}<div id="bdLc"></div>`;
  const draw = (m) => { const host = $("bdLc"); if (host && S.det === det) m.renderLpCopyDetail(host, det.data, { ui: lcUi() }); };
  if (LC) draw(LC); else lpCopyMod().then(draw).catch(() => { const host = $("bdLc"); if (host) host.innerHTML = errBox("This agent's copy view failed to load.", "retry-det"); });
}
/** a priced listing's public view sends params: { redacted: true }: its rules open in the buyer's copy */
const LOCKED = `<div class="b-locked" title="This listing is priced: its rules, wallets and tokens open in your copy.">${svg("shield")}<span><b>Rules locked</b> until you copy</span></div>`;
function paintPos() {
  const el = $("bdPos"), det = S.det; if (!el || !det?.data) return;
  const ps = [...det.data.positions].sort((a, b) => (N(b.valueUsd) ?? 0) - (N(a.valueUsd) ?? 0));
  const n = $("bdPosN"); if (n) n.textContent = ps.length ? String(ps.length) : "";
  el.innerHTML = ps.length
    ? `<div class="b-tbl b-pos"><div class="b-th"><span>Token</span><span class="b-n">Qty</span><span class="b-n">Cost</span><span class="b-n">Value</span><span class="b-n">PnL</span></div>${ps.map(posRow).join("")}</div>`
    : `<div class="b-none" title="Buys show up here when ${det.data.bot.type === "custom" ? "the trigger fires" : "a followed wallet trades"}">No open positions</div>`;
}
function posRow(p) {
  const cost = N(p.costUsd), pnl = N(p.pnlUsd);
  return `<div class="b-pr"><span class="b-tok">${tokLogo(p.symbol ?? "?", imgOf(p), "", p.mint)}<span><a href="${SOLSCAN.token}${encodeURIComponent(p.mint)}" target="_blank" rel="noopener" title="${esc(p.mint)}"><b>${esc(symOf(p.symbol, p.mint))}</b></a><small title="Opened">${esc(age(p.openedAt))}</small></span></span>
    <span class="b-n" data-k="Qty">${qty(p.qty)}</span><span class="b-n" data-k="Cost">${usd(cost)}</span><span class="b-n" data-k="Value">${usd(p.valueUsd)}</span>
    <span class="b-n b-ppl ${cls(pnl)}" data-k="PnL">${signed(pnl)}${cost && pnl != null ? `<small>${signedPct(pnl / cost)}</small>` : ""}</span></div>`;
}
function fillsTable(fills, fresh, footer = "") {
  const trig = !fills.some((f) => f.source?.wallet) && fills.some((f) => f.source?.detail); // custom agents: what fired, not a wallet
  return `<div class="b-tbl b-fills"><div class="b-th"><span>Time</span><span>Side</span><span>Token</span><span class="b-n">Amount</span><span class="b-n">Price</span>${trig ? `<span title="What fired the trade">Trigger</span>` : `<span title="Followed wallet">Wallet</span>`}<span class="b-n">PnL</span></div>${fills.map((f, i) => fillRow(f, fresh?.has(f.id))).join("")}${footer}</div>`;
}
/** a trigger's text for a narrow cell: "schedule: every 1d" → "every 1d", cut at a word */
const trigShort = (d) => { const t = agentWords(d).replace(/^\s*(trigger|schedule|price|confluence|new token|lp event)\s*[:·-]\s*/i, "").trim(); return t.length > 28 ? `${t.slice(0, 27).replace(/\s+\S*$/, "")}…` : t; };
function fillRow(f, fresh) {
  const sk = f.status === "skipped", src = f.source ?? {}, sell = f.side === "sell";
  const lag = (toMs(f.ts) ?? 0) - (toMs(src.ts) ?? Infinity), w = when(f.ts);
  const lagTxt = lag >= 0 && lag < 3_600_000 ? `+${lag < 10_000 ? (lag / 1000).toFixed(1) : Math.round(lag / 1000)}s` : null;
  const q = f.quote;
  const qt = q ? `Jupiter quote${q.route?.length ? `: ${q.route.join(" › ")}` : ""}${N(q.priceImpactPct) != null ? `, impact ${N(q.priceImpactPct).toFixed(2)}%` : ""}` : "";
  const pl = sk ? `<span class="b-skl" title="${esc(`Skipped: ${agentWords(f.reason || "a filter")}`)}">${esc(skipShort(f.reason))}</span>` : sell && N(f.pnlUsd) != null ? signed(f.pnlUsd) : "";
  return `<div class="b-fr${sk ? " b-sk" : ""}${fresh ? " b-flash" : ""}"${sk ? ` title="${esc(`Skipped: ${agentWords(f.reason || "a filter")}`)}"` : ""}>
    <span class="b-ft"${lagTxt ? ` title="${lagTxt} after the followed wallet's trade"` : ""}>${w.hm}${w.day ? `<small class="b-day">${w.day}</small>` : lagTxt ? `<small>${lagTxt}</small>` : ""}</span>
    <span class="b-side ${sell ? "sell" : "buy"}">${sell ? "SELL" : "BUY"}</span>
    <span class="b-tok"><span class="b-side m ${sell ? "sell" : "buy"}" aria-hidden="true">${sell ? "SELL" : "BUY"}</span>${tokLogo(f.symbol ?? "?", imgOf(f), "", f.mint)}<span><b>${esc(symOf(f.symbol, f.mint))}</b>${N(f.tokenAmount) ? `<small>${qty(f.tokenAmount)}</small>` : ""}</span></span>
    <span class="b-n b-amt">${usd(f.usd)}</span>
    <span class="b-n b-px"${qt ? ` title="${esc(qt)}"` : ""}>${price(f.priceUsd)}</span>
    <span class="b-src">${src.wallet ? `<a href="${SOLSCAN.acct}${encodeURIComponent(src.wallet)}" target="_blank" rel="noopener" title="${esc(src.wallet)}">${esc(short(src.wallet))}</a>` : src.detail ? `<span class="b-trg" title="${esc(agentWords(src.detail))}">${esc(trigShort(src.detail))}</span>` : "—"}${src.tx ? `<a class="b-tx" href="${SOLSCAN.tx}${encodeURIComponent(src.tx)}" target="_blank" rel="noopener" title="The followed wallet's transaction" aria-label="The followed wallet's transaction">↗</a>` : ""}</span>
    <span class="b-n b-pl ${sk ? "" : cls(sell ? f.pnlUsd : null)}">${pl}</span>
  </div>`;
}
function paintFills() {
  const el = $("bdFills"), det = S.det; if (!el || !det?.data) return;
  const fills = det.data.fills, copy = trades(det.data.bot);
  const n = $("bdFillsN"); if (n) n.textContent = fills.length ? int(fills.length) : "";
  if (det.data.bot.type === "lp") { el.innerHTML = fills.length ? lpFillsTable(fills.slice(0, det.nFills), det.fresh) : `<div class="b-none" title="The open lands here within a minute of the start">No moves yet</div>`; return; }
  el.innerHTML = fills.length
    ? fillsTable(fills.slice(0, det.nFills), det.fresh, fills.length > det.nFills ? `<button type="button" class="b-more" data-act="fills-more">Show more</button>` : "")
    : `<div class="b-none" title="${det.data.bot.type === "custom" && copy ? "The agent trades when its trigger fires and every filter passes" : copy ? "The agent mirrors the next trade a followed wallet makes" : "Each match shows here"}">${copy ? "No fills yet" : "No matches yet"}</div>`;
}
/** a log line's first sentence, at most ~64 characters (the row opens to the full text) */
const logBrief = (m) => { const t = String(m ?? "").trim(), c = t.split(/(?<=[.;])\s/)[0].replace(/[.;]$/, ""); return c.length > 66 ? `${c.slice(0, 64).replace(/\s+\S*$/, "")}…` : c === t.replace(/[.;]$/, "") ? t : `${c}…`; };
function paintLog() {
  const el = $("bdLog"), det = S.det; if (!el || !det?.data) return;
  const evs = det.data.events;
  el.innerHTML = evs.length
    ? `<ol class="b-log">${evs.slice(0, det.nEv).map((e) => { const full = String(e.msg ?? ""), b = logBrief(full), k = `${e.ts}|${full.slice(0, 24)}`, open = det.logOpen?.has(k), more = b !== full; return `<li class="${["warn", "error"].includes(e.level) ? e.level : "info"}${more ? " b-lx" : ""}"${more ? ` data-act="logx" data-k="${esc(k)}" title="${esc(open ? "Show less" : full)}" aria-expanded="${!!open}"` : ""}><time>${(({ hm, day }) => `${hm}${day ? `<small>${day}</small>` : ""}`)(when(e.ts))}</time><i></i><span>${esc(open ? full : b)}</span></li>`; }).join("")}${evs.length > det.nEv ? `<li class="b-lmore"><button type="button" class="b-more" data-act="ev-more">Show more</button></li>` : ""}</ol>`
    : `<div class="b-none">Nothing logged yet.</div>`;
}
async function setStatus(kind) {
  const det = S.det; if (!det?.data || det.busy) return;
  det.busy = kind; det.msg = null; paintHead();
  try {
    const j = await api(`/v1/agents/${encodeURIComponent(det.id)}/${kind}`, { method: "POST" });
    const bot = j?.bot ?? j;
    if (S.det === det && bot?.id) { det.data.bot = bot; syncListBot(bot); }
  } catch (e) { det.msg = e.message; }
  det.busy = null;
  if (S.det === det) { paintHead(); paintHero(); }
}
async function delBot() {
  const det = S.det; if (!det || det.busy) return;
  det.busy = "del"; paintHead();
  try {
    await api(`/v1/agents/${encodeURIComponent(det.id)}`, { method: "DELETE" });
    if (S.bots) S.bots = S.bots.filter((b) => b.id !== det.id);
    toast("Agent deleted.");
    if (S.det === det) go("mine", { replace: true }); // its entry would open a deleted agent: My agents takes its place
  } catch (e) {
    det.busy = null; det.confirm = false; det.msg = e.message;
    if (S.det === det) paintHead();
  }
}

// live: SSE over fetch (X-Session header), reconnect with backoff while the detail is open
function stopLive() { S.ctrl?.abort(); S.ctrl = null; S.live = "off"; }
async function startLive() {
  const det = S.det; if (!det || det.pub) return;
  stopLive();
  const ctrl = new AbortController(); S.ctrl = ctrl;
  let wait = 1000;
  while (!ctrl.signal.aborted && S.det === det) {
    setLive(wait > 1000 ? "retry" : "connecting");
    try {
      const r = await fetch(`/v1/agents/${encodeURIComponent(det.id)}/stream`, { headers: { "X-Session": session(), Accept: "text/event-stream" }, signal: ctrl.signal });
      if (r.status === 404 || r.status === 403) { setLive("off"); if (S.ctrl === ctrl) S.ctrl = null; return; }
      if (!r.ok || !r.body) throw new Error(String(r.status));
      setLive("on"); wait = 1000;
      await readSse(r.body, (ev, raw) => onSse(ev, raw, det));
    } catch {
      if (ctrl.signal.aborted) return;
    }
    if (ctrl.signal.aborted || S.det !== det) return;
    setLive("retry");
    await sleep(wait, ctrl.signal);
    wait = Math.min(wait * 2, 15_000);
  }
}
/** read a text/event-stream body to its end, one (event, data) per block */
async function readSse(body, onEvent, onData) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onData?.();
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const c = line.indexOf(":"), k = c < 0 ? line : line.slice(0, c);
        let v = c < 0 ? "" : line.slice(c + 1);
        if (v.startsWith(" ")) v = v.slice(1);
        if (k === "event") ev = v; else if (k === "data") data.push(v);
      }
      if (data.length) onEvent(ev, data.join("\n"));
    }
  }
}
function onSse(ev, raw, det) {
  if (S.det !== det || !det.data) return;
  let d;
  try { d = JSON.parse(raw); } catch { return; }
  const type = ["fill", "event", "stats"].includes(ev) ? ev : d?.type; // a bare Bot also has .type, so the SSE event name wins
  if (type === "fill") {
    const f = d.fill ?? d;
    if (!f?.id || det.data.fills.some((x) => x.id === f.id)) return;
    det.data.fills.unshift(f); det.fresh.add(f.id);
    paintFills();
    setTimeout(() => det.fresh.delete(f.id), 2600);
    clearTimeout(S.posT); S.posT = setTimeout(() => { if (S.det === det) loadDetail(true); }, 1500); // positions move with every fill
  } else if (type === "event") {
    const e = d.event ?? d;
    if (!e?.msg) return;
    det.data.events.unshift(e);
    if (det.data.events.length > 500) det.data.events.length = 500;
    paintLog();
  } else if (type === "stats") {
    const bot = d.bot ?? d;
    if (!bot || (bot.id && bot.id !== det.id)) return;
    det.data.bot = { ...det.data.bot, ...bot };
    syncListBot(det.data.bot);
    paintHead(); paintHero();
  }
}

// ── LP agent: scan pools → range → amount and exits → backtest → start on paper (ask2049-notes/bots-contract.md "## LP agent") ──
const LP_SORTS = [["fees", "Fees"], ["tvl", "TVL"], ["deposits", "Deposits"], ["net", "Net flow"], ["lps", "LPs"]];
const LP_DEXES = [["", "All venues"], ["meteora_dlmm", "Meteora DLMM"], ["meteora_damm_v2", "Meteora DAMM v2"], ["raydium_clmm", "Raydium CLMM"], ["pumpswap", "PumpSwap"]];
const FLAG = { thin_tvl: "Thin TVL", new_pool: "New pool", lp_exodus: "LP exodus", mint_authority: "Mint auth", freeze_authority: "Freeze auth",
  safety_unknown: "Safety ?", no_tvl: "No TVL", no_fee_apr: "No APR", short_history: "Short history" };
const flagName = (f) => FLAG[f?.code] ?? String(f?.code ?? "flag").replace(/_/g, " ");
const flagChip = (f) => `<span class="ag-flag" title="${esc(f.msg ?? "")}">${ic("alert")}${esc(flagName(f))}</span>`;
const pctNum = (x) => { const n = N(x); if (n == null) return "—"; const a = Math.abs(n); return `${a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toFixed(1)}%`; };
const scanKey = () => `${S.lp.sort}|${S.lp.dex}`;
const strs = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s) : []);

function lpFormHtml() {
  const L = S.lp;
  const paths = `<div class="b-seg ag-lppath" role="tablist" aria-label="How the LP agent picks positions"><button type="button" role="tab" data-lppath="pool" class="${L.path !== "copy" ? "on" : ""}" aria-selected="${L.path !== "copy"}">${ic("drop")}Pick a pool</button><button type="button" role="tab" data-lppath="copy" class="${L.path === "copy" ? "on" : ""}" aria-selected="${L.path === "copy"}">${ic("users")}Copy smart LPs</button></div>`;
  if (L.path === "copy") return `${paths}<div id="lcHost"><div class="b-step"><div class="b-skel" style="height:22px;width:40%"></div><div class="b-skel" style="height:200px;margin-top:14px"></div></div></div>`;
  return `${paths}<section class="b-step">${stepHead(1, "Pool", "Solana pools ranked over the last 24 hours. Fee APR is the venue's own number and an estimate. Flags are warnings: read them before you pick.")}
      <div class="b-bar">${seg("lpsort", LP_SORTS, L.sort)}<span class="b-in bb-sel ag-dex"><select data-lpdex aria-label="Venue">${LP_DEXES.map(([v, l]) => `<option value="${v}"${v === L.dex ? " selected" : ""}>${l}</option>`).join("")}</select></span></div>
      <div id="lpScan">${lpScanHtml()}</div>
      <div id="lpPick">${lpPickHtml()}</div>
    </section>
    <section class="b-step">${stepHead(2, "Range", "Where the position earns fees. Wider stays in range longer and earns less per dollar.")}<div id="lpRange">${lpRangeHtml()}</div></section>
    <section class="b-step">${stepHead(3, "Amount &amp; exits", "Paper money. Out of range too long, the agent recenters the same width on the price.")}
      <div class="b-grid">
        ${field("amount", "Amount", { pre: "$", hint: "10–10,000", store: "lp" })}
        ${field("oor", "Rebalance after", { suf: "min", ph: "30", mode: "numeric", hint: "5–1,440", tip: "Out of range this long, 5 to 1,440 minutes", store: "lp" })}
        ${field("maxDay", "Rebalances/day", { ph: "4", mode: "numeric", hint: "0–24", tip: "At most, 0 to 24 a day. 0 = never", store: "lp" })}
        ${field("drop", "Token drop exit", { suf: "%", ph: "Off", hint: "5–95", tip: "Exit when the token drops this much from the first open, 5 to 95", store: "lp" })}
        ${field("stop", "Daily stop", { pre: "$", ph: "Off", tip: "Daily loss stop: closes after this loss in a day", store: "lp" })}
      </div>
      <div class="b-togs">${tog("exodus", "LP exodus exit", "Exit on LP exodus: withdrawals above twice the deposits in an hour, $1,000 or more.", "lp")}${tog("safety", "Safety check", "Do not open on a token with a live mint or freeze authority.", "lp")}</div>
    </section>
    <section class="b-step">${stepHead(4, "Backtest", "Replay this range on the pool's hourly prices: fees against IL, LP against holding.")}
      <div class="b-bar">${seg("lpdays", DAY_OPTS, L.days)}<button type="button" class="b-btn pri" data-act="lpbt" id="lpBtBtn">${ic("chart")}Run backtest</button></div>
      <div id="lpBt">${lpBtHtml()}</div>
    </section>
    ${startBox("Paper mode: the position is marked every minute with Jupiter prices and the pool's own data; nothing is sent. Fee income is always an estimate from the pool's fee APR.", "Start LP agent")}`;
}

// step 1: the scan
async function loadScan(force) {
  const L = S.lp, k = scanKey(), c = L.scans[k];
  if (c?.list && !force && Date.now() - c.at < 120_000) return paintScan();
  if (c?.loading) return;
  L.scans[k] = { ...(c ?? {}), loading: true, err: null };
  paintScan();
  try {
    const q = new URLSearchParams({ limit: "20", sort: L.sort });
    if (L.dex) q.set("dex", L.dex);
    const j = await api(`/v1/agents/lp/scan?${q}`);
    L.scans[k] = { list: rows(j.rows).filter((r) => typeof r.pool === "string" && B58.test(r.pool)), best: j.best ?? null, notes: strs(j.notes), at: Date.now() };
  } catch (e) { L.scans[k] = { ...(L.scans[k] ?? {}), loading: false, err: e.message }; }
  if (S.lp === L && scanKey() === k) paintScan();
}
function paintScan() { const el = $("lpScan"); if (el) el.innerHTML = lpScanHtml(); }
function lpScanHtml() {
  const c = S.lp.scans[scanKey()];
  if (!c || (!c.list && !c.err)) return `<div class="b-tbl">${`<div class="b-skrow"><div class="b-skel"></div></div>`.repeat(6)}</div><p class="b-hint ag-wait" title="Reading pools, venue APIs and LP flows">${ic("spin")}Reading pools…</p>`;
  if (c.err && !c.list) return errBox(c.err, "lp-retry");
  if (!c.list.length) return `<div class="b-none" title="Try another venue or sort">No pools match</div>`;
  return `<div class="b-tbl ag-pools${c.loading ? " b-dim" : ""}"><div class="b-th"><span></span><span>Pool</span><span class="b-n">TVL</span><span class="b-n">Vol 24h</span><span class="b-n" title="Fee APR, the venue's own estimate">Fee APR</span><span class="b-n" title="Net flow 24h: deposits minus withdrawals">Net 24h</span><span>Flags</span></div>
    ${(S.lp.more ? c.list : c.list.filter((r, i) => i < 10 || r.pool === S.lp.pool?.pool)).map((r) => scanRow(r, c.best === r.pool)).join("")}
    ${c.list.length > 10 ? `<button type="button" class="b-more" data-act="lp-more">${S.lp.more ? "Top 10" : `All ${c.list.length}`}</button>` : ""}</div>
    ${c.err ? `<p class="b-warnt">${esc(c.err)}</p>` : ""}${c.notes?.length ? `<details class="ag-notes"><summary>Sources</summary><ul>${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}`;
}
function scanRow(r, best) {
  const on = S.lp.pool?.pool === r.pool, fl = rows(r.flags);
  return `<label class="ag-pr${on ? " on" : ""}"><input type="radio" name="lppool" data-lppool="${esc(r.pool)}"${on ? " checked" : ""} aria-label="Pick ${esc(r.pair)}"><span class="b-box ag-rad">${svg("check", 3)}</span>
    <span class="b-tok">${pairLogo(r, "sm")}<span><b>${esc(r.pair)}${best ? ` <em class="ag-top" title="Highest score among the pools with no flag">BEST</em>` : ""}</b><small>${esc(r.venue ?? r.dex)} · <span title="Pool age">${N(r.ageHours) != null ? dur(N(r.ageHours) * 3600) : "age ?"}</span></small></span></span>
    <span class="b-n" data-k="TVL">${usd(r.tvlUsd)}</span>
    <span class="b-n" data-k="Vol 24h">${usd(r.volume24hUsd)}</span>
    <span class="b-n ag-apr" data-k="Fee APR" title="${esc(r.feeAprSource ?? "No fee APR from the venue")}">${aprTxt(r.feeAprPct)}${N(r.feeAprPct) != null ? `<em class="ag-est">est.</em>` : ""}</span>
    <span class="b-n ${cls(r.netFlow24hUsd)}" data-k="Net flow">${signed(r.netFlow24hUsd)}</span>
    <span class="ag-flags">${fl.length ? fl.map(flagChip).join("") : `<span class="ag-noflag" title="No flags">—</span>`}</span>
  </label>`;
}
function lpPickHtml() {
  const r = S.lp.pool; if (!r) return "";
  const fl = rows(r.flags), lh = r.lastHour && typeof r.lastHour === "object" ? r.lastHour : null;
  return `<div class="ag-pick">
    <div class="ag-pickh">${pairLogo(r)}<span><b>${esc(r.pair)}</b><small>${esc(r.venue ?? r.dex)} · <a class="mono" href="${SOLSCAN.acct}${encodeURIComponent(r.pool)}" target="_blank" rel="noopener" title="${esc(`Pool ${r.pool}`)}">${esc(short(r.pool))}</a> · <span title="Score, of 100">${int(r.score)}/100</span></small></span></div>
    <div class="b-figs ag-pickf">${[["Price", price(r.priceUsd)], ["TVL", usd(r.tvlUsd)], ["Fees 24h", usd(r.fees24hUsd)], ["Fee APR", `${aprTxt(r.feeAprPct)}${N(r.feeAprPct) != null ? `<em class="ag-est">est.</em>` : ""}`],
      ["In 24h", usd(r.deposits24hUsd)], ["Out 24h", usd(r.withdrawals24hUsd)], ["LPs 24h", int(r.lps24h)], ["1h in / out", lh ? `${usd(lh.depositsUsd)} / ${usd(lh.withdrawalsUsd)}` : "—"]].map(([k, v]) => fig(k, v)).join("")}</div>
    ${fl.length ? `<div class="ag-flags ag-pflags">${fl.map(flagChip).join("")}</div><details class="ag-notes"><summary>Flags</summary><ul>${fl.map((f) => `<li><b>${esc(flagName(f))}.</b> ${esc(f.msg ?? "")}</li>`).join("")}</ul></details>` : `<p class="ag-clean">${ic("check")}No flags</p>`}
  </div>`;
}
function pickPool(pool) {
  const L = S.lp, r = L.scans[scanKey()]?.list?.find((x) => x.pool === pool);
  if (!r || L.pool?.pool === pool) return;
  L.pool = r; L.bt = null; L.btKey = null; L.btErr = null;
  root.querySelectorAll(".ag-pr").forEach((x) => x.classList.toggle("on", x.querySelector("input")?.dataset.lppool === pool));
  const pk = $("lpPick"); if (pk) pk.innerHTML = lpPickHtml();
  paintLpBt(); loadRange(pool);
  if ($("bMsg")?.classList.contains("bad")) setMsg("", false);
  paintGo();
}

// step 2: range presets from the pool's volatility (or a custom ±%)
async function loadRange(pool) {
  const L = S.lp, c = L.ranges[pool];
  if (c && (c.loading || (c.data && Date.now() - c.at < 300_000))) return paintRange();
  L.ranges[pool] = { loading: true };
  paintRange();
  try { L.ranges[pool] = { data: await api(`/v1/agents/lp/range?pool=${encodeURIComponent(pool)}&hours=24`), at: Date.now() }; }
  catch (e) { L.ranges[pool] = { err: e.message }; }
  const d = L.ranges[pool].data;
  if (L.pool?.pool === pool && L.preset !== "custom" && !rows(d?.presets).some((x) => x.preset === L.preset)) { L.preset = "custom"; if (!L.custom) L.custom = "20"; }
  if (S.lp === L && L.pool?.pool === pool) { paintRange(); lpStale(); }
}
function paintRange() { const el = $("lpRange"); if (el) el.innerHTML = lpRangeHtml(); }
function lpRangeHtml() {
  const L = S.lp, r = L.pool;
  if (!r) return `<div class="b-none">Pick a pool first</div>`;
  const c = L.ranges[r.pool] ?? { loading: true };
  if (c.loading) return `<div class="ag-rgs">${`<div class="ag-rg ag-rgsk"><div class="b-skel" style="height:74px"></div></div>`.repeat(4)}</div>`;
  const d = c.data, ps = rows(d?.presets), tok = d?.token && r.tokenSymbol ? r.tokenSymbol : r.tokenSymbol ?? "token", q = r.quoteSymbol ?? "quote";
  const card = (p) => {
    const on = L.preset === p.preset, tir = N(p.expectedTimeInRangePct);
    return `<button type="button" class="ag-rg${on ? " on" : ""}" data-lppreset="${esc(p.preset)}" aria-pressed="${on}">
      <b>${esc(cap(String(p.preset)))}</b>
      <span class="ag-rgw"><i class="b-down">${MINUS}${pctNum(p.downPct)}</i><i class="b-up">+${pctNum(p.upPct)}</i></span>
      <small title="${tir != null ? `A 24 h position held in range ${Math.round(tir)}% of the past week` : "Time in range unknown"}">${tir != null ? `${Math.round(tir)}% in range` : "—"}</small>
      <small class="ag-rgn">${pnum(p.lower)}–${pnum(p.upper)}${N(p.bins) ? ` · ${int(p.bins)} bins` : N(p.ticks) ? ` · ${int(p.ticks)} ticks` : ""}</small></button>`;
  };
  const on = L.preset === "custom", notes = [d?.venueShape, ...strs(d?.notes)].filter((x) => typeof x === "string" && x);
  return `${d ? `<p class="ag-rgp"><span title="${esc(`${q} per ${tok}`)}">Price <b class="mono">${pnum(d.price)}</b> ${esc(q)}/${esc(tok)}</span> · <span${d.priceSource ? ` title="${esc(d.priceSource)}"` : ""}>${price(d.priceUsd)}</span>${d.volatility ? ` · <span title="Daily swing">swing <b>${pctNum(d.volatility.dailyPct)}</b>/d</span>` : ""}</p>` : c.err ? `<div class="ag-rgerr">${errBox(c.err, "lp-range-retry")}</div>` : ""}
    ${d?.fullRange ? `<div class="b-banner" title="This venue has no price range: the position is modeled full range, earning on every price.">${ic("alert")}<span>Full range only</span></div>` : ""}
    <div class="ag-rgs">${ps.map(card).join("")}
      <div class="ag-rg ag-rgc${on ? " on" : ""}" data-lppreset="custom"><b>Custom</b><span class="b-in"><i>±</i><input data-lp="custom" inputmode="decimal" autocomplete="off" placeholder="20" value="${esc(L.custom)}" aria-label="Custom range, percent around the price"><i>%</i></span><small title="Around the price, 1 to 90">±1–90%</small></div></div>
    ${notes.length ? `<details class="ag-notes"><summary>Method</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}`;
}

// steps 3 + 4: params, backtest
function lpParams() {
  const L = S.lp;
  if (!L.pool) return { err: "Pick a pool first." };
  const amt = N(L.amount);
  if (amt == null || amt < 10 || amt > 10000) return { err: "Amount must be between $10 and $10,000." };
  const p = { pool: L.pool.pool, amountUsd: amt, safety: L.safety };
  if (L.preset === "custom") { const r = N(L.custom); if (r == null || r < 1 || r > 90) return { err: "A custom range must be between ±1% and ±90%." }; p.rangePct = r; }
  else p.preset = L.preset;
  const oor = L.oor === "" ? 30 : N(L.oor);
  if (oor == null || oor < 5 || oor > 1440) return { err: "Rebalance after must be 5 to 1,440 minutes." };
  const md = L.maxDay === "" ? 4 : N(L.maxDay);
  if (md == null || md < 0 || md > 24 || !Number.isInteger(md)) return { err: "Rebalances a day must be a whole number, 0 to 24." };
  p.rebalance = { outOfRangeMinutes: oor, maxPerDay: md };
  const ex = { lpExodus: L.exodus, tokenDropPct: null, dailyLossStopUsd: null };
  if (L.drop !== "") { const v = N(L.drop); if (v == null || v < 5 || v > 95) return { err: "The token drop exit must be 5% to 95%, or empty for none." }; ex.tokenDropPct = v; }
  if (L.stop !== "") { const v = N(L.stop); if (v == null || v <= 0) return { err: "The daily loss stop must be above $0, or empty for none." }; ex.dailyLossStopUsd = v; }
  p.exits = ex;
  return { params: p };
}
const lpBtBody = (params) => { const b = { ...params, days: S.lp.days }; delete b.safety; return b; };
const lpBtKeyNow = () => { const { params } = lpParams(); return params ? JSON.stringify(lpBtBody(params)) : null; };
function lpStale() { const el = $("lpStale"); if (el && S.lp.bt) el.hidden = lpBtKeyNow() === S.lp.btKey; }
async function runLpBacktest() {
  const L = S.lp, { params, err } = lpParams();
  if (err) return setMsg(err, true);
  setMsg("", false);
  L.btBusy = true; L.btErr = null; paintLpBt();
  const body = lpBtBody(params);
  try { L.bt = await api("/v1/agents/lp/backtest", { method: "POST", body }); L.btKey = JSON.stringify(body); }
  catch (e) { L.btErr = e.message; }
  L.btBusy = false;
  if (S.lp === L) paintLpBt();
}
function paintLpBt() { const el = $("lpBt"); if (el) el.innerHTML = lpBtHtml(); paintGo(); lpStale(); }
function lpBtHtml() {
  const L = S.lp;
  if (!L.bt) {
    if (L.btBusy) return `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p>${ic("spin")}Replaying ${dayTag(L.days)} of hourly prices…</p></div>`;
    if (L.btErr) return errBox(L.btErr, "lpbt");
    return `<div class="b-none">${L.pool ? "No run yet" : "Pick a pool first"}</div>`;
  }
  const bt = L.bt, q = L.pool?.quoteSymbol ?? "quote", rg = bt.range, eq = rows(bt.equity), fills = rows(bt.fills), notes = strs(bt.notes);
  const ser = (k) => eq.map((e) => ({ t: toMs(e.ts), v: N(e[k]) }));
  const exitAt = bt.exited ? toMs(bt.exited.ts) : null; // after an exit the position is closed: no range, nothing "out of range"
  return `<div class="b-btres${L.btBusy ? " b-dim" : ""}">
    ${L.btErr ? `<div class="b-banner bad">${ic("alert")}<span>${esc(L.btErr)}</span></div>` : ""}
    <p class="b-stale" id="lpStale" hidden>${ic("alert")}Settings changed · run again</p>
    <div class="b-bth ag-ih"><em class="ag-rp">replay ${esc(dayTag(bt.days))}</em><span>${esc(bt.pair ?? "")} · ${usd(bt.amountUsd)} · ${bt.preset ? esc(cap(String(bt.preset))) : `±${pctNum(bt.rangePct)}`}${rg ? ` (${MINUS}${pctNum(rg.downPct)} / +${pctNum(rg.upPct)})` : bt.fullRange ? " · full range" : ""}</span>${info(noteList(notes), "How this replay is computed")}</div>
    <div class="b-tiles b-t6">${tile("PnL", signed(bt.pnlUsd), `<span title="final value from the amount">${usd(bt.finalUsd)} / ${usd(bt.amountUsd)}</span> · <span title="max drawdown">drawdown ${usd(bt.maxDrawdownUsd)}</span>`, cls(bt.pnlUsd))}${tile("LP vs HODL", signed(bt.lpVsHodlUsd), `HODL ${usd(bt.hodlUsd)} · <span title="${esc(`All in ${q}`)}">${esc(q)} ${usd(bt.quoteOnlyUsd)}</span>`, cls(bt.lpVsHodlUsd))}${tileH(`Fees <em class="ag-est">est.</em>`, signed(bt.feesUsd), N(bt.feeAprPct) != null ? `<span title="An estimate from the fee APR">${aprTxt(bt.feeAprPct)} APR</span>` : "no APR", cls(bt.feesUsd))}${tile("IL", signed(bt.ilUsd), "", cls(bt.ilUsd))}${tile("In range", pctNum(bt.timeInRangePct), `<span title="hours replayed">${int(bt.hours)}h</span>`)}${tile("Rebalances", int(bt.rebalances), N(bt.rebalanceCostUsd) ? `cost ${usd(bt.rebalanceCostUsd)}` : "")}</div>
    ${bt.exited ? `<div class="b-banner" title="${esc(agentWords(bt.exited.reason))}">${ic("alert")}<span>Exited ${esc(fullTime(toMs(bt.exited.ts)))}: ${esc(brief(bt.exited.reason))}</span></div>` : ""}
    ${linesChart([{ name: "LP", cls: "lp", pts: ser("usd") }, { name: "HODL", cls: "hodl", pts: ser("hodlUsd") }, { name: `100% ${q}`, cls: "q", pts: ser("quoteOnlyUsd") }], "LP vs HODL")}
    ${bandChart(eq.map((e) => { const t = toMs(e.ts), gone = exitAt != null && t > exitAt; return { t, p: N(e.price), lo: gone ? null : N(e.lower), hi: gone ? null : N(e.upper), in: gone ? null : e.inRange }; }), "Price and range", `${q} per ${L.pool?.tokenSymbol ?? "token"}`)}
    ${fills.length ? `<div class="b-sech"><h3>Moves</h3><small>${int(fills.length)}</small></div>${lpFillsTable(fills)}` : ""}
  </div>`;
}
const KIND = { open: "OPEN", rebalance: "REBAL", close: "CLOSE" };
function lpFillsTable(fills, fresh) {
  return `<div class="b-tbl ag-lpf"><div class="b-th"><span>Time</span><span>Move</span><span class="b-n">Amount</span><span class="b-n">PnL</span><span>Why</span></div>
    ${fills.map((f) => {
      const k = f.kind ?? (f.side === "sell" ? "close" : "open"), w = when(f.ts), p = N(f.pnlUsd);
      return `<div class="ag-lfr${fresh?.has?.(f.id) ? " b-flash" : ""}"><span class="b-ft">${w.hm}${w.day ? `<small class="b-day">${w.day}</small>` : ""}</span><span class="ag-bd ${k === "open" ? "buy" : k === "close" ? "sell" : "reb"}" title="${esc(cap(String(k)))}">${KIND[k] ?? esc(String(k).toUpperCase())}</span><span class="b-n">${usd(f.usd)}</span><span class="b-n ${cls(p)}">${p == null ? "" : signed(p)}</span><span class="ag-lfw">${esc(agentWords(f.reason ?? ""))}</span></div>`;
    }).join("")}</div>`;
}

// charts: several USD lines on one time axis; pool price (log scale) with the range as a band and hours out of range shaded
const xLabels = (t0, t1) => {
  const span = t1 - t0, o = span > 2 * 86400e3 ? { month: "short", day: "numeric" } : span > 30 * 3600e3 ? { month: "short", day: "numeric", hour: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false };
  const f = (ms) => new Date(ms).toLocaleString("en-US", o);
  return `<span>${f(t0)}</span><span>${f((t0 + t1) / 2)}</span><span>${f(t1)}</span>`;
};
function linesChart(series, title) {
  const ss = series.map((s) => ({ ...s, pts: s.pts.filter((p) => p.t != null && p.v != null).sort((a, b) => a.t - b.t) })).filter((s) => s.pts.length >= 2);
  if (!ss.length) return `<div class="b-none" title="${esc(title)}">Not enough points</div>`;
  const all = ss.flatMap((s) => s.pts);
  let lo = Math.min(...all.map((p) => p.v)), hi = Math.max(...all.map((p) => p.v));
  if (lo === hi) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(Math.max(...all.map((p) => p.t)), t0 + 1);
  const X = (t) => ((t - t0) / (t1 - t0)) * 1000, Y = (v) => (1 - (v - lo) / (hi - lo)) * 300;
  const ticks = niceTicks(lo, hi).filter((t) => t >= lo && t <= hi);
  const lastOf = (s) => s.pts[s.pts.length - 1].v;
  return `<div class="b-chart ag-ch"><div class="b-cth">${esc(title)}<span class="ag-leg">${ss.map((s) => `<span><i class="ag-sw ${s.cls}"></i>${esc(s.name)} <b>${usd(lastOf(s))}</b></span>`).join("")}</span></div>
    <div class="b-yax" aria-hidden="true">${ticks.map((t) => `<span style="top:${(Y(t) / 3).toFixed(2)}%">${tickUsd(t)}</span>`).join("")}</div>
    <div class="b-plot ag-static" role="img" aria-label="${esc(title)}: ${esc(ss.map((s) => `${s.name} ${usd(lastOf(s))}`).join(", "))}"><svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
      ${ticks.map((t) => `<line class="b-gl" x1="0" x2="1000" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/>`).join("")}
      ${ss.map((s) => `<path class="b-line ag-l ${s.cls}" d="${s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("")}"/>`).join("")}
    </svg></div>
    <div></div><div class="b-xax" aria-hidden="true">${xLabels(t0, t1)}</div></div>`;
}
function bandChart(raw, title, unit) {
  const pts = raw.filter((p) => p.t != null && N(p.p) > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return `<div class="b-none">Not enough prices</div>`;
  const ps = pts.map((p) => p.p), pMin = Math.min(...ps), pMax = Math.max(...ps);
  const bounds = pts.flatMap((p) => [N(p.lo), N(p.hi)]).filter((v) => v != null && v > 0);
  let lo = Math.max(Math.min(pMin, ...bounds), pMin / 3), hi = Math.min(Math.max(pMax, ...bounds), pMax * 3);
  if (!(hi > lo)) { lo = pMin * 0.9; hi = pMax * 1.1; }
  const pad = (Math.log(hi) - Math.log(lo)) * 0.14 || 0.05, a = Math.log(lo) - pad, z = Math.log(hi) + pad;
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const X = (t) => ((t - t0) / (t1 - t0)) * 1000;
  const Y = (v) => (1 - (Math.min(Math.max(Math.log(v), a), z) - a) / (z - a)) * 300;
  // one rect per run of equal bounds (the band moves at each rebalance), one per run of hours out of range
  let band = "", out = "";
  for (let i = 0; i < pts.length;) {
    let j = i;
    while (j + 1 < pts.length && N(pts[j + 1].lo) === N(pts[i].lo) && N(pts[j + 1].hi) === N(pts[i].hi)) j++;
    const xa = X(pts[i].t), xb = j + 1 < pts.length ? X(pts[j + 1].t) : 1000, ub = N(pts[i].hi), lb = N(pts[i].lo);
    if ((ub != null || lb != null) && xb > xa) {
      const yt = ub != null && ub > 0 ? Y(ub) : 0, yb = lb != null && lb > 0 ? Y(lb) : 300;
      band += `<rect class="ag-band" x="${xa.toFixed(1)}" y="${yt.toFixed(1)}" width="${(xb - xa).toFixed(1)}" height="${Math.max(0, yb - yt).toFixed(1)}"/>`;
      for (const y of [ub != null && ub > 0 ? yt : null, lb != null && lb > 0 ? yb : null]) if (y != null) band += `<line class="ag-bnd" x1="${xa.toFixed(1)}" x2="${xb.toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    }
    i = j + 1;
  }
  for (let i = 0; i < pts.length;) {
    if (pts[i].in !== false) { i++; continue; }
    let j = i; while (j + 1 < pts.length && pts[j + 1].in === false) j++;
    const xa = X(pts[i].t), xb = j + 1 < pts.length ? X(pts[j + 1].t) : 1000;
    if (xb > xa) out += `<rect class="ag-out" x="${xa.toFixed(1)}" y="0" width="${(xb - xa).toFixed(1)}" height="300"/>`;
    i = j + 1;
  }
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.p).toFixed(1)}`).join("");
  const last = pts[pts.length - 1], anyOut = !!out;
  // label what matters: the current range's bounds and the last price (generic ticks only when there is no range)
  const marks = [N(last.hi), N(last.p), N(last.lo)].filter((v) => v != null && v > 0 && Math.log(v) >= a && Math.log(v) <= z);
  const ticks = marks.length >= 2 ? marks.filter((v, i) => marks.findIndex((w) => Math.abs(Y(w) - Y(v)) < 22) === i) : [0.12, 0.5, 0.88].map((k) => Math.exp(z - (z - a) * k));
  return `<div class="b-chart ag-ch ag-band-ch"><div class="b-cth">${esc(title)}<span class="ag-leg"><span><i class="ag-sw px"></i>Price <b>${pnum(last.p)}</b></span><span><i class="ag-sw band"></i>Range</span>${anyOut ? `<span><i class="ag-sw out"></i>Out of range</span>` : ""}</span></div>
    <div class="b-yax" aria-hidden="true">${ticks.map((t) => `<span style="top:${(Y(t) / 3).toFixed(2)}%">${pnum(t)}</span>`).join("")}</div>
    <div class="b-plot ag-static" role="img" aria-label="${esc(title)} in ${esc(unit)}: last price ${pnum(last.p)}${N(last.lo) ? `, range ${pnum(last.lo)} to ${N(last.hi) ? pnum(last.hi) : "no upper bound"}` : ""}"><svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
      ${out}${band}<path class="b-line ag-l px" d="${line}"/>
    </svg><span class="ag-pxm${last.in === false ? " out" : last.in === true ? " in" : ""}" style="left:${(X(last.t) / 10).toFixed(2)}%;top:${(Y(last.p) / 3).toFixed(2)}%" title="Last price ${pnum(last.p)}"></span></div>
    <div></div><div class="b-xax" aria-hidden="true">${xLabels(t0, t1)}</div><div></div><p class="ag-unit">Log scale, ${esc(unit)}</p></div>`;
}

// LP detail: the live paper position (lp.state, lp.points)
function lpHeroHtml(b, lp) {
  const st = b.stats ?? {}, s = lp?.state && typeof lp.state === "object" ? lp.state : null, m = s?.mark && typeof s.mark === "object" ? s.mark : null, pts = rows(lp?.points);
  const tot = totOf(b), inv = N(st.investedUsd) ?? 0, tir = N(s?.trackedMs) ? (N(s.timeInRangeMs) ?? 0) / N(s.trackedMs) : null;
  const tok = s?.tokenSymbol ?? "token", q = s?.quoteSymbol ?? "quote", rg = s?.range;
  const rangeTxt = rg ? (rg.full ? "full range" : `${pnum(rg.lower)}–${rg.upper == null ? "∞" : pnum(rg.upper)} ${q}/${tok} (${MINUS}${pctNum(rg.downPct)} / ${rg.upPct == null ? "open" : `+${pctNum(rg.upPct)}`})`) : "not open";
  const closed = s?.status === "closed"; // a closed position has no range to be in: no live chip
  const inNow = closed ? "" : s?.inRange === true ? `<span class="ag-inr on">In range</span>` : s?.inRange === false ? `<span class="ag-inr off">Out of range${N(s.outSince) ? ` ${dur((Date.now() - N(s.outSince)) / 1000)}` : ""}</span>` : "";
  const banner = s?.status === "closed" ? `<div class="b-banner" title="${esc(`${s.closeReason ? agentWords(s.closeReason) : "Closed"}. Resume to open it again.`)}">${ic("alert")}<span>Closed${s.closedAt ? ` ${esc(agoC(s.closedAt))}` : ""}${s.closeReason ? `: ${esc(brief(s.closeReason))}` : ""}</span></div>`
    : !s || s.status === "opening" ? `<div class="b-banner" title="Reading the pool, the token's safety facts and Jupiter prices">${ic("spin")}<span>Opening…</span></div>` : "";
  const cmp = m ? compareHtml([["LP", N(m.equityUsd), "lp"], ["HODL", N(m.hodlUsd), "hodl"], [`100% ${q}`, N(m.quoteOnlyUsd), "q"]]) : "";
  // the points are kept every 10 min; the hero reads the last mark (a minute old at most, or the close): the charts end on it
  // too, so the legend and the hero show the same final values
  const ser = pts.map((p) => ({ t: toMs(p.ts), p: N(p.price), lo: N(p.lower), hi: N(p.upper), in: p.inRange, eq: N(p.equityUsd), ho: N(p.hodlUsd) }));
  const mt = toMs(m?.ts), lastT = ser.length ? Math.max(...ser.map((x) => x.t ?? 0)) : null;
  if (m && mt != null && lastT != null && mt > lastT) {
    ser.push({ t: mt, p: N(m.price), lo: closed ? null : N(rg?.lower), hi: closed ? null : N(rg?.upper), in: closed ? null : s?.inRange, eq: N(m.equityUsd), ho: N(m.hodlUsd) });
  } else if (m && mt != null && mt === lastT) { const x = ser.find((y) => y.t === lastT); if (N(m.equityUsd) != null) x.eq = N(m.equityUsd); if (N(m.hodlUsd) != null) x.ho = N(m.hodlUsd); }
  const charts = ser.length >= 2
    ? bandChart(ser.map(({ t, p, lo, hi, in: i }) => ({ t, p, lo, hi, in: i })), "Price and range", `${q} per ${tok}`)
      + linesChart([{ name: "LP", cls: "lp", pts: ser.map((x) => ({ t: x.t, v: x.eq })) }, { name: "HODL", cls: "hodl", pts: ser.map((x) => ({ t: x.t, v: x.ho })) }], "LP vs HODL")
    : `<div class="b-none" title="The agent marks the pool every 10 minutes">Chart fills every 10 min</div>`;
  return `<div class="b-hero">
      <div class="b-big"><small>Total PnL</small><b class="${cls(tot)}">${signed(tot)}</b><span>${inv ? `<span class="${cls(tot)}">${signedPct(tot / inv)}</span> <span title="deposited">/ ${usd(inv)}</span>` : "—"}</span></div>
      <div class="b-tiles b-t6">${tile("Value now", usd(m?.equityUsd), m ? `<span title="Marked">${esc(agoC(m.ts))}</span>` : "")}${tile("vs HODL", signed(m?.vsHodlUsd), m ? `HODL ${usd(m.hodlUsd)}` : "", cls(m?.vsHodlUsd))}${tileH(`Fees <em class="ag-est">est.</em>`, signed(s?.feesTotalUsd ?? 0), N(s?.feeApr?.pct) != null ? `<span title="An estimate from the fee APR">${aprTxt(s.feeApr.pct)} APR</span>` : "", cls(s?.feesTotalUsd))}${tile("IL", signed(m?.ilUsd), "", cls(m?.ilUsd))}${tile("In range", tir == null ? "—" : pct(tir), N(s?.trackedMs) ? `<span title="tracked">/ ${dur(N(s.trackedMs) / 1000)}</span>` : "")}${tile("Rebalances", int(s?.rebalances ?? 0), N(s?.rebalanceCostUsd) ? `cost ${usd(s.rebalanceCostUsd)}` : "")}</div>
    </div>
    ${s ? `<div class="b-params"><span class="b-pk">Pool</span>${addrChip(s.pool, "acct")}<span class="ag-rgline">${esc(s.pair)} · ${esc(s.venue)} · ${esc(rangeTxt)}</span>${inNow}</div>` : ""}
    ${banner}${cmp}${charts}`;
}
function compareHtml(items) {
  const vals = items.map((x) => x[1]).filter((v) => v != null);
  if (!vals.length) return "";
  const top = Math.max(...vals), best = vals.filter((v) => Math.abs(v - top) < 0.005).length === 1 ? top : null; // a tie (the open) has no best
  return `<div class="ag-cmp">${items.map(([k, v, c]) => { const on = best != null && v === best; return `<div class="ag-cmpc${on ? " best" : ""}"><span><i class="ag-sw ${c}"></i>${esc(k)}${on ? `<em>Best</em>` : ""}</span><b>${usd(v)}</b></div>`; }).join("")}</div>`;
}

// ── equity chart: SVG line that stretches, HTML axis labels that do not; crosshair + tooltip on hover / arrow keys ─────────
const CH = new Map();
let chN = 0;
function niceTicks(lo, hi, n = 4) {
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), e = step0 / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const tickUsd = (v) => { const a = Math.abs(v), s = v < 0 ? MINUS : ""; return a >= 1e4 ? `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K` : Number.isInteger(v) ? `${s}$${a.toLocaleString("en-US")}` : `${s}$${a.toFixed(2)}`; };
function equityHtml(points, title) {
  const pts = rows(points).map((p) => ({ t: toMs(p?.ts), v: N(p?.usd) })).filter((p) => p.t != null && p.v != null).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return `<div class="b-none">Not enough points</div>`;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (lo === hi) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t > t0 ? pts[pts.length - 1].t : t0 + 1;
  const X = (t) => ((t - t0) / (t1 - t0)) * 1000, Y = (v) => (1 - (v - lo) / (hi - lo)) * 300;
  const id = `bc${++chN}`;
  CH.set(id, { pts, X, Y });
  if (CH.size > 12) CH.delete(CH.keys().next().value);
  const base = pts[0].v, up = pts[pts.length - 1].v >= base, col = up ? "var(--hi)" : "var(--bad)";
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const ticks = niceTicks(lo, hi).filter((t) => t >= lo && t <= hi);
  const span = t1 - t0, xl = (ms) => new Date(ms).toLocaleString("en-US", span > 2 * 86400e3 ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `<div class="b-chart"><div class="b-cth">${esc(title)}<span>${usd(pts[0].v)} → <b class="${up ? "b-up" : "b-down"}">${usd(pts[pts.length - 1].v)}</b></span></div>
    <div class="b-yax" aria-hidden="true">${ticks.map((t) => `<span style="top:${(Y(t) / 3).toFixed(2)}%">${tickUsd(t)}</span>`).join("")}</div>
    <div class="b-plot" tabindex="0" data-chart="${id}" role="img" aria-label="${esc(title)}: ${usd(pts[0].v)} to ${usd(pts[pts.length - 1].v)}. Arrow keys step through points.">
      <svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
        ${ticks.map((t) => `<line class="b-gl" x1="0" x2="1000" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/>`).join("")}
        <line class="b-base" x1="0" x2="1000" y1="${Y(base).toFixed(1)}" y2="${Y(base).toFixed(1)}"/>
        <path class="b-area" d="${line}L1000,300L0,300Z" style="fill:${col}"/>
        <path class="b-line" d="${line}" style="stroke:${col}"/>
      </svg>
      <div class="b-xh" hidden></div><div class="b-dot" hidden style="background:${col}"></div><div class="b-tip" hidden></div>
    </div>
    <div></div><div class="b-xax" aria-hidden="true"><span>${xl(t0)}</span><span>${xl((t0 + t1) / 2)}</span><span>${xl(t1)}</span></div>
  </div>`;
}
function onChartMove(e) {
  const plot = e.target.closest?.(".b-plot"); if (!plot) return;
  const c = CH.get(plot.dataset.chart); if (!c) return;
  const r = plot.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000;
  let best = 0;
  for (let i = 1; i < c.pts.length; i++) if (Math.abs(c.X(c.pts[i].t) - x) < Math.abs(c.X(c.pts[best].t) - x)) best = i;
  showPt(plot, c, best);
}
function showPt(plot, c, i) {
  const p = c.pts[i]; plot.dataset.i = i;
  const x = c.X(p.t) / 10, y = c.Y(p.v) / 3;
  const xh = plot.querySelector(".b-xh"), dot = plot.querySelector(".b-dot"), tip = plot.querySelector(".b-tip");
  xh.hidden = dot.hidden = tip.hidden = false;
  xh.style.left = dot.style.left = tip.style.left = `${x}%`;
  dot.style.top = `${y}%`;
  const b = document.createElement("b"); b.textContent = usd(p.v);
  const s = document.createElement("small"); s.textContent = fullTime(p.t);
  tip.replaceChildren(b, s);
  tip.style.transform = x > 62 ? "translateX(calc(-100% - 12px))" : "translateX(12px)";
}
function hidePt(plot) { plot.querySelectorAll(".b-xh,.b-dot,.b-tip").forEach((x) => { x.hidden = true; }); }
function stepChart(plot, d) {
  const c = CH.get(plot.dataset.chart); if (!c) return;
  const cur = plot.dataset.i == null ? (d > 0 ? -1 : c.pts.length) : Number(plot.dataset.i);
  showPt(plot, c, Math.min(c.pts.length - 1, Math.max(0, cur + d)));
}

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function onClick(e) {
  const t = e.target;
  if (t.id === "mkDlg") return closePay(); // a click on the backdrop
  const a = t.closest("[data-lppath],[data-go],[data-open],[data-act],[data-days],[data-btdays],[data-type],[data-tog],[data-rm],[data-rmm],[data-win],[data-copy],[data-smart],[data-tstart],[data-tbuild],[data-lpsort],[data-lpdays],[data-lppreset],[data-lptog],[data-mk],[data-mkw],[data-mksort],[data-mkcopy]");
  if (!a || !root.contains(a)) return;
  if (a.matches("[data-open]") && t.closest("a[href]")) return;
  const ds = a.dataset;
  if (ds.act === "back") return goBack(ds.to);
  if (ds.lppath) { if (S.lp.path !== ds.lppath) { S.lp.path = ds.lppath; paintForm(); } return; }
  if (ds.go) return go(ds.go, { type: ds.type });
  if (ds.open) return go("detail", { id: ds.open, pub: ds.pub === "1" });
  if (ds.type) { if (S.f.type !== ds.type) { S.f.type = ds.type; setMsg("", false); paintForm(); } return; }
  if (ds.days) { S.f.days = Number(ds.days); S.f.more = false; a.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === a)); paintTraders(); loadTraders(); return; }
  if (ds.btdays) { S.f.btDays = Number(ds.btdays); a.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === a)); stale(); return; }
  if (ds.tog) { S.f[ds.tog] = !S.f[ds.tog]; a.setAttribute("aria-checked", String(S.f[ds.tog])); stale(); return; }
  if (ds.rm != null) { S.f.wallets = S.f.wallets.filter((w) => w !== ds.rm); hint("bAddMsg", ""); paintSel(); return; }
  if (ds.rmm != null) { S.f.mints = S.f.mints.filter((m) => m !== ds.rmm); paintSel(); return; }
  if (ds.win) { if (H.win !== ds.win) { H.win = ds.win; paintLb(); loadLb(); } return; }
  if (ds.copy) return void copyAgent(ds.copy, a, S.det?.id === ds.copy ? S.det.mk?.listing?.title ?? S.det.data?.bot?.name : undefined);
  if (ds.mkcopy) return void copyAgent(ds.mkcopy, a, (MK.lists[MK.sort] ?? []).find((l) => l.id === ds.mkcopy)?.title ?? S.det?.mk?.listing?.title);
  if (ds.mksort) { if (MK.sort !== ds.mksort) { MK.sort = ds.mksort; paintMarket(); loadMarket(); } return; }
  if (ds.mkw) { if (MK.pay && !MK.pay.busy) { MK.pay.wallet = ds.mkw; paintPayFoot(); } return; }
  if (ds.mk) {
    if (ds.mk === "close") return closePay();
    if (ds.mk === "pay") return void payGo();
    if (ds.mk === "redeem") { const P = MK.pay; if (P?.sig) payRun(P, () => redeemPay(P)); return; }
    if (ds.mk === "create") return void payCreateWallet();
    if (ds.mk === "signin") return paySignIn();
    return;
  }
  if (ds.smart) { const tk = rows(H.smart?.tokens).find((x) => x.mint === ds.smart); if (tk) go("build", { strategy: smartStrategy(tk) }); return; }
  if (ds.tstart) return void startTpl(ds.tstart, a);
  if (ds.tbuild) { const tp = tplOf(ds.tbuild); if (tp) go("build", { template: ds.tbuild, strategy: tp.strategy }); return; } // the builder marks it Loaded
  if (ds.lpsort) { if (S.lp.sort !== ds.lpsort) { S.lp.sort = ds.lpsort; segOn(a); paintScan(); loadScan(); } return; }
  if (ds.lpdays) { S.lp.days = Number(ds.lpdays); segOn(a); lpStale(); return; }
  if (ds.lppreset) {
    if (S.lp.preset !== ds.lppreset) { S.lp.preset = ds.lppreset; paintRange(); lpStale(); if (ds.lppreset === "custom") root.querySelector('input[data-lp="custom"]')?.focus(); }
    return;
  }
  if (ds.lptog) { S.lp[ds.lptog] = !S.lp[ds.lptog]; a.setAttribute("aria-checked", String(S.lp[ds.lptog])); lpStale(); return; }
  switch (ds.act) {
    case "lc-reload": return paintForm();
    case "retry-bots": S.botsErr = null; paintMine(); return void loadBots();
    case "retry-stats": H.statsErr = null; paintKpis(); return void loadStats();
    case "retry-smart": H.smartErr = null; paintSmart(); return void loadSmart();
    case "retry-lb": H.boardErr = null; paintLb(); return void loadLb();
    case "mk-retry": MK.err = null; paintMarket(); return void loadMarket();
    case "mk-open": return mkOpen();
    case "mk-cancel": if (S.det) { S.det.mk.open = false; paintHead(); paintMk(); } return;
    case "mk-save": return void mkSave();
    case "mk-unlist": return void mkUnlist();
    case "lb-all": { H.lbAll = !H.lbAll; paintLb(); if (!H.lbAll) $("agBoardS")?.scrollIntoView({ block: "start" }); return; }
    case "skg": { const k = ds.k; if (F.open.has(k)) F.open.delete(k); else F.open.add(k); return paintTape(); }
    case "skips": F.skips = !F.skips; a.setAttribute("aria-pressed", String(F.skips)); a.textContent = F.skips ? "Hide skips" : "Show skips"; $("agTape")?.classList.toggle("ag-noskip", !F.skips); return;
    case "flush": return resumeTape();
    case "lp-retry": return void loadScan(true);
    case "lp-more": S.lp.more = !S.lp.more; return paintScan();
    case "lp-range-retry": if (S.lp.pool) { delete S.lp.ranges[S.lp.pool.pool]; loadRange(S.lp.pool.pool); } return;
    case "lpbt": return void runLpBacktest();
    case "retry-det": if (S.det) { S.det.err = null; paintDetail(); loadDetail(); } return;
    case "traders-retry": return void loadTraders(true);
    case "retry-build": return go("build");
    case "fork": { const sp = stratOf(S.det?.data?.bot); if (sp) go("build", { strategy: sp }); return; }
    case "more": S.f.more = !S.f.more; return paintTraders();
    case "top3": {
      const list = S.traders[S.f.days]?.list ?? [];
      let added = 0;
      for (const tr of list) { if (added >= 3 || S.f.wallets.length >= MAX_WALLETS) break; if (!S.f.wallets.includes(tr.wallet)) { S.f.wallets.push(tr.wallet); added++; } }
      if (!list.length) hint("bAddMsg", "The trader list has not loaded yet.");
      return paintSel();
    }
    case "addw": return addAddr("bAddW", "bAddMsg", S.f.wallets, MAX_WALLETS, "wallet");
    case "addm": return addAddr("bAddM", "bAddMMsg", S.f.mints, MAX_MINTS, "token");
    case "bt": return void runBacktest();
    case "bt-all": S.f.btAll = true; return paintBt();
    case "create": return void createBot();
    case "pause": case "resume": return void setStatus(ds.act);
    case "del": if (S.det) { S.det.confirm = true; S.det.msg = null; paintHead(); } return;
    case "del-no": if (S.det) { S.det.confirm = false; paintHead(); } return;
    case "del-yes": return void delBot();
    case "fills-more": if (S.det) { S.det.nFills += 100; paintFills(); } return;
    case "ev-more": if (S.det) { S.det.nEv += 100; paintLog(); } return;
    case "logx": if (S.det) { const o = (S.det.logOpen ??= new Set()); if (o.has(ds.k)) o.delete(ds.k); else o.add(ds.k); paintLog(); } return;
  }
}
const segOn = (a) => a.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === a));
function onInput(e) {
  const t = e.target, lk = t.dataset?.lp, mk = t.dataset?.mkf;
  if (mk) {
    if (mk === "price" || mk === "share") { const v = numOnly(t.value, false); if (v !== t.value) t.value = v; }
    if (S.det?.mk?.f) S.det.mk.f[mk] = t.value;
    const n = root.querySelector(`[data-mkn="${mk}"]`); if (n) n.textContent = `${t.value.length}/${mk === "title" ? 48 : 280}`;
    if ($("mkMsg")?.classList.contains("bad")) mkMsg("", false);
    if (S.det?.mk?.f) mkShowErr(t, mk); // also while Save waits for the agent's first hour
    paintMkSum();
    return;
  }
  if (lk) {
    const v = numOnly(t.value, lk === "oor" || lk === "maxDay");
    if (v !== t.value) t.value = v;
    S.lp[lk] = t.value;
    showFieldErr(t, "lp", lk);
    if (lk === "custom" && S.lp.preset !== "custom") { S.lp.preset = "custom"; root.querySelectorAll("[data-lppreset]").forEach((x) => { x.classList.toggle("on", x.dataset.lppreset === "custom"); if (x.tagName === "BUTTON") x.setAttribute("aria-pressed", String(x.dataset.lppreset === "custom")); }); }
    if ($("bMsg")?.classList.contains("bad")) { setMsg("", false); paintGo(); }
    lpStale();
    return;
  }
  const k = t.dataset?.f;
  if (!k) return;
  if (NUMF.has(k)) {
    const v = numOnly(t.value, k === "maxOpen");
    if (v !== t.value) t.value = v;
  }
  S.f[k] = t.value;
  if (NUMF.has(k)) showFieldErr(t, "f", k);
  if (k === "usd") { const m = $("bMaxTok"); if (m) m.placeholder = defMaxTok(); }
  if ($("bMsg")?.classList.contains("bad")) { setMsg("", false); paintGo(); }
  stale();
}
function onChange(e) {
  const t = e.target;
  if (t.matches?.("input[data-w]")) toggleWallet(t.dataset.w, t.checked);
  else if (t.matches?.("input[data-lppool]")) pickPool(t.dataset.lppool);
  else if (t.matches?.("select[data-lpdex]")) { S.lp.dex = t.value; paintScan(); loadScan(); }
}
function onKey(e) {
  const t = e.target;
  if (e.key === "Escape" && MK.pay) { e.preventDefault(); return closePay(); }
  if (e.key === "Enter" && t.id === "bAddW") { e.preventDefault(); addAddr("bAddW", "bAddMsg", S.f.wallets, MAX_WALLETS, "wallet"); }
  else if (e.key === "Enter" && t.id === "bAddM") { e.preventDefault(); addAddr("bAddM", "bAddMMsg", S.f.mints, MAX_MINTS, "token"); }
  else if ((e.key === "Enter" || e.key === " ") && t.matches?.("[data-open][role=button]")) { e.preventDefault(); t.click(); }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && t.classList?.contains("b-plot")) { e.preventDefault(); stepChart(t, e.key === "ArrowRight" ? 1 : -1); }
}
