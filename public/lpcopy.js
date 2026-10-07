// LP copy agent (ask2049-notes/PROMPT-copy-smart-lp.md), mounted by bots.js: the smart-LP board → pick wallets (or the board's top N
// at the start) → size and rules → backtest → start a paper LP copy agent; and the copy agent's detail (the wallets it copies, each
// copied move next to the wallet's own transaction, the positions). API: GET /v1/agents/lp/smart, POST /v1/agents/lp/copy/backtest,
// POST /v1/agents { type: "lp", params: { mode: "copy", … } }. Every attribute is data-lc-*, every class lc-* (plus the page's b-* ones),
// so bots.js's root listeners never act on this subtree. Colours are the page's tokens.

const SOLSCAN = { tx: "https://solscan.io/tx/", acct: "https://solscan.io/account/" };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VENUES = [["meteora_dlmm", "Meteora DLMM"], ["meteora_damm_v2", "Meteora DAMM v2"], ["raydium_clmm", "Raydium CLMM"], ["pumpswap", "PumpSwap"]];
const DAYS = [[1, "24h"], [3, "3d"], [7, "7d"]];
const MINUS = "−";
const MAX_WALLETS = 10;

// ── formatting (bots.js passes its own helpers in deps.ui; these are the fallbacks) ─────────────────────────────────────────
const N = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const escF = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usdF = (x) => { const n = N(x); if (n == null) return "n/a"; const a = Math.abs(n), s = n < 0 ? MINUS : ""; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${s}$${(a / 1e3).toFixed(1)}K` : a >= 1000 ? `${s}$${Math.round(a).toLocaleString("en-US")}` : `${s}$${a.toFixed(2)}`; };
const short = (s, a = 4, b = 4) => { s = String(s ?? ""); return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
const pct1 = (x) => { const n = N(x); if (n == null) return "n/a"; const a = Math.abs(n); return `${n < 0 ? MINUS : ""}${a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toFixed(1)}%`; };
const signedPct = (x) => { const n = N(x); if (n == null) return "n/a"; const a = Math.round(Math.abs(n) * 10) / 10; return `${n < 0 ? MINUS : "+"}${a >= 10 ? Math.round(a) : a.toFixed(1)}%`; };
const hold = (s) => { const n = N(s); return n == null ? "n/a" : n < 3600 ? `${Math.max(1, Math.round(n / 60))}m` : n < 86400 ? `${(n / 3600).toFixed(1)}h` : `${(n / 86400).toFixed(1)}d`; };
const hm = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const lagText = (ms) => (ms == null || ms < 0 || ms > 6 * 3600e3 ? null : ms < 120e3 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60e3)} min`);
const rows = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === "object") : []);
const strs = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string" && s) : []);
const priceTxt = (x) => { const n = N(x); return n == null ? "n/a" : n >= 1 ? n.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : Number(n.toPrecision(4)).toString(); };
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
const SPIN = '<i class="b-i b-spin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg></i>';
const ALERT = '<i class="b-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/></svg></i>';
const INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/></svg>';
/** notes behind a small (i) popover, closed by default (same markup and look as bots.js) */
const info = (html, label = "Notes") => (html ? `<details class="ag-i"><summary aria-label="${escF(label)}" title="${escF(label)}">${INFO}</summary><div class="ag-ip">${html}</div></details>` : "");
const PAPER = `<em class="ag-pp" title="Paper mode: nothing is sent">PAPER</em>`;
const VSHORT = { meteora_dlmm: "DLMM", meteora_damm_v2: "DAMM v2", raydium_clmm: "CLMM", pumpswap: "PumpSwap", "Meteora DLMM": "DLMM", "Meteora DAMM v2": "DAMM v2", "Raydium CLMM": "CLMM" };
const vshort = (v) => VSHORT[v] ?? String(v ?? "");
const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t);

/** The helpers this module draws with: bots.js's when given (same look as the rest of the page), else the fallbacks above. */
function kit(deps) {
  const u = deps?.ui ?? {};
  const esc = u.esc ?? escF, usd = u.usd ?? usdF;
  const signed = u.signed ?? ((x) => { const n = N(x); return n == null ? "n/a" : n > 0 ? `+${usd(n)}` : usd(n); });
  const cls = u.cls ?? ((x) => { const n = N(x); return n == null || n === 0 ? "" : n > 0 ? "b-up" : "b-down"; });
  const int = u.int ?? ((x) => (N(x) == null ? "0" : Math.round(N(x)).toLocaleString("en-US")));
  const tile = u.tile ?? ((k, v, sub = "", c = "") => `<div class="b-tile"><small>${esc(k)}</small><b class="${c}">${v}</b>${sub ? `<span>${sub}</span>` : ""}</div>`);
  const errBox = u.errBox ?? ((msg, act) => `<div class="b-errbox">${ALERT}<span>${esc(msg)}</span>${act ? `<button type="button" class="b-btn" data-act="${act}">Try again</button>` : ""}</div>`);
  const equityHtml = u.equityHtml ?? null;
  return { esc, usd, signed, cls, int, tile, errBox, equityHtml };
}

// ── styles (once per page) ─────────────────────────────────────────────────────────────────────────────────────────────────
const CSS = `
.lc { display: flex; flex-direction: column; min-width: 0; }
.lc-tbl { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.lc-th, .lc-r { display: grid; gap: 10px; align-items: center; padding: 9px 14px; min-width: 0; }
.lc-th { background: var(--muted); font-size: 12px; color: var(--muted-fg); }
.lc-th > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-th .lc-n { font: inherit; }
.lc-r { border-top: 1px solid var(--border-soft); font-size: 13.5px; }
.lc-th + .lc-r { border-top: 0; }
.lc .lc-stats { display: contents; }
.lc-n { text-align: right; font: 13px "Geist Mono", monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
.lc-m { font: 12px "Geist Mono", monospace; color: var(--muted-fg); }
.lc a { color: inherit; text-decoration: none; }
.lc a:hover { color: var(--purple); }
.lc-board .lc-th, .lc-board .lc-r { grid-template-columns: 20px 22px minmax(0, 1.25fr) 64px 66px 86px 60px 80px minmax(0, 1.4fr); }
.lc-board .lc-r { position: relative; cursor: pointer; }
.lc-board .lc-r:hover { background: var(--muted); }
.lc-board .lc-r.on { background: color-mix(in srgb, var(--purple) 10%, transparent); }
.lc-board.top .lc-r { cursor: default; }
.lc-board .lc-r input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.lc-box { width: 18px; height: 18px; display: grid; place-items: center; border: 1.5px solid var(--border); border-radius: 5px; color: transparent; }
.lc-box svg { width: 12px; height: 12px; }
.lc-r.on .lc-box { border-color: var(--primary); background: var(--primary); color: var(--primary-fg); }
.lc-r input:focus-visible + .lc-box { outline: 2px solid var(--purple); outline-offset: 2px; }
.lc-rank { font: 600 12px "Geist Mono", monospace; color: var(--muted-fg); text-align: center; }
.lc-w { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.lc-w b { font: 500 13.5px "Geist Mono", monospace; }
.lc-w small, .lc-pools small { font-size: 11.5px; color: var(--muted-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-pools { display: flex; flex-direction: column; min-width: 0; font-size: 12.5px; line-height: 1.35; }
.lc-pools span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-built { font: 600 13px "Geist Mono", monospace; text-align: right; white-space: nowrap; }
.lc-built small { display: block; font: 400 11px Geist, ui-sans-serif, system-ui, sans-serif; color: var(--muted-fg); }
.lc-topn { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--muted-fg); }
.lc-topn .b-in { height: 34px; width: 74px; padding: 0 10px; }
.lc-trap { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; }
.lc-trap > b { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.lc-trap > b .b-i { color: var(--purple); }
.lc-trap p { margin: 4px 0 8px; font-size: 13px; color: var(--muted-fg); }
.lc-traph { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; }
.lc-traph b { display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 600; }
.lc-traph b .b-i { color: var(--purple); }
.lc-traph small { font-size: 12px; color: var(--muted-fg); }
.lc-tl { display: flex; flex-direction: column; border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; }
.lc-tr { display: grid; grid-template-columns: 20px 104px 112px minmax(0, 1fr) minmax(0, 1.5fr); gap: 12px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--border-soft); font-size: 13px; }
.lc-tr:first-child { border-top: 0; }
.lc-trk { font: 600 12px "Geist Mono", monospace; color: var(--muted-fg); }
.lc-tw { font: 500 12.5px "Geist Mono", monospace; color: var(--fg); text-decoration: none; }
.lc-tw:hover { color: var(--purple); }
.lc-tp { display: flex; flex-direction: column; line-height: 1.25; }
.lc-tp small { font-size: 10.5px; color: var(--muted-fg); }
.lc-tp b { font: 600 14px "Geist Mono", monospace; font-variant-numeric: tabular-nums; }
.lc-tio { font: 12px "Geist Mono", monospace; color: var(--muted-fg); font-variant-numeric: tabular-nums; }
.lc-tv { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 7px; min-width: 0; }
.lc-tv em { padding: 1px 6px; border-radius: 5px; background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); font: 600 10.5px/1.5 "Geist Mono", monospace; font-style: normal; text-transform: uppercase; letter-spacing: .04em; }
.lc-tv em.kept { background: color-mix(in srgb, var(--hi) 14%, transparent); color: var(--hi); }
.lc-tv b { font-weight: 600; }
.lc-tv small { flex-basis: 100%; font-size: 11.5px; line-height: 1.4; color: var(--muted-fg); }
.lc-drops > small { flex-basis: 100%; font-size: 11.5px; color: var(--muted-fg); }
.lc-trap ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.lc-trap li { display: grid; grid-template-columns: 22px minmax(0, 150px) minmax(0, 1fr); gap: 10px; align-items: baseline; font-size: 13px; }
.lc-trap li > span:first-child { font: 600 12px "Geist Mono", monospace; color: var(--muted-fg); }
.lc-trap li .lc-chord { font: 12.5px "Geist Mono", monospace; }
.lc-trap li .lc-v { color: var(--muted-fg); overflow-wrap: anywhere; }
.lc-trap li .lc-v b { color: var(--fg); font-weight: 500; }
.lc-drops { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.lc-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--border-soft); border-radius: 999px; font-size: 12px; color: var(--muted-fg); }
.lc-chip b { font: 600 12px "Geist Mono", monospace; color: var(--fg); }
.lc-ven { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.lc-ven button { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 12px; border: 1px solid var(--border); border-radius: 10px; background: transparent; font-size: 13.5px; color: var(--muted-fg); }
.lc-ven button[aria-pressed="true"] { border-color: var(--purple); color: var(--fg); background: color-mix(in srgb, var(--purple) 10%, transparent); }
.lc-ven button .lc-box { width: 15px; height: 15px; }
.lc-ven button[aria-pressed="true"] .lc-box { border-color: var(--primary); background: var(--primary); color: var(--primary-fg); }
.lc-skips { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: 13px; color: var(--muted-fg); }
.lc-skips b { font: 600 12.5px "Geist Mono", monospace; color: var(--fg); margin-right: 6px; }
.lc-pos .lc-th, .lc-pos .lc-r { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) 108px 108px minmax(0, 1fr) 80px; }
.lc-moves .lc-th, .lc-moves .lc-r { grid-template-columns: 92px 58px minmax(0, 1fr) minmax(0, 1.5fr) 64px 136px; align-items: start; }
.lc-kind { justify-self: start; padding: 1px 6px; border-radius: 5px; font: 600 10.5px/1.5 "Geist Mono", monospace; letter-spacing: .05em; }
.lc-kind.open { color: var(--hi); background: color-mix(in srgb, var(--hi) 14%, transparent); }
.lc-kind.close { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); }
.lc-kind.skip { color: var(--muted-fg); background: var(--muted); }
.lc-src { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 13px; }
.lc-src small { font: 11.5px "Geist Mono", monospace; color: var(--muted-fg); }
.lc-src small a { color: var(--purple); }
.lc-why { font-size: 12px; color: var(--muted-fg); overflow-wrap: anywhere; }
.lc-wl { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.lc-wl > div { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: 12px; background: var(--muted); min-width: 0; }
.lc-wl b { font: 500 13.5px "Geist Mono", monospace; }
.lc-wl small { font-size: 12px; color: var(--muted-fg); overflow-wrap: anywhere; }
.lc-wl small.bad { color: var(--bad); }
.lc-sub { margin: 0 0 10px; font-size: 13px; color: var(--muted-fg); }
.lc-in { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--muted-fg); vertical-align: 1px; }
.lc-in.on { background: var(--hi); }
.lc-pnl { margin-bottom: 14px; }
.lc-rb { position: relative; display: block; width: 100%; max-width: 160px; height: 6px; margin: 5px 0 2px; border-radius: 3px; background: var(--muted); }
.lc-rb > i { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: color-mix(in srgb, var(--hi) 35%, transparent); }
.lc-rb.out > i { background: color-mix(in srgb, var(--muted-fg) 30%, transparent); }
.lc-rb > b { position: absolute; top: -3px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: var(--hi); }
.lc-rb.out > b { background: var(--bad); }
@media (max-width: 760px) {
  .lc-th { display: none !important; }
  .lc-board .lc-r { grid-template-columns: 20px minmax(0, 1fr) auto; grid-template-areas: "box w built" "box s s" "box p p"; gap: 6px 10px; padding: 11px 12px; align-items: start; }
  .lc-board .lc-r > .lc-box { grid-area: box; margin-top: 2px; }
  .lc-board .lc-r > .lc-rank { display: none; }
  .lc-board .lc-r > .lc-w { grid-area: w; }
  .lc-board .lc-r > .lc-built { grid-area: built; }
  .lc-board .lc-r > .lc-stats { grid-area: s; display: flex; flex-wrap: wrap; gap: 3px 14px; }
  .lc-board .lc-r > .lc-pools { grid-area: p; }
  .lc-stats .lc-n { text-align: left; font-size: 12.5px; }
  .lc-stats .lc-n::before { content: attr(data-k) " "; font: 11.5px Geist, ui-sans-serif, system-ui, sans-serif; color: var(--muted-fg); }
  .lc-pos .lc-r { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 10px 12px; }
  .lc-pos .lc-r > :nth-child(n+2):not(:last-child) { grid-column: 1 / -1; }
  .lc-pos .lc-r > :last-child { grid-row: 1; grid-column: 2; }
  .lc-pos .lc-r > [data-k]::before { content: attr(data-k) " "; font: 11.5px Geist, ui-sans-serif, system-ui, sans-serif; color: var(--muted-fg); }
  .lc-moves .lc-r { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "k pool agent" "src src src" "t lag lag"; gap: 4px 10px; padding: 10px 12px; }
  .lc-moves .lc-r > :nth-child(1) { grid-area: t; } .lc-moves .lc-r > :nth-child(2) { grid-area: k; } .lc-moves .lc-r > :nth-child(3) { grid-area: pool; }
  .lc-moves .lc-r > :nth-child(4) { grid-area: src; } .lc-moves .lc-r > :nth-child(5) { grid-area: lag; text-align: left; } .lc-moves .lc-r > :nth-child(6) { grid-area: agent; }
  .lc-trap li { grid-template-columns: 18px minmax(0, 1fr); }
  .lc-tr { grid-template-columns: 18px minmax(0, 1fr) auto; gap: 4px 10px; }
  .lc-tr > .lc-tio, .lc-tr > .lc-tv { grid-column: 2 / -1; }
  .lc-trap li .lc-v { grid-column: 2; }
}
`;
function injectStyle() {
  if (document.getElementById("lc-style")) return;
  const s = document.createElement("style");
  s.id = "lc-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── create: board → wallets → rules → backtest → start ─────────────────────────────────────────────────────────────────────
/** deps: { api(path, { method, body }) → Promise<json> (throws Error with a readable message), onCreated(bot), session?,
 *  ui?: { esc, usd, signed, cls, int, tile, errBox, equityHtml } }. Renders into `root`; returns { destroy() }. */
export function renderLpCopyCreate(root, deps) {
  injectStyle();
  const K = kit(deps);
  const { esc, usd, signed, cls, int, tile } = K;
  const S = {
    days: 3, boards: {}, mode: "top", top: "3", sel: new Set(), amount: "200", maxOpen: "3", tvl: "50000", venues: new Set(VENUES.map((v) => v[0])),
    removes: true, exodus: true, safety: true, drop: "", stop: "", btDays: 3, bt: null, btKey: null, btBusy: false, btErr: null, busy: false, msg: "", bad: false,
  };
  let alive = true;
  const $ = (id) => root.querySelector(`#${id}`);
  const head = (n, t, sub) => `<div class="b-sh"><span class="b-num">${n}</span><div><h3>${t}</h3></div>${info(esc(sub), `About: ${t.replace(/&amp;/g, "&")}`)}</div>`;
  const seg = (attr, vals, cur) => `<div class="b-seg sm">${vals.map(([v, l]) => `<button type="button" data-lc-${attr}="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const field = (k, label, { pre = "", suf = "", hint = "", tip = "", ph = "", mode = "decimal" } = {}) => `<label class="b-field"${tip ? ` title="${esc(tip)}"` : ""}><span>${label}${hint ? `<small class="b-fh">${hint}</small>` : ""}</span><span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-lc-f="${k}" inputmode="${mode}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(S[k])}">${suf ? `<i>${suf}</i>` : ""}</span></label>`;
  const tog = (k, label, hint) => `<button type="button" class="b-tog" role="switch" aria-checked="${S[k]}" data-lc-tog="${k}" title="${esc(hint)}"><span class="b-sw"></span><span><b>${label}</b></span></button>`;

  root.innerHTML = `<div class="lc">
    <section class="b-step">${head(1, "Smart LPs", "Solana wallets ranked by what they earned providing liquidity, built only on positions Chord's tape saw from the first deposit. Fees are the ones they claimed.")}
      <div class="b-bar">${seg("days", DAYS, S.days)}${seg("mode", [["top", "Top"], ["pick", "Pick"]], S.mode)}<span class="lc-topn" id="lcTopN"></span><span class="lc-cov" id="lcCov"></span></div>
      <div id="lcBoard"></div>
    </section>
    <section class="b-step">${head(2, "Size &amp; rules", "Each copied add opens one paper position in the same pool with the wallet's own range. The copy never rebalances: it moves when the wallet moves.")}
      <div class="b-grid">
        ${field("amount", "Per position", { pre: "$", hint: "10–2,000" })}
        ${field("maxOpen", "Open at once", { ph: "3", mode: "numeric", hint: "1–10", tip: "1 to 10, one per pool" })}
        ${field("tvl", "TVL floor", { pre: "$", ph: "50000", tip: "Pool TVL floor: thinner pools are skipped" })}
        ${field("drop", "Token drop exit", { suf: "%", ph: "Off", hint: "5–95", tip: "Exit on a token drop from each open, 5 to 95" })}
        ${field("stop", "Daily stop", { pre: "$", ph: "Off", tip: "Daily loss stop: closes everything and stops" })}
      </div>
      <div class="lc-ven" id="lcVen"></div>
      <div class="b-togs">${tog("removes", "Follow removes", "Close when the wallet closes or takes out half its deposit.")}${tog("exodus", "LP exodus exit", "Exit on LP exodus: withdrawals above twice the deposits in an hour, $1,000 or more.")}${tog("safety", "Safety check", "Skip tokens with a live mint or freeze authority.")}</div>
    </section>
    <section class="b-step">${head(3, "Backtest", "Replay the wallets' LP moves with these rules on Chord's 5 or 15 minute prices: estimated fees, IL, and every skip with its reason.")}
      <div class="b-bar">${seg("btdays", DAYS, S.btDays)}<button type="button" class="b-btn pri" data-lc-act="bt" id="lcBtBtn">Run backtest</button></div>
      <div id="lcBt"></div>
    </section>
    <div class="b-start"><div class="b-stn">${PAPER}<span class="b-msg" id="lcMsg"></span>${info("Paper mode: the agent checks the wallets every minute and opens or closes paper positions at Jupiter's prices; nothing is sent. Fee income is always an estimate from each pool's fee APR.", "Paper mode")}</div>
      <button type="button" class="b-cta" data-lc-act="start" id="lcGo">Start LP copy</button>
    </div>
  </div>`;

  // ── board ──
  const board = () => S.boards[S.days];
  async function loadBoard(force) {
    const d = S.days, c = S.boards[d];
    if (c?.data && !force && Date.now() - c.at < 5 * 60e3) return paintBoard();
    if (c?.loading) return;
    S.boards[d] = { ...(c ?? {}), loading: true, err: null };
    paintBoard();
    try { S.boards[d] = { data: await deps.api(`/v1/agents/lp/smart?days=${d}&limit=20`), at: Date.now() }; }
    catch (e) { S.boards[d] = { ...(S.boards[d] ?? {}), loading: false, err: e?.message ?? String(e) }; }
    if (alive && S.days === d) { paintBoard(); paintGo(); }
  }
  function paintBoard() {
    const el = $("lcBoard"); if (!el) return;
    paintTopN();
    const c = board();
    if (!c || (!c.data && !c.err)) { el.innerHTML = `<div class="lc-tbl">${'<div class="b-skrow"><div class="b-skel"></div></div>'.repeat(6)}</div><p class="b-hint" title="Reading the LP wallets' positions on Chord. The board is cached for 10 minutes.">${SPIN} Reading LP wallets…</p>`; return; }
    if (c.err && !c.data) { el.innerHTML = K.errBox(c.err, "lc-retry"); return; }
    const b = c.data, list = rows(b.rows).filter((r) => typeof r.wallet === "string" && B58.test(r.wallet));
    const top = topN();
    const body = list.length ? list.map((r, i) => boardRow(r, i, top)).join("") : `<div class="b-none" title="Try another window">No wallet passes the rules</div>`;
    const covH = N(b.coverageStart) != null ? Math.round((Date.now() - N(b.coverageStart)) / 3600e3) : null;
    const covTxt = covH != null ? `Chord's Solana LP tape starts ${hm(N(b.coverageStart))}: this window covers ${covH} hours of it, so each wallet has only a few positions to judge.` : "";
    const cv = $("lcCov"); if (cv) { cv.innerHTML = covH != null ? `<em class="ag-rp" title="${esc(covTxt)}">tape ${esc(String(covH))}h</em>` : ""; }
    el.innerHTML = `<div class="lc-tbl lc-board${S.mode === "top" ? " top" : ""}${c.loading ? " b-dim" : ""}" role="group" aria-label="Smart LP wallets">
        <div class="lc-th"><span></span><span>#</span><span>Wallet</span><span class="lc-n" title="Positions seen from the first deposit">Seen</span><span class="lc-n">Fee yield</span><span class="lc-n" title="Realized ROI">ROI</span><span class="lc-n">Win</span><span class="lc-n" title="Median hold">Hold</span><span>Pools</span></div>
        ${body}</div>
      ${trapHtml(b)}
      ${strs(b.notes).length || covTxt ? `<details class="ag-notes"><summary>Method</summary><ul>${covTxt ? `<li>${esc(covTxt)}</li>` : ""}${strs(b.notes).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}`;
  }
  function boardRow(r, i, top) {
    const on = S.mode === "top" ? i < top : S.sel.has(r.wallet);
    const roi = N(r.roiPct), wr = N(r.winRate);
    return `<label class="lc-r${on ? " on" : ""}"><input type="checkbox" data-lc-w="${esc(r.wallet)}"${on ? " checked" : ""}${S.mode === "top" ? " disabled" : ""} aria-label="Copy ${esc(short(r.wallet))}"><span class="lc-box">${CHECK}</span>
      <span class="lc-rank">${i + 1}</span>
      <span class="lc-w"><a href="${SOLSCAN.acct}${encodeURIComponent(r.wallet)}" target="_blank" rel="noopener" title="${esc(r.wallet)}"><b>${esc(short(r.wallet))}</b></a><small title="${esc(`score ${r.score} · ${strs(r.venues).join(", ")}`)}">${esc(String(r.score))} · ${esc(strs(r.venues).map(vshort).join(", "))}</small></span>
      <span class="lc-built" title="Positions the tape saw from their first deposit (of ${int(r.positionsAll)} Chord counts in the window)">${int(r.positions)}</span>
      <span class="lc-stats"><span class="lc-n" data-k="Fee yield">${pct1(r.feeYieldPct)}</span><span class="lc-n ${cls(roi)}" data-k="ROI">${roi == null ? "—" : signedPct(roi)}</span><span class="lc-n" data-k="Win">${wr == null ? "—" : `${Math.round(wr * 100)}%`}</span><span class="lc-n" data-k="Hold">${hold(r.medianHoldS)}</span></span>
      <span class="lc-pools" title="${esc(strs(r.pairs).join(", "))}"><span>${esc(strs(r.pairs)[0] ?? "")}</span><small title="pools · deposited">${int(r.pools)} · ${usd(r.depositedUsd)}</small></span>
    </label>`;
  }
  function trapHtml(b) {
    const t = rows(b.trap), drops = rows(b.dropped);
    if (!t.length && !drops.length) return "";
    // "dropped: pool launcher (opens new pools …)" → the tag, and why in small print
    const verdict = (v) => { const m = /^\s*(dropped|kept)?:?\s*([^(]+?)\s*(?:\((.*)\))?\s*$/i.exec(String(v ?? "")); return m ? { tag: m[2], why: m[3] ?? "", kept: /^kept/i.test(m[1] ?? "") } : { tag: String(v ?? ""), why: "", kept: false }; };
    const left = drops.reduce((a, d) => a + (N(d.wallets) ?? 0), 0);
    // what the board leaves out stays one click away: closed by default, the counts on the summary line
    return `<details class="lc-trap"><summary class="lc-traph">${ALERT}<b>Not copied</b><span class="lc-trn">${t.length ? `<b>${int(t.length)}</b> top earners` : ""}${t.length && drops.length ? " · " : ""}${drops.length ? `<b>${int(left)}</b> filtered` : ""}</span></summary>
      <p>Chord's top LP earners by realized PnL, checked against the tape. Chord's ranking counts what a wallet takes out of a position the tape never saw it fund, and pool creators pulling their launch liquidity. This board only judges positions seen from the first deposit.</p>
      ${t.length ? `<div class="lc-tl">${t.map((x, i) => { const v = verdict(x.verdict); return `<div class="lc-tr"><span class="lc-trk">${i + 1}</span>
          <a class="lc-tw" href="${SOLSCAN.acct}${encodeURIComponent(x.wallet)}" target="_blank" rel="noopener" title="${esc(x.wallet)}">${esc(short(x.wallet))}</a>
          <span class="lc-tp" title="Chord realized PnL"><b class="${cls(x.chordRealizedPnlUsd)}">${N(x.chordRealizedPnlUsd) != null ? signed(x.chordRealizedPnlUsd) : "—"}</b></span>
          <span class="lc-tio" title="put in → took out · wins">${usd(x.chordDepositedUsd)} → ${usd(x.chordWithdrawnUsd)}${N(x.chordWinRate) != null ? ` · ${Math.round(N(x.chordWinRate) * 100)}%` : ""}</span>
          <span class="lc-tv"${v.why ? ` title="${esc(v.why)}"` : ""}><em class="${v.kept ? "kept" : ""}">${v.kept ? "kept" : "dropped"}</em><b>${esc(v.tag)}</b></span></div>`; }).join("")}</div>` : ""}
      ${drops.length ? `<div class="lc-drops">${drops.map((d) => { const m = /^([^(]+?)\s*\((.*)\)\s*$/.exec(String(d.reason ?? "")); return `<span class="lc-chip"${m ? ` title="${esc(m[2])}"` : ""}><b>${int(d.wallets)}</b>${esc(m ? m[1] : d.reason)}</span>`; }).join("")}</div>` : ""}
    </details>`;
  }

  const topN = () => { const n = Math.round(N(S.top) ?? 3); return Math.max(1, Math.min(10, n)); };
  function paintTopN() {
    const el = $("lcTopN"); if (!el) return;
    el.innerHTML = S.mode === "top" ? `<span class="b-in" title="Copy the top N of the board, picked when it starts"><input data-lc-f="top" inputmode="numeric" value="${esc(S.top)}" aria-label="How many of the top wallets"></span>` : `<span title="Wallets picked">${int(S.sel.size)}/${MAX_WALLETS}</span>`;
  }

  // ── params ──
  function params() {
    const p = { mode: "copy" };
    if (S.mode === "top") {
      const n = N(S.top);
      if (n == null || !Number.isInteger(n) || n < 1 || n > 10) return { err: "The top of the board must be a whole number from 1 to 10." };
      p.wallets = { smartLps: { top: n, days: S.days } };
    } else {
      if (!S.sel.size) return { err: "Pick at least one wallet on the board." };
      p.wallets = [...S.sel];
    }
    const amt = N(S.amount);
    if (amt == null || amt < 10 || amt > 2000) return { err: "The amount per position must be between $10 and $2,000." };
    p.amountUsd = amt;
    const mo = S.maxOpen === "" ? 3 : N(S.maxOpen);
    if (mo == null || !Number.isInteger(mo) || mo < 1 || mo > 10) return { err: "Open at once must be a whole number from 1 to 10." };
    p.maxOpenPositions = mo;
    const tv = S.tvl === "" ? 50000 : N(S.tvl);
    if (tv == null || tv < 0) return { err: "The TVL floor must be $0 or more." };
    p.minPoolTvlUsd = tv;
    if (!S.venues.size) return { err: "Keep at least one venue." };
    p.venues = VENUES.map((v) => v[0]).filter((v) => S.venues.has(v));
    p.followRemoves = S.removes;
    const ex = { lpExodus: S.exodus, tokenDropPct: null, dailyLossStopUsd: null };
    if (S.drop !== "") { const v = N(S.drop); if (v == null || v < 5 || v > 95) return { err: "The token drop exit must be 5% to 95%, or empty for none." }; ex.tokenDropPct = v; }
    if (S.stop !== "") { const v = N(S.stop); if (v == null || v <= 0) return { err: "The daily loss stop must be above $0, or empty for none." }; ex.dailyLossStopUsd = v; }
    p.exits = ex;
    p.safety = S.safety;
    return { params: p };
  }
  const btBody = (p) => ({ ...p, days: S.btDays });
  const btKeyNow = () => { const { params: p } = params(); return p ? JSON.stringify(btBody(p)) : null; };
  function setMsg(t, bad) { S.msg = t; S.bad = bad; const el = $("lcMsg"); if (el) { el.textContent = t; el.classList.toggle("bad", !!bad); } }
  function paintGo() {
    const b = $("lcGo"); if (!b) return;
    const { err } = params();
    b.disabled = S.busy || !!err;
    b.innerHTML = S.busy ? `${SPIN}Starting…` : "Start LP copy";
    if (!S.busy && !S.bad) setMsg(err ? err : S.bt && S.btKey === btKeyNow() ? "" : "Not backtested", false);
    const st = $("lcStale"); if (st && S.bt) st.hidden = S.btKey === btKeyNow();
  }
  function paintVen() {
    const el = $("lcVen"); if (!el) return;
    el.innerHTML = VENUES.map(([v, l]) => `<button type="button" data-lc-ven="${v}" aria-pressed="${S.venues.has(v)}"><span class="lc-box">${CHECK}</span>${l}</button>`).join("");
  }

  // ── backtest ──
  async function runBt() {
    const { params: p, err } = params();
    if (err) return setMsg(err, true);
    S.bad = false; S.btBusy = true; S.btErr = null; paintBt();
    const body = btBody(p);
    try { S.bt = await deps.api("/v1/agents/lp/copy/backtest", { method: "POST", body }); S.btKey = JSON.stringify(body); }
    catch (e) { S.btErr = e?.message ?? String(e); }
    S.btBusy = false;
    if (alive) { paintBt(); paintGo(); }
  }
  function paintBt() {
    const el = $("lcBt"); if (!el) return;
    const btn = $("lcBtBtn"); if (btn) { btn.disabled = S.btBusy; btn.innerHTML = S.btBusy ? `${SPIN}Replaying…` : "Run backtest"; }
    if (!S.bt) {
      if (S.btBusy) { el.innerHTML = `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p title="Reading the wallets' LP moves and each pool's prices on Chord. This takes up to a minute.">${SPIN}Replaying… up to 1 min</p></div>`; return; }
      el.innerHTML = S.btErr ? K.errBox(S.btErr, "lc-bt") : `<div class="b-none">No run yet</div>`;
      return;
    }
    const bt = S.bt, pos = rows(bt.positions), skips = rows(bt.skipped), eq = rows(bt.equity), notes = strs(bt.notes);
    const chart = eq.length > 1 ? (K.equityHtml ? K.equityHtml(eq.map((e) => ({ ts: e.ts, usd: e.usd })), "PnL") : sparkline(eq)) : "";
    el.innerHTML = `<div class="b-btres${S.btBusy ? " b-dim" : ""}">
      ${S.btErr ? `<div class="b-banner bad">${ALERT}<span>${esc(S.btErr)}</span></div>` : ""}
      <p class="b-stale" id="lcStale" hidden>${ALERT}Settings changed · run again</p>
      ${strs(bt.unread).length ? `<div class="b-banner bad" title="Chord could not read the LP events of these wallets (twice): their moves are not in this replay. Run it again in a minute.">${ALERT}<span>Unread: ${esc(strs(bt.unread).map((w) => short(w)).join(", "))} · run again</span></div>` : ""}
      <div class="b-bth"><em class="ag-rp">replay ${esc(String(N(bt.windowHours) ?? 0))}h</em><span>${esc(String(bt.walletsFrom ?? ""))} · ${usd(bt.amountUsd)}/position · ${int(bt.maxOpenPositions)} open · TVL ≥ ${usd(bt.minPoolTvlUsd)}</span>${info(notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "", "What this replay can and cannot see")}</div>
      <div class="b-tiles b-t6">
        ${tile("PnL", signed(bt.pnlUsd), `<span title="put in">/ ${usd(bt.investedUsd)}</span> · <span title="max drawdown">drawdown ${usd(bt.maxDrawdownUsd)}</span>`, cls(bt.pnlUsd))}
        <div class="b-tile" title="Fee APR today × time in range: an estimate"><small>Fees <em class="ag-est">est.</em></small><b class="${cls(bt.feesUsd)}">${signed(bt.feesUsd)}</b></div>
        ${tile("IL", signed(bt.ilUsd), "", cls(bt.ilUsd))}
        ${tile("Copied", `${int(bt.copied)}<em class="ag-of">/${int(bt.entries)}</em>`, `<span title="LP adds by the wallets copied · moves">${int(bt.moves)} moves</span>`)}
        ${tile("Win rate", N(bt.winRate) == null ? "—" : `${Math.round(N(bt.winRate) * 100)}%`, "")}
        ${tile("Realized", signed(bt.realizedUsd), `open ${signed(bt.unrealizedUsd)}`, cls(bt.realizedUsd))}
      </div>
      ${chart}
      ${skips.length ? `<div><div class="b-sech"><h3>Skipped adds</h3><small>${int(skips.reduce((a, s) => a + (N(s.n) ?? 0), 0))}</small></div><ul class="lc-skips">${skips.map((s) => `<li><b>${int(s.n)}</b>${esc(s.reason)}</li>`).join("")}</ul></div>` : ""}
      ${pos.length ? `<div><div class="b-sech"><h3>Copied positions</h3><small>${int(pos.length)}</small></div>${posTable(pos)}</div>` : ""}
    </div>`;
    paintGo();
  }
  function posTable(pos) {
    return `<div class="lc-tbl lc-pos"><div class="lc-th"><span>Pool</span><span>Copied from</span><span>Opened</span><span>Closed</span><span>Range</span><span class="lc-n">PnL</span></div>
      ${pos.map((p) => `<div class="lc-r"><span class="lc-src"><b>${esc(p.pair)}</b><small title="${esc(venueName(p.dex))} · fees (est.) · IL">${esc(vshort(p.dex))} · fees ${usd(p.feesUsd)} <em class="ag-est">est.</em> · IL ${signed(p.ilUsd)}</small></span>
        <span class="lc-src"><a href="${SOLSCAN.acct}${encodeURIComponent(p.wallet)}" target="_blank" rel="noopener">${esc(short(p.wallet))}</a><small><a href="${SOLSCAN.tx}${encodeURIComponent(p.tx)}" target="_blank" rel="noopener" title="The wallet's add" aria-label="The wallet's add">add ↗</a></small></span>
        <span class="lc-m" data-k="Opened">${esc(hm(p.openedAt))}</span>
        <span class="lc-m" data-k="Closed">${p.closedAt ? esc(hm(p.closedAt)) : "open"}</span>
        <span class="lc-src"><span>${p.range ? `${signedPct(-p.range.downPct)} / ${signedPct(p.range.upPct)}` : "full range"}</span><small>${N(p.timeInRangePct) != null ? `${pct1(p.timeInRangePct)} in range` : ""}${p.closeReason ? ` · ${esc(p.closeReason)}` : ""}</small></span>
        <span class="lc-n ${cls(p.pnlUsd)}">${signed(p.pnlUsd)}</span></div>`).join("")}</div>`;
  }

  // ── start ──
  async function start() {
    const { params: p, err } = params();
    if (err) return setMsg(err, true);
    S.busy = true; S.bad = false; paintGo();
    try {
      const name = S.mode === "top" ? `Copy top ${p.wallets.smartLps.top} smart LP${p.wallets.smartLps.top > 1 ? "s" : ""} (${S.days} d)` : undefined;
      const bot = await deps.api("/v1/agents", { method: "POST", body: { type: "lp", params: p, ...(name ? { name } : {}) } });
      S.busy = false;
      deps.onCreated?.(bot);
    } catch (e) { S.busy = false; setMsg(e?.message ?? String(e), true); paintGo(); }
  }

  // ── events (this subtree only) ──
  function onClick(e) {
    const a = e.target.closest?.("[data-lc-days],[data-lc-mode],[data-lc-btdays],[data-lc-tog],[data-lc-ven],[data-lc-act],[data-act^='lc-']");
    if (!a || !root.contains(a)) return;
    const ds = a.dataset;
    const segOn = () => a.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === a));
    if (ds.lcDays) { S.days = Number(ds.lcDays); segOn(); loadBoard(); paintGo(); return; }
    if (ds.lcMode) { S.mode = ds.lcMode; segOn(); paintBoard(); paintGo(); return; }
    if (ds.lcBtdays) { S.btDays = Number(ds.lcBtdays); segOn(); paintGo(); return; }
    if (ds.lcTog) { S[ds.lcTog] = !S[ds.lcTog]; a.setAttribute("aria-checked", String(S[ds.lcTog])); paintGo(); return; }
    if (ds.lcVen) { if (S.venues.has(ds.lcVen)) S.venues.delete(ds.lcVen); else S.venues.add(ds.lcVen); a.setAttribute("aria-pressed", String(S.venues.has(ds.lcVen))); paintGo(); return; }
    const act = ds.lcAct ?? ds.act;
    if (act === "bt" || act === "lc-bt") return void runBt();
    if (act === "start") return void start();
    if (act === "lc-retry") { S.boards[S.days] = null; return void loadBoard(true); }
  }
  function onChange(e) {
    const w = e.target.dataset?.lcW;
    if (w == null || !root.contains(e.target)) return;
    if (e.target.checked && S.sel.size >= MAX_WALLETS) { e.target.checked = false; return setMsg(`At most ${MAX_WALLETS} wallets.`, true); }
    if (e.target.checked) S.sel.add(w); else S.sel.delete(w);
    e.target.closest(".lc-r")?.classList.toggle("on", e.target.checked);
    S.bad = false; paintTopN(); paintGo();
  }
  function onInput(e) {
    const k = e.target.dataset?.lcF;
    if (k == null || !root.contains(e.target)) return;
    S[k] = e.target.value.trim();
    if (k === "top") { const top = topN(); root.querySelectorAll(".lc-board .lc-r").forEach((r, i) => r.classList.toggle("on", i < top)); }
    S.bad = false; paintGo();
  }
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  paintVen(); paintBoard(); paintBt(); paintGo(); loadBoard();
  return { destroy() { alive = false; root.removeEventListener("click", onClick); root.removeEventListener("change", onChange); root.removeEventListener("input", onInput); } };
}

const venueName = (dex) => (VENUES.find((v) => v[0] === dex)?.[1] ?? String(dex ?? ""));
/** A plain PnL line when bots.js's chart is not passed in. */
function sparkline(eq) {
  const pts = eq.map((e) => ({ t: N(e.ts), v: N(e.usd) })).filter((p) => p.t != null && p.v != null);
  if (pts.length < 2) return "";
  let lo = Math.min(0, ...pts.map((p) => p.v)), hi = Math.max(0, ...pts.map((p) => p.v));
  if (lo === hi) { lo -= 1; hi += 1; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * 1000, Y = (v) => (1 - (v - lo) / (hi - lo)) * 160;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const col = pts[pts.length - 1].v >= 0 ? "var(--hi)" : "var(--bad)";
  return `<svg viewBox="0 0 1000 160" preserveAspectRatio="none" style="width:100%;height:140px" role="img" aria-label="PnL over the replay"><line x1="0" x2="1000" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="var(--border)" stroke-dasharray="4 4"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

/** The copy agent's PnL over time, from its fills: 0 at the start, the running realized PnL at each close, and now the
 *  realized plus the open positions' PnL, so the curve ends on the hero's total. Closes older than the fills the server
 *  sends are one step at the first close shown. Drawn with bots.js's equityHtml (hover, keyboard). */
function pnlCurve(data, K) {
  if (!K.equityHtml) return "";
  const bot = data?.bot ?? {}, st = bot.stats ?? {}, toT = (t) => { const n = N(t); return n == null ? null : n < 1e12 ? n * 1000 : n; };
  const closes = rows(data?.fills).filter((x) => x.status === "filled" && N(x.pnlUsd) != null && toT(x.ts) != null).sort((a, b) => toT(a.ts) - toT(b.ts));
  const open = rows(data?.lp?.copy?.positions).some((p) => p.status === "open");
  if (!closes.length && !open) return "";
  const realized = N(st.realizedUsd), total = (realized ?? closes.reduce((a, x) => a + N(x.pnlUsd), 0)) + (N(st.unrealizedUsd) ?? 0);
  const t0 = toT(bot.createdAt) ?? (closes.length ? toT(closes[0].ts) - 60e3 : Date.now() - 3600e3);
  const pts = [{ ts: t0, usd: 0 }];
  let run = realized != null ? realized - closes.reduce((a, x) => a + N(x.pnlUsd), 0) : 0;
  if (Math.abs(run) >= 0.005 && closes.length) pts.push({ ts: Math.max(t0, toT(closes[0].ts) - 1), usd: run });
  else run = 0;
  for (const x of closes) pts.push({ ts: toT(x.ts), usd: (run += N(x.pnlUsd)) });
  const last = Math.max(pts[pts.length - 1].ts, toT(st.lastEventAt) ?? 0, bot.status === "running" ? Date.now() : 0);
  pts.push({ ts: last > pts[pts.length - 1].ts ? last : pts[pts.length - 1].ts + 1, usd: Math.round(total * 100) / 100 });
  return K.equityHtml(pts, "PnL");
}
/** where the price sits in an open position's range: the band, the price tick (red when out of range) */
function rangeBar(r, price, inRange, quote, esc) {
  const lo = N(r?.lower), hi = N(r?.upper), px = N(price);
  if (!r || r.full || lo == null || hi == null || px == null || !(hi > lo) || !(px > 0)) return "";
  const a = Math.min(lo, px), z = Math.max(hi, px), pad = (z - a) * 0.12, A = a - pad, Z = z + pad, at = (v) => (((v - A) / (Z - A)) * 100).toFixed(1);
  const tip = `${priceTxt(lo)}–${priceTxt(hi)} ${quote ?? ""} · price ${priceTxt(px)} · ${inRange ? "in range" : "out of range"}`;
  return `<span class="lc-rb${inRange ? "" : " out"}" role="img" aria-label="${esc(tip)}" title="${esc(tip)}"><i style="left:${at(lo)}%;width:${(at(hi) - at(lo)).toFixed(1)}%"></i><b style="left:${at(px)}%"></b></span>`;
}

// ── detail: wallets followed, each copied move next to the wallet's transaction, positions ──────────────────────────────────
/** data = GET /v1/agents/:id (or /public/:id) of an LP copy agent: { bot, fills, lp: { copy: { follow, positions } } }.
 *  deps: same ui helpers as above (no api needed). Pure render: call it again with fresh data. */
export function renderLpCopyDetail(root, data, deps) {
  injectStyle();
  const K = kit(deps);
  const { esc, usd, signed, cls, int } = K;
  const plural = (n, w) => `${int(n)} ${w}${N(n) === 1 ? "" : "s"}`;
  const f = data?.lp?.copy?.follow ?? null, positions = rows(data?.lp?.copy?.positions);
  const pnlHtml = pnlCurve(data, K);
  const fills = rows(data?.fills).filter((x) => x.source?.via === "lp");
  const picked = new Map(rows(f?.picked).map((p) => [p.wallet, p]));
  const errs = f?.pollErrors && typeof f.pollErrors === "object" ? f.pollErrors : {};
  const wallets = strs(f?.wallets);
  const walletsHtml = !f ? `<div class="b-none" title="Reading which wallets to copy">Starting…</div>`
    : !wallets.length ? `<div class="b-none">${f.from === "smart" ? "Picking the top wallets…" : "No wallet to copy"}</div>`
    : `<div class="lc-wl">${wallets.map((w) => { const p = picked.get(w); return `<div><a href="${SOLSCAN.acct}${encodeURIComponent(w)}" target="_blank" rel="noopener" title="${esc(w)}"><b>${esc(short(w))}</b></a><small title="${p ? "score · positions it is built on" : "given wallet"}">${p ? `${esc(String(p.score))} · ${int(p.positions)} seen` : "given"}</small>${errs[w] ? `<small class="bad" title="Retried every minute">Check failed: ${esc(errs[w])}</small>` : ""}</div>`; }).join("")}</div>`;
  const subTip = f ? `${f.from === "smart" && f.board ? `The top ${int(f.board.top)} of the smart-LP board (${int(f.board.days)} d), picked when it started. ` : ""}Adds since ${hm(N(f.since) ?? Date.now())} are copied${N(f.lastPollAt) ? `; last checked ${hm(N(f.lastPollAt))}` : ""}. ${plural(f.moves, "move")} seen, ${int(f.copied)} copied, ${int(f.skipped)} skipped.` : "";
  const sub = f ? `<span title="${esc(subTip)}">${f.from === "smart" && f.board ? `top ${int(f.board.top)} · ${int(f.board.days)}d · ` : ""}since ${esc(hm(N(f.since) ?? Date.now()))} · <b>${int(f.moves)}</b> seen · <b>${int(f.copied)}</b> copied · <b>${int(f.skipped)}</b> skipped</span>` : "";
  // one line per move: time · kind · pool (and a skip's reason, short) · the wallet's own move · lag · paper; full text in titles
  const day = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : hm(ms));
  const why = (r) => { const t = String(r ?? "").replace(/\s*\((?:one|the|all)\b[^)]*\)/gi, "").replace(/ is under the /i, " < ").replace(/ reached$/i, "").trim(); return t.length > 30 ? `${t.slice(0, 29)}…` : t; };
  const what = (src) => { const d = String(src.detail ?? ""); return /closed/i.test(d) ? "closed" : /opened/i.test(d) ? "opened" : N(src.usd) != null ? `${src.side === "sell" ? MINUS : "+"}${usd(src.usd)}` : src.side === "sell" ? "removed" : "added"; };
  const moveRow = (x) => {
    const s = x.source ?? {}, own = !B58.test(String(s.wallet ?? "")) || s.wallet === x.mint; // an exit rule's source is the pool itself
    const kind = x.status === "skipped" ? "skip" : x.kind === "close" || x.side === "sell" ? "close" : "open";
    const lag = own ? null : lagText((N(x.ts) ?? 0) - (N(s.ts) ?? Infinity));
    const srcHtml = own ? `<span class="lc-src" title="${esc(String(x.reason ?? ""))}"><span>Exit rule</span></span>`
      : `<span class="lc-src lc-src1" title="${esc(`${String(s.detail ?? "")} · ${hm(N(s.ts) ?? 0)}`)}"><a href="${SOLSCAN.acct}${encodeURIComponent(s.wallet)}" target="_blank" rel="noopener">${esc(short(s.wallet))}</a><span>${esc(what(s))}</span><a href="${SOLSCAN.tx}${encodeURIComponent(String(s.tx ?? ""))}" target="_blank" rel="noopener" title="The wallet's own transaction" aria-label="The wallet's own transaction">↗</a></span>`;
    const agent = kind === "skip" ? `<span class="lc-n lc-m">—</span>` : `<span class="lc-n"${kind === "close" && N(x.pnlUsd) != null ? ` title="${esc(`PnL ${signed(x.pnlUsd)}`)}"` : ""}>${usd(x.usd)}${kind === "close" && N(x.pnlUsd) != null ? ` <small class="${cls(x.pnlUsd)}">${signed(x.pnlUsd)}</small>` : ""}</span>`;
    return `<div class="lc-r"${kind === "skip" && x.reason ? ` title="${esc(`Skipped: ${x.reason}`)}"` : kind !== "skip" && x.reason ? ` title="${esc(String(x.reason))}"` : ""}><span class="lc-m">${esc(day(N(x.ts) ?? 0))}</span><span class="lc-kind ${kind}">${kind.toUpperCase()}</span>
      <span class="lc-src lc-src1"><b>${esc(String(x.symbol ?? short(x.mint)))}</b>${kind === "skip" && x.reason ? `<small class="lc-why">${esc(why(x.reason))}</small>` : ""}</span>
      ${srcHtml}<span class="lc-n">${lag ?? ""}</span>${agent}</div>`;
  };
  const posRow = (p) => {
    const r = p.range, m = p.mark, cp = p.copied;
    const rg = !r ? "—" : r.full ? "full range" : `${priceTxt(r.lower)}–${r.upper == null ? "∞" : priceTxt(r.upper)} ${esc(p.quoteSymbol ?? "")}`;
    const val = p.status === "open" && m ? m.equityUsd : null;
    return `<div class="lc-r"><span class="lc-src"><b>${esc(p.pair)}</b><small>${esc(p.venue ?? "")} · ${p.status === "open" ? `<span class="lc-in${p.inRange ? " on" : ""}"></span>${p.inRange ? "in range" : "out of range"}` : `<span title="${esc(String(p.closeReason ?? ""))}">closed: ${esc(cut(String(p.closeReason ?? "").split(/:\s/)[0], 34))}</span>`}</small></span>
      <span class="lc-src">${cp ? `<a href="${SOLSCAN.acct}${encodeURIComponent(cp.wallet)}" target="_blank" rel="noopener">${esc(short(cp.wallet))}</a><small><a href="${SOLSCAN.tx}${encodeURIComponent(cp.tx)}" target="_blank" rel="noopener" title="The wallet's add">add ↗</a></small>` : ""}</span>
      <span class="lc-m" data-k="Opened">${p.first ? esc(hm(p.first.openedAt)) : ""}</span>
      <span class="lc-m" data-k="Closed">${p.closedAt ? esc(hm(p.closedAt)) : "open"}</span>
      <span class="lc-src"><span>${rg}</span>${p.status === "open" ? rangeBar(r, m?.price, p.inRange, p.quoteSymbol, esc) : ""}<small>fees ${usd(p.feesTotalUsd)} <em class="ag-est">est.</em>${m ? ` · IL ${signed(m.ilUsd)}` : ""}</small></span>
      <span class="lc-n">${val != null ? usd(val) : ""}</span></div>`;
  };
  root.innerHTML = `<div class="lc">
    ${pnlHtml ? `<div class="lc-pnl">${pnlHtml}</div>` : ""}
    <section class="b-step"><div class="b-sech"><h3>Copying</h3><small>${int(wallets.length)}</small></div>${sub ? `<p class="lc-sub">${sub}</p>` : ""}${walletsHtml}</section>
    <section class="b-step"><div class="b-sech"><h3>Copied moves</h3><small>${int(fills.length)}</small></div>
      ${fills.length ? `<div class="lc-tbl lc-moves"><div class="lc-th"><span>Time</span><span>Move</span><span>Pool</span><span title="The wallet's own move">Source</span><span class="lc-n" title="Reaction">Lag</span><span class="lc-n">Paper</span></div>${fills.slice(0, 25).map(moveRow).join("")}${fills.length > 25 ? `<details class="lc-more"><summary>All ${int(fills.length)}</summary>${fills.slice(25).map(moveRow).join("")}</details>` : ""}</div>`
        : `<div class="b-none" title="LP wallets can sit still for hours; every add and remove they make from now on shows up here next to their own transaction.">No moves yet</div>`}
    </section>
    <section class="b-step"><div class="b-sech"><h3>Positions</h3><small>${int(positions.filter((p) => p.status === "open").length)} open</small>${PAPER}${info("Paper positions marked every minute at Jupiter's prices. Fees are an estimate from each pool's fee APR while in range; IL is against holding what each position opened with.", "Paper positions")}</div>
      ${positions.length ? `<div class="lc-tbl lc-pos"><div class="lc-th"><span>Pool</span><span title="Copied from">From</span><span>Opened</span><span>Closed</span><span>Range</span><span class="lc-n">Value</span></div>${positions.map(posRow).join("")}</div>`
        : `<div class="b-none">No position yet</div>`}
    </section>
  </div>`;
}
