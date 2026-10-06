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
const SHIELD = '<i class="b-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9 12 2 2 4-4"/></svg></i>';

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
.lc-moves .lc-th, .lc-moves .lc-r { grid-template-columns: 92px 58px minmax(0, 1fr) minmax(0, 1.5fr) 64px 84px; align-items: start; }
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
  const head = (n, t, sub) => `<div class="b-sh"><span class="b-num">${n}</span><div><h3>${t}</h3><p>${sub}</p></div></div>`;
  const seg = (attr, vals, cur) => `<div class="b-seg sm">${vals.map(([v, l]) => `<button type="button" data-lc-${attr}="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const field = (k, label, { pre = "", suf = "", hint = "", ph = "", mode = "decimal" } = {}) => `<label class="b-field"><span>${label}</span><span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-lc-f="${k}" inputmode="${mode}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(S[k])}">${suf ? `<i>${suf}</i>` : ""}</span>${hint ? `<small>${hint}</small>` : ""}</label>`;
  const tog = (k, label, hint) => `<button type="button" class="b-tog" role="switch" aria-checked="${S[k]}" data-lc-tog="${k}"><span class="b-sw"></span><span><b>${label}</b><small>${hint}</small></span></button>`;

  root.innerHTML = `<div class="lc">
    <section class="b-step">${head(1, "Pick the LPs to copy", "Solana wallets ranked by what they earned providing liquidity, built only on positions Chord's tape saw from the first deposit. Fees are the ones they claimed.")}
      <div class="b-bar">${seg("days", DAYS, S.days)}${seg("mode", [["top", "Top of the board"], ["pick", "Pick wallets"]], S.mode)}<span class="lc-topn" id="lcTopN"></span></div>
      <div id="lcBoard"></div>
    </section>
    <section class="b-step">${head(2, "Size and rules", "Each copied add opens one paper position in the same pool with the wallet's own range. The copy never rebalances: it moves when the wallet moves.")}
      <div class="b-grid">
        ${field("amount", "Per position", { pre: "$", hint: "10 to 2,000" })}
        ${field("maxOpen", "Open at once", { ph: "3", mode: "numeric", hint: "1 to 10, one per pool" })}
        ${field("tvl", "Pool TVL floor", { pre: "$", ph: "50000", hint: "Thinner pools are skipped" })}
        ${field("drop", "Exit on token drop", { suf: "%", ph: "Off", hint: "From each open, 5 to 95" })}
        ${field("stop", "Daily loss stop", { pre: "$", ph: "Off", hint: "Closes everything and stops" })}
      </div>
      <div class="lc-ven" id="lcVen"></div>
      <div class="b-togs">${tog("removes", "Follow removes", "Close when the wallet closes or takes out half its deposit.")}${tog("exodus", "Exit on LP exodus", "Withdrawals above twice the deposits in an hour, $1,000 or more.")}${tog("safety", "Safety check", "Skip tokens with a live mint or freeze authority.")}</div>
    </section>
    <section class="b-step">${head(3, "Backtest", "Replay the wallets' LP moves with these rules on Chord's 5 or 15 minute prices: estimated fees, IL, and every skip with its reason.")}
      <div class="b-bar">${seg("btdays", DAYS, S.btDays)}<button type="button" class="b-btn pri" data-lc-act="bt" id="lcBtBtn">Run backtest</button></div>
      <div id="lcBt"></div>
    </section>
    <div class="b-start">
      <p class="b-note">${SHIELD}<span>Paper mode: the agent checks the wallets every minute and opens or closes paper positions at Jupiter's prices; nothing is sent. Fee income is always an estimate from each pool's fee APR.</span></p>
      <p class="b-msg" id="lcMsg"></p>
      <button type="button" class="b-cta" data-lc-act="start" id="lcGo">Start paper LP copy agent</button>
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
    if (!c || (!c.data && !c.err)) { el.innerHTML = `<div class="lc-tbl">${'<div class="b-skrow"><div class="b-skel"></div></div>'.repeat(6)}</div><p class="b-hint">${SPIN} Reading the LP wallets' positions on Chord. The board is cached for 10 minutes.</p>`; return; }
    if (c.err && !c.data) { el.innerHTML = K.errBox(c.err, "lc-retry"); return; }
    const b = c.data, list = rows(b.rows).filter((r) => typeof r.wallet === "string" && B58.test(r.wallet));
    const top = topN();
    const body = list.length ? list.map((r, i) => boardRow(r, i, top)).join("") : `<div class="b-none">No wallet passes the rules in this window yet. Try another window.</div>`;
    const cov = N(b.coverageStart) != null ? `<p class="lc-sub">Chord's Solana LP tape starts ${esc(hm(N(b.coverageStart)))}: this window covers ${esc(String(Math.round((Date.now() - N(b.coverageStart)) / 3600e3)))} hours of it, so each wallet has only a few positions to judge.</p>` : "";
    el.innerHTML = `${cov}<div class="lc-tbl lc-board${S.mode === "top" ? " top" : ""}${c.loading ? " b-dim" : ""}" role="group" aria-label="Smart LP wallets">
        <div class="lc-th"><span></span><span>#</span><span>Wallet</span><span class="lc-n">Built on</span><span class="lc-n">Fee yield</span><span class="lc-n">Realized ROI</span><span class="lc-n">Win rate</span><span class="lc-n">Median hold</span><span>Pools</span></div>
        ${body}</div>
      ${trapHtml(b)}
      ${strs(b.notes).length ? `<details class="ag-notes"><summary>How this board is built</summary><ul>${strs(b.notes).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}`;
  }
  function boardRow(r, i, top) {
    const on = S.mode === "top" ? i < top : S.sel.has(r.wallet);
    const roi = N(r.roiPct), wr = N(r.winRate);
    return `<label class="lc-r${on ? " on" : ""}"><input type="checkbox" data-lc-w="${esc(r.wallet)}"${on ? " checked" : ""}${S.mode === "top" ? " disabled" : ""} aria-label="Copy ${esc(short(r.wallet))}"><span class="lc-box">${CHECK}</span>
      <span class="lc-rank">${i + 1}</span>
      <span class="lc-w"><a href="${SOLSCAN.acct}${encodeURIComponent(r.wallet)}" target="_blank" rel="noopener" title="${esc(r.wallet)}"><b>${esc(short(r.wallet))}</b></a><small>score ${esc(String(r.score))} · ${esc(strs(r.venues).join(", "))}</small></span>
      <span class="lc-built" title="Positions the tape saw from their first deposit (of ${int(r.positionsAll)} Chord counts in the window)">${int(r.positions)}<small>positions</small></span>
      <span class="lc-stats"><span class="lc-n" data-k="Fee yield">${pct1(r.feeYieldPct)}</span><span class="lc-n ${cls(roi)}" data-k="Realized ROI">${roi == null ? "no closes" : signedPct(roi)}</span><span class="lc-n" data-k="Win rate">${wr == null ? "n/a" : `${Math.round(wr * 100)}%`}</span><span class="lc-n" data-k="Median hold">${hold(r.medianHoldS)}</span></span>
      <span class="lc-pools">${strs(r.pairs).slice(0, 2).map((p) => `<span>${esc(p)}</span>`).join("")}<small>${int(r.pools)} pool${N(r.pools) === 1 ? "" : "s"} · ${usd(r.depositedUsd)} in</small></span>
    </label>`;
  }
  function trapHtml(b) {
    const t = rows(b.trap), drops = rows(b.dropped);
    if (!t.length && !drops.length) return "";
    // "dropped: pool launcher (opens new pools …)" → the tag, and why in small print
    const verdict = (v) => { const m = /^\s*(dropped|kept)?:?\s*([^(]+?)\s*(?:\((.*)\))?\s*$/i.exec(String(v ?? "")); return m ? { tag: m[2], why: m[3] ?? "", kept: /^kept/i.test(m[1] ?? "") } : { tag: String(v ?? ""), why: "", kept: false }; };
    return `<div class="lc-trap"><div class="lc-traph"><b>${ALERT}Not copied, and why</b><small>Chord's top LP earners by realized PnL, checked against the tape</small></div>
      <p>Chord's ranking counts what a wallet takes out of a position the tape never saw it fund, and pool creators pulling their launch liquidity. This board only judges positions seen from the first deposit.</p>
      ${t.length ? `<div class="lc-tl">${t.map((x, i) => { const v = verdict(x.verdict); return `<div class="lc-tr"><span class="lc-trk">${i + 1}</span>
          <a class="lc-tw" href="${SOLSCAN.acct}${encodeURIComponent(x.wallet)}" target="_blank" rel="noopener" title="${esc(x.wallet)}">${esc(short(x.wallet))}</a>
          <span class="lc-tp"><small>Chord realized</small><b class="${cls(x.chordRealizedPnlUsd)}">${N(x.chordRealizedPnlUsd) != null ? signed(x.chordRealizedPnlUsd) : "n/a"}</b></span>
          <span class="lc-tio">put in ${usd(x.chordDepositedUsd)} · took out ${usd(x.chordWithdrawnUsd)}${N(x.chordWinRate) != null ? ` · ${Math.round(N(x.chordWinRate) * 100)}% wins` : ""}</span>
          <span class="lc-tv"><em class="${v.kept ? "kept" : ""}">${v.kept ? "kept" : "dropped"}</em><b>${esc(v.tag)}</b>${v.why ? `<small>${esc(v.why)}</small>` : ""}</span></div>`; }).join("")}</div>` : ""}
      ${drops.length ? `<div class="lc-drops"><small>Every wallet left out</small>${drops.map((d) => `<span class="lc-chip"><b>${int(d.wallets)}</b>${esc(d.reason)}</span>`).join("")}</div>` : ""}
    </div>`;
  }

  const topN = () => { const n = Math.round(N(S.top) ?? 3); return Math.max(1, Math.min(10, n)); };
  function paintTopN() {
    const el = $("lcTopN"); if (!el) return;
    el.innerHTML = S.mode === "top" ? `Copy the top <span class="b-in"><input data-lc-f="top" inputmode="numeric" value="${esc(S.top)}" aria-label="How many of the top wallets"></span> picked when it starts` : `<span>${int(S.sel.size)} of ${MAX_WALLETS} picked</span>`;
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
    b.innerHTML = S.busy ? `${SPIN}Starting…` : "Start paper LP copy agent";
    if (!S.busy && !S.bad) setMsg(err ? err : S.bt && S.btKey === btKeyNow() ? "" : "Run the backtest first to see how these rules would have done.", false);
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
      if (S.btBusy) { el.innerHTML = `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p>${SPIN}Reading the wallets' LP moves and each pool's prices on Chord. This takes up to a minute.</p></div>`; return; }
      el.innerHTML = S.btErr ? K.errBox(S.btErr, "lc-bt") : `<div class="b-none">Run it to see what copying these wallets would have earned, with every skip and why.</div>`;
      return;
    }
    const bt = S.bt, pos = rows(bt.positions), skips = rows(bt.skipped), eq = rows(bt.equity), notes = strs(bt.notes);
    const chart = eq.length > 1 ? (K.equityHtml ? K.equityHtml(eq.map((e) => ({ ts: e.ts, usd: e.usd })), "PnL over the replay") : sparkline(eq)) : "";
    el.innerHTML = `<div class="b-btres${S.btBusy ? " b-dim" : ""}">
      ${S.btErr ? `<div class="b-banner bad">${ALERT}<span>${esc(S.btErr)}</span></div>` : ""}
      <p class="b-stale" id="lcStale" hidden>${ALERT}Settings changed since this run. Run it again to update.</p>
      ${strs(bt.unread).length ? `<div class="b-banner bad">${ALERT}<span>Chord could not read the LP events of ${esc(strs(bt.unread).map((w) => short(w)).join(", "))} (twice): their moves are not in this replay. Run it again in a minute.</span></div>` : ""}
      <div class="b-bth"><b>${esc(String(N(bt.windowHours) ?? 0))} h replayed</b><span>${esc(String(bt.walletsFrom ?? ""))} · ${usd(bt.amountUsd)} a position, at most ${int(bt.maxOpenPositions)} open, TVL floor ${usd(bt.minPoolTvlUsd)}</span></div>
      <div class="b-tiles b-t6">
        ${tile("PnL", signed(bt.pnlUsd), `on ${usd(bt.investedUsd)} put in · drawdown ${usd(bt.maxDrawdownUsd)}`, cls(bt.pnlUsd))}
        ${tile("Fees (est.)", signed(bt.feesUsd), "fee APR today × time in range", cls(bt.feesUsd))}
        ${tile("IL", signed(bt.ilUsd), "exact range math", cls(bt.ilUsd))}
        ${tile("Copied", `${int(bt.copied)} of ${int(bt.entries)}`, `LP adds by the wallets · ${int(bt.moves)} moves`)}
        ${tile("Win rate", N(bt.winRate) == null ? "n/a" : `${Math.round(N(bt.winRate) * 100)}%`, "closed copies")}
        ${tile("Realized", signed(bt.realizedUsd), `open ${signed(bt.unrealizedUsd)}`, cls(bt.realizedUsd))}
      </div>
      ${chart}
      ${skips.length ? `<div><div class="b-sech"><h3>Skipped adds</h3><small>${int(skips.reduce((a, s) => a + (N(s.n) ?? 0), 0))}</small></div><ul class="lc-skips">${skips.map((s) => `<li><b>${int(s.n)}</b>${esc(s.reason)}</li>`).join("")}</ul></div>` : ""}
      ${pos.length ? `<div><div class="b-sech"><h3>Copied positions</h3><small>${int(pos.length)}</small></div>${posTable(pos)}</div>` : ""}
      ${notes.length ? `<details class="ag-notes"><summary>What this replay can and cannot see</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
    </div>`;
    paintGo();
  }
  function posTable(pos) {
    return `<div class="lc-tbl lc-pos"><div class="lc-th"><span>Pool</span><span>Copied from</span><span>Opened</span><span>Closed</span><span>Range</span><span class="lc-n">PnL</span></div>
      ${pos.map((p) => `<div class="lc-r"><span class="lc-src"><b>${esc(p.pair)}</b><small>${esc(venueName(p.dex))} · fees ${usd(p.feesUsd)} est., IL ${signed(p.ilUsd)}</small></span>
        <span class="lc-src"><a href="${SOLSCAN.acct}${encodeURIComponent(p.wallet)}" target="_blank" rel="noopener">${esc(short(p.wallet))}</a><small><a href="${SOLSCAN.tx}${encodeURIComponent(p.tx)}" target="_blank" rel="noopener" title="The wallet's add">its add ↗</a></small></span>
        <span class="lc-m" data-k="Opened">${esc(hm(p.openedAt))}</span>
        <span class="lc-m" data-k="Closed">${p.closedAt ? esc(hm(p.closedAt)) : "still open"}</span>
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

// ── detail: wallets followed, each copied move next to the wallet's transaction, positions ──────────────────────────────────
/** data = GET /v1/agents/:id (or /public/:id) of an LP copy agent: { bot, fills, lp: { copy: { follow, positions } } }.
 *  deps: same ui helpers as above (no api needed). Pure render: call it again with fresh data. */
export function renderLpCopyDetail(root, data, deps) {
  injectStyle();
  const K = kit(deps);
  const { esc, usd, signed, cls, int } = K;
  const plural = (n, w) => `${int(n)} ${w}${N(n) === 1 ? "" : "s"}`;
  const f = data?.lp?.copy?.follow ?? null, positions = rows(data?.lp?.copy?.positions);
  const fills = rows(data?.fills).filter((x) => x.source?.via === "lp");
  const picked = new Map(rows(f?.picked).map((p) => [p.wallet, p]));
  const errs = f?.pollErrors && typeof f.pollErrors === "object" ? f.pollErrors : {};
  const wallets = strs(f?.wallets);
  const walletsHtml = !f ? `<div class="b-none">Starting: reading which wallets to copy.</div>`
    : !wallets.length ? `<div class="b-none">${f.from === "smart" ? "Picking the top wallets of the smart-LP board…" : "No wallet to copy."}</div>`
    : `<div class="lc-wl">${wallets.map((w) => { const p = picked.get(w); return `<div><a href="${SOLSCAN.acct}${encodeURIComponent(w)}" target="_blank" rel="noopener" title="${esc(w)}"><b>${esc(short(w))}</b></a><small>${p ? `score ${esc(String(p.score))} · built on ${int(p.positions)} positions` : "given wallet"}</small>${errs[w] ? `<small class="bad">Last check failed: ${esc(errs[w])} (retried every minute)</small>` : ""}</div>`; }).join("")}</div>`;
  const sub = f ? `${f.from === "smart" && f.board ? `The top ${int(f.board.top)} of the smart-LP board (${int(f.board.days)} d), picked when it started. ` : ""}Adds since ${esc(hm(N(f.since) ?? Date.now()))} are copied${N(f.lastPollAt) ? `; last checked ${esc(hm(N(f.lastPollAt)))}` : ""}. ${plural(f.moves, "move")} seen, ${int(f.copied)} copied, ${int(f.skipped)} skipped.` : "";
  const moveRow = (x) => {
    const s = x.source ?? {}, own = !B58.test(String(s.wallet ?? "")) || s.wallet === x.mint; // an exit rule's source is the pool itself
    const kind = x.status === "skipped" ? "skip" : x.kind === "close" || x.side === "sell" ? "close" : "open";
    const lag = own ? null : lagText((N(x.ts) ?? 0) - (N(s.ts) ?? Infinity));
    const srcHtml = own ? `<span class="lc-src"><span>Exit rule</span><small>${esc(String(x.reason ?? "").replace(/^Exit, /, ""))}</small></span>`
      : `<span class="lc-src"><span>${esc(String(s.detail ?? `${short(s.wallet)} ${s.side === "sell" ? "removed" : "added"}`))}</span><small><a href="${SOLSCAN.acct}${encodeURIComponent(s.wallet)}" target="_blank" rel="noopener">${esc(short(s.wallet))}</a> · ${esc(hm(N(s.ts) ?? 0))} · <a href="${SOLSCAN.tx}${encodeURIComponent(String(s.tx ?? ""))}" target="_blank" rel="noopener" title="The wallet's own transaction">tx ↗</a></small></span>`;
    const agent = kind === "skip" ? `<span class="lc-src" style="text-align:right"><span class="lc-m">skipped</span></span>` : `<span class="lc-src" style="text-align:right"><span class="lc-n">${usd(x.usd)}</span>${kind === "close" && N(x.pnlUsd) != null ? `<small class="${cls(x.pnlUsd)}">${signed(x.pnlUsd)}</small>` : ""}</span>`;
    return `<div class="lc-r"><span class="lc-m">${esc(hm(N(x.ts) ?? 0))}</span><span class="lc-kind ${kind}">${kind.toUpperCase()}</span>
      <span class="lc-src"><b>${esc(String(x.symbol ?? short(x.mint)))}</b>${kind === "skip" && x.reason ? `<small class="lc-why">${esc(x.reason)}</small>` : ""}</span>
      ${srcHtml}<span class="lc-n">${lag ?? ""}</span>${agent}</div>`;
  };
  const posRow = (p) => {
    const r = p.range, m = p.mark, cp = p.copied;
    const rg = !r ? "n/a" : r.full ? "full range" : `${priceTxt(r.lower)} to ${r.upper == null ? "no top" : priceTxt(r.upper)} ${esc(p.quoteSymbol ?? "")}`;
    const val = p.status === "open" && m ? m.equityUsd : null;
    return `<div class="lc-r"><span class="lc-src"><b>${esc(p.pair)}</b><small>${esc(p.venue ?? "")} · ${p.status === "open" ? `<span class="lc-in${p.inRange ? " on" : ""}"></span>${p.inRange ? "in range" : "out of range"}` : `closed: ${esc(String(p.closeReason ?? ""))}`}</small></span>
      <span class="lc-src">${cp ? `<a href="${SOLSCAN.acct}${encodeURIComponent(cp.wallet)}" target="_blank" rel="noopener">${esc(short(cp.wallet))}</a><small><a href="${SOLSCAN.tx}${encodeURIComponent(cp.tx)}" target="_blank" rel="noopener">its add ↗</a></small>` : ""}</span>
      <span class="lc-m" data-k="Opened">${p.first ? esc(hm(p.first.openedAt)) : ""}</span>
      <span class="lc-m" data-k="Closed">${p.closedAt ? esc(hm(p.closedAt)) : "open"}</span>
      <span class="lc-src"><span>${rg}</span><small>fees ${usd(p.feesTotalUsd)} est.${m ? ` · IL ${signed(m.ilUsd)}` : ""}</small></span>
      <span class="lc-n">${val != null ? usd(val) : ""}</span></div>`;
  };
  root.innerHTML = `<div class="lc">
    <section class="b-step"><div class="b-sech"><h3>Wallets it copies</h3><small>${int(wallets.length)}</small></div>${sub ? `<p class="lc-sub">${sub}</p>` : ""}${walletsHtml}</section>
    <section class="b-step"><div class="b-sech"><h3>Copied moves</h3><small>${int(fills.length)}</small></div>
      ${fills.length ? `<div class="lc-tbl lc-moves"><div class="lc-th"><span>Agent</span><span>Move</span><span>Pool</span><span>The wallet's move</span><span class="lc-n">Reaction</span><span class="lc-n">Paper</span></div>${fills.map(moveRow).join("")}</div>`
        : `<div class="b-none">No move copied yet. LP wallets can sit still for hours; every add and remove they make from now on shows up here next to their own transaction.</div>`}
    </section>
    <section class="b-step"><div class="b-sech"><h3>Positions</h3><small>${int(positions.filter((p) => p.status === "open").length)} open</small></div>
      ${positions.length ? `<div class="lc-tbl lc-pos"><div class="lc-th"><span>Pool</span><span>Copied from</span><span>Opened</span><span>Closed</span><span>Range</span><span class="lc-n">Value</span></div>${positions.map(posRow).join("")}</div>`
        : `<div class="b-none">No position yet.</div>`}
      <p class="b-note" style="margin-top:12px">${SHIELD}<span>Paper positions marked every minute at Jupiter's prices. Fees are an estimate from each pool's fee APR while in range; IL is against holding what each position opened with.</span></p>
    </section>
  </div>`;
}
