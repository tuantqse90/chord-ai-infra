// Agents on Monad: copy-trader, alert and custom agents trading on paper, priced by Chord's router, every fill committed to the
// agent's ERC-8004 track record on Monad (trust.js shows the record and checks it in the browser).
// API: /v1/agents* (alias of /v1/bots*) and /v1/trust/*. Every request carries X-Session; every server string is escaped.
// Screens (hash routes): #agents = Overview (the record on Monad, live numbers, top agents, live tape, smart money, templates) ·
// #agents/leaderboard · #agents/traders (Chord's Monad smart traders, the board behind Copy trader) · #agents/mine · #agents/new ·
// #agents/new/alert · #agents/build · #agents/build/<templateId> (builder.js, loaded lazily) · #agents/classic[/<id>] (classic.js,
// loaded lazily: textbook strategies backtested on four data sources, run on Perpl perps or Monad spot) · #agents/<id> · #agents/public/<id>.
// #bots/… opens the same screens. Visible copy says "agent"; code identifiers still say bot. Numbers carry the screen; notes
// sit behind a closed (i) popover, full sentences in titles.
// every agent's mark: two letters of its name on a neutral square (the words carry the type; no mascot faces)
const agentInitials = (n) => { const w = String(n ?? "").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] ?? "A") + (w[1]?.[0] ?? w[0]?.[1] ?? "")).toUpperCase(); };
const av = (b, size) => `<span class="ag-av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" aria-hidden="true">${esc(agentInitials(b?.name))}</span>`;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const EXPLORER = "https://monadscan.com";
const EXP = { tx: `${EXPLORER}/tx/`, acct: `${EXPLORER}/address/`, token: `${EXPLORER}/token/` };
/** ERC-8004 Identity Registry on Monad: an agent's identity is its token id there */
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const idUrl = (agentId) => `${EXP.token}${IDENTITY}?a=${encodeURIComponent(agentId)}`;
const ADDR = /^0x[0-9a-fA-F]{40}$/; // a Monad address
const TXH = /^0x[0-9a-fA-F]{64}$/; // a Monad transaction hash
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
  chl: '<path d="m15 6-6 6 6 6"/>',
  chr: '<path d="m9 6 6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
};
const svg = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] ?? ""}</svg>`;
const ic = (n, sw) => `<i class="b-i${n === "spin" ? " b-spin" : ""}">${svg(n, sw)}</i>`;

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const MINUS = "-";
const N = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const toMs = (t) => { const n = N(t); return n == null ? null : n < 1e12 ? n * 1000 : n; }; // the contract does not say s or ms
const short = (s, a = 4, b = 4) => { s = String(s ?? ""); return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
const int = (x) => { const n = N(x); return n == null ? "0" : Math.round(n).toLocaleString("en-US"); };
const plural = (n, w) => `${int(n)} ${w}${N(n) === 1 ? "" : "s"}`;
function usd(x) {
  const n = N(x); if (n == null) return "-";
  const a = Math.abs(n), s = n < 0 ? MINUS : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1000) return `${s}$${Math.round(a).toLocaleString("en-US")}`;
  if (a > 0 && a < 0.01) return `${s}<$0.01`;
  return `${s}$${a.toFixed(2)}`;
}
const signed = (x) => { const n = N(x); return n == null ? "-" : n > 0 ? `+${usd(n)}` : usd(n); };
const cls = (x) => { const n = N(x); return n == null || n === 0 ? "" : n > 0 ? "b-up" : "b-down"; };
const pct = (x) => { const n = N(x); if (n == null) return "-"; const v = n * 100; return `${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`; };
const signedPct = (x) => { const n = N(x); return n == null ? "-" : `${n > 0 ? "+" : n < 0 ? MINUS : ""}${pct(Math.abs(n))}`; };
const compact = (x) => { const n = N(x); if (n == null) return "-"; const a = Math.abs(n); return a >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`; };
const SUB = "₀₁₂₃₄₅₆₇₈₉";
function price(x) {
  const p = N(x); if (p == null) return "-";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(p >= 100 ? 2 : 3)}`;
  if (p <= 0) return "$0";
  const zeros = Math.floor(-Math.log10(p)); // 0.0000123 → 4 zeros after the point
  if (zeros >= 4) return `$0.0${String(zeros).split("").map((d) => SUB[d]).join("")}${Math.round(p * 10 ** (zeros + 3))}`;
  return `$${p.toPrecision(4)}`;
}
function qty(x) {
  const n = N(x); if (n == null) return "-";
  const a = Math.abs(n);
  return a >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : a >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : a ? n.toPrecision(3) : "0";
}
function ago(t) {
  const ms = toMs(t); if (ms == null) return "-";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 10 ? "just now" : s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
const age = (t) => { const ms = toMs(t); if (ms == null) return "-"; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 3600 ? `${Math.max(1, Math.floor(s / 60))}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const dur = (sec) => { const s = N(sec); if (s == null) return "-"; return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h` : `${(s / 86400).toFixed(1)}d`; };
const daysLabel = (d) => (Number(d) === 1 ? "24 hours" : `${int(d)} days`);
const dayTag = (d) => (Number(d) === 1 ? "24h" : `${int(d)}d`);
/** { hm: "14:03:21", day: "Oct 6" | null when today } */
function when(t) {
  const ms = toMs(t); if (ms == null) return { hm: "-", day: null };
  const d = new Date(ms);
  return { hm: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), day: d.toDateString() === new Date().toDateString() ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
}
const fullTime = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const imgOf = (o) => { const u = o?.image ?? o?.logo ?? o?.logoURI ?? null; return /^https:\/\//.test(String(u ?? "")) || /^\/[^/]/.test(String(u ?? "")) ? String(u) : null; };
// Token pictures: a Monad token goes through Chord's logo route first, a third-party picture is the second try; the monogram
// underneath (two letters on the token's own hue) shows while the picture loads and stays when it fails. app.js swaps / drops
// the images (img[data-tl] load and error, caught on the document).
const hueOf = (s) => { let h = 7; for (const ch of String(s ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (sym) => (String(sym ?? "").replace(/^\$/, "").replace(/^0x/i, "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
/** pictures that failed once on this page: a repaint draws the monogram (or the fallback) at once, no new request.
 *  Caught on window, before app.js's document listener swaps the src or drops the image. */
const FAILED = new Set();
addEventListener("error", (e) => { const img = e.target; if (img instanceof HTMLImageElement && img.hasAttribute("data-tl")) { const s = img.getAttribute("src"); if (s) FAILED.add(s); } }, true);
function tokLogo(symbol, img, size = "", mint = null) {
  const m = typeof mint === "string" && ADDR.test(mint) ? mint : null;
  const own = m ? LOGO(m) : null;
  const third = img && img !== own ? img : null;
  let src = own ?? third;
  let alt = own && third ? third : null;
  if (alt && FAILED.has(alt)) alt = null;
  if (src && FAILED.has(src)) { src = alt; alt = null; }
  return `<span class="tlogo b-tl${size ? ` ${size}` : ""}" style="--mh:${hueOf(m ?? symbol)}"><b>${esc(initials(symbol))}</b>${src ? `<img data-tl src="${esc(src)}"${alt ? ` data-alt="${esc(alt)}"` : ""} alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}
const rows = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === "object") : []); // drop malformed rows instead of failing the screen
const symOf = (s, mint) => (s ? String(s) : short(mint));
const STATUS = { running: "Running", paused: "Paused", stopped: "Stopped", error: "Error" };
const statusHtml = (s) => `<span class="b-st ${STATUS[s] ? s : ""}"><i></i>${esc(STATUS[s] ?? s ?? "Unknown")}</span>`;
const badge = (mode) => `<span class="b-badge${mode === "live" ? " live" : ""}">${mode === "live" ? "Live" : "Paper"}</span>`;
const tile = (k, v, sub = "", c = "") => `<div class="b-tile"><small>${esc(k)}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
/** a tile whose label carries a chip (est.) */
const tileH = (kHtml, v, sub = "", c = "") => `<div class="b-tile"><small>${kHtml}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
const errBox = (msg, act) => `<div class="b-errbox">${ic("alert")}<span>${esc(msg)}</span>${act ? `<button type="button" class="b-btn" data-act="${act}">Try again</button>` : ""}</div>`;
const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
/** "4 s ago" / "3 min ago" (the live parts of the page tick every second through <time data-at>) */
function agoS(t) {
  const ms = toMs(t); if (ms == null) return "-";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}
/** "12s" / "4m" / "3h" / "2d": the terminal clock (time[data-at][data-c] ticks every second on Home, the full time in its title) */
function agoC(t) {
  const ms = toMs(t); if (ms == null) return "-";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const agoCTag = (t) => { const ms = toMs(t); return ms == null ? "-" : `<time data-at="${ms}" data-c="1" title="${esc(fullTime(ms))}">${agoC(ms)}</time>`; };
/** notes, methodology and long explanations: a small (i) that opens a popover, closed by default (its host is position: relative) */
const info = (html, label = "Notes") => (html ? `<details class="ag-i"><summary aria-label="${esc(label)}" title="${esc(label)}">${svg("info", 2)}</summary><div class="ag-ip">${html}</div></details>` : "");
const noteList = (ns) => (ns.length > 1 ? `<ul>${ns.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ns.length ? `<p>${esc(ns[0])}</p>` : "");
const PAPER = `<em class="ag-pp" title="Paper mode: nothing is sent">Paper</em>`;
const secs = (x) => { const n = N(x); return n == null ? "-" : `${n < 10 ? n.toFixed(1) : Math.round(n)} s`; };
/** a value that is already in percent (-21 = -21 %) */
const pctPts = (x) => { const n = N(x); if (n == null) return "-"; const a = Math.abs(n); return `${n > 0 ? "+" : n < 0 ? MINUS : ""}${a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toFixed(a >= 100 ? 0 : 1)}%`; };
const LOGO = (mint) => `https://api.getchord.xyz/v1/logo/143/${encodeURIComponent(String(mint).toLowerCase())}`;
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
const S = { screen: null, vis: false, bots: null, botsErr: null, det: null, traders: {}, f: freshForm(), tick: null, ctrl: null, live: "off", posT: null, timers: [] };
/** the overview's data (kept across visits so a return paints at once, then refreshes) */
const H = { stats: null, statsErr: null, trust: null, smart: null, smartErr: null, smartPrev: null, win: "today", boards: {}, boardErr: null, moves: {}, tpls: undefined, tplAt: 0,
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

// ── entry points ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** deps: { showView(v), session: string | () => string, icon?(name) }. Renders into <section id="botsv">. */
export function initBots(deps) {
  D = deps ?? {};
  root = $("botsv");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  const tab = (go, label, extra = "") => `<button type="button" role="tab" data-go="${go}">${label}${extra}</button>`;
  root.innerHTML = `<div class="b-wrap">
    <header class="ag-top">
      <div class="ag-ttl"><h1>Agents</h1><span class="ag-mode" title="Monad mainnet, chain 143. Nothing is sent: every fill is priced by a real quote.">Paper trading on Monad</span>${info("Agents trade Monad on paper: every fill is priced by a real router quote from Chord and nothing is sent. Each fill is hashed and committed to the agent's ERC-8004 track record on Monad seconds after it happens, so the record cannot be edited after the outcome is known. Check any record in your browser, copy an agent in one click.", "About agents")}</div>
      <button type="button" class="b-new" data-go="create">${ic("plus", 2.2)}New agent</button>
    </header>
    <nav class="ag-tabs" role="tablist" aria-label="Agents">${tab("home", "Overview")}${tab("board", "Leaderboard")}${tab("traders", "Smart traders")}${tab("classic", "Classic")}${tab("lp", "LP pools")}${tab("mine", "My agents", `<span class="ag-cnt" id="agMineCnt"></span>`)}</nav>
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

/** Open the view. opts: { screen: "home" | "board" | "traders" | "mine" | "create" | "build" | "detail", id?, pub?, type?: "copy" | "alert",
 *  prefill?: CopyParams & AlertParams & { name, type }, template?, strategy?, explanation?, text? (build) } or a hash tail ("new",
 *  "new/alert", "build", "build/<templateId>", "leaderboard", "traders", "mine", "<id>", "public/<id>"). No opts: the #agents… / #bots…
 *  hash, else the last screen. */
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
  if (!rest || ["market", "marketplace", "lps", "smart-lps"].includes(rest)) return { screen: "home" };
  if (rest === "mine") return { screen: "mine" };
  if (rest === "new" || rest === "create" || rest === "new/copy" || rest.startsWith("new/lp")) return { screen: "create", type: "copy" };
  if (rest === "new/alert") return { screen: "create", type: "alert" };
  if (rest === "build") return { screen: "build" };
  const lm = /^lp(?:\/(0x[0-9a-fA-F]{40}))?$/.exec(rest);
  if (lm) return { screen: "lp", pool: lm[1] ? lm[1].toLowerCase() : null };
  const cm = /^classic(?:\/([a-z0-9-]+))?$/.exec(rest);
  if (cm) return { screen: "classic", strategy: cm[1] ?? null };
  const bm = /^build\/(.+)$/.exec(rest);
  if (bm) return { screen: "build", template: decodeURIComponent(bm[1]) };
  if (rest === "leaderboard" || rest === "board") return { screen: "board" };
  if (rest === "traders" || rest === "smart-traders") return { screen: "traders" };
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
/** a deep link opened in a fresh tab: put the Agents overview under it, so Back from it stays on the site */
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
const BACK_LABEL = [[/^#agents$/, "Overview"], [/^#agents\/(leaderboard|board)$/, "Leaderboard"], [/^#agents\/(smart-)?traders$/, "Smart traders"], [/^#agents\/mine$/, "My agents"], [/^#agents\/(new|create)/, "New agent"], [/^#agents\/build/, "Builder"], [/^#agents\/public\//, "Agent"]];
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
  if (S.screen === "home") { loadStats(true); loadTrust(); loadLb(true); loadSmart(true); loadBots(true); if (!F.ctrl) startFeed(); }
  else if (S.screen === "board") { loadLb(true); loadBots(true); }
  else if (S.screen === "mine") loadBots(true);
  else if (S.screen === "traders") loadSt();
  else if (S.screen === "detail" && S.det) { loadDetail(true); if (!S.det.pub && !S.ctrl) startLive(); }
}
function stopAll() { stopLive(); stopFeed(); S.timers.forEach(clearInterval); S.timers = []; clearInterval(S.tick); S.tick = null; clearTimeout(S.posT); }
const every = (ms, fn) => S.timers.push(setInterval(() => { if (vis()) fn(); }, ms));
/** the screen on show is one of these */
const on = (...screens) => screens.includes(S.screen);
/** the tab of the screen on show (the detail of an agent opened from the leaderboard marks no tab) */
function markTab(cur) { root.querySelectorAll(".ag-tabs [data-go]").forEach((b) => { const it = b.dataset.go === cur; b.classList.toggle("on", it); b.setAttribute("aria-selected", String(it)); if (it) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }); }
const HASH = { home: "#agents", board: "#agents/leaderboard", traders: "#agents/traders", mine: "#agents/mine" };
const TAB_OF = { classic: "classic", lp: "lp" }; // screens with a tab but their own address (a strategy / a pool in the hash)

function go(screen, o = {}) {
  stopAll();
  if (screen === "market" || screen === "lps") screen = "home";
  if (screen === "detail" && !o.id) screen = "home";
  S.screen = screen;
  markTab(HASH[screen] ? screen : TAB_OF[screen] ?? null);
  root.querySelector(".b-wrap")?.classList.toggle("ag-wide", screen !== "create" && screen !== "build" && screen !== "classic");
  const main = $("bMain"), mode = o.replace ? "replace" : "push";
  if (HASH[screen]) nav(HASH[screen], mode);
  if (screen === "home") {
    main.innerHTML = homeHtml();
    // first visit to the Agents overview: its tooltip tour, once per browser (tour.js; the top bar's "?" replays it)
    if (!S.tourTried) {
      S.tourTried = true;
      import(`./tour.js${new URL(import.meta.url).search}`).then((m) => {
        if (!m.tourSeen("agents")) setTimeout(() => { if (S.screen === "home" && !root.hidden && !m.tourActive()) m.startTour("agents"); }, 1200);
      }).catch(() => {});
    }
    paintTrust(); paintKpis(); paintTape(); paintSmart(); paintLb(); paintTpls(); paintCls();
    loadTrust(); loadStats(); loadSmart(); loadLb(); loadTpls(); loadCls(); loadBots(true);
    startFeed();
    every(10_000, () => { loadStats(true); loadBots(true); });
    every(15_000, () => { loadLb(true); loadTrust(); });
    every(30_000, () => loadSmart(true));
    every(1000, tickAgo);
  } else if (screen === "board") {
    main.innerHTML = boardHtml();
    paintLb(); loadLb(); loadBots(true);
    every(15_000, () => loadLb(true));
    every(1000, tickAgo);
  } else if (screen === "traders") {
    main.innerHTML = stHtml();
    paintSt(); loadSt();
    every(60_000, () => loadSt(true));
    every(1000, tickAgo);
  } else if (screen === "mine") {
    main.innerHTML = mineHtml();
    paintMine(); paintTpls(); paintCls(); loadBots(); loadTpls(); loadCls();
    every(10_000, () => loadBots(true));
    every(1000, tickAgo);
  } else if (screen === "create") {
    if (o.type === "copy" || o.type === "alert") S.f.type = o.type;
    nav(createHash(), mode);
    main.innerHTML = createHtml();
    paintSel(); paintGo();
    if (S.f.type === "copy") loadTraders();
  } else if (screen === "build") {
    nav(o.template ? `#agents/build/${encodeURIComponent(o.template)}` : "#agents/build", mode);
    main.innerHTML = `<div id="bBuild" class="bb-host"><div class="b-skel" style="height:44px;width:40%"></div><div class="b-skel" style="height:220px;margin-top:18px"></div></div>`;
    openBuilder(o);
  } else if (screen === "lp") {
    nav(o.pool ? `#agents/lp/${o.pool}` : "#agents/lp", mode);
    main.innerHTML = `<div id="bLp" class="bb-host"><div class="b-skel" style="height:44px;width:40%"></div><div class="b-skel" style="height:260px;margin-top:18px"></div></div>`;
    openLp(o);
  } else if (screen === "classic") {
    nav(o.strategy ? `#agents/classic/${encodeURIComponent(o.strategy)}` : "#agents/classic", mode);
    main.innerHTML = `<div id="bCls" class="bb-host"><div class="b-skel" style="height:44px;width:40%"></div><div class="b-skel" style="height:220px;margin-top:18px"></div></div>`;
    openClassic(o);
  } else if (screen === "detail") {
    S.det = { id: String(o.id), pub: !!o.pub, data: null, err: null, confirm: false, busy: null, msg: null, nFills: 50, nEv: 40, fresh: new Set(), commits: new Map(), agentId: null, verify: !!o.verify };
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
// ── LP agents (lp.js, loaded on first use): Monad pools from Chord's LP index, every range replayed, start one ─────────────
let LMp = null;
const lpMod = () => (LMp ??= import(`./lp.js${new URL(import.meta.url).search}`).catch((e) => { LMp = null; throw e; }));
async function openLp(o) {
  let m;
  try { m = await lpMod(); }
  catch { const el = $("bLp"); if (el && S.screen === "lp") el.innerHTML = errBox("The LP screen failed to load. Check your connection.", "retry-lp"); return; }
  const el = $("bLp");
  if (!el || S.screen !== "lp") return;
  m.renderLp(el, {
    api, crumb: () => crumbHtml("home", "Overview"), setHash,
    onCreated: (bot) => { S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)]; go("detail", { id: bot.id }); },
    ui: { esc, usd, signed, cls, pct, int, ic, errBox, equityHtml, info },
    route: { pool: o.pool ?? null },
  });
}
// ── Classic strategies (classic.js, loaded on first use): backtest a textbook strategy on four data sources, start it ─────
let CM = null, CMp = null;
const classicMod = () => (CMp ??= import(`./classic.js${new URL(import.meta.url).search}`).then((m) => (CM = m)).catch((e) => { CMp = null; throw e; }));
async function openClassic(o) {
  let m;
  try { m = await classicMod(); }
  catch { const el = $("bCls"); if (el && S.screen === "classic") el.innerHTML = errBox("The classic strategies screen failed to load. Check your connection.", "retry-cls"); return; }
  const el = $("bCls");
  if (!el || S.screen !== "classic") return;
  m.renderClassic(el, {
    api, crumb: () => crumbHtml("home", "Overview"), setHash,
    onCreated: (bot) => { S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)]; go("detail", { id: bot.id }); },
    ui: { esc, usd, signed, cls, pct, int, ic, errBox, equityHtml, info },
    route: { strategy: o.strategy ?? null, prefill: o.prefill ?? null },
  });
}
H.cls = undefined; H.clsAt = 0;
async function loadCls() {
  if (H.cls !== undefined && Date.now() - H.clsAt < 300_000) return paintCls();
  try { const j = await api("/v1/classic/templates"); H.cls = rows(j.templates); H.clsAt = j.building ? 0 : Date.now(); }
  catch { H.cls = null; H.clsAt = Date.now(); }
  try { H.clsBoard = rows((await api("/v1/classic/board")).rows); } catch { H.clsBoard = null; }
  if (on("home", "mine")) paintCls();
}
const clsTitle = (id) => (H.cls ?? []).find((t) => t.id === id)?.title ?? id;
const pctCell = (v) => { const m = N(v); return `<span class="b-n ${cls(m)}">${m == null ? "-" : `${m > 0 ? "+" : ""}${Math.abs(m) >= 100 ? m.toFixed(0) : m.toFixed(1)}%`}</span>`; };
/** the board's setups up in every window, best 6 months first */
function paintCls() {
  const s = $("agClsS"), el = $("agCls"); if (!s || !el) return;
  const m = (r, w) => N(r.windows?.[w]?.median);
  const good = rows(H.clsBoard).filter((r) => [30, 90, 180].every((w) => (m(r, w) ?? -1) > 0 && r.windows[w].agree !== false)).sort((a, b) => m(b, 180) - m(a, 180)).slice(0, 8);
  s.hidden = !good.length;
  if (good.length) el.innerHTML = `<div class="ag-list ag-bt"><div class="ag-li head" aria-hidden="true"><span>Strategy</span><span>1 month</span><span>3 months</span><span>6 months</span><span>Hold</span><span>Drawdown</span></div>${good.map((r) => `<button type="button" class="ag-li" data-cls="${esc(r.strategy)}" data-sym="${esc(r.symbol)}" data-tf="${esc(r.tf)}" title="${esc(`Open ${clsTitle(r.strategy)} on ${r.symbol} ${r.tf}: backtest it on four sources, start it`)}">
      <span class="ag-lin"><b>${esc(r.symbol)} ${esc(clsTitle(r.strategy))}</b><small>${esc(r.tf)}</small></span>${pctCell(m(r, 30))}${pctCell(m(r, 90))}${pctCell(m(r, 180))}<span class="b-n dim">${r.holdPct?.[180] == null ? "-" : `${N(r.holdPct[180]) > 0 ? "+" : ""}${Number(r.holdPct[180]).toFixed(0)}%`}</span><span class="b-n dim">${N(r.windows[180].maxDrawdownPct) == null ? "-" : `${Math.round(r.windows[180].maxDrawdownPct)}%`}</span></button>`).join("")}</div>`;
}
/** "1M +x · 3M +y · 6M +z": the backtest board's medians across sources for one setup */
function winLine(strategy, symbol, tf, board) {
  const r = rows(board).find((x) => x.strategy === strategy && x.symbol === symbol && x.tf === tf);
  if (!r) return "";
  const c = (w, l) => { const m = N(r.windows?.[w]?.median); return `<span title="${esc(`Median across sources, last ${l === "1M" ? "month" : l === "3M" ? "3 months" : "6 months"}, $1,000 at 1x on Perpl`)}"><small>${l}</small><b class="${cls(m)}">${m == null ? "-" : `${m > 0 ? "+" : ""}${m.toFixed(1)}%`}</b></span>`; };
  return `<div class="ag-cw">${c(30, "1M")}${c(90, "3M")}${c(180, "6M")}</div>`;
}
async function startCls(id, btn) {
  const t = (H.cls ?? []).find((x) => x.id === id); if (!t || btn?.disabled) return;
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `${ic("spin")}Starting…`; }
  try {
    const j = await api("/v1/agents", { method: "POST", body: { type: "classic", mode: "paper", params: { strategy: id, symbol: "BTC", venue: "perpl", sizeUsd: 1000, leverage: 1, signalSource: "binance", templateId: id } } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)];
    toast(`${bot.name || "Your agent"} runs on paper now.`);
    go("detail", { id: bot.id });
  } catch (e) { toast(e.message); if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}
const PERPL_APP = "https://app.perpl.xyz";
const tokHref = (m) => (String(m).startsWith("perpl:") ? PERPL_APP : String(m).startsWith("lp:") ? `${EXP.acct}${encodeURIComponent(String(m).slice(3))}` : `${EXP.token}${encodeURIComponent(m)}`);

const stratOf = (b) => (b?.type === "custom" && b.params?.strategy && typeof b.params.strategy === "object" ? b.params.strategy : null);
/** custom bots: the action decides whether the bot holds positions (buy / sell) or only reports matches (alert / webhook) */
const trades = (b) => b?.type === "copy" || b?.type === "classic" || b?.type === "lp" || (b?.type === "custom" && !["alert", "webhook"].includes(stratOf(b)?.action?.type));
/** plain lines for a custom bot: the server's when it sends them, else builder.js explains the strategy (loads it once, then repaints) */
function explainOf(b) {
  const x = b.params?.explanation ?? b.explanation;
  if (Array.isArray(x) && x.some((s) => typeof s === "string" && s)) return x.filter((s) => typeof s === "string" && s);
  if (BM) { try { return BM.explain(stratOf(b)); } catch { return []; } }
  builderMod().then(() => { if (on("mine")) paintMine(); else if (on("detail")) paintHero(); }).catch(() => {});
  return [];
}
/** "Trigger: when …" → the block name set apart */
const xlHtml = (x) => { const m = /^(Trigger|Filters|Action|Exits|Limits):\s*/.exec(x); return m ? `<b>${m[1]}</b> ${esc(x.slice(m[0].length))}` : esc(x); };
const typeShort = (b) => ({ copy: "Copy trader", custom: "Custom", classic: "Classic", lp: "LP" })[b.type] ?? "Alert";
const typeLabel = (b) => `${typeShort(b)} agent`;
const typeIcon = (b) => ({ copy: "users", custom: "blocks", lp: "drop" })[b.type] ?? "bell";

// ── Overview: the record on Monad · live numbers · top agents · live tape · smart money right now · templates ─────────────
const WINS = [["today", "Today"], ["7d", "7 days"], ["all", "All time"]];
const winTabs = () => `<div class="b-seg sm" role="tablist" aria-label="Window">${WINS.map(([v, l]) => `<button type="button" role="tab" data-win="${v}" class="${H.win === v ? "on" : ""}" aria-selected="${H.win === v}">${l}</button>`).join("")}</div>`;
function homeHtml() {
  return `<div class="ag-home">
    <section class="ag-kpis ag-load" id="agHero" aria-label="Agents right now"></section>
    <section class="ag-sec" id="agBoardS" aria-labelledby="agBoardH">
      <header class="ag-sh"><h2 id="agBoardH">Top agents</h2>${winTabs()}<button type="button" class="ag-more" data-go="board">Full leaderboard${ic("chr", 2)}</button></header>
      <div id="agBoard"></div>
    </section>
    <div class="ag-row">
      <section class="ag-panel ag-tapep" aria-labelledby="agTapeH">
        <header class="ag-ph"><h2 id="agTapeH">Live tape</h2><span class="ag-live" id="agLive"></span><small class="ag-lag" id="agLag" hidden></small>
          <button type="button" class="ag-tgl" data-act="skips" aria-pressed="${F.skips}" title="Skipped trades show the safety filters at work">${F.skips ? "Hide skips" : "Show skips"}</button></header>
        <div class="ag-tapew"><button type="button" class="ag-newn" id="agNewN" data-act="flush" hidden></button><ol class="ag-tape${F.skips ? "" : " ag-noskip"}" id="agTape"></ol></div>
      </section>
      <section class="ag-panel ag-smartp" aria-labelledby="agSmartH">
        <header class="ag-ph"><h2 id="agSmartH" title="Tokens the day's smart traders bought on Monad in the last 15 minutes">Smart money</h2><small id="agSmartM"></small></header>
        <div class="ag-smh" aria-hidden="true"><span>Token</span><span title="Smart wallets that bought">Wallets</span><span title="Price move since the first smart buy, and USD bought">Move</span></div>
        <div class="ag-smartl" id="agSmart"></div>
      </section>
    </div>
    <section class="ag-sec" id="agTplS" aria-labelledby="agTplH" hidden>
      <header class="ag-sh"><h2 id="agTplH">Start from a template</h2>${info("Paper agents with tested defaults. Start runs one at once; Edit opens it in the builder first. The number on each card is the server's replay of the template over recent days.")}</header>
      <div id="agTpl"></div>
    </section>
    <section class="ag-sec" id="agClsS" aria-labelledby="agClsH" hidden>
      <header class="ag-sh"><h2 id="agClsH">Best backtests</h2>${info("The backtest board's best setups: every classic and quant strategy on every Perpl market, 1h and 4h, replayed over the last 1, 3 and 6 months at $1,000 and 1x on Perpl with fees and funding. Each window is the median of the data sources (Binance, OKX, Hyperliquid, Perpl) that cover it. Hold is the coin itself over the same 6 months. History, not a forecast.", "About the backtests")}<button type="button" class="ag-more" data-go="classic">All strategies${ic("chr", 2)}</button></header>
      <div id="agCls"></div>
    </section>
  </div>`;
}
/** every live clock on the screen: data-c="a" = "5m ago" (the boards), data-c = "5m" (the terminal clock), none = "5 min ago" */
function tickAgo() { root.querySelectorAll("time[data-at]").forEach((t) => { const at = Number(t.dataset.at), s = t.dataset.c === "a" ? ago(at) : t.dataset.c ? agoC(at) : agoS(at); if (t.textContent !== s) t.textContent = s; }); }
const mineIds = () => new Set((S.bots ?? []).map((b) => b.id));

// the record on Monad: what an agent's trust rests on, with the contracts that hold it (/v1/trust/status)
async function loadTrust() {
  try { H.trust = await api("/v1/trust/status"); } catch { /* the card keeps what it showed */ }
  if (on("home")) { paintTrust(); paintKpis(); }
}
const addrA = (a, label) => (ADDR.test(a ?? "") ? `<a class="mono" href="${EXP.acct}${encodeURIComponent(a)}" target="_blank" rel="noopener" title="${esc(`${label}: ${a}`)}">${esc(short(a, 6, 4))}${ic("ext")}</a>` : `<span class="ag-rec-off">not deployed</span>`);
function paintTrust() {
  const el = $("agTrust"); if (!el) return;
  const s = H.trust, c = s?.contracts ?? {}, cm = s?.committer ?? null;
  const cmTxt = !s ? "-" : !cm?.enabled ? "Off" : cm.lowFunds ? "Waiting for MON" : cm.lastError ? "Retrying" : "Running";
  const cmCls = !cm?.enabled ? "off" : cm.lowFunds || cm.lastError ? "warn" : "on";
  el.innerHTML = `<div class="ag-rec-l">
      <h2>Trading agents with a record they can't rewrite</h2>
      <p>Every agent has an ERC-8004 identity on Monad. Every fill is committed on-chain seconds after it happens, before anyone knows how it ends.</p>
      <div class="ag-rec-a"><button type="button" class="b-new" data-act="verify-top">${ic("shield")}Verify an agent</button><a class="b-btn" href="#trust">How it works</a></div>
    </div>
    <dl class="ag-rec-r">
      <div><dt>Identity</dt><dd>${addrA(c.identityRegistry, "ERC-8004 Identity Registry")}<em>ERC-8004</em></dd></div>
      <div><dt>Track record</dt><dd>${addrA(c.trackRecord, "TrackRecord")}<em>hash chain</em></dd></div>
      <div><dt>Validation</dt><dd>${addrA(c.validationRegistry, "ERC-8004 Validation Registry")}<em>ERC-8004</em></dd></div>
      <div><dt>Committer</dt><dd><span class="ag-cm ${cmCls}" title="${esc(cm?.lastError ?? "Commits pending fills every 15 s")}"><i aria-hidden="true"></i>${esc(cmTxt)}</span>${cm?.lastTickAt ? `<small>${agoCTag(cm.lastTickAt)}</small>` : ""}</dd></div>
    </dl>`;
}
/** Verify an agent: the agent with the most fills on Monad, its record checked in the browser as the page opens */
function verifyTop() {
  const all = Object.values(H.boards).flat().filter((b) => N(b?.trust?.committed) > 0);
  const best = all.sort((a, b) => N(b.trust.committed) - N(a.trust.committed))[0];
  if (!best) { toast("No agent has a committed fill yet."); return go("board"); }
  go("detail", { id: best.id, pub: !mineIds().has(best.id), verify: true });
}

// live numbers: they count when they change
async function loadStats() {
  try { H.stats = await api("/v1/agents/stats"); H.statsErr = null; } catch (e) { H.statsErr = e.message; }
  if (on("home")) paintKpis();
}
function paintKpis() {
  const el = $("agHero"); if (!el) return;
  if (!el.dataset.ready) {
    el.dataset.ready = "1";
    el.innerHTML = `<div class="ag-kpi"><small><i class="ag-dot" aria-hidden="true"></i>Agents live</small><b><span data-k="live">-</span><em class="ag-ks" data-k="liveS"></em></b><span class="ag-ksub" data-k="liveT">&nbsp;</span></div>
      <div class="ag-kpi"><small title="Fills whose document hash is in the agent's chain on Monad">Fills on Monad</small><b><span data-k="committed">-</span></b><span class="ag-ksub" data-k="committedS">&nbsp;</span></div>
      <div class="ag-kpi"><small title="Median time from a fill to the block that holds its commit, last 500 commits">To Monad</small><b><span data-k="lag">-</span></b><span class="ag-ksub">&nbsp;</span></div>
      <div class="ag-kpi"><small title="Paper trades in the last 24 hours">Trades 24h</small><b><span data-k="trades">-</span></b><span class="ag-ksub" data-k="tradesS">&nbsp;</span></div>
      <div class="ag-kpi"><small title="Paper PnL of all agents together, last 24 hours">PnL 24h</small><b><span data-k="pnl">-</span></b><span class="ag-ksub" data-k="pnlS">&nbsp;</span></div>
      <div class="ag-kpi act"><button type="button" class="b-btn" data-act="verify-top" title="Open the agent with the most fills on Monad and check its record in your browser">${ic("shield")}Verify an agent</button></div>`;
  }
  const s = H.stats, t = H.trust, k = (n) => el.querySelector(`[data-k="${n}"]`);
  el.classList.toggle("ag-load", !s && !t);
  if (s) {
    countUp(k("live"), s.live, int);
    k("liveS").textContent = `/${int(s.agents)}`;
    k("liveT").innerHTML = `updated ${agoCTag(s.updatedAt ?? Date.now())}`;
    countUp(k("trades"), s.trades24h, int);
    k("tradesS").textContent = `${int(s.skips24h)} skipped by filters`;
    const p = k("pnl"); p.className = cls(s.pnl24hUsd); countUp(p, s.pnl24hUsd, signed);
    const b = s.best && typeof s.best === "object" ? s.best : null;
    k("pnlS").innerHTML = b?.id ? `best <button type="button" class="ag-klink" data-open="${esc(b.id)}"${mineIds().has(b.id) ? "" : ' data-pub="1"'} title="${esc(`Open ${b.name || "the best agent"}`)}">${esc(b.name || "Untitled agent")}</button>` : "&nbsp;";
    // Chord's Monad feed runs behind sometimes: the tape says so, so reaction times read honestly
    const lag = N(s.feed?.lagS), lg = $("agLag");
    if (lg) { lg.hidden = !(lag > 120); lg.textContent = lag > 120 ? `feed ${dur(lag)} behind` : ""; lg.title = "Chord's Monad trade feed is behind the chain by this much; copies react late by the same amount"; }
  }
  if (t?.counts) {
    countUp(k("committed"), t.counts.committed, int);
    const lag = N(t.commitLag?.medianMs);
    if (lag != null) k("lag").textContent = `${(lag / 1000).toFixed(lag < 10_000 ? 1 : 0)} s`;
    k("committedS").textContent = `${plural(t.counts.agents, "ERC-8004 agent")}${t.counts.pending ? `, ${int(t.counts.pending)} pending` : ""}`;
  }
  if (H.statsErr && !s) k("liveT").innerHTML = `<span class="b-warnt">${esc(H.statsErr)}</span>`;
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
  // copies of one agent make the same move at the same moment: one row with "×N" (the agents in its title), not N identical rows
  const same = (a, b) => a.kind === "fill" && b.kind === "fill" && a.side === b.side && a.mint === b.mint && a.agent?.id !== b.agent?.id && Math.abs((N(a.usd) ?? 0) - (N(b.usd) ?? 0)) < 0.01
    && Math.round((N(a.pnlUsd) ?? 0) * 100) === Math.round((N(b.pnlUsd) ?? 0) * 100) && Math.abs(a.at - b.at) < 120_000;
  for (const it of F.items) {
    const last = groups[groups.length - 1];
    if (it.kind === "skip") { if (Array.isArray(last)) last.push(it); else groups.push([it]); }
    else if (last && !Array.isArray(last) && same(last, it)) last.dupNames = [...(last.dupNames ?? [last.agent?.name || "Untitled agent"]), it.agent?.name || "Untitled agent"];
    else groups.push(it.kind === "fill" ? { ...it } : it);
  }
  const fresh = (it) => F.fresh.delete(fkey(it));
  const top = el.scrollTop;
  el.innerHTML = groups.map((g) => (!Array.isArray(g) ? tapeRow(g, fresh(g)) : g.length === 1 ? tapeRow(g[0], fresh(g[0])) : skipGroup(g, g.map(fresh).some(Boolean)))).join("");
  el.scrollTop = top;
}
/** "liquidity $1,334 is below the bot's $20,000 minimum" → "liquidity under $20k": the check that said no, without the value */
const short$ = (x) => { const m = /^([\d.,]+)\s*([KMB])?$/i.exec(String(x).trim()); if (!m) return x; const n = Number(m[1].replace(/,/g, "")) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1); return !Number.isFinite(n) ? x : n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${n}`; };
function skipWhy(r) {
  const t = String(r ?? "").trim();
  const m = /^(liquidity|market cap|volume(?: 24h)?|fdv|holders)\b.*?(?:needs at least|below the (?:bot|agent)'s|minimum of|at least)\s*\$?(\d[\d.,]*(?:\s?[KMB](?![A-Za-z]))?)/i.exec(t);
  if (m) return `${m[1].toLowerCase()} under ${/holders/i.test(m[1]) ? "" : "$"}${short$(m[2])}`;
  if (/transfer tax/i.test(t)) return "transfer tax";
  if (/selling it straight back|no sell route|sell quote/i.test(t)) return "round trip fails";
  if (/max per token/i.test(t)) return "max per token";
  if (/no (jupiter|router) quote|not tradable/i.test(t)) return "no router quote";
  return agentWords(t.replace(/^safety(?: unchecked)?:\s*/i, "").split(/[:(]|\s\$?\d/)[0].replace(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, (w) => w.replace(/Usd$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()).trim().slice(0, 32)) || "a filter";
}
/** a skip's reason as one readable clause for its fill row: the filter's first sentence, whole words */
function skipLine(r) {
  const t = agentWords(String(r ?? "").replace(/^safety(?: unchecked)?:\s*/i, "")).split(/\.\s/)[0].trim();
  if (!t) return "skipped by a filter";
  return t.length <= 80 ? t : `${t.slice(0, 78).replace(/\s+\S*$/, "")}…`;
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
  const bd = k === "skip" ? `<span class="ag-bd skip">Skip</span>` : ev ? `<span class="ag-bd ${it.level === "error" ? "err" : "warn"}">${it.level === "error" ? "Error" : "Note"}</span>` : `<span class="ag-bd ${sell ? "sell" : "buy"}">${sell ? "Sell" : "Buy"}</span>`;
  const sym = ev ? null : symOf(it.symbol, it.mint);
  const logo = ev ? `<span class="tlogo b-tl ag-tev">${ic("alert")}</span>` : tokLogo(sym ?? "?", null, "", it.mint);
  const rx = N(it.reactionS), pnl = N(it.pnlUsd), name = it.agent.name || "Untitled agent";
  const what = k === "skip" ? `skipped: ${agentWords(it.reason || "a filter")}` : ev ? agentWords(it.msg) : it.trigger || (sell ? "closed the position" : "opened a position");
  const dup = it.dupNames?.length > 1 ? `<em class="ag-dup" title="${esc(it.dupNames.join(", "))}">×${it.dupNames.length}</em>` : "";
  const mid = ev ? `<span class="ag-tw">${esc(brief(it.msg))}</span>` : `<b class="ag-sym">${esc(sym)}</b>${dup}${k === "skip" ? `<span class="ag-tw">${esc(skipShort(it.reason))}</span>` : ""}`;
  const anim = fresh ? ` ag-in${k === "fill" ? (sell ? " ag-ins" : " ag-inb") : ""}` : "";
  return `<li class="ag-tr ${k}${anim}" data-open="${esc(it.agent.id)}"${own ? "" : ' data-pub="1"'} title="${esc(`${it.dupNames?.length > 1 ? it.dupNames.join(", ") : name}, ${what}`)}">
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
  if (m) m.innerHTML = d ? `<span title="Window">${int(d.windowMin ?? 15)}m</span>, ${agoCTag(d.updatedAt ?? Date.now())}` : "15m";
  if (!d) { el.innerHTML = H.smartErr ? `<div class="ag-pad">${errBox(H.smartErr, "retry-smart")}</div>` : `<div class="ag-skr"><div class="b-skel"></div></div>`.repeat(5); return; }
  const toks = rows(d.tokens).filter((t) => typeof t.mint === "string" && ADDR.test(t.mint));
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
    <span class="ag-smn"><a href="${EXP.token}${encodeURIComponent(t.mint)}" target="_blank" rel="noopener" title="${esc(`${label}, ${t.mint}`)}"><b class="${t.symbol ? "" : "mono"}">${esc(label)}</b></a><small title="Since the first smart buy">${agoCTag(t.firstBuyAt)}</small></span>
    <span class="ag-smw" title="${esc(plural(w, "smart wallet"))}"><b class="${wf}">${int(w)}</b></span>
    <span class="ag-smv" title="Price move since the first smart buy, USD bought"><b class="${cls(mv)}">${pctPts(mv)}</b><small>${usd(t.usdIn)}</small></span>
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
    filters: [{ field: "smartBuyers1h", op: ">=", value: w }, { field: "liquidityUsd", op: ">=", value: 30000 }, { safety: "not_flagged" }],
    action: { type: "buy", usd: 20 },
    exits: { takeProfitPct: 100, stopLossPct: 30, trailingPct: 25, maxHoldMin: 1440 },
    limits: { maxOpenPositions: 5, dailyBudgetUsd: 100 },
  };
}

// leaderboard: /v1/agents/board?window=…, rank moves kept per window in sessionStorage. The overview shows the top 5, the
// Leaderboard tab every agent; each row carries the agent's ERC-8004 identity and its fills on Monad.
const WIN_LABEL = { today: "Today", "7d": "7 days", all: "All time" };
const LB_HOME = 5, LB_PHONE = 10;
function boardHtml() {
  return `<section class="ag-sec ag-boardv" aria-labelledby="agBoardH">
    <header class="ag-sh"><h2 id="agBoardH">Leaderboard</h2><small id="agBoardN"></small>${info("Agents on the public board, ranked by paper PnL over the window. Each one's fills are committed to its ERC-8004 track record on Monad as they happen: open an agent to check its record in your browser.", "About the leaderboard")}${winTabs()}</header>
    <div id="agBoard"></div>
  </section>`;
}
async function loadLb() {
  const w = H.win;
  try { const j = await api(`/v1/agents/board?window=${encodeURIComponent(w)}`); const list = rows(j.agents).filter((b) => typeof b.id === "string"); H.boards[w] = list; H.boardErr = null; trackRanks(w, list); }
  catch (e) { H.boardErr = e.message; }
  if (on("home", "board") && H.win === w) paintLb();
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
const lbHead = (all) => `<div class="ag-lh" aria-hidden="true"><span>#</span><span>Agent</span><span title="ERC-8004 identity on Monad, and the fills committed to its track record">On Monad</span><span class="b-n" title="PnL over the window">PnL</span><span class="b-n">${all ? "Realized" : "All-time"}</span><span class="b-n">Win</span><span class="b-n">Trades</span><span>Equity</span><span></span></div>`;
function paintLb() {
  const el = $("agBoard"); if (!el) return;
  root.querySelectorAll("[data-win]").forEach((b) => { const it = b.dataset.win === H.win; b.classList.toggle("on", it); b.setAttribute("aria-selected", String(it)); });
  const list = H.boards[H.win], home = on("home");
  const n = $("agBoardN"); if (n) n.textContent = list?.length ? plural(list.length, "agent") : "";
  if (!list) { el.innerHTML = H.boardErr ? errBox(H.boardErr, "retry-lb") : `<div class="ag-lb">${`<div class="ag-skr"><div class="b-skel"></div></div>`.repeat(home ? LB_HOME : 8)}</div>`; return; }
  if (!list.length) { el.innerHTML = `<div class="b-none">No agents on the board yet. <button type="button" class="b-btn sm" data-go="create">${ic("plus", 2.2)}Start one</button></div>`; return; }
  const mine = mineIds(), all = H.win === "all";
  const cut = home ? LB_HOME : narrow() && !H.lbAll && list.length > LB_PHONE ? LB_PHONE : list.length;
  const more = !home && narrow() && list.length > LB_PHONE ? `<button type="button" class="b-more" data-act="lb-all" aria-expanded="${!!H.lbAll}">${H.lbAll ? `Top ${LB_PHONE}` : `Show all ${int(list.length)}`}</button>` : "";
  el.innerHTML = `<div class="ag-lb">${lbHead(all)}${list.slice(0, cut).map((b, i) => lbRow(b, i, mine.has(b.id))).join("")}${more}</div>
    ${home && list.length > cut ? `<button type="button" class="ag-lbmore" data-go="board">${int(list.length - cut)} more on the leaderboard${ic("chr", 2)}</button>` : ""}${H.boardErr ? `<p class="b-warnt">${esc(H.boardErr)}</p>` : ""}`;
}
/** the overview column is phone-wide (the same 640 px the layout's container queries use) */
const narrow = () => (root.querySelector(".ag-home, .ag-boardv")?.clientWidth || root.clientWidth || innerWidth) <= 640;
const rankMove = (mv) => (mv === "new" ? `<i class="ag-mv new">NEW</i>` : N(mv) > 0 ? `<i class="ag-mv up" title="Up ${mv} since the last update">▲${mv}</i>` : N(mv) < 0 ? `<i class="ag-mv down" title="Down ${-mv} since the last update">▼${-mv}</i>` : "");
/** the board's PnL flashes green / red when it moved since the last paint */
function pnlFlash(b) {
  const pnl = N(b.pnl), pk = `lb:${H.win}:${b.id}`, was = H.prev.get(pk);
  H.prev.set(pk, pnl);
  return was != null && pnl != null && Math.abs(was - pnl) >= 0.005 ? (pnl > was ? " ag-fu" : " ag-fd") : "";
}
const metaOf = (b) => [b.template || typeShort(b), b.mode === "live" ? "Live" : "Paper", `${age(b.createdAt)} old`, b.status === "running" ? "" : STATUS[b.status] ?? b.status].filter(Boolean).join(", ");
const stChips = (b) => `${b.mode === "live" ? `<em class="ag-chip live">Live</em>` : ""}${b.status && b.status !== "running" ? `<em class="ag-chip st">${esc(STATUS[b.status] ?? b.status)}</em>` : ""}`;
/** the agent's ERC-8004 identity and its fills on Monad (the board's trust field); alerts never trade, so they have none */
function trustCell(b) {
  const t = b.trust;
  if (t?.agentId) {
    const v = t.validation && N(t.validation.response) != null ? `<em class="ag-val" title="Latest validation score from the independent validator">${int(t.validation.response)}/100</em>` : "";
    return `<span class="ag-oc"><a class="ag-id" href="${esc(idUrl(t.agentId))}" target="_blank" rel="noopener" title="${esc(`ERC-8004 agent #${t.agentId} on Monad`)}">#${esc(t.agentId)}</a>${v}<small title="${esc(`${plural(t.committed, "fill")} committed on Monad${t.pending ? `, ${int(t.pending)} pending` : ""}`)}">${plural(t.committed, "fill")}${t.pending ? ` +${int(t.pending)}` : ""}</small></span>`;
  }
  return trades(b) ? `<span class="ag-oc dim" title="Registered on Monad with its first trade">no trade yet</span>` : `<span class="ag-oc dim" title="Alerts never trade, so nothing is committed">alert only</span>`;
}
function lbRow(b, i, own) {
  const st = b.stats ?? {}, all = H.win === "all", pnl = N(b.pnl), second = all ? N(st.realizedUsd) : N(b.pnlAll), fl = pnlFlash(b), name = b.name || "Untitled agent";
  return `<div class="ag-lr${i < 3 ? " top" : ""}" role="button" tabindex="0" data-open="${esc(b.id)}"${own ? "" : ' data-pub="1"'} aria-label="${esc(`Rank ${i + 1}: ${name}`)}">
    <span class="ag-rk"><b>${i + 1}</b>${rankMove(H.moves[H.win]?.[b.id])}</span>
    <span class="ag-ln" title="${esc(`${name}, ${metaOf(b)}`)}">${av(b, 30)}<span class="ag-lnt"><b>${esc(name)}</b><small>${esc(b.template || typeShort(b))}, ${esc(age(b.createdAt))}${own ? `, <em class="b-you">yours</em>` : ""}${stChips(b)}</small></span></span>
    ${trustCell(b)}
    <span class="b-n ag-pw ${cls(pnl)}" data-k="PnL"><span class="ag-fv${fl}">${signed(pnl)}</span></span>
    <span class="b-n ag-x ag-x2 ${cls(second)}" data-k="${all ? "Realized" : "All-time"}">${signed(second)}</span>
    <span class="b-n ag-x" data-k="Win">${pct(st.winRate)}</span>
    <span class="b-n ag-x" data-k="Trades">${int(st.trades)}</span>
    <span class="ag-sp">${sparkSvg(b.spark, false)}</span>
    <span class="ag-cp">${own ? "" : `<button type="button" class="b-btn sm ag-copy" data-copy="${esc(b.id)}" title="Copy this agent: a new paper agent with the same rules" aria-label="${esc(`Copy ${name}`)}">${ic("copy")}<span>Copy</span></button>`}</span>
  </div>`;
}
function sparkSvg(a, big) {
  const v = (Array.isArray(a) ? a : []).map(N).filter((x) => x != null);
  if (v.length < 2) return `<span class="ag-spn">-</span>`;
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
/** Copy an agent: a new paper agent with the same rules, on this browser's session, free */
async function copyAgent(id, btn, title) {
  if (!id || btn?.disabled) return;
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `${ic("spin")}<span>Copying…</span>`; }
  try {
    const src = Object.values(H.boards).flat().find((b) => b?.id === id);
    const n = title ?? src?.name ?? null, name = n ? copyName(n) : null;
    const j = await api(`/v1/agents/${encodeURIComponent(id)}/copy`, { method: "POST", body: name ? { name } : {} });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The copy was made but the answer had no id. Check My agents.");
    S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)];
    toast("Copied. It runs on paper in My agents now.");
    go("detail", { id: bot.id });
  } catch (e) {
    toast(e.message);
    if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
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
  if (on("home", "mine")) paintTpls();
}
/** a replay's window as it really ran: the new-token board keeps 24 h, so a 3-day replay covers the last 24 h */
const replayTag = (days, coveredH) => { const ch = N(coveredH); return ch != null && N(days) != null && ch < N(days) * 24 ? `replay, last ${ch % 24 === 0 ? dayTag(ch / 24) : `${int(ch)}h`}` : `replay ${dayTag(days)}`; };
/** "13/20 wallets read" when the replay could not read every followed wallet (the unread ones in the title) */
function walletsReadChip(x) {
  const un = Array.isArray(x?.unreadWallets) ? x.unreadWallets.filter((w) => typeof w === "string") : [], rd = N(x?.walletsRead);
  if (!un.length || rd == null) return "";
  return `<em class="ag-chip ag-wr" title="${esc(`Not read in this replay: ${un.join(", ")}`)}">${int(rd)}/${int(rd + un.length)} wallets read</em>`;
}
function paintTpls() {
  const s = $("agTplS"), el = $("agTpl"); if (!s || !el) return;
  s.hidden = !H.tpls;
  if (H.tpls) el.innerHTML = `<div class="ag-list ag-tl">${H.tpls.map(tplCard).join("")}</div>`;
}
function tplCard(t, i) {
  const st = t.strategy, id = String(t.id ?? i), run = N(t.running), hl = t.headline && typeof t.headline === "object" ? t.headline : null;
  const size = st?.action?.type === "buy" ? N(st.action.usd) : null, title = t.title ?? st.name ?? "Template";
  // the server's replay of the template: PnL on its trade size, or the number of alerts for an alert-only template
  const days = hl ? (N(hl.coveredHours) != null && N(hl.coveredHours) < N(hl.days) * 24 ? `last ${int(hl.coveredHours)}h` : `${daysLabel(hl.days)}`) : "";
  const res = !hl ? `<span class="b-n dim">-</span>` : !["buy", "sell"].includes(st?.action?.type) ? `<span class="b-n">${plural(hl.signals ?? hl.trades, "alert")}</span>`
    : !N(hl.trades) ? `<span class="b-n dim">No trades</span>` : `<span class="b-n ${cls(hl.pnlUsd)}">${signed(hl.pnlUsd)}</span>`;
  const line = t.oneLine ?? t.line ?? st.description ?? "";
  return `<div class="ag-li">
    <span class="ag-lin"><b>${esc(title)}</b>${run ? `<small>${int(run)} running</small>` : ""}</span>
    <span class="ag-lid" title="${esc(`${line}${t.risk ? ` Risk: ${t.risk}` : ""}`)}">${esc(line)}</span>
    <span class="ag-lir" title="${esc(hl ? `The server's replay over the ${days}${size ? `, $${size} a trade` : ""}` : "")}">${res}<small>${hl ? esc(`${days} replay`) : ""}</small></span>
    <span class="ag-lia"><button type="button" class="b-btn sm" data-tbuild="${esc(id)}" title="Open in the builder">Edit</button><button type="button" class="b-btn sm pri" data-tstart="${esc(id)}" title="Start a paper agent with these defaults">Start</button></span>
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

// ── Smart traders (#agents/traders): Chord's Monad smart-traders board, the one behind the Copy trader form ────────────────
// GET /v1/agents/traders?days=1|3|7&limit=100. Copy on a row opens New agent → Copy trader with that wallet picked; ticks +
// "Copy N wallets" pick several (into the form's own wallet list, up to 10). A wallet is a monogram on its own hue, never the
// agent mascot.
const BD = { st: { days: 1, lists: {}, sel: [], page: 1, sig: "" } };
const BD_LIMIT = 100, BD_PAGE = 20;
/** ‹ 1 2 3 › under a board, 20 rows a page (nothing when it fits on one page); data-pg="st:2" */
function pagerHtml(key, page, total) {
  const pages = Math.ceil(total / BD_PAGE);
  if (pages <= 1) return "";
  const b = (p, body, label, extra = "") => `<button type="button" class="ag-pg-b${p === page && !extra ? " on" : ""}" data-pg="${key}:${p}"${p < 1 || p > pages ? " disabled" : ""}${p === page && !extra ? ' aria-current="page"' : ""} aria-label="${esc(label)}">${body}</button>`;
  const from = (page - 1) * BD_PAGE + 1, to = Math.min(total, page * BD_PAGE);
  return `<nav class="ag-pg" aria-label="Pages"><small class="ag-pg-n">${int(from)}–${int(to)} of ${int(total)}</small><span class="ag-pg-bs">${b(page - 1, svg("chl", 2.2), "Previous page", "prev")}${Array.from({ length: pages }, (_, i) => b(i + 1, int(i + 1), `Page ${i + 1}`)).join("")}${b(page + 1, svg("chr", 2.2), "Next page", "next")}</span></nav>`;
}
const pageOf = (page, total) => Math.max(1, Math.min(page, Math.ceil(total / BD_PAGE) || 1));
const BD_DAYS = [[1, "24h"], [3, "3d"], [7, "7d"]];
const winSeg = (attr, cur) => `<div class="b-seg sm" role="tablist" aria-label="Window">${BD_DAYS.map(([v, l]) => `<button type="button" role="tab" data-${attr}="${v}" class="${cur === v ? "on" : ""}" aria-selected="${cur === v}">${l}</button>`).join("")}</div>`;
const segSync = (attr, cur) => root.querySelectorAll(`[data-${attr}]`).forEach((b) => { const on = Number(b.dataset[attr]) === cur; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
const walletMono = (w) => `<span class="tlogo b-tl sm ag-st-mono" style="--mh:${hueOf(w)}" aria-hidden="true"><b>${esc(String(w).replace(/^0x/i, "").slice(0, 2).toUpperCase())}</b></span>`;
/** monogram · short address (Monadscan) · copy-address button */
const walletCell = (w, sub = "") => `<span class="ag-st-w">${walletMono(w)}<span class="ag-st-wa"><span class="ag-st-wl"><a class="mono" href="${EXP.acct}${encodeURIComponent(w)}" target="_blank" rel="noopener" title="${esc(`${w}, open on Monadscan`)}">${esc(short(w))}${ic("ext")}</a><button type="button" class="ag-st-ca" data-caddr="${esc(w)}" title="Copy address" aria-label="${esc(`Copy the address ${short(w)}`)}">${svg("copy")}</button></span>${sub ? `<small class="ag-st-sub" aria-hidden="true">${sub}</small>` : ""}</span></span>`;
/** "5m ago", ticking every second (tickAgo), the full time in its title */
const agoATag = (t) => { const ms = toMs(t); return ms == null ? "-" : `<time data-at="${ms}" data-c="a" title="${esc(fullTime(ms))}">${ago(ms)}</time>`; };
const bdSkel = (n, head, cl = "") => `<div class="ag-st-tbl ${cl}">${head}${`<div class="ag-st-skr"><div class="b-skel"></div></div>`.repeat(n)}</div>`;
async function copyAddr(w, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(w); ok = true; }
  catch {
    try { const ta = document.createElement("textarea"); ta.value = w; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0"; document.body.append(ta); ta.select(); ok = document.execCommand("copy"); ta.remove(); } catch {}
  }
  if (ok && btn?.isConnected) { btn.innerHTML = svg("check", 2.4); btn.classList.add("ok"); clearTimeout(btn._t); btn._t = setTimeout(() => { if (btn.isConnected) { btn.innerHTML = svg("copy"); btn.classList.remove("ok"); } }, 1400); }
  toast(ok ? `Copied ${short(w)}` : "Could not copy here. Open it on Monadscan instead.");
}

// smart traders
const ST_HEAD = `<div class="ag-st-h" aria-hidden="true"><span></span><span>#</span><span>Wallet</span><span class="b-n" title="Realized PnL over the window">Realized</span><span class="b-n" title="USD traded over the window">Volume</span><span class="b-n">Win</span><span class="b-n">Trades</span><span class="b-n ag-st-mid" title="Tokens traded">Tokens</span><span class="b-n ag-st-mid" title="Chord's Smart Score">Score</span><span>Best token</span><span class="b-n" title="Last trade">Last</span><span></span></div>`;
function stHtml() {
  return `<div class="ag-stv"><section class="ag-sec" aria-labelledby="agStH">
    <header class="ag-sh ag-st-sh"><h2 id="agStH">Smart traders</h2><small id="agStM"></small>${info("<p>Monad wallets ranked by Chord's Smart Score across every DEX, with realized PnL over the window. Bots are filtered out by Chord's rules. Past results are not a promise.</p>", "About smart traders")}
      <span class="ag-st-ctl">${winSeg("stdays", BD.st.days)}<span class="ag-st-pick" id="agStPick"></span></span></header>
    <div id="agStB"></div>
  </section></div>`;
}
async function loadSt(force) {
  const d = BD.st.days, c = BD.st.lists[d];
  if (c?.loading || (c?.list && !force && Date.now() - c.at < 60_000)) return;
  BD.st.lists[d] = { ...(c ?? {}), loading: true, err: null };
  if (!c?.list) paintSt();
  try {
    const j = await api(`/v1/agents/traders?days=${d}&limit=${BD_LIMIT}`);
    BD.st.lists[d] = { list: rows(j.traders).filter((t) => typeof t.wallet === "string" && ADDR.test(t.wallet)), at: Date.now() };
  } catch (e) { BD.st.lists[d] = { ...(BD.st.lists[d] ?? {}), loading: false, err: e.message }; }
  if (S.screen === "traders" && BD.st.days === d) paintSt();
}
function paintSt() {
  const el = $("agStB"); if (!el) return;
  segSync("stdays", BD.st.days);
  paintStPick();
  const c = BD.st.lists[BD.st.days], m = $("agStM");
  if (m) m.textContent = c?.list ? plural(c.list.length, "wallet") : "";
  if (!c?.list) { BD.st.sig = ""; el.innerHTML = c?.err ? errBox(c.err, "st-retry") : bdSkel(10, ST_HEAD, "ag-st-t"); return; }
  // a refresh with the same answer leaves the table alone (hover, focus and ticks stay where they are)
  const page = BD.st.page = pageOf(BD.st.page, c.list.length);
  const sig = `${BD.st.days}|${page}|${c.err ?? ""}|${JSON.stringify(c.list)}`;
  if (sig === BD.st.sig && el.firstElementChild) return;
  BD.st.sig = sig;
  if (!c.list.length) { el.innerHTML = `<div class="b-none" title="Try a longer window">No smart traders in this window</div>`; return; }
  const off = (page - 1) * BD_PAGE;
  el.innerHTML = `<div class="ag-st-tbl ag-st-t">${ST_HEAD}${c.list.slice(off, off + BD_PAGE).map((t, i) => stRow(t, off + i)).join("")}</div>${pagerHtml("st", page, c.list.length)}${c.err ? `<p class="b-warnt">${esc(c.err)}</p>` : ""}`;
}
function stRow(t, i) {
  const w = t.wallet, sel = BD.st.sel, on = sel.includes(w), dis = !on && sel.length >= MAX_WALLETS;
  const bt = t.bestToken && typeof t.bestToken === "object" ? t.bestToken : null, bsym = bt?.symbol ? String(bt.symbol) : "?", pnl = N(t.realizedPnlUsd);
  return `<div class="ag-st-r${on ? " on" : ""}${i < 3 ? " top" : ""}">
    <label class="ag-st-ck${dis ? " dis" : ""}" title="${dis ? `Up to ${MAX_WALLETS} wallets per agent` : "Tick to copy several wallets in one agent"}"><input type="checkbox" data-stw="${esc(w)}"${on ? " checked" : ""}${dis ? " disabled" : ""} aria-label="${esc(`Pick ${short(w)}`)}"><span class="b-box">${svg("check", 3)}</span></label>
    <span class="ag-st-rk">${i + 1}</span>
    ${walletCell(w, `${plural(t.tokens, "token")}${N(t.medianHoldS) != null ? `, ${esc(dur(t.medianHoldS))} hold` : ""}`)}
    <span class="b-n ag-st-pnl ${cls(pnl)}" title="${esc(`Realized PnL, ${daysLabel(BD.st.days)}`)}">${signed(pnl)}</span>
    <span class="ag-st-xs"><span class="b-n" data-k="Volume">${usd(t.volumeUsd)}</span><span class="b-n" data-k="Win">${pct(t.winRate)}</span><span class="b-n" data-k="Trades">${int(t.trades)}</span><span class="b-n ag-st-mid" data-k="Tok" title="Tokens traded">${int(t.tokens)}</span><span class="b-n ag-st-mid" data-k="Score" title="Chord's Smart Score">${compact(t.score)}</span></span>
    <span class="ag-st-best"${bt ? ` title="${esc(`Best token: ${bsym}, realized ${signed(bt.realizedPnlUsd)}`)}"` : ""}>${bt ? `${tokLogo(bsym, imgOf(bt), "sm", bt.mint)}<b>${esc(bsym)}</b><small class="${cls(bt.realizedPnlUsd)}">${signed(bt.realizedPnlUsd)}</small>` : `<small>-</small>`}</span>
    <span class="b-n ag-st-last">${agoATag(t.lastTrade)}</span>
    <span class="ag-st-cp"><button type="button" class="b-btn sm ag-copy" data-stcopy="${esc(w)}" title="New copy-trader agent following this wallet" aria-label="${esc(`Copy ${short(w)}`)}">${ic("copy")}<span class="ag-st-cpt">Copy</span></button></span>
  </div>`;
}
function paintStPick() {
  const el = $("agStPick"); if (!el) return;
  const n = BD.st.sel.length;
  el.innerHTML = `<span class="ag-st-seln" title="${esc(`Wallets ticked, up to ${MAX_WALLETS} per agent`)}">${int(n)}/${MAX_WALLETS}</span><button type="button" class="b-btn sm ag-st-clr${n ? "" : " off"}" data-act="st-clear"${n ? "" : ' tabindex="-1" aria-hidden="true"'}>Clear</button><button type="button" class="b-btn sm ag-go ag-st-cn" data-act="st-copyn"${n ? "" : " disabled"} title="${esc(n ? `New copy-trader agent following ${plural(n, "wallet")}` : "Tick wallets to copy several in one agent")}">${ic("copy")}${n ? `Copy ${plural(n, "wallet")}` : "Copy wallets"}</button>`;
}
/** ticks change in place (no repaint): the row, the 10-wallet cap on the others, the Copy N button */
function paintStSel() {
  const sel = BD.st.sel, full = sel.length >= MAX_WALLETS;
  root.querySelectorAll("input[data-stw]").forEach((inp) => {
    const on = sel.includes(inp.dataset.stw), dis = !on && full;
    inp.checked = on; inp.disabled = dis;
    inp.closest(".ag-st-r")?.classList.toggle("on", on);
    const l = inp.closest(".ag-st-ck"); if (l) { l.classList.toggle("dis", dis); l.title = dis ? `Up to ${MAX_WALLETS} wallets per agent` : "Tick to copy several wallets in one agent"; }
  });
  paintStPick();
}
function toggleSt(w, on) {
  if (on && !BD.st.sel.includes(w)) { if (BD.st.sel.length >= MAX_WALLETS) toast(`Up to ${MAX_WALLETS} wallets per agent.`); else BD.st.sel.push(w); }
  if (!on) BD.st.sel = BD.st.sel.filter((x) => x !== w);
  paintStSel();
}
/** New agent → Copy trader with these wallets picked, on this board's window (the form's picker shows the same board) */
function copyTraders(list) {
  const ws = [...new Set(list.filter((w) => typeof w === "string" && ADDR.test(w)))].slice(0, MAX_WALLETS);
  if (!ws.length) return;
  const d = BD.st.days, c = BD.st.lists[d];
  if (c?.list?.length) S.traders[d] = { list: c.list, at: c.at };
  const rank = (w) => c?.list?.findIndex((t) => t.wallet === w) ?? -1;
  Object.assign(S.f, { type: "copy", wallets: ws, days: d, btDays: d, more: ws.some((w) => rank(w) >= 10), bt: null, btKey: null, btErr: null, btAll: false });
  go("create", { type: "copy" });
}

// ── My agents (live: PnL counts and flashes on change, last action ticks, running dot pulses, mini equity line) ───────────
function mineHtml() {
  return `<div class="ag-home"><section class="ag-sec" aria-labelledby="agMineH">
      <header class="ag-sh"><h2 id="agMineH">My agents</h2><small id="agMineN"></small>${info(`Up to ${MAX_BOTS} agents, kept on this browser's session. Paper only: nothing is sent. Each trading agent gets an ERC-8004 identity on Monad with its first trade.`)}<span class="ag-shb" id="agMineB" hidden><button type="button" class="b-btn sm" data-go="build">${ic("blocks")}Build</button><button type="button" class="b-btn sm" data-go="create">${ic("plus", 2.2)}New agent</button></span></header>
      <div id="bMine"></div>
    </section>
    <section class="ag-sec" id="agTplS" aria-labelledby="agTplH" hidden>
      <header class="ag-sh"><h2 id="agTplH">Start from a template</h2>${info("Paper agents with tested defaults. Start runs one at once; Edit opens it in the builder first. The number on each card is the server's replay of the template over recent days.")}</header>
      <div id="agTpl"></div>
    </section>
    <section class="ag-sec" id="agClsS" aria-labelledby="agClsH" hidden>
      <header class="ag-sh"><h2 id="agClsH">Best backtests</h2>${info("The backtest board's best setups: every classic and quant strategy on every Perpl market, 1h and 4h, replayed over the last 1, 3 and 6 months at $1,000 and 1x on Perpl with fees and funding. Each window is the median of the data sources (Binance, OKX, Hyperliquid, Perpl) that cover it. Hold is the coin itself over the same 6 months. History, not a forecast.", "About the backtests")}<button type="button" class="ag-more" data-go="classic">All strategies${ic("chr", 2)}</button></header>
      <div id="agCls"></div>
    </section></div>`;
}
async function loadBots(quiet) {
  try { const j = await api("/v1/agents"); S.bots = rows(j.bots).filter((b) => b.id); S.botsErr = null; }
  catch (e) { S.botsErr = e.message; }
  const c = $("agMineCnt"); if (c) c.textContent = S.bots?.length ? String(S.bots.length) : "";
  const ids = (S.bots ?? []).map((b) => b.id).sort().join();
  if (ids !== H.mineSig) { H.mineSig = ids; if (on("home", "board") && H.boards[H.win]) paintLb(); } // YOU badges, no Copy on my own rows
  if (!on("mine")) return;
  if (!quiet || S.bots) paintMine();
  if (S.bots?.some(trades) && Date.now() - H.sparkAt > 30_000) loadSparks();
}
async function loadSparks() {
  H.sparkAt = Date.now();
  const list = (S.bots ?? []).filter(trades).slice(0, MAX_BOTS);
  await Promise.all(list.map(async (b) => {
    try { const j = await api(`/v1/agents/${encodeURIComponent(b.id)}`); H.sparks.set(b.id, sparkFrom(rows(j.fills), j.bot ?? b)); } catch {}
  }));
  if (on("mine") && list.length) paintMine();
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
  const n = $("agMineN"); if (n) n.textContent = S.bots?.length ? `${S.bots.length}/${MAX_BOTS}` : "";
  const hb = $("agMineB"); if (hb) hb.hidden = !S.bots?.length;
  if (S.botsErr && !S.bots) { el.innerHTML = errBox(S.botsErr, "retry-bots"); return; }
  if (!S.bots) { el.innerHTML = `<div class="b-cards">${`<div class="b-card b-skc"><div class="b-skel" style="height:34px;width:62%"></div><div class="b-skel" style="height:30px;width:44%"></div><div class="b-skel" style="height:46px"></div></div>`.repeat(2)}</div>`; return; }
  if (!S.bots.length) {
    el.innerHTML = `<div class="ag-mempty"><b>No agents yet</b><span>Copy a Monad wallet, watch one, or describe a strategy in a sentence.</span>
      <span class="ag-ebtns"><button type="button" class="b-new" data-go="create" data-type="copy">${ic("users")}Copy trader</button><button type="button" class="b-btn" data-go="create" data-type="alert">${ic("bell")}Alert</button><button type="button" class="b-btn" data-go="build">${ic("blocks")}Build</button></span></div>`;
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
const fig = (k, v) => `<span><small>${esc(k)}</small><b>${v}</b></span>`;
function cardHtml(b) {
  const st = b.stats ?? {}, p = b.params ?? {}, custom = b.type === "custom", copy = trades(b);
  const nw = p.wallets?.length ?? 0, nm = p.mints?.length ?? 0;
  const tot = totOf(b), sp = H.sparks.get(b.id);
  const sub = custom ? (BM && stratOf(b) ? BM.summary(stratOf(b)) : "Custom") : copy ? `Copies ${plural(nw, "wallet")}` : [nw && plural(nw, "wallet"), nm && plural(nm, "token")].filter(Boolean).join(", ") || "nothing watched";
  const xl = custom ? explainOf(b) : [];
  const body = custom && !copy
    ? `<div class="b-pnl">${int(st.trades)}<small>${N(st.trades) === 1 ? "match" : "matches"}</small></div>`
    : copy
    ? `<div class="ag-cpl"><div class="b-pnl ${cls(tot)}"><span class="ag-fv" data-pnl="${esc(b.id)}" data-v="${tot}">${signed(tot)}</span><small>PnL</small></div>${sp ? sparkSvg(sp, true) : ""}</div>
       <div class="b-figs">${fig("Realized", `<span class="${cls(st.realizedUsd)}">${signed(st.realizedUsd ?? 0)}</span>`)}${fig("Open PnL", `<span class="${cls(st.unrealizedUsd)}">${signed(st.unrealizedUsd ?? 0)}</span>`)}${fig("Invested", usd(st.investedUsd ?? 0))}${fig("Trades", int(st.trades))}${fig("Open", int(st.openPositions))}${fig("Win", pct(st.winRate))}</div>`
    : `<div class="b-pnl">${int(st.trades)}<small>${N(st.trades) === 1 ? "match" : "matches"}</small></div>
       <div class="b-figs">${fig("Wallets", int(nw))}${fig("Tokens", int(nm))}${fig("Min size", usd(p.minUsd ?? 1000))}${fig("Webhook", p.webhook ? "On" : "Off")}</div>`;
  return `<div class="b-card" role="button" tabindex="0" data-open="${esc(b.id)}" aria-label="Open ${esc(b.name || "agent")}"${xl.length ? ` title="${esc(xl.join("\n"))}"` : ""}>
    <div class="b-ch">${av(b, 40)}<span class="b-cn"><b>${esc(b.name || "Untitled agent")}</b><small title="${esc(typeLabel(b))}">${esc(sub)}</small></span>${badge(b.mode)}</div>
    ${body}
    ${b.status === "error" && b.error ? `<div class="b-cerr">${esc(b.error)}</div>` : ""}
    <div class="b-cf">${statusHtml(b.status)}<span class="b-cfo">${copy ? `<span class="ag-oc-s" title="Fills go to this agent's ERC-8004 track record on Monad">${ic("shield")}On Monad</span>` : ""}<span title="Last action">${st.lastEventAt ? agoCTag(st.lastEventAt) : "-"}</span></span></div>
  </div>`;
}
function syncListBot(bot) { if (S.bots && bot?.id) S.bots = S.bots.map((x) => (x.id === bot.id ? bot : x)); }
// ── Create ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAME_PH = { copy: "Optional, e.g. Top 3 Monad traders", alert: "Optional, e.g. Whale watch" };
const FORM = { copy: () => copyFormHtml(), alert: () => alertFormHtml() };
function createHtml() {
  const f = S.f, tb = (t, icon, label) => `<button type="button" role="tab" data-type="${t}" class="${f.type === t ? "on" : ""}">${ic(icon)}${label}</button>`;
  return `${crumbHtml("mine", "My agents")}
    <div class="b-c2"><h2>New agent</h2><div class="b-seg bb-seg3" id="bTypeSeg" role="tablist" aria-label="Agent type">${tb("copy", "users", "Copy trader")}${tb("alert", "bell", "Alert")}<button type="button" role="tab" data-go="build" class="bb-segb" title="Build your own">${ic("blocks")}Build</button></div></div>
    <label class="b-field b-namef"><span>Name</span><span class="b-in"><input data-f="name" maxlength="48" autocomplete="off" placeholder="${NAME_PH[f.type] ?? NAME_PH.copy}" value="${esc(f.name)}"></span></label>
    <div id="bForm">${(FORM[f.type] ?? FORM.copy)()}</div>`;
}
// field checks while typing: a number field never drops a minus sign, it says what is wrong instead
/** "-5" / "-5" / "5k"-free: the typed text as a number, null when empty, NaN when not a number */
const numIn = (v) => { const t = String(v ?? "").trim().replace(/^[-–]/, "-"); return t === "" ? null : /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN; };
/** [min, max, whole, optional, message for out of range] */
const FCHK = {
  f: { usd: [1, 1000, false, false, "$1 to $1,000"], maxTok: [0, Infinity, false, true], maxOpen: [1, Infinity, true, true, "1 or more"], slip: [0.01, 50, false, true, "0.01 to 50%"],
    minLiq: [0, Infinity, false, true], stop: [0.01, Infinity, false, true, "above $0, or empty"], minUsd: [0, Infinity, false, true] },
};
function fieldErr(store, k, v) {
  const c = FCHK[store]?.[k]; if (!c) return null;
  const [min, max, whole, opt, msg] = c, n = numIn(v);
  if (n == null) return opt ? null : "needs a value";
  if (Number.isNaN(n)) return "must be a number";
  if (n < 0) return "must be 0 or more";
  if (whole && !Number.isInteger(n)) return "a whole number";
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
const numOnly = (v, whole) => { let t = String(v).replace(/-|–/g, "-").replace(whole ? /[^0-9-]/g : /[^0-9.-]/g, ""); t = t.replace(/(?!^)-/g, ""); return whole ? t : t.replace(/(\..*)\./g, "$1"); };
const field = (k, label, { pre = "", suf = "", hint = "", tip = "", ph = "", id = "", wide = false, mode = "decimal", store = "f" } = {}) =>
  `<label class="b-field${wide ? " wide" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><span>${label}${hint ? `<small class="b-fh">${hint}</small>` : ""}</span><span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-${store}="${k}"${id ? ` id="${id}"` : ""} inputmode="${mode}" autocomplete="off" spellcheck="false" value="${esc(S[store][k])}" placeholder="${esc(ph)}">${suf ? `<i>${suf}</i>` : ""}</span><small class="bb-err" data-ferr="${store}:${k}">${esc(fieldErr(store, k, S[store][k]) ?? "")}</small></label>`;
const tog = (k, label, hint) => `<button type="button" class="b-tog" role="switch" aria-checked="${S.f[k]}" data-tog="${k}" title="${esc(hint)}"><span class="b-sw"></span><span><b>${label}</b></span></button>`;
/** a step: its number and a title of three words at most; what the step does sits behind (i) */
const stepHead = (n, title, sub) => `<div class="b-sh"><span class="b-num">${n}</span><div><h3>${title}</h3></div>${info(esc(sub), `About: ${title.replace(/&amp;/g, "&")}`)}</div>`;
/** the start box: PAPER, the full paper note behind (i), the form's message, the button */
const startBox = (note, cta) => `<div class="b-start"><div class="b-stn">${PAPER}<span class="b-msg" id="bMsg"></span>${info(esc(note), "Paper mode")}</div><button type="button" class="b-cta" data-act="create" id="bGo">${cta}</button></div>`;
const seg = (attr, vals, cur) => `<div class="b-seg sm">${vals.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
const DAY_OPTS = [[1, "24h"], [3, "3d"], [7, "7d"]];
const defMaxTok = () => { const u = N(S.f.usd); return u > 0 ? `Default ${usd(u * 3)}` : "Default 3× per trade"; };

function copyFormHtml() {
  const f = S.f;
  return `<section class="b-step">${stepHead(1, "Wallets", "Top Monad smart traders on Chord's board (all DEXes). Pick up to 10, or add any wallet.")}
      <div class="b-bar">${seg("days", DAY_OPTS, f.days)}<button type="button" class="b-btn sm" data-act="top3">Add top 3</button><span class="b-seln" id="bSelN"></span></div>
      <div id="bTraders">${tradersHtml()}</div>
      <div class="b-add"><input id="bAddW" class="mono" placeholder="Add a wallet: paste a Monad address (0x…)" spellcheck="false" autocomplete="off" aria-label="Add a wallet"><button type="button" class="b-btn" data-act="addw">Add</button></div>
      <p class="b-hint" id="bAddMsg"></p>
      <div class="b-chips" id="bChips"></div>
    </section>
    <section class="b-step">${stepHead(2, "Size &amp; safety", "Caps apply to every mirrored trade.")}
      <div class="b-grid">
        ${field("usd", "Per trade", { pre: "$", hint: "1–1,000", tip: "USDC per mirrored buy, 1 to 1,000" })}
        ${field("maxTok", "Max per token", { pre: "$", id: "bMaxTok", ph: defMaxTok(), tip: "Adds to a held token stop here" })}
        ${field("maxOpen", "Max open", { ph: "10", mode: "numeric", tip: "Max open positions: new buys wait above this" })}
        ${field("slip", "Slippage", { suf: "%", ph: "1", tip: "Per fill, on the router quote" })}
        ${field("minLiq", "Min liquidity", { pre: "$", ph: "20000", tip: "Thinner tokens are skipped" })}
        ${field("stop", "Daily stop", { pre: "$", ph: "Off", tip: "Daily loss stop: pauses the agent after this loss in a day" })}
      </div>
      <div class="b-togs">
        ${tog("mirror", "Mirror sells", "When a followed wallet sells a token the agent holds, the agent sells all of it.")}
        ${tog("safety", "Safety check", "Skip tokens with a transfer tax, or where a $10 buy sold straight back through the router returns less than 90%.")}
      </div>
    </section>
    <section class="b-step">${stepHead(3, "Backtest", "Replay the picked wallets' real trades with these rules. Prices come from each trade's own swap.")}
      <div class="b-bar">${seg("btdays", DAY_OPTS, f.btDays)}<button type="button" class="b-btn pri" data-act="bt" id="bBtBtn">${ic("chart")}Run backtest</button></div>
      <div id="bBt">${btHtml()}</div>
    </section>
    ${startBox("Paper mode: fills are priced by a real router quote on Monad when the followed wallet's trade reaches Chord's feed; nothing is sent. Each fill is committed on-chain to the agent's ERC-8004 track record.", "Start agent")}`;
}
function alertFormHtml() {
  return `<section class="b-step">${stepHead(1, "Watch", "Wallets, tokens, or both.")}
      <div class="b-lbl">Wallets</div>
      <div class="b-add"><input id="bAddW" class="mono" placeholder="Paste a Monad wallet address (0x…)" spellcheck="false" autocomplete="off" aria-label="Add a wallet"><button type="button" class="b-btn" data-act="addw">Add</button></div>
      <p class="b-hint" id="bAddMsg"></p>
      <div class="b-chips" id="bChips"></div>
      <div class="b-lbl">Tokens</div>
      <div class="b-add"><input id="bAddM" class="mono" placeholder="Paste a Monad token address (0x…)" spellcheck="false" autocomplete="off" aria-label="Add a token"><button type="button" class="b-btn" data-act="addm">Add</button></div>
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
}
const createHash = () => (S.f.type === "alert" ? "#agents/new/alert" : "#agents/new");

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
  return `<div class="b-tbl b-trs${c.loading ? " b-dim" : ""}"><div class="b-th"><span></span><span>Wallet</span><span class="b-n">Score</span><span class="b-n">Realized</span><span class="b-n">Volume</span><span class="b-n">Win</span><span class="b-n">Trades</span><span>Best</span></div>
    ${rows.map(trRow).join("")}
    ${c.list.length > 10 ? `<button type="button" class="b-more" data-act="more">${S.f.more ? "Top 10" : `All ${c.list.length}`}</button>` : ""}</div>
    ${c.err ? `<p class="b-warnt">${esc(c.err)}</p>` : ""}`;
}
function trRow(t) {
  const on = S.f.wallets.includes(t.wallet), dis = !on && S.f.wallets.length >= MAX_WALLETS, bt = t.bestToken;
  return `<label class="b-tr${on ? " on" : ""}${dis ? " dis" : ""}"><input type="checkbox" data-w="${esc(t.wallet)}"${on ? " checked" : ""}${dis ? " disabled" : ""} aria-label="Follow ${esc(short(t.wallet))}"><span class="b-box">${svg("check", 3)}</span>
    <span class="b-tw"><span><span class="mono">${esc(short(t.wallet))}</span><a href="${EXP.acct}${encodeURIComponent(t.wallet)}" target="_blank" rel="noopener" title="Open on Monadscan" aria-label="Open on Monadscan">${ic("ext")}</a></span><small title="${esc(`${plural(t.tokens, "token")} traded, last trade ${ago(t.lastTrade)}`)}">${plural(t.tokens, "token")}${N(t.medianHoldS) != null ? `, ${dur(t.medianHoldS)} hold` : ""}, ${esc(agoC(t.lastTrade))}</small></span>
    <span class="b-tstats"><span class="b-n" data-k="Score">${compact(t.score)}</span><span class="b-n ${cls(t.realizedPnlUsd)}" data-k="PnL">${signed(t.realizedPnlUsd)}</span><span class="b-n" data-k="Volume">${usd(t.volumeUsd)}</span><span class="b-n" data-k="Win">${pct(t.winRate)}</span><span class="b-n" data-k="Trades">${int(t.trades)}</span></span>
    <span class="b-best">${bt ? `${tokLogo(bt.symbol, imgOf(bt), "sm", bt.mint)}<b>${esc(bt.symbol ?? "?")}</b><small class="${cls(bt.realizedPnlUsd)}">${signed(bt.realizedPnlUsd)}</small>` : `<small>-</small>`}</span></label>`;
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
  if (!ADDR.test(v)) return hint(msgId, `That is not a Monad ${what} address (0x and 40 hex characters).`);
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
  const ready = f.type === "copy" ? f.wallets.length > 0 : f.wallets.length + f.mints.length > 0;
  if (b) { b.disabled = f.busy || !ready; b.innerHTML = f.busy ? `${ic("spin")}Starting…` : f.type === "copy" ? "Start agent" : "Start alert"; }
  if (msg && !msg.classList.contains("bad")) msg.textContent = ready ? "" : f.type === "copy" ? "Pick a wallet first" : "Add a wallet or token";
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
    if (f.btBusy) return `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p>${ic("spin")}Replaying ${plural(f.wallets.length, "wallet")}, ${dayTag(f.btDays)}…</p></div>`;
    if (f.btErr) return errBox(f.btErr, "bt");
    return `<div class="b-none">${f.wallets.length ? "No run yet" : "Pick wallets first"}</div>`;
  }
  const bt = f.bt, r = N(bt.realizedUsd) ?? 0, u = N(bt.unrealizedUsd) ?? 0, tot = r + u, dd = Math.abs(N(bt.maxDrawdownUsd) ?? 0);
  const fills = rows(bt.fills).sort((a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0));
  const shown = f.btAll ? fills : fills.slice(0, 25);
  const notes = Array.isArray(bt.notes) ? bt.notes.filter((n) => typeof n === "string" && n) : [];
  return `<div class="b-btres${f.btBusy ? " b-dim" : ""}">
    ${f.btErr ? `<div class="b-banner bad">${ic("alert")}<span>${esc(f.btErr)}</span></div>` : ""}
    <p class="b-stale" id="bStale" hidden>${ic("alert")}Settings changed, run again</p>
    <div class="b-bth ag-ih"><em class="ag-rp">${esc(replayTag(bt.days, bt.coveredHours))}</em>${walletsReadChip(bt)}<span>${plural(bt.wallets?.length ?? 0, "wallet")}, ${usd(bt.usdPerTrade)}/trade</span>${info(noteList(notes))}</div>
    <div class="b-tiles b-t5">${tile("PnL", signed(tot), `realized ${signed(r)}, open ${signed(u)}`, cls(tot))}${tile("Win rate", pct(bt.winRate))}${tile("Trades", int(bt.trades), `${int(bt.buys)} buy, ${int(bt.sells)} sell, ${int(bt.skipped)} skip`)}${tile("Drawdown", dd ? `${MINUS}${usd(dd)}` : "$0.00", "", dd ? "b-down" : "")}${tile("Invested", usd(bt.investedUsd ?? 0))}</div>
    ${equityHtml(bt.equity, "Equity")}
    ${fills.length ? `<div class="b-sech"><h3>Fills</h3><small>${int(fills.length)}</small></div>${fillsTable(shown, null, fills.length > shown.length ? `<button type="button" class="b-more" data-act="bt-all">All ${int(fills.length)}</button>` : "")}` : `<div class="b-none">No trades in this window</div>`}
  </div>`;
}

async function createBot() {
  const f = S.f;
  if (f.busy) return;
  const built = f.type === "copy" ? copyParams() : alertParams();
  if (built.err) return setMsg(built.err, true);
  setMsg("", false);
  f.busy = true; paintGo();
  try {
    const body = { type: f.type, params: built.params, ...(f.name.trim() ? { name: f.name.trim() } : {}), ...(f.type === "copy" ? { mode: "paper" } : {}) };
    const j = await api("/v1/agents", { method: "POST", body });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    S.bots = [bot, ...(S.bots ?? []).filter((x) => x.id !== bot.id)];
    S.f = { ...freshForm(), days: f.days, btDays: f.btDays };
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
  const addrs = (a) => (Array.isArray(a) ? [...new Set(a.map((x) => String(x ?? "").trim()).filter((x) => ADDR.test(x)))] : null);
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

// ── Detail: the agent's numbers on the left, its record on Monad on the right; every fill row links its commit ────────────
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
    const first = !det.data;
    det.data = { bot: j.bot, positions: rows(j.positions), fills: rows(j.fills).sort(byTs), events: rows(j.events).sort(byTs) };
    det.err = null;
    if (!det.pub) syncListBot(j.bot);
    if (!first) { paintHead(); paintHero(); paintPos(); paintFills(); paintLog(); return; } // the trust panel keeps its own state
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
    el.innerHTML = det.err ? errBox(det.err, "retry-det") : `<div class="b-skel" style="height:54px;width:55%"></div><div class="b-skel" style="height:160px;margin-top:18px"></div><div class="b-skel" style="height:220px;margin-top:18px"></div>`;
    return;
  }
  const copy = trades(det.data.bot);
  el.innerHTML = `<div id="bdHead"></div>
    <div class="bd-grid${copy ? "" : " one"}"><div class="bd-main"><div id="bdHero"></div>${copy ? `<section class="b-sec"><div class="b-sech"><h3>Open positions</h3><small id="bdPosN"></small></div><div id="bdPos"></div></section>` : ""}</div>${copy ? `<aside class="bd-side"><div id="bdTrust"></div></aside>` : ""}</div>
    <section class="b-sec"><div class="b-sech"><h3>${copy ? "Fills" : "Matches"}</h3><small id="bdFillsN"></small>${copy ? info("Each filled trade is a JSON document; its keccak-256 goes into this agent's hash chain on Monad. The On Monad column links the commit transaction and how long after the fill it landed.", "About fills") : ""}</div><div id="bdFills"></div></section>
    <section class="b-sec"><div class="b-sech"><h3>Log</h3></div><div id="bdLog"></div></section>`;
  paintHead(); paintHero(); paintPos(); paintFills(); paintLog(); mountTrust();
}
// On-chain trust (trust.js): one mounted panel per open agent, the same node re-attached across the repaints. Its answer
// (/v1/trust/agents/:id) comes back here too: the head shows the ERC-8004 id, each fill row its commit.
let TRp = null;
const trustMod = () => (TRp ??= import(`./trust.js${new URL(import.meta.url).search}`).catch((e) => { TRp = null; throw e; }));
function mountTrust() {
  const det = S.det, host = $("bdTrust"); if (!host || !det?.data) return;
  if (S.trust?.id === det.id && S.trust.el) { host.replaceWith(S.trust.el); return; }
  S.trust?.api?.destroy?.();
  const el = document.createElement("div"); el.id = "bdTrust"; host.replaceWith(el);
  S.trust = { id: det.id, el, api: null };
  trustMod().then((m) => {
    if (S.trust?.el !== el) return;
    S.trust.api = m.mountTrustPanel(el, { api, botId: det.id, icon: (n) => ic(n), autoVerify: det.verify, onData: (t) => onTrust(det, t) });
    if (det.verify) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }));
  }).catch(() => {});
}
function onTrust(det, t) {
  if (S.det !== det || !t) return;
  const id = t.identity?.agentId ?? null, m = new Map();
  for (const f of rows(t.fills)) if (f.fillId) m.set(f.fillId, f);
  const sig = `${id}|${[...m.values()].map((f) => `${f.seq}:${f.commitTx ?? ""}`).join(",")}`;
  if (sig === det.commitSig) return;
  det.commitSig = sig; det.agentId = id; det.commits = m;
  paintHead(); paintFills();
}
const LIVE = { on: "Live", connecting: "Connecting…", retry: "Reconnecting…", off: "Offline" };
const liveTag = () => `<span class="b-live ${S.live}" id="bdLive">${LIVE[S.live]}</span>`;
function setLive(s) { S.live = s; const el = $("bdLive"); if (el) { el.className = `b-live ${s}`; el.textContent = LIVE[s]; } }
function paintHead() {
  const el = $("bdHead"), det = S.det; if (!el || !det?.data) return;
  const b = det.data.bot;
  const fork = stratOf(b) || b.type === "classic" ? `<button type="button" class="b-btn" data-act="fork" title="${b.type === "classic" ? "Open these settings in the classic backtester" : "Open a copy of this strategy in the builder"}">${ic("fork")}Fork</button>` : "";
  let ctl;
  const list = trades(b) && (!det.pub || mineIds().has(b.id)) ? `<a class="b-btn" href="#market/list/${esc(b.id)}" title="List this agent on the marketplace, ranked by its record on Monad">${ic("tag")}List</a>` : "";
  if (det.pub) ctl = `${fork}${list}${mineIds().has(b.id) ? "" : `<button type="button" class="b-new" data-copy="${esc(b.id)}" title="Copy this agent: a new paper agent with the same rules">${ic("copy")}Copy agent</button>`}`;
  else if (det.confirm) ctl = `<span class="b-confirm">Delete with history?</span><button type="button" class="b-btn danger" data-act="del-yes"${det.busy ? " disabled" : ""}>${det.busy === "del" ? `${ic("spin")}Deleting…` : "Delete"}</button><button type="button" class="b-btn" data-act="del-no"${det.busy ? " disabled" : ""}>Keep</button>`;
  else {
    const run = b.status === "running", dis = det.busy ? " disabled" : "";
    const label = det.busy === "pause" ? "Pausing…" : det.busy === "resume" ? "Resuming…" : run ? "Pause" : "Resume";
    ctl = `${fork}${list}<button type="button" class="b-btn" data-act="${run ? "pause" : "resume"}"${dis}>${ic(det.busy ? "spin" : run ? "pause" : "play")}${label}</button><button type="button" class="b-btn danger" data-act="del"${dis}>${ic("trash")}Delete</button>`;
  }
  const idChip = det.agentId ? `<a class="ag-id lg" href="${esc(idUrl(det.agentId))}" target="_blank" rel="noopener" title="${esc(`ERC-8004 agent #${det.agentId} on Monad's Identity Registry`)}">ERC-8004 #${esc(det.agentId)}${ic("ext")}</a>` : "";
  el.innerHTML = `<div class="b-dh">${av(b, 56)}
      <div class="b-dt"><h2>${esc(b.name || "Untitled agent")}</h2><div class="b-meta"><span>${typeShort(b)}</span>${badge(b.mode)}${statusHtml(b.status)}<span title="${esc(`Started ${ago(b.createdAt)}`)}">${esc(agoC(b.createdAt))}</span>${idChip}${det.pub ? "" : liveTag()}</div></div>
      <div class="b-ctl">${ctl}</div></div>
    ${b.error ? `<div class="b-banner bad">${ic("alert")}<span>${esc(b.error)}</span></div>` : ""}
    ${det.msg ? `<div class="b-banner bad">${ic("alert")}<span>${esc(det.msg)}</span></div>` : ""}`;
}
const addrChip = (a, kind) => `<a class="b-chip ln" href="${kind === "token" ? EXP.token : EXP.acct}${encodeURIComponent(a)}" target="_blank" rel="noopener" title="${esc(a)}"><span class="mono">${esc(short(a))}</span>${ic("ext")}</a>`;
/** the numbers card: total PnL large, then one row of figures, then what the agent follows and its rules */
function perfCard(big, figs, foot = "") {
  return `<section class="bd-perf"><div class="bd-pnl">${big}</div><div class="bd-figs">${figs.join("")}</div>${foot ? `<div class="bd-foot">${foot}</div>` : ""}</section>`;
}
const fg = (k, v, sub = "", c = "") => `<div class="bd-fig"><small>${esc(k)}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
function paintHero() {
  const el = $("bdHero"), det = S.det; if (!el || !det?.data) return;
  const b = det.data.bot, st = b.stats ?? {}, p = b.params ?? {}, sp = stratOf(b);
  const last = fg("Last event", st.lastEventAt ? esc(agoC(st.lastEventAt)) : "-");
  const tradesFig = fg("Trades", int(st.trades), `${int(st.buys)} buy, ${int(st.sells)} sell, ${int(st.skipped)} skip`);
  const pnlBig = (inv, tot) => `<small>Total PnL</small><b class="${cls(tot)}">${signed(tot)}</b><span>${inv ? `<span class="${cls(tot)}">${signedPct(tot / inv)}</span> on ${usd(inv)} invested` : "no trades yet"}</span>`;
  const r = N(st.realizedUsd) ?? 0, u = N(st.unrealizedUsd) ?? 0, tot = r + u, inv = N(st.investedUsd) ?? 0;
  if (b.type === "custom") {
    const xl = explainOf(b), lim = sp?.limits ?? {}, ws = Array.isArray(sp?.trigger?.wallets?.list) ? sp.trigger.wallets.list : [];
    const foot = `${ws.length ? `<div class="b-params"><span class="b-pk">Following</span>${ws.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      ${xl.length ? `<div class="b-rules bb-xs">${sp && BM ? `<span class="bb-xsum">${esc(BM.summary(sp))}</span>` : ""}<details class="ag-notes bb-xdd"><summary>Rules</summary><ol class="bb-xd">${xl.map((x) => `<li>${xlHtml(x)}</li>`).join("")}</ol></details></div>` : sp ? "" : `<div class="b-none">No strategy attached</div>`}`;
    el.innerHTML = trades(b)
      ? perfCard(pnlBig(inv, tot), [fg("Realized", signed(r), "", cls(r)), fg("Unrealized", signed(u), "", cls(u)), fg("Win rate", pct(st.winRate)), tradesFig, fg("Open", `${int(st.openPositions)}${N(lim.maxOpenPositions) != null ? `<em class="ag-of">/${int(lim.maxOpenPositions)}</em>` : ""}`), last], foot)
      : perfCard(`<small>Matches</small><b>${int(st.trades)}</b><span>${sp?.action?.type === "webhook" ? "sent to a webhook" : "kept in the log"}</span>`, [fg("Matches", int(st.trades)), fg("Skipped", int(st.skipped)), last], foot);
  } else if (b.type === "lp") {
    const ls = det.lp, pos = rows(det.data.positions)[0];
    if (det.lpAt == null || Date.now() - det.lpAt > 60_000) { det.lpAt = Date.now(); api(`/v1/agents/lp/state/${encodeURIComponent(b.id)}`).then((j) => { if (S.det === det) { det.lp = j; paintHero(); } }).catch(() => {}); }
    const pxs = (v) => (v == null ? "∞" : Number(v) >= 1 ? Number(v).toPrecision(5) : Number(v).toPrecision(4));
    const range = ls ? (ls.range.low == null ? "Full range" : `${pxs(ls.range.low)} – ${pxs(ls.range.high)}`) : "-";
    const foot = ls ? `<div class="b-rules"><span title="Pool">${esc(ls.pair)}</span><span title="DEX and fee">${esc(ls.dex)}, ${(ls.feeBps / 100).toFixed(2)}%</span><span title="Range, in ${esc(ls.anchor)} per ${esc(ls.side)}">${esc(range)}</span><span title="Re-centred after 6 hours out of range">${p.rebalance === false ? "no re-centre" : "re-centres"}</span><span title="Amount in the pool">${usd(p.amountUsd)}</span></div>
      <div class="b-params"><span class="b-pk">Pool</span><a class="b-chip ln" href="${EXP.acct}${encodeURIComponent(ls.pool)}" target="_blank" rel="noopener"><span class="mono">${esc(short(ls.pool))}</span>${ic("ext")}</a><a class="b-chip ln" href="#agents/lp/${esc(ls.pool)}"><span>Pool page</span></a></div>` : "";
    el.innerHTML = perfCard(pnlBig(inv, tot), [fg("Value", pos ? usd(pos.priceUsd) : "-", ls ? `${usd(ls.costUsd)} in` : ""), fg("Fees earned", ls ? usd(ls.feesUsd) : "-", "", "up"), fg("In range", ls?.inRangePct != null ? `${Math.round(ls.inRangePct)}%` : "-", ls ? `${int(ls.hoursInRange)}/${int(ls.hoursSeen)} hours` : ""),
      fg("Re-centres", ls ? int(ls.rebalances) : "-"), fg("Realized", signed(r), "", cls(r)), last], foot);
  } else if (b.type === "classic") {
    const pos = rows(det.data.positions)[0], q = N(pos?.qty) ?? 0, perp = p.venue === "perpl";
    const t = (H.cls ?? []).find((x) => x.id === p.strategy);
    const side = !pos ? "Flat" : q < 0 ? "Short" : "Long";
    const rules = [[t?.title ?? p.strategy, t?.rule ?? "Classic strategy"], [`${p.symbol} ${p.tf}`, "Market and timeframe"], [perp ? `Perpl perps` : "Monad spot", perp ? "Paper fills walk Perpl's live book and pay its taker fee" : "Paper fills priced by Chord's router on Monad"],
      [`${usd(p.sizeUsd)}${perp ? ` at ${p.leverage}x` : ""}`, "Size per position"], [`signals: ${({ binance: "Binance", okx: "OKX", hyperliquid: "Hyperliquid", perpl: "Perpl" })[p.signalSource] ?? p.signalSource}`, "Closed candles from this source drive the strategy"]];
    const foot = `<div class="b-rules">${rules.map(([x, tt]) => `<span title="${esc(tt)}">${esc(x)}</span>`).join("")}</div>${perp ? `<div class="b-params"><span class="b-pk">Venue</span><a class="b-chip ln" href="${PERPL_APP}" target="_blank" rel="noopener"><span>Perpl, ${esc(p.symbol)}-PERP</span>${ic("ext")}</a></div>` : ""}`;
    el.innerHTML = perfCard(pnlBig(inv, tot), [fg("Position", side, pos ? `${usd(Math.abs(N(pos.costUsd) ?? 0))} at ${usd(Math.abs(N(pos.costUsd) ?? 0) / Math.max(1e-12, Math.abs(q)))}` : "", side === "Long" ? "up" : side === "Short" ? "down" : ""),
      fg("Realized", signed(r), "", cls(r)), fg("Unrealized", signed(u), "", cls(u)), fg("Win rate", pct(st.winRate)), tradesFig, last], foot);
    if (H.cls === undefined) loadCls().then(() => S.det === det && paintHero());
    if (det.clsWin === undefined) { det.clsWin = null; api(`/v1/classic/board?symbol=${encodeURIComponent(p.symbol)}&tf=${encodeURIComponent(p.tf)}`).then((j) => { if (S.det === det) { det.clsWin = rows(j.rows); paintHero(); } }).catch(() => {}); }
    const wl = winLine(p.strategy, p.symbol, p.tf, det.clsWin);
    if (wl) el.querySelector(".bd-foot")?.insertAdjacentHTML("afterbegin", `<div class="b-params"><span class="b-pk" title="This setup on the backtest board: median across Binance, OKX, Hyperliquid and Perpl, $1,000 at 1x">Backtest</span>${wl}</div>`);
  } else if (b.type === "copy") {
    const per = N(p.usdPerTrade);
    const rules = [per != null && [`${usd(per)}/trade`, "Per mirrored buy"], per != null && [`${usd(N(p.maxPerTokenUsd) ?? per * 3)}/token`, "Max per token"], [`${int(p.maxOpenPositions ?? 10)} open max`, "Max open positions"],
      [`${+((N(p.slippageBps) ?? 100) / 100).toFixed(2)}% slip`, "Slippage"], [`liq ≥ ${usd(p.minLiquidityUsd ?? 20000)}`, "Min liquidity"], [p.safety === false ? "safety off" : "safety on", "No transfer tax, and a $10 round trip through the router returns at least 90%"],
      [p.mirrorSells === false ? "holds sells" : "mirrors sells", "When a followed wallet sells"], [N(p.dailyLossStopUsd) ? `stop ${usd(p.dailyLossStopUsd)}/day` : "no daily stop", "Daily loss stop"]].filter(Boolean);
    const foot = `${p.wallets?.length ? `<div class="b-params"><span class="b-pk">Following</span>${p.wallets.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}<div class="b-rules">${rules.map(([x, t]) => `<span title="${esc(t)}">${esc(x)}</span>`).join("")}</div>`;
    el.innerHTML = perfCard(pnlBig(inv, tot), [fg("Realized", signed(r), "", cls(r)), fg("Unrealized", signed(u), "", cls(u)), fg("Win rate", pct(st.winRate)), tradesFig, fg("Open", `${int(st.openPositions)}<em class="ag-of">/${int(p.maxOpenPositions ?? 10)}</em>`), last], foot);
  } else {
    const hookHost = (() => { try { return new URL(p.webhook).host; } catch { return null; } })();
    const foot = `${p.wallets?.length ? `<div class="b-params"><span class="b-pk">Wallets</span>${p.wallets.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      ${p.mints?.length ? `<div class="b-params"><span class="b-pk">Tokens</span>${p.mints.map((m) => addrChip(m, "token")).join("")}</div>` : ""}`;
    el.innerHTML = perfCard(`<small>Matches</small><b>${int(st.trades)}</b><span>trades of ${usd(p.minUsd ?? 1000)} or more</span>`,
      [fg("Wallets", int(p.wallets?.length ?? 0)), fg("Tokens", int(p.mints?.length ?? 0)), fg("Webhook", p.webhook ? "On" : "Off", !det.pub && hookHost ? esc(hookHost) : ""), fg("Skipped", int(st.skipped)), last], foot);
  }
}
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
  const perp = String(p.mint).startsWith("perpl:"), sideTag = perp ? `<em class="b-pside ${N(p.qty) < 0 ? "sell" : "buy"}">${N(p.qty) < 0 ? "Short" : "Long"}</em>` : "";
  return `<div class="b-pr"><span class="b-tok">${tokLogo(p.symbol ?? "?", imgOf(p), "", p.mint)}<span><a href="${esc(tokHref(p.mint))}" target="_blank" rel="noopener" title="${esc(perp ? `${p.symbol} on Perpl` : p.mint)}"><b>${esc(symOf(p.symbol, p.mint))}</b></a>${sideTag}<small title="Opened">${esc(age(p.openedAt))}</small></span></span>
    <span class="b-n" data-k="Qty">${qty(Math.abs(N(p.qty) ?? 0))}</span><span class="b-n" data-k="Cost">${usd(perp ? Math.abs(cost ?? 0) : cost)}</span><span class="b-n" data-k="Value">${usd(perp ? Math.abs(N(p.valueUsd) ?? 0) : p.valueUsd)}</span>
    <span class="b-n b-ppl ${cls(pnl)}" data-k="PnL">${signed(pnl)}${cost && pnl != null ? `<small>${signedPct(pnl / Math.abs(cost))}</small>` : ""}</span></div>`;
}
/** fills (the agent's page, and replays in the create form and the builder). commits (the agent's page only): fill id → its
 *  record on Monad, which adds the On Monad column */
function fillsTable(fills, fresh, footer = "", commits = null) {
  // custom agents and replays: what fired, not a wallet (a replay's source names the trigger, e.g. "price move", not an address)
  const trig = !fills.some((f) => ADDR.test(f.source?.wallet ?? "")) && fills.some((f) => f.source?.detail || f.source?.wallet);
  return `<div class="b-tbl b-fills${commits ? " oc" : ""}"><div class="b-th"><span>Time</span><span>Side</span><span>Token</span><span class="b-n">Amount</span><span class="b-n">Price</span>${trig ? `<span title="What fired the trade">Trigger</span>` : `<span title="Followed wallet">Wallet</span>`}<span class="b-n">PnL</span>${commits ? `<span class="b-n" title="Sequence number in the agent's chain on Monad, linked to its commit transaction">On Monad</span>` : ""}</div>${fills.map((f) => fillRow(f, fresh?.has(f.id), commits)).join("")}${footer}</div>`;
}
/** a trigger's text for a narrow cell: "schedule: every 1d" → "every 1d", cut at a word */
const trigShort = (d) => { const t = agentWords(d).replace(/^\s*(trigger|schedule|price|confluence)\s*[:·-]\s*/i, "").trim(); return t.length > 28 ? `${t.slice(0, 27).replace(/\s+\S*$/, "")}…` : t; };
const lagS = (ms) => (N(ms) == null ? "" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
/** the On Monad cell: #seq linked to the commit tx and the lag after the fill; pending while the committer has not sent it */
function commitCell(f, commits) {
  if (f.status === "skipped") return `<span class="b-n b-oc"></span>`;
  const c = commits.get(f.id);
  if (!c) return `<span class="b-n b-oc dim" title="Not in the agent's record: filled before its ERC-8004 identity, or still being written">-</span>`;
  if (!c.commitTx) return `<span class="b-n b-oc pend" title="Hashed, waiting for the next commit (every 15 s)">#${int(c.seq)} pending</span>`;
  return `<span class="b-n b-oc"><a href="${EXP.tx}${encodeURIComponent(c.commitTx)}" target="_blank" rel="noopener" title="${esc(`Fill #${c.seq} in this agent's chain, committed ${lagS(c.lagMs)} after the fill. Document hash ${c.hash}`)}">${ic("check", 2.4)}#${int(c.seq)}</a><small>${esc(lagS(c.lagMs))}</small></span>`;
}
function fillRow(f, fresh, commits) {
  const sk = f.status === "skipped", src = f.source ?? {}, sell = f.side === "sell";
  const lag = sk ? -1 : (toMs(f.ts) ?? 0) - (toMs(src.ts) ?? Infinity), w = when(f.ts); // a skip has no reaction time
  const lagTxt = lag >= 0 && lag < 3_600_000 ? `+${lag < 10_000 ? (lag / 1000).toFixed(1) : Math.round(lag / 1000)}s` : null;
  const q = f.quote;
  const qt = q ? `${esc(q.provider ?? "Router")} quote${q.route?.length ? `: ${q.route.join(" › ")}` : ""}${N(q.priceImpactPct) != null ? `, impact ${N(q.priceImpactPct).toFixed(2)}%` : ""}` : "";
  const pl = sk ? "" : sell && N(f.pnlUsd) != null ? signed(f.pnlUsd) : "";
  return `<div class="b-fr${sk ? " b-sk" : ""}${fresh ? " b-flash" : ""}"${sk ? ` title="${esc(`Skipped: ${agentWords(f.reason || "a filter")}`)}"` : ""}>
    <span class="b-ft"${lagTxt ? ` title="${lagTxt} after the followed wallet's trade"` : ""}>${w.hm}${w.day ? `<small class="b-day">${w.day}</small>` : lagTxt ? `<small>${lagTxt}</small>` : ""}</span>
    <span class="b-side ${sk ? "skip" : sell ? "sell" : "buy"}">${sk ? "Skip" : sell ? "Sell" : "Buy"}</span>
    <span class="b-tok"><span class="b-side m ${sk ? "skip" : sell ? "sell" : "buy"}" aria-hidden="true">${sk ? "Skip" : sell ? "Sell" : "Buy"}</span>${tokLogo(f.symbol ?? "?", imgOf(f), "", f.mint)}<span><b>${esc(symOf(f.symbol, f.mint))}</b>${sk ? `<small class="b-skl">${esc(skipLine(f.reason))}</small>` : N(f.tokenAmount) ? `<small>${qty(f.tokenAmount)}</small>` : ""}</span></span>
    <span class="b-n b-amt">${usd(f.usd)}</span>
    <span class="b-n b-px"${qt ? ` title="${esc(qt)}"` : ""}>${price(f.priceUsd)}</span>
    <span class="b-src">${ADDR.test(src.wallet ?? "") ? `<a href="${EXP.acct}${encodeURIComponent(src.wallet)}" target="_blank" rel="noopener" title="${esc(src.wallet)}">${esc(short(src.wallet, 6, 4))}</a>` : src.detail ? `<span class="b-trg" title="${esc(agentWords(src.detail))}">${esc(trigShort(src.detail))}</span>` : src.wallet ? `<span class="b-trg">${esc(src.wallet)}</span>` : "-"}${TXH.test(src.tx ?? "") ? `<a class="b-tx" href="${EXP.tx}${encodeURIComponent(src.tx)}" target="_blank" rel="noopener" title="The trade that fired it, on Monad" aria-label="The trade that fired it, on Monad">${ic("ext")}</a>` : ""}</span>
    <span class="b-n b-pl ${sk ? "" : cls(sell ? f.pnlUsd : null)}">${pl}</span>
    ${commits ? commitCell(f, commits) : ""}
  </div>`;
}
function paintFills() {
  const el = $("bdFills"), det = S.det; if (!el || !det?.data) return;
  const fills = det.data.fills, copy = trades(det.data.bot);
  const n = $("bdFillsN"); if (n) n.textContent = fills.length ? int(fills.length) : "";
  el.innerHTML = fills.length
    ? fillsTable(fills.slice(0, det.nFills), det.fresh, fills.length > det.nFills ? `<button type="button" class="b-more" data-act="fills-more">Show more</button>` : "", copy ? det.commits : null)
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
  return `<div class="b-chart"><div class="b-cth">${esc(title)}<span>${usd(pts[0].v)} to <b class="${up ? "b-up" : "b-down"}">${usd(pts[pts.length - 1].v)}</b></span></div>
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
  const a = t.closest("[data-go],[data-open],[data-act],[data-days],[data-btdays],[data-type],[data-tog],[data-rm],[data-rmm],[data-win],[data-copy],[data-smart],[data-tstart],[data-tbuild],[data-stdays],[data-pg],[data-stcopy],[data-caddr],[data-cls],[data-clstart]");
  if (!a || !root.contains(a)) return;
  if (a.matches("[data-open]") && t.closest("a[href]")) return;
  const ds = a.dataset;
  if (ds.act === "back") return goBack(ds.to);
  if (ds.go) return go(ds.go, { type: ds.type, fresh: true });
  if (ds.open) return go("detail", { id: ds.open, pub: ds.pub === "1" });
  if (ds.type) { if (S.f.type !== ds.type) { S.f.type = ds.type; setMsg("", false); paintForm(); } return; }
  if (ds.days) { S.f.days = Number(ds.days); S.f.more = false; segOn(a); paintTraders(); loadTraders(); return; }
  if (ds.btdays) { S.f.btDays = Number(ds.btdays); segOn(a); stale(); return; }
  if (ds.tog) { S.f[ds.tog] = !S.f[ds.tog]; a.setAttribute("aria-checked", String(S.f[ds.tog])); stale(); return; }
  if (ds.rm != null) { S.f.wallets = S.f.wallets.filter((w) => w !== ds.rm); hint("bAddMsg", ""); paintSel(); return; }
  if (ds.rmm != null) { S.f.mints = S.f.mints.filter((m) => m !== ds.rmm); paintSel(); return; }
  if (ds.win) { if (H.win !== ds.win) { H.win = ds.win; paintLb(); loadLb(); } return; }
  if (ds.copy) return void copyAgent(ds.copy, a, S.det?.id === ds.copy ? S.det.data?.bot?.name : undefined);
  if (ds.stdays) { const v = Number(ds.stdays); if (BD.st.days !== v) { BD.st.days = v; BD.st.page = 1; paintSt(); loadSt(); } return; }
  if (ds.pg) {
    const [k, p] = ds.pg.split(":");
    if (k === "st" && Number(p) !== BD.st.page) { BD.st.page = Number(p); paintSt(); $("agStH")?.scrollIntoView({ block: "start", behavior: "smooth" }); }
    return;
  }
  if (ds.stcopy) return copyTraders([ds.stcopy]);
  if (ds.caddr) return void copyAddr(ds.caddr, a);
  if (ds.smart) { const tk = rows(H.smart?.tokens).find((x) => x.mint === ds.smart); if (tk) go("build", { strategy: smartStrategy(tk) }); return; }
  if (ds.tstart) return void startTpl(ds.tstart, a);
  if (ds.clstart) return void startCls(ds.clstart, a);
  if (ds.cls) return go("classic", { strategy: ds.cls, prefill: ds.sym ? { strategy: ds.cls, symbol: ds.sym, tf: ds.tf } : null });
  if (ds.tbuild) { const tp = tplOf(ds.tbuild); if (tp) go("build", { template: ds.tbuild, strategy: tp.strategy }); return; } // the builder marks it Loaded
  switch (ds.act) {
    case "verify-top": return verifyTop();
    case "retry-bots": S.botsErr = null; paintMine(); return void loadBots();
    case "retry-smart": H.smartErr = null; paintSmart(); return void loadSmart();
    case "retry-lb": H.boardErr = null; paintLb(); return void loadLb();
    case "lb-all": { H.lbAll = !H.lbAll; paintLb(); if (!H.lbAll) $("agBoardH")?.scrollIntoView({ block: "start" }); return; }
    case "skg": { const k = ds.k; if (F.open.has(k)) F.open.delete(k); else F.open.add(k); return paintTape(); }
    case "skips": F.skips = !F.skips; a.setAttribute("aria-pressed", String(F.skips)); a.textContent = F.skips ? "Hide skips" : "Show skips"; $("agTape")?.classList.toggle("ag-noskip", !F.skips); return;
    case "flush": return resumeTape();
    case "retry-det": if (S.det) { S.det.err = null; paintDetail(); loadDetail(); } return;
    case "traders-retry": return void loadTraders(true);
    case "st-retry": return void loadSt(true);
    case "st-clear": BD.st.sel = []; return paintStSel();
    case "st-copyn": return copyTraders(BD.st.sel);
    case "retry-build": return go("build");
    case "fork": { const fb = S.det?.data?.bot; if (fb?.type === "classic") return go("classic", { strategy: fb.params?.strategy, prefill: fb.params }); const sp = stratOf(fb); if (sp) go("build", { strategy: sp }); return; }
    case "retry-cls": return go("classic");
    case "retry-lp": return go("lp");
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
  const t = e.target, k = t.dataset?.f;
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
  else if (t.matches?.("input[data-stw]")) toggleSt(t.dataset.stw, t.checked);
}
function onKey(e) {
  const t = e.target;
  if (e.key === "Enter" && t.id === "bAddW") { e.preventDefault(); addAddr("bAddW", "bAddMsg", S.f.wallets, MAX_WALLETS, "wallet"); }
  else if (e.key === "Enter" && t.id === "bAddM") { e.preventDefault(); addAddr("bAddM", "bAddMMsg", S.f.mints, MAX_MINTS, "token"); }
  else if ((e.key === "Enter" || e.key === " ") && t.matches?.("[data-open][role=button]")) { e.preventDefault(); t.click(); }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && t.classList?.contains("b-plot")) { e.preventDefault(); stepChart(t, e.key === "ArrowRight" ? 1 : -1); }
}
