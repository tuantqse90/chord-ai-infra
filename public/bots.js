// Bots view: Solana copy-trader and alert bots in paper mode, backtests on real history, the public leaderboard.
// API: /v1/bots* (ask2049-notes/bots-contract.md). Every request carries X-Session; every server string is escaped.
// Screens: My bots · Create (copy / alert, trader picker, backtest) · Detail (live over SSE) · Leaderboard (+ public detail).
// Hash routes: #bots · #bots/new · #bots/new/alert · #bots/leaderboard · #bots/<id> · #bots/public/<id>.
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
/** { hm: "14:03:21", day: "Oct 6" | null when today } */
function when(t) {
  const ms = toMs(t); if (ms == null) return { hm: "—", day: null };
  const d = new Date(ms);
  return { hm: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), day: d.toDateString() === new Date().toDateString() ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
}
const fullTime = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const imgOf = (o) => { const u = o?.image ?? o?.logo ?? o?.logoURI ?? null; return /^https:\/\//.test(String(u ?? "")) || /^\/[^/]/.test(String(u ?? "")) ? String(u) : null; };
const tokLogo = (symbol, img, size = "") => `<span class="tlogo b-tl${size ? ` ${size}` : ""}"><b>${esc(String(symbol ?? "?").replace(/^\$/, "")[0] ?? "?")}</b>${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>`;
const rows = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === "object") : []); // drop malformed rows instead of failing the screen
const symOf = (s, mint) => (s ? String(s) : short(mint));
const STATUS = { running: "Running", paused: "Paused", stopped: "Stopped", error: "Error" };
const statusHtml = (s) => `<span class="b-st ${STATUS[s] ? s : ""}"><i></i>${esc(STATUS[s] ?? s ?? "Unknown")}</span>`;
const badge = (mode) => `<span class="b-badge${mode === "live" ? " live" : ""}">${mode === "live" ? "LIVE" : "PAPER"}</span>`;
const tile = (k, v, sub = "", c = "") => `<div class="b-tile"><small>${esc(k)}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
const errBox = (msg, act) => `<div class="b-errbox">${ic("alert")}<span>${esc(msg)}</span>${act ? `<button type="button" class="b-btn" data-act="${act}">Try again</button>` : ""}</div>`;
const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
let D = null, root = null;
const freshForm = () => ({ type: "copy", name: "", days: 7, more: false, wallets: [], mints: [], usd: "20", maxTok: "", maxOpen: "10", slip: "1", minLiq: "20000", stop: "",
  mirror: true, safety: true, btDays: 7, bt: null, btKey: null, btErr: null, btBusy: false, btAll: false, minUsd: "1000", hook: "", busy: false });
const S = { screen: null, vis: false, bots: null, botsErr: null, board: null, boardErr: null, det: null, traders: {}, f: freshForm(), tick: null, ctrl: null, live: "off", posT: null };
const session = () => (typeof D?.session === "function" ? D.session() : D?.session) ?? "";
const vis = () => !!root && !root.hidden && document.visibilityState === "visible";

const ERR = {
  too_many_bots: `You already have ${MAX_BOTS} bots. Delete one to start another.`,
  live_not_enabled: "Live mode is not switched on yet. Bots run in paper mode.",
  not_found: "This bot does not exist any more.",
};
function errText(status, j) {
  if (j?.error && ERR[j.error]) return ERR[j.error];
  if (j?.message) return String(j.message);
  if (status === 404) return ERR.not_found;
  if (status === 409) return ERR.too_many_bots;
  if (status === 429) return "Too many requests. Wait a few seconds and try again.";
  if (status >= 500) return `The server failed (${status}). Try again in a moment.`;
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
  if (!r.ok) throw new Error(errText(r.status, j));
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
  root.innerHTML = `<div class="b-wrap">
    <header class="b-head">
      <div class="b-ttl"><h1>Bots</h1><p>Copy Solana's smart traders on paper, or get alerts when wallets and tokens move.</p></div>
      <div class="b-nav">
        <div class="b-tabs" role="tablist" aria-label="Bots"><button type="button" role="tab" data-go="mine">My bots</button><button type="button" role="tab" data-go="board">Leaderboard</button></div>
        <button type="button" class="b-new" data-go="create">${ic("plus", 2.2)}New bot</button>
      </div>
    </header>
    <div id="bMain"></div>
  </div>`;
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("keydown", onKey);
  root.addEventListener("pointermove", onChartMove);
  root.addEventListener("pointerleave", (e) => { if (e.target.classList?.contains("b-plot") && document.activeElement !== e.target) hidePt(e.target); }, true);
  root.addEventListener("focusout", (e) => { if (e.target.classList?.contains("b-plot")) hidePt(e.target); });
  S.vis = !root.hidden;
  new MutationObserver(onVisibility).observe(root, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (vis()) refreshCurrent(); });
  window.addEventListener("hashchange", () => { const o = fromHash(location.hash); if (o) openBots(o); }); // a pasted #bots/… link in an open tab
}

/** Open the view. opts: { screen: "mine" | "create" | "board" | "detail", id?, pub?, type?: "copy" | "alert", prefill?: CopyParams & AlertParams & { name, type } }
 *  or a hash tail ("new", "leaderboard", "<id>", "public/<id>"). No opts: the #bots… hash, else the last screen. */
export function openBots(opts) {
  if (!root) return;
  S.vis = true;
  D.showView?.("bots");
  const o = typeof opts === "string" ? fromHash(`#bots/${opts}`) : opts ?? fromHash(location.hash);
  if (o?.prefill) applyPrefill(o.prefill);
  if (o) go(o.screen ?? "mine", o);
  else if (S.screen) resume();
  else go("mine");
}

function fromHash(h) {
  const m = /^#bots(?:\/(.*))?$/.exec(h || "");
  if (!m) return null;
  const rest = m[1] ?? "";
  if (!rest) return { screen: "mine" };
  if (rest === "new" || rest === "create") return { screen: "create" };
  if (rest === "new/alert") return { screen: "create", type: "alert" };
  if (rest === "leaderboard") return { screen: "board" };
  const pm = /^public\/(.+)$/.exec(rest);
  return pm ? { screen: "detail", id: decodeURIComponent(pm[1]), pub: true } : { screen: "detail", id: decodeURIComponent(rest) };
}
function setHash(h) { try { if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h); } catch {} }

function onVisibility() {
  const v = !root.hidden;
  if (v === S.vis) return;
  S.vis = v;
  if (!v) { stopAll(); if (/^#bots/.test(location.hash)) setHash(""); }
  else resume();
}
function resume() {
  if (!S.screen) return go("mine");
  go(S.screen, S.screen === "detail" ? { id: S.det?.id, pub: S.det?.pub } : {});
}
function refreshCurrent() {
  if (S.screen === "mine") loadBots(true);
  else if (S.screen === "board") loadBoard(true);
  else if (S.screen === "detail" && S.det) { loadDetail(true); if (!S.det.pub && !S.ctrl) startLive(); }
}
function stopAll() { stopLive(); clearInterval(S.tick); S.tick = null; clearTimeout(S.posT); }

function go(screen, o = {}) {
  stopAll();
  if (screen === "detail" && !o.id) screen = "mine";
  S.screen = screen;
  const tab = screen === "board" || (screen === "detail" && o.pub) ? "board" : screen === "mine" || screen === "detail" ? "mine" : null;
  root.querySelectorAll(".b-tabs [data-go]").forEach((b) => { const on = b.dataset.go === tab; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  const main = $("bMain");
  if (screen === "mine") {
    setHash("#bots");
    main.innerHTML = `<div id="bMine"></div>`;
    paintMine(); loadBots();
    S.tick = setInterval(() => vis() && loadBots(true), 15_000);
  } else if (screen === "board") {
    setHash("#bots/leaderboard");
    main.innerHTML = `<p class="b-lead">Every paper and live bot, ranked by realized plus unrealized PnL. Updates every 30 seconds.</p><div id="bBoard"></div>`;
    paintBoard(); loadBoard();
    if (!S.bots) loadBots(true);
    S.tick = setInterval(() => vis() && loadBoard(true), 30_000);
  } else if (screen === "create") {
    if (o.type === "copy" || o.type === "alert") S.f.type = o.type;
    setHash(S.f.type === "alert" ? "#bots/new/alert" : "#bots/new");
    main.innerHTML = createHtml();
    paintSel(); paintGo();
    if (S.f.type === "copy") loadTraders();
  } else if (screen === "detail") {
    S.det = { id: String(o.id), pub: !!o.pub, data: null, err: null, confirm: false, busy: null, msg: null, nFills: 50, nEv: 40, fresh: new Set() };
    setHash(o.pub ? `#bots/public/${encodeURIComponent(o.id)}` : `#bots/${encodeURIComponent(o.id)}`);
    main.innerHTML = `<div class="b-crumb"><button type="button" data-go="${o.pub ? "board" : "mine"}">${ic("back")}${o.pub ? "Leaderboard" : "My bots"}</button></div><div id="bDet"></div>`;
    paintDetail(); loadDetail();
    if (!o.pub) startLive();
    S.tick = setInterval(() => vis() && loadDetail(true), o.pub ? 15_000 : 30_000);
  }
  root.scrollTop = 0;
}

// ── My bots ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadBots(quiet) {
  try { const j = await api("/v1/bots"); S.bots = rows(j.bots).filter((b) => b.id); S.botsErr = null; }
  catch (e) { S.botsErr = e.message; }
  if (S.screen === "mine" && (!quiet || S.bots)) paintMine();
}
function paintMine() {
  const el = $("bMine"); if (!el) return;
  if (S.botsErr && !S.bots) { el.innerHTML = errBox(S.botsErr, "retry-bots"); return; }
  if (!S.bots) { el.innerHTML = `<div class="b-cards">${`<div class="b-card b-skc"><div class="b-skel" style="height:34px;width:62%"></div><div class="b-skel" style="height:30px;width:44%"></div><div class="b-skel" style="height:46px"></div></div>`.repeat(3)}</div>`; return; }
  if (!S.bots.length) {
    el.innerHTML = `<div class="b-empty"><div class="b-empty-ic">${ic("bot", 1.6)}</div><h2>No bots yet</h2>
      <p>Pick Solana's best traders, backtest them on their real trades, then let a paper bot mirror them as they trade.</p>
      <button type="button" class="b-cta" data-go="create" data-type="copy">${ic("plus", 2.2)}Create a copy bot</button>
      <button type="button" class="b-linkbtn" data-go="create" data-type="alert">or set up an alert</button></div>`;
    return;
  }
  el.innerHTML = `<div class="b-sub"><span>${plural(S.bots.length, "bot")} · up to ${MAX_BOTS} per session. Bots belong to this browser's session.</span>${S.botsErr ? `<span class="b-warnt">${esc(S.botsErr)}</span>` : ""}</div>
    <div class="b-cards">${S.bots.map(cardHtml).join("")}</div>`;
}
const fig = (k, v) => `<span><small>${esc(k)}</small><b>${v}</b></span>`;
function cardHtml(b) {
  const st = b.stats ?? {}, p = b.params ?? {}, copy = b.type === "copy";
  const nw = p.wallets?.length ?? 0, nm = p.mints?.length ?? 0;
  const tot = (N(st.realizedUsd) ?? 0) + (N(st.unrealizedUsd) ?? 0);
  const sub = copy ? `Copy trader · ${plural(nw, "wallet")}` : `Alert · ${[nw && plural(nw, "wallet"), nm && plural(nm, "token")].filter(Boolean).join(", ") || "nothing watched"}`;
  const body = copy
    ? `<div class="b-pnl ${cls(tot)}">${signed(tot)}<small>PnL</small></div>
       <div class="b-split"><span>Realized <b class="${cls(st.realizedUsd)}">${signed(st.realizedUsd ?? 0)}</b></span><span>Unrealized <b class="${cls(st.unrealizedUsd)}">${signed(st.unrealizedUsd ?? 0)}</b></span></div>
       <div class="b-figs">${fig("Invested", usd(st.investedUsd ?? 0))}${fig("Trades", int(st.trades))}${fig("Open", int(st.openPositions))}${fig("Win rate", pct(st.winRate))}</div>`
    : `<div class="b-pnl">${int(st.trades)}<small>${N(st.trades) === 1 ? "match" : "matches"}</small></div>
       <div class="b-split"><span>Trades of <b>${usd(p.minUsd ?? 1000)}</b> or more</span></div>
       <div class="b-figs">${fig("Wallets", int(nw))}${fig("Tokens", int(nm))}${fig("Min size", usd(p.minUsd ?? 1000))}${fig("Webhook", p.webhook ? "On" : "Off")}</div>`;
  return `<div class="b-card" role="button" tabindex="0" data-open="${esc(b.id)}" aria-label="Open ${esc(b.name || "bot")}">
    <div class="b-ch"><span class="b-ico">${ic(copy ? "users" : "bell")}</span><span class="b-cn"><b>${esc(b.name || "Untitled bot")}</b><small>${esc(sub)}</small></span>${badge(b.mode)}</div>
    ${body}
    ${b.status === "error" && b.error ? `<div class="b-cerr">${esc(b.error)}</div>` : ""}
    <div class="b-cf">${statusHtml(b.status)}<span>${st.lastEventAt ? `Last event ${ago(st.lastEventAt)}` : "No events yet"}</span></div>
  </div>`;
}
function syncListBot(bot) { if (S.bots && bot?.id) S.bots = S.bots.map((x) => (x.id === bot.id ? bot : x)); }

// ── Leaderboard ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadBoard(quiet) {
  try { const j = await api("/v1/bots/leaderboard"); S.board = rows(j.bots).filter((b) => b.id); S.boardErr = null; }
  catch (e) { S.boardErr = e.message; }
  if (S.screen === "board" && (!quiet || S.board)) paintBoard();
}
function paintBoard() {
  const el = $("bBoard"); if (!el) return;
  if (S.boardErr && !S.board) { el.innerHTML = errBox(S.boardErr, "retry-board"); return; }
  if (!S.board) { el.innerHTML = `<div class="b-tbl">${`<div class="b-skrow"><div class="b-skel"></div></div>`.repeat(6)}</div>`; return; }
  if (!S.board.length) {
    el.innerHTML = `<div class="b-empty sm"><h2>No bots on the board yet</h2><p>Start a paper bot and it shows up here with its PnL.</p><button type="button" class="b-cta" data-go="create" data-type="copy">${ic("plus", 2.2)}Create a copy bot</button></div>`;
    return;
  }
  const mine = new Set((S.bots ?? []).map((b) => b.id));
  el.innerHTML = `<div class="b-tbl b-lb"><div class="b-th"><span>#</span><span>Bot</span><span class="b-lc">Type</span><span class="b-lc">Mode</span><span class="b-n">PnL</span><span class="b-n b-lc">Trades</span><span class="b-n b-lc">Age</span></div>
    ${S.board.map((b, i) => lbRow(b, i, mine.has(b.id))).join("")}</div>
    ${S.boardErr ? `<p class="b-warnt">${esc(S.boardErr)}</p>` : ""}`;
}
function lbRow(b, i, own) {
  const st = b.stats ?? {}, tot = (N(st.realizedUsd) ?? 0) + (N(st.unrealizedUsd) ?? 0);
  const type = b.type === "copy" ? "Copy trader" : "Alert";
  return `<div class="b-lr" role="button" tabindex="0" data-open="${esc(b.id)}"${own ? "" : ` data-pub="1"`}>
    <span class="b-rank${i < 3 ? " top" : ""}">${i + 1}</span>
    <span class="b-ln"><b><span>${esc(b.name || "Untitled bot")}</span>${own ? `<em class="b-you">YOU</em>` : ""}${b.status !== "running" ? `<em class="b-paused">${esc(STATUS[b.status] ?? b.status)}</em>` : ""}</b><small>${b.type === "copy" ? "Copy" : "Alert"} · ${b.mode === "live" ? "Live" : "Paper"} · ${plural(st.trades, "trade")} · ${age(b.createdAt)} old</small></span>
    <span class="b-lc">${esc(type)}</span>
    <span class="b-lc">${badge(b.mode)}</span>
    <span class="b-n b-lp ${cls(tot)}">${signed(tot)}<small>realized ${signed(st.realizedUsd ?? 0)}</small></span>
    <span class="b-n b-lc">${int(st.trades)}</span>
    <span class="b-n b-lc">${age(b.createdAt)}</span>
  </div>`;
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function createHtml() {
  const f = S.f;
  return `<div class="b-crumb"><button type="button" data-go="mine">${ic("back")}My bots</button></div>
    <div class="b-c2"><h2>New bot</h2><div class="b-seg" id="bTypeSeg" role="tablist" aria-label="Bot type"><button type="button" role="tab" data-type="copy" class="${f.type === "copy" ? "on" : ""}">${ic("users")}Copy trader</button><button type="button" role="tab" data-type="alert" class="${f.type === "alert" ? "on" : ""}">${ic("bell")}Alert</button></div></div>
    <label class="b-field b-namef"><span>Name</span><span class="b-in"><input data-f="name" maxlength="48" autocomplete="off" placeholder="${f.type === "copy" ? "Optional, e.g. Top 3 smart traders" : "Optional, e.g. Whale watch"}" value="${esc(f.name)}"></span></label>
    <div id="bForm">${f.type === "copy" ? copyFormHtml() : alertFormHtml()}</div>`;
}
const field = (k, label, { pre = "", suf = "", hint = "", ph = "", id = "", wide = false, mode = "decimal" } = {}) =>
  `<label class="b-field${wide ? " wide" : ""}"><span>${label}</span><span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-f="${k}"${id ? ` id="${id}"` : ""} inputmode="${mode}" autocomplete="off" spellcheck="false" value="${esc(S.f[k])}" placeholder="${esc(ph)}">${suf ? `<i>${suf}</i>` : ""}</span>${hint ? `<small>${hint}</small>` : ""}</label>`;
const tog = (k, label, hint) => `<button type="button" class="b-tog" role="switch" aria-checked="${S.f[k]}" data-tog="${k}"><span class="b-sw"></span><span><b>${label}</b><small>${hint}</small></span></button>`;
const stepHead = (n, title, sub) => `<div class="b-sh"><span class="b-num">${n}</span><div><h3>${title}</h3><p>${sub}</p></div></div>`;
const seg = (attr, vals, cur) => `<div class="b-seg sm">${vals.map(([v, l]) => `<button type="button" data-${attr}="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
const DAY_OPTS = [[1, "24h"], [3, "3d"], [7, "7d"]];
const defMaxTok = () => { const u = N(S.f.usd); return u ? `Default ${usd(u * 3)}` : "Default 3× per trade"; };

function copyFormHtml() {
  const f = S.f;
  return `<section class="b-step">${stepHead(1, "Wallets to follow", "Top Solana smart traders by realized profit. Pick up to 10, or add any wallet.")}
      <div class="b-bar">${seg("days", DAY_OPTS, f.days)}<button type="button" class="b-btn sm" data-act="top3">Add top 3</button><span class="b-seln" id="bSelN"></span></div>
      <div id="bTraders">${tradersHtml()}</div>
      <div class="b-add"><input id="bAddW" class="mono" placeholder="Add a wallet: paste a Solana address" spellcheck="false" autocomplete="off" aria-label="Add a wallet"><button type="button" class="b-btn" data-act="addw">Add</button></div>
      <p class="b-hint" id="bAddMsg"></p>
      <div class="b-chips" id="bChips"></div>
    </section>
    <section class="b-step">${stepHead(2, "Size and safety", "Caps apply to every mirrored trade.")}
      <div class="b-grid">
        ${field("usd", "Per trade", { pre: "$", hint: "USDC per mirrored buy, 1 to 1,000" })}
        ${field("maxTok", "Max per token", { pre: "$", id: "bMaxTok", ph: defMaxTok(), hint: "Adds to a held token stop here" })}
        ${field("maxOpen", "Max open positions", { ph: "10", mode: "numeric", hint: "New buys wait above this" })}
        ${field("slip", "Slippage", { suf: "%", ph: "1", hint: "Per fill, on the Jupiter quote" })}
        ${field("minLiq", "Min liquidity", { pre: "$", ph: "20000", hint: "Thinner tokens are skipped" })}
        ${field("stop", "Daily loss stop", { pre: "$", ph: "Off", hint: "Pauses the bot after this loss in a day" })}
      </div>
      <div class="b-togs">
        ${tog("mirror", "Mirror sells", "When a followed wallet sells a token the bot holds, the bot sells all of it.")}
        ${tog("safety", "Safety check", "Skip tokens whose mint or freeze authority is still live.")}
      </div>
    </section>
    <section class="b-step">${stepHead(3, "Backtest", "Replay the picked wallets' real trades with these rules.")}
      <div class="b-bar">${seg("btdays", DAY_OPTS, f.btDays)}<button type="button" class="b-btn pri" data-act="bt" id="bBtBtn">${ic("chart")}Run backtest</button></div>
      <div id="bBt">${btHtml()}</div>
    </section>
    <div class="b-start">
      <p class="b-note">${ic("shield")}<span>Paper mode: fills are priced by a real Jupiter quote at the moment the followed wallet trades; nothing is sent. Live mode signs from your own wallet under limits. Coming soon.</span></p>
      <p class="b-msg" id="bMsg"></p>
      <button type="button" class="b-cta" data-act="create" id="bGo">Start paper bot</button>
    </div>`;
}
function alertFormHtml() {
  return `<section class="b-step">${stepHead(1, "What to watch", "Wallets, tokens, or both.")}
      <div class="b-lbl">Wallets</div>
      <div class="b-add"><input id="bAddW" class="mono" placeholder="Paste a Solana wallet address" spellcheck="false" autocomplete="off" aria-label="Add a wallet"><button type="button" class="b-btn" data-act="addw">Add</button></div>
      <p class="b-hint" id="bAddMsg"></p>
      <div class="b-chips" id="bChips"></div>
      <div class="b-lbl">Tokens</div>
      <div class="b-add"><input id="bAddM" class="mono" placeholder="Paste a token mint address" spellcheck="false" autocomplete="off" aria-label="Add a token"><button type="button" class="b-btn" data-act="addm">Add</button></div>
      <p class="b-hint" id="bAddMMsg"></p>
      <div class="b-chips" id="bMints"></div>
    </section>
    <section class="b-step">${stepHead(2, "When to alert", "A trade by a watched wallet, or in a watched token, at or above this size.")}
      <div class="b-grid two">
        ${field("minUsd", "Min trade size", { pre: "$", ph: "1000", hint: "Default $1,000" })}
        ${field("hook", "Webhook", { ph: "https://… (optional)", mode: "url", hint: "Each match is also sent here. https only." })}
      </div>
    </section>
    <div class="b-start">
      <p class="b-note">${ic("bell")}<span>Alerts never trade. Matches show in the bot's log here.</span></p>
      <p class="b-msg" id="bMsg"></p>
      <button type="button" class="b-cta" data-act="create" id="bGo">Start alert bot</button>
    </div>`;
}
function paintForm() {
  const seg = $("bTypeSeg"); if (!seg) return;
  seg.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("on", b.dataset.type === S.f.type));
  const nm = root.querySelector('input[data-f="name"]'); if (nm) nm.placeholder = S.f.type === "copy" ? "Optional, e.g. Top 3 smart traders" : "Optional, e.g. Whale watch";
  $("bForm").innerHTML = S.f.type === "copy" ? copyFormHtml() : alertFormHtml();
  setHash(S.f.type === "alert" ? "#bots/new/alert" : "#bots/new");
  paintSel(); paintGo();
  if (S.f.type === "copy") loadTraders();
}

// traders picker
async function loadTraders(force) {
  const d = S.f.days, c = S.traders[d];
  if (c?.list && !force && Date.now() - c.at < 120_000) return paintTraders();
  if (c?.loading) return;
  S.traders[d] = { ...(c ?? {}), loading: true, err: null };
  paintTraders();
  try { const j = await api(`/v1/bots/traders?days=${d}`); S.traders[d] = { list: rows(j.traders).filter((t) => typeof t.wallet === "string"), at: Date.now() }; }
  catch (e) { S.traders[d] = { ...(S.traders[d] ?? {}), loading: false, err: e.message }; }
  if (S.f.days === d) paintTraders();
}
function paintTraders() { const el = $("bTraders"); if (el) el.innerHTML = tradersHtml(); }
function tradersHtml() {
  const c = S.traders[S.f.days];
  if (!c || (!c.list && !c.err)) return `<div class="b-tbl">${`<div class="b-skrow"><div class="b-skel"></div></div>`.repeat(5)}</div>`;
  if (c.err && !c.list) return errBox(c.err, "traders-retry");
  if (!c.list.length) return `<div class="b-none">No smart traders in this window yet. Try 7d, or add a wallet below.</div>`;
  const rows = S.f.more ? c.list : c.list.slice(0, 10);
  return `<div class="b-tbl b-trs${c.loading ? " b-dim" : ""}"><div class="b-th"><span></span><span>Wallet</span><span class="b-n">Score</span><span class="b-n">Realized</span><span class="b-n">ROI</span><span class="b-n">Win rate</span><span class="b-n">Trades</span><span>Best token</span></div>
    ${rows.map(trRow).join("")}
    ${c.list.length > 10 ? `<button type="button" class="b-more" data-act="more">${S.f.more ? "Show the top 10" : `Show all ${c.list.length}`}</button>` : ""}</div>
    ${c.err ? `<p class="b-warnt">${esc(c.err)}</p>` : ""}`;
}
function trRow(t) {
  const on = S.f.wallets.includes(t.wallet), dis = !on && S.f.wallets.length >= MAX_WALLETS, bt = t.bestToken;
  return `<label class="b-tr${on ? " on" : ""}${dis ? " dis" : ""}"><input type="checkbox" data-w="${esc(t.wallet)}"${on ? " checked" : ""}${dis ? " disabled" : ""} aria-label="Follow ${esc(short(t.wallet))}"><span class="b-box">${svg("check", 3)}</span>
    <span class="b-tw"><span><span class="mono">${esc(short(t.wallet))}</span><a href="${SOLSCAN.acct}${encodeURIComponent(t.wallet)}" target="_blank" rel="noopener" title="Open on Solscan" aria-label="Open on Solscan">${ic("ext")}</a></span><small>${plural(t.tokens, "token")} · holds ${dur(t.medianHoldS)} · ${ago(t.lastTrade)}</small></span>
    <span class="b-tstats"><span class="b-n" data-k="Score">${compact(t.score)}</span><span class="b-n ${cls(t.realizedPnlUsd)}" data-k="PnL">${signed(t.realizedPnlUsd)}</span><span class="b-n ${cls(t.roi)}" data-k="ROI">${signedPct(t.roi)}</span><span class="b-n" data-k="Win">${pct(t.winRate)}</span><span class="b-n" data-k="Trades">${int(t.trades)}</span></span>
    <span class="b-best">${bt ? `${tokLogo(bt.symbol, imgOf(bt), "sm")}<b>${esc(bt.symbol ?? "?")}</b><small class="${cls(bt.realizedPnlUsd)}">${signed(bt.realizedPnlUsd)}</small>` : `<small>—</small>`}</span></label>`;
}

// selection (wallets for both types, mints for alerts)
const chip = (v, kind) => `<span class="b-chip"><span class="mono">${esc(short(v))}</span><button type="button" data-${kind}="${esc(v)}" aria-label="Remove ${esc(short(v))}">×</button></span>`;
function paintSel() {
  const f = S.f;
  const n = $("bSelN"); if (n) n.textContent = `${f.wallets.length} of ${MAX_WALLETS} picked`;
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
  if (list.length >= max) return hint(msgId, `Up to ${max} per bot.`);
  list.push(v); inp.value = ""; hint(msgId, "");
  paintSel();
}
function toggleWallet(w, on) {
  const f = S.f;
  if (on && !f.wallets.includes(w)) { if (f.wallets.length >= MAX_WALLETS) { hint("bAddMsg", `Up to ${MAX_WALLETS} wallets per bot.`); paintSel(); return; } f.wallets.push(w); }
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
  if (b) { b.disabled = f.busy || !ready; b.innerHTML = f.busy ? `${ic("spin")}Starting…` : f.type === "copy" ? "Start paper bot" : "Start alert bot"; }
  if (msg && !msg.classList.contains("bad")) msg.textContent = ready ? "" : f.type === "copy" ? "Pick at least one wallet to follow." : "Add at least one wallet or token.";
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
    const bt = await api("/v1/bots/backtest", { method: "POST", body: { params, days: f.btDays } });
    f.bt = bt; f.btKey = key; f.btAll = false;
  } catch (e) { f.btErr = e.message; }
  f.btBusy = false;
  if (S.f === f) paintBt();
}
function paintBt() { const el = $("bBt"); if (el) el.innerHTML = btHtml(); paintGo(); stale(); }
function btHtml() {
  const f = S.f;
  if (!f.bt) {
    if (f.btBusy) return `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p>${ic("spin")}Replaying ${plural(f.wallets.length, "wallet")} over the last ${daysLabel(f.btDays)}…</p></div>`;
    if (f.btErr) return errBox(f.btErr, "bt");
    return `<div class="b-none">${f.wallets.length ? "Run it to see what these rules would have made." : "Pick wallets above, then run it to see what these rules would have made."} Prices come from each trade's own swap.</div>`;
  }
  const bt = f.bt, r = N(bt.realizedUsd) ?? 0, u = N(bt.unrealizedUsd) ?? 0, tot = r + u, dd = Math.abs(N(bt.maxDrawdownUsd) ?? 0);
  const fills = rows(bt.fills).sort((a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0));
  const shown = f.btAll ? fills : fills.slice(0, 25);
  const notes = Array.isArray(bt.notes) ? bt.notes.filter((n) => typeof n === "string" && n) : [];
  return `<div class="b-btres${f.btBusy ? " b-dim" : ""}">
    ${f.btErr ? `<div class="b-banner bad">${ic("alert")}<span>${esc(f.btErr)}</span></div>` : ""}
    <p class="b-stale" id="bStale" hidden>${ic("alert")}Settings changed since this run. Run it again to update.</p>
    <div class="b-bth"><b>Last ${daysLabel(bt.days)}</b><span>${plural(bt.wallets?.length ?? 0, "wallet")} · ${usd(bt.usdPerTrade)} a trade</span></div>
    <div class="b-tiles b-t5">${tile("PnL", signed(tot), `realized ${signed(r)} · open ${signed(u)}`, cls(tot))}${tile("Win rate", pct(bt.winRate))}${tile("Trades", int(bt.trades), `${int(bt.buys)} buys · ${int(bt.sells)} sells · ${int(bt.skipped)} skipped`)}${tile("Max drawdown", dd ? `${MINUS}${usd(dd)}` : "$0.00", "", dd ? "b-down" : "")}${tile("Invested", usd(bt.investedUsd ?? 0))}</div>
    ${equityHtml(bt.equity, "Equity over the run")}
    ${fills.length ? `<div class="b-sech"><h3>Fills</h3><small>${int(fills.length)}</small></div>${fillsTable(shown, null, fills.length > shown.length ? `<button type="button" class="b-more" data-act="bt-all">Show all ${int(fills.length)}</button>` : "")}` : `<div class="b-none">No trades from these wallets in this window.</div>`}
    ${notes.length ? `<ul class="b-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
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
    const j = await api("/v1/bots", { method: "POST", body });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The bot was created but the answer had no id. Check My bots.");
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
    const j = await api(det.pub ? `/v1/bots/public/${encodeURIComponent(det.id)}` : `/v1/bots/${encodeURIComponent(det.id)}`);
    if (S.det !== det) return;
    if (!j?.bot) throw new Error("The server sent a bot without its details.");
    const byTs = (a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0);
    det.data = { bot: j.bot, positions: rows(j.positions), fills: rows(j.fills).sort(byTs), events: rows(j.events).sort(byTs) };
    det.err = null;
    if (!det.pub) syncListBot(j.bot);
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
  const copy = det.data.bot.type === "copy";
  el.innerHTML = `<div id="bdHead"></div><div id="bdHero"></div>
    ${copy ? `<section class="b-sec"><div class="b-sech"><h3>Open positions</h3><small id="bdPosN"></small></div><div id="bdPos"></div></section>` : ""}
    <section class="b-sec"><div class="b-sech"><h3>${copy ? "Fills" : "Matches"}</h3><small id="bdFillsN"></small></div><div id="bdFills"></div></section>
    <section class="b-sec"><div class="b-sech"><h3>Log</h3></div><div id="bdLog"></div></section>`;
  paintHead(); paintHero(); paintPos(); paintFills(); paintLog();
}
const LIVE = { on: "Live", connecting: "Connecting…", retry: "Reconnecting…", off: "Offline" };
const liveTag = () => `<span class="b-live ${S.live}" id="bdLive">${LIVE[S.live]}</span>`;
function setLive(s) { S.live = s; const el = $("bdLive"); if (el) { el.className = `b-live ${s}`; el.textContent = LIVE[s]; } }
function paintHead() {
  const el = $("bdHead"), det = S.det; if (!el || !det?.data) return;
  const b = det.data.bot, copy = b.type === "copy";
  let ctl;
  if (det.pub) ctl = `<span class="b-ro">${ic("eye")}Read-only</span>`;
  else if (det.confirm) ctl = `<span class="b-confirm">Delete this bot and its history?</span><button type="button" class="b-btn danger" data-act="del-yes"${det.busy ? " disabled" : ""}>${det.busy === "del" ? `${ic("spin")}Deleting…` : "Delete"}</button><button type="button" class="b-btn" data-act="del-no"${det.busy ? " disabled" : ""}>Keep</button>`;
  else {
    const run = b.status === "running", dis = det.busy ? " disabled" : "";
    const label = det.busy === "pause" ? "Pausing…" : det.busy === "resume" ? "Resuming…" : run ? "Pause" : "Resume";
    ctl = `<button type="button" class="b-btn" data-act="${run ? "pause" : "resume"}"${dis}>${ic(det.busy ? "spin" : run ? "pause" : "play")}${label}</button><button type="button" class="b-btn danger" data-act="del"${dis}>${ic("trash")}Delete</button>`;
  }
  el.innerHTML = `<div class="b-dh"><span class="b-ico lg">${ic(copy ? "users" : "bell")}</span>
      <div class="b-dt"><h2>${esc(b.name || "Untitled bot")}</h2><div class="b-meta"><span>${copy ? "Copy trader" : "Alert"}</span>${badge(b.mode)}${statusHtml(b.status)}<span>Started ${ago(b.createdAt)}</span>${det.pub ? "" : liveTag()}</div></div>
      <div class="b-ctl">${ctl}</div></div>
    ${b.error ? `<div class="b-banner bad">${ic("alert")}<span>${esc(b.error)}</span></div>` : ""}
    ${det.msg ? `<div class="b-banner bad">${ic("alert")}<span>${esc(det.msg)}</span></div>` : ""}`;
}
const addrChip = (a, kind) => `<a class="b-chip ln" href="${kind === "token" ? SOLSCAN.token : SOLSCAN.acct}${encodeURIComponent(a)}" target="_blank" rel="noopener" title="${esc(a)}"><span class="mono">${esc(short(a))}</span>${ic("ext")}</a>`;
function paintHero() {
  const el = $("bdHero"), det = S.det; if (!el || !det?.data) return;
  const b = det.data.bot, st = b.stats ?? {}, p = b.params ?? {};
  if (b.type === "copy") {
    const r = N(st.realizedUsd) ?? 0, u = N(st.unrealizedUsd) ?? 0, tot = r + u, inv = N(st.investedUsd) ?? 0;
    const per = N(p.usdPerTrade);
    const rules = [per != null && `${usd(per)} a trade`, per != null && `up to ${usd(N(p.maxPerTokenUsd) ?? per * 3)} per token`, `${int(p.maxOpenPositions ?? 10)} open at most`,
      `${+((N(p.slippageBps) ?? 100) / 100).toFixed(2)}% slippage`, `min liquidity ${usd(p.minLiquidityUsd ?? 20000)}`, p.safety === false ? "safety check off" : "safety check on",
      p.mirrorSells === false ? "holds through sells" : "mirrors sells", N(p.dailyLossStopUsd) ? `pauses after ${usd(p.dailyLossStopUsd)} lost in a day` : "no daily stop"].filter(Boolean);
    el.innerHTML = `<div class="b-hero">
        <div class="b-big"><small>Total PnL</small><b class="${cls(tot)}">${signed(tot)}</b><span>${inv ? `${signedPct(tot / inv)} on ${usd(inv)} invested` : "Nothing invested yet"}</span></div>
        <div class="b-tiles b-t6">${tile("Realized", signed(r), "", cls(r))}${tile("Unrealized", signed(u), "", cls(u))}${tile("Win rate", pct(st.winRate), st.winRate == null ? "no closed trades yet" : "")}${tile("Trades", int(st.trades), `${int(st.buys)} buys · ${int(st.sells)} sells · ${int(st.skipped)} skipped`)}${tile("Open positions", int(st.openPositions), `of ${int(p.maxOpenPositions ?? 10)} max`)}${tile("Last event", st.lastEventAt ? ago(st.lastEventAt) : "none yet")}</div>
      </div>
      ${p.wallets?.length ? `<div class="b-params"><span class="b-pk">Following</span>${p.wallets.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      <div class="b-rules">${rules.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`;
  } else {
    const hookHost = (() => { try { return new URL(p.webhook).host; } catch { return null; } })();
    el.innerHTML = `<div class="b-hero">
        <div class="b-big"><small>Matches</small><b>${int(st.trades)}</b><span>trades of ${usd(p.minUsd ?? 1000)} or more</span></div>
        <div class="b-tiles b-t6">${tile("Wallets", int(p.wallets?.length ?? 0))}${tile("Tokens", int(p.mints?.length ?? 0))}${tile("Min size", usd(p.minUsd ?? 1000))}${tile("Webhook", p.webhook ? "On" : "Off", !det.pub && hookHost ? esc(hookHost) : "")}${tile("Skipped", int(st.skipped))}${tile("Last event", st.lastEventAt ? ago(st.lastEventAt) : "none yet")}</div>
      </div>
      ${p.wallets?.length ? `<div class="b-params"><span class="b-pk">Wallets</span>${p.wallets.map((w) => addrChip(w, "acct")).join("")}</div>` : ""}
      ${p.mints?.length ? `<div class="b-params"><span class="b-pk">Tokens</span>${p.mints.map((m) => addrChip(m, "token")).join("")}</div>` : ""}`;
  }
}
function paintPos() {
  const el = $("bdPos"), det = S.det; if (!el || !det?.data) return;
  const ps = [...det.data.positions].sort((a, b) => (N(b.valueUsd) ?? 0) - (N(a.valueUsd) ?? 0));
  const n = $("bdPosN"); if (n) n.textContent = ps.length ? String(ps.length) : "";
  el.innerHTML = ps.length
    ? `<div class="b-tbl b-pos"><div class="b-th"><span>Token</span><span class="b-n">Qty</span><span class="b-n">Cost</span><span class="b-n">Value</span><span class="b-n">PnL</span></div>${ps.map(posRow).join("")}</div>`
    : `<div class="b-none">No open positions. Buys show up here when a followed wallet trades.</div>`;
}
function posRow(p) {
  const cost = N(p.costUsd), pnl = N(p.pnlUsd);
  return `<div class="b-pr"><span class="b-tok">${tokLogo(p.symbol ?? "?", imgOf(p))}<span><b>${esc(symOf(p.symbol, p.mint))}</b><small><a href="${SOLSCAN.token}${encodeURIComponent(p.mint)}" target="_blank" rel="noopener">${esc(short(p.mint))}</a> · ${esc(age(p.openedAt))}</small></span></span>
    <span class="b-n" data-k="Qty">${qty(p.qty)}</span><span class="b-n" data-k="Cost">${usd(cost)}</span><span class="b-n" data-k="Value">${usd(p.valueUsd)}</span>
    <span class="b-n b-ppl ${cls(pnl)}" data-k="PnL">${signed(pnl)}${cost && pnl != null ? `<small>${signedPct(pnl / cost)}</small>` : ""}</span></div>`;
}
function fillsTable(fills, fresh, footer = "") {
  return `<div class="b-tbl b-fills"><div class="b-th"><span>Time</span><span>Side</span><span>Token</span><span class="b-n">Amount</span><span class="b-n">Price</span><span>Followed wallet</span><span class="b-n">PnL</span></div>${fills.map((f, i) => fillRow(f, fresh?.has(f.id))).join("")}${footer}</div>`;
}
function fillRow(f, fresh) {
  const sk = f.status === "skipped", src = f.source ?? {}, sell = f.side === "sell";
  const lag = (toMs(f.ts) ?? 0) - (toMs(src.ts) ?? Infinity), w = when(f.ts);
  const lagTxt = lag >= 0 && lag < 3_600_000 ? `+${lag < 10_000 ? (lag / 1000).toFixed(1) : Math.round(lag / 1000)}s` : null;
  const q = f.quote;
  const qt = q ? `Jupiter quote${q.route?.length ? `: ${q.route.join(" › ")}` : ""}${N(q.priceImpactPct) != null ? `, impact ${N(q.priceImpactPct).toFixed(2)}%` : ""}` : "";
  const pl = sk ? `<span class="b-skl">Skipped</span>` : sell && N(f.pnlUsd) != null ? signed(f.pnlUsd) : "";
  return `<div class="b-fr${sk ? " b-sk" : ""}${fresh ? " b-flash" : ""}">
    <span class="b-ft"${lagTxt ? ` title="${lagTxt} after the followed wallet's trade"` : ""}>${w.hm}${w.day ? `<small class="b-day">${w.day}</small>` : lagTxt ? `<small>${lagTxt}</small>` : ""}</span>
    <span class="b-side ${sell ? "sell" : "buy"}">${sell ? "SELL" : "BUY"}</span>
    <span class="b-tok"><span class="b-side m ${sell ? "sell" : "buy"}" aria-hidden="true">${sell ? "SELL" : "BUY"}</span>${tokLogo(f.symbol ?? "?", imgOf(f))}<span><b>${esc(symOf(f.symbol, f.mint))}</b>${N(f.tokenAmount) ? `<small>${qty(f.tokenAmount)}</small>` : ""}</span></span>
    <span class="b-n b-amt">${usd(f.usd)}</span>
    <span class="b-n b-px"${qt ? ` title="${esc(qt)}"` : ""}>${price(f.priceUsd)}</span>
    <span class="b-src">${src.wallet ? `<a href="${SOLSCAN.acct}${encodeURIComponent(src.wallet)}" target="_blank" rel="noopener" title="${esc(src.wallet)}">${esc(short(src.wallet))}</a>` : "—"}${src.tx ? `<a class="b-tx" href="${SOLSCAN.tx}${encodeURIComponent(src.tx)}" target="_blank" rel="noopener" title="The followed wallet's transaction">tx ↗</a>` : ""}</span>
    <span class="b-n b-pl ${sk ? "" : cls(sell ? f.pnlUsd : null)}">${pl}</span>
    ${sk && f.reason ? `<span class="b-why">${esc(f.reason)}</span>` : ""}
  </div>`;
}
function paintFills() {
  const el = $("bdFills"), det = S.det; if (!el || !det?.data) return;
  const fills = det.data.fills, copy = det.data.bot.type === "copy";
  const n = $("bdFillsN"); if (n) n.textContent = fills.length ? int(fills.length) : "";
  el.innerHTML = fills.length
    ? fillsTable(fills.slice(0, det.nFills), det.fresh, fills.length > det.nFills ? `<button type="button" class="b-more" data-act="fills-more">Show more</button>` : "")
    : `<div class="b-none">${copy ? "No fills yet. The bot mirrors the next trade a followed wallet makes." : "No matches yet."}</div>`;
}
function paintLog() {
  const el = $("bdLog"), det = S.det; if (!el || !det?.data) return;
  const evs = det.data.events;
  el.innerHTML = evs.length
    ? `<ol class="b-log">${evs.slice(0, det.nEv).map((e) => `<li class="${["warn", "error"].includes(e.level) ? e.level : "info"}"><time>${(({ hm, day }) => `${hm}${day ? `<small>${day}</small>` : ""}`)(when(e.ts))}</time><i></i><span>${esc(e.msg)}</span></li>`).join("")}${evs.length > det.nEv ? `<li class="b-lmore"><button type="button" class="b-more" data-act="ev-more">Show more</button></li>` : ""}</ol>`
    : `<div class="b-none">Nothing logged yet.</div>`;
}
async function setStatus(kind) {
  const det = S.det; if (!det?.data || det.busy) return;
  det.busy = kind; det.msg = null; paintHead();
  try {
    const j = await api(`/v1/bots/${encodeURIComponent(det.id)}/${kind}`, { method: "POST" });
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
    await api(`/v1/bots/${encodeURIComponent(det.id)}`, { method: "DELETE" });
    if (S.bots) S.bots = S.bots.filter((b) => b.id !== det.id);
    if (S.det === det) go("mine");
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
      const r = await fetch(`/v1/bots/${encodeURIComponent(det.id)}/stream`, { headers: { "X-Session": session(), Accept: "text/event-stream" }, signal: ctrl.signal });
      if (r.status === 404 || r.status === 403) { setLive("off"); if (S.ctrl === ctrl) S.ctrl = null; return; }
      if (!r.ok || !r.body) throw new Error(String(r.status));
      setLive("on"); wait = 1000;
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); onSse(block, det); }
      }
    } catch {
      if (ctrl.signal.aborted) return;
    }
    if (ctrl.signal.aborted || S.det !== det) return;
    setLive("retry");
    await sleep(wait, ctrl.signal);
    wait = Math.min(wait * 2, 15_000);
  }
}
function onSse(block, det) {
  let ev = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":"), k = i < 0 ? line : line.slice(0, i);
    let v = i < 0 ? "" : line.slice(i + 1);
    if (v.startsWith(" ")) v = v.slice(1);
    if (k === "event") ev = v; else if (k === "data") data.push(v);
  }
  if (!data.length || S.det !== det || !det.data) return;
  let d;
  try { d = JSON.parse(data.join("\n")); } catch { return; }
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
  if (pts.length < 2) return `<div class="b-none">Not enough points to draw the equity curve.</div>`;
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
  const a = t.closest("[data-go],[data-open],[data-act],[data-days],[data-btdays],[data-type],[data-tog],[data-rm],[data-rmm]");
  if (!a || !root.contains(a)) return;
  if (a.matches("[data-open]") && t.closest("a[href]")) return;
  const ds = a.dataset;
  if (ds.go) return go(ds.go, { type: ds.type });
  if (ds.open) return go("detail", { id: ds.open, pub: ds.pub === "1" });
  if (ds.type) { if (S.f.type !== ds.type) { S.f.type = ds.type; setMsg("", false); paintForm(); } return; }
  if (ds.days) { S.f.days = Number(ds.days); S.f.more = false; a.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === a)); paintTraders(); loadTraders(); return; }
  if (ds.btdays) { S.f.btDays = Number(ds.btdays); a.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === a)); stale(); return; }
  if (ds.tog) { S.f[ds.tog] = !S.f[ds.tog]; a.setAttribute("aria-checked", String(S.f[ds.tog])); stale(); return; }
  if (ds.rm != null) { S.f.wallets = S.f.wallets.filter((w) => w !== ds.rm); hint("bAddMsg", ""); paintSel(); return; }
  if (ds.rmm != null) { S.f.mints = S.f.mints.filter((m) => m !== ds.rmm); paintSel(); return; }
  switch (ds.act) {
    case "retry-bots": S.botsErr = null; paintMine(); return void loadBots();
    case "retry-board": S.boardErr = null; paintBoard(); return void loadBoard();
    case "retry-det": if (S.det) { S.det.err = null; paintDetail(); loadDetail(); } return;
    case "traders-retry": return void loadTraders(true);
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
  }
}
function onInput(e) {
  const t = e.target, k = t.dataset?.f;
  if (!k) return;
  if (NUMF.has(k)) {
    const v = t.value.replace(k === "maxOpen" ? /[^0-9]/g : /[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    if (v !== t.value) t.value = v;
  }
  S.f[k] = t.value;
  if (k === "usd") { const m = $("bMaxTok"); if (m) m.placeholder = defMaxTok(); }
  if ($("bMsg")?.classList.contains("bad")) { setMsg("", false); paintGo(); }
  stale();
}
function onChange(e) { const t = e.target; if (t.matches?.("input[data-w]")) toggleWallet(t.dataset.w, t.checked); }
function onKey(e) {
  const t = e.target;
  if (e.key === "Enter" && t.id === "bAddW") { e.preventDefault(); addAddr("bAddW", "bAddMsg", S.f.wallets, MAX_WALLETS, "wallet"); }
  else if (e.key === "Enter" && t.id === "bAddM") { e.preventDefault(); addAddr("bAddM", "bAddMMsg", S.f.mints, MAX_MINTS, "token"); }
  else if ((e.key === "Enter" || e.key === " ") && t.matches?.("[data-open][role=button]")) { e.preventDefault(); t.click(); }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && t.classList?.contains("b-plot")) { e.preventDefault(); stepChart(t, e.key === "ArrowRight" ? 1 : -1); }
}
