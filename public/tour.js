// Tooltip tours (ask2049-notes/PROMPT-tooltip-tour.md): a spotlight on one element at a time and a small card next to it.
// "chat" runs on the Chat home and ends on the Agents rail item ("Click here to try Agents"); "agents" runs on the Agents home.
// Each runs once per browser on its own; startTour(name, { force: true }) replays it (the top bar's "?").
// A step's element is waited for (up to 2 s) and scrolled into view; a step whose element never shows is skipped. No glow, no
// blur: the page around the element is dimmed and outlined. Self-contained: own styles (prefix tr-), the page's color tokens.
const STEPS = {
  chat: [
    { at: () => document.querySelector("#composerHome"), t: "Ask anything on-chain", b: "Wallets, tokens, trades, payments. Every answer shows its sources.", place: "bottom" },
    { at: () => document.querySelector("#cats"), t: "Pick a topic", b: "Ideas built from live data.", place: "top" },
    { at: () => document.querySelector("#sugs .sug") ? document.querySelector("#sugs") : null, t: "Or start here", b: "Live questions, one click to ask.", place: "top" },
    { at: () => vis("#railTrade"), t: "Trade", b: "Swap on Solana and EVM chains. Your wallet signs.", place: "right" },
    { at: () => vis("#railWallet"), t: "Your wallet", b: "Deposit, withdraw, convert. Sign-in by Privy.", place: "right" },
    { at: () => vis('nav.rail a[href="/developer/reference"]'), t: "Docs", b: "Every tool is an API. An agent in three calls.", place: "right" },
    { at: () => vis("#railBots"), t: "Agents", b: "Trading agents from one sentence, with receipts.", place: "right", cta: "Click here to try Agents", always: true },
  ],
  agents: [
    { at: () => document.querySelector("#agAuto .at-card"), t: "Auto-trade", b: "Your agents trade from your wallet. One signature, your limits.", place: "bottom" },
    { at: () => document.querySelector("#agHero:not(.ag-load)"), t: "Live numbers", b: "Agents, trades, skips and PnL, all live.", place: "bottom" },
    { at: () => document.querySelector("#agTape")?.closest(".ag-panel"), t: "Live tape", b: "Each fill traced to the wallet it copied. Skips say why.", place: "top" },
    { at: () => document.querySelector("#agSmart")?.closest(".ag-panel"), t: "Smart money", b: "What the day's best wallets bought in 15 minutes.", place: "top" },
    { at: () => vis('.b-nav [data-go="traders"]'), t: "Who to follow", b: "Wallets ranked by real profit, bots filtered out.", place: "bottom" },
    { at: () => vis('.b-nav [data-go="lps"]'), t: "Smart LPs", b: "LPs judged from their first deposit, traps dropped.", place: "bottom" },
    { at: () => document.querySelector("#agBoardS"), t: "Leaderboard", b: "Copy any agent in one click.", place: "top" },
    { at: () => document.querySelector("#mkS"), t: "Marketplace", b: "Profitable agents for sale. Copy with x402.", place: "top" },
    { at: () => vis('.b-nav [data-go="create"]'), t: "Build your own", b: "Copy a trader, an LP, or describe it in words.", place: "bottom", cta: "Got it", always: true },
  ],
};
const KEY = (n) => `ask2049_tour_${n}`;
/** the element when it is on screen; false when it exists but is hidden (the rail on a phone: skip at once); null when not yet rendered */
const vis = (sel) => { const el = document.querySelector(sel); return !el ? null : el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" ? el : false; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phone = () => matchMedia("(max-width: 640px)").matches;

export function tourSeen(name) { try { return localStorage.getItem(KEY(name)) === "1"; } catch { return false; } }
function markSeen(name) { try { localStorage.setItem(KEY(name), "1"); } catch { /* private mode: it shows again next time */ } }

let T = null; // { name, steps, i, el, opts, dom: { ov, spot, card }, seq }
export const tourActive = (name) => !!T && (!name || T.name === name);

/** Start a tour (once per browser unless force). opts.onCta(): what the last step's button does after the tour closes. */
export async function startTour(name, opts = {}) {
  if (!STEPS[name] || (!opts.force && tourSeen(name)) || (T && T.name === name)) return false;
  if (T) endTour(true);
  injectStyle();
  const ov = Object.assign(document.createElement("div"), { className: "tr-ov" });
  const spot = Object.assign(document.createElement("div"), { className: "tr-spot" });
  const card = Object.assign(document.createElement("div"), { className: "tr-card" });
  card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite");
  document.body.append(ov, spot, card);
  T = { name, steps: STEPS[name], i: -1, el: null, opts, dom: { ov, spot, card }, seq: 0 };
  ov.addEventListener("click", (e) => e.stopPropagation());
  card.addEventListener("click", onCard);
  addEventListener("keydown", onKey, true);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  await show(0, 1);
  return true;
}

/** Close the tour; seen = true marks it done (Skip, Esc, the end, a view change). */
export function endTour(seen = true) {
  if (!T) return;
  const { name, dom } = T;
  if (seen) markSeen(name);
  removeEventListener("keydown", onKey, true);
  removeEventListener("resize", place);
  removeEventListener("scroll", place, true);
  dom.ov.remove(); dom.spot.remove(); dom.card.remove();
  T = null;
}

async function show(i, dir) {
  if (!T) return;
  const seq = ++T.seq, steps = T.steps;
  T.dom.card.classList.add("tr-wait");
  for (; i >= 0 && i < steps.length; i += dir) {
    let el = null;
    for (let k = 0; k < 20 && !el; k++) {
      const r = steps[i].at();
      if (r === false) break; // there but hidden: no waiting
      el = r || null;
      if (!el) await sleep(100);
      if (!T || seq !== T.seq) return;
    }
    if (el || steps[i].always) {
      T.i = i; T.el = el;
      if (el) { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); await sleep(60); }
      if (!T || seq !== T.seq) return;
      paint(); place();
      return;
    }
  }
  if (i >= steps.length) finish(); else if (T.i < 0) show(0, 1);
}

function paint() {
  const s = T.steps[T.i], n = T.steps.length, last = T.i === n - 1;
  T.dom.card.classList.remove("tr-wait");
  T.dom.card.innerHTML = `<div class="tr-top"><span class="tr-n">${T.i + 1} / ${n}</span><button type="button" class="tr-skip" data-tr="skip">Skip</button></div>
    <b class="tr-t">${esc(s.t)}</b><p class="tr-b">${esc(s.b)}</p>
    <div class="tr-act">${T.i > 0 ? `<button type="button" class="tr-btn" data-tr="back">Back</button>` : "<span></span>"}<button type="button" class="tr-btn tr-go" data-tr="${last ? "end" : "next"}">${esc(last ? s.cta ?? "Done" : "Next")}</button></div>`;
  T.dom.card.setAttribute("aria-label", s.t);
  requestAnimationFrame(() => T?.dom.card.querySelector('[data-tr="next"],[data-tr="end"]')?.focus({ preventScroll: true }));
}

function place() {
  if (!T || T.i < 0) return;
  const { spot, card } = T.dom, el = T.el, s = T.steps[T.i], pad = 6, gap = 14;
  const W = innerWidth, H = innerHeight;
  if (!el || !el.isConnected) {
    spot.style.cssText = `left:${W / 2}px;top:${H / 2}px;width:0;height:0`; // nothing to point at: a centred card on the dim
    if (!phone()) card.style.cssText = `left:${Math.max(16, (W - card.offsetWidth) / 2)}px;top:${Math.max(16, (H - card.offsetHeight) / 2)}px`;
    else card.style.cssText = "";
    return;
  }
  const r = el.getBoundingClientRect();
  spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px`;
  if (phone()) { card.style.cssText = ""; return; } // docked at the bottom by CSS
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x, y;
  const fitsBelow = r.bottom + pad + gap + ch < H - 8, fitsAbove = r.top - pad - gap - ch > 8;
  if (s.place === "right" && r.right + pad + gap + cw < W - 8) { x = r.right + pad + gap; y = r.top + r.height / 2 - ch / 2; }
  else if ((s.place === "top" && fitsAbove) || (!fitsBelow && fitsAbove)) { x = r.left; y = r.top - pad - gap - ch; }
  else if (fitsBelow) { x = r.left; y = r.bottom + pad + gap; }
  else { x = r.left; y = H - ch - 16; }
  x = Math.max(16, Math.min(x, W - cw - 16)); y = Math.max(16, Math.min(y, H - ch - 16));
  card.style.cssText = `left:${x}px;top:${y}px`;
}

function finish() {
  const cta = T?.opts?.onCta;
  endTour(true);
  if (cta) setTimeout(cta, 0);
}
function onCard(e) {
  const b = e.target.closest("[data-tr]"); if (!b || !T) return;
  const a = b.dataset.tr;
  if (a === "skip") return endTour(true);
  if (a === "back") return show(T.i - 1, -1);
  if (a === "next") return show(T.i + 1, 1);
  if (a === "end") return finish();
}
function onKey(e) {
  if (!T) return;
  if (e.key === "Escape") { e.preventDefault(); endTour(true); }
  else if (e.key === "ArrowRight") { e.preventDefault(); T.i === T.steps.length - 1 ? finish() : show(T.i + 1, 1); }
  else if (e.key === "ArrowLeft" && T.i > 0) { e.preventDefault(); show(T.i - 1, -1); }
}

function injectStyle() {
  if (document.getElementById("tr-style")) return;
  const s = document.createElement("style");
  s.id = "tr-style";
  s.textContent = `
.tr-ov { position: fixed; inset: 0; z-index: 9990; }
.tr-spot { position: fixed; z-index: 9991; border-radius: 12px; pointer-events: none; box-shadow: 0 0 0 2px var(--hi, #14F195), 0 0 0 9999px rgba(6, 6, 12, .62); transition: left .22s ease, top .22s ease, width .22s ease, height .22s ease; }
.tr-card { position: fixed; z-index: 9992; width: 320px; max-width: calc(100vw - 32px); display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 14px; border: 1px solid var(--border, #2d2a38); border-radius: 14px; background: var(--card, #121119); color: var(--fg, #f2f0fa); box-shadow: 0 10px 30px rgba(0, 0, 0, .35); transition: left .22s ease, top .22s ease, opacity .15s; }
.tr-card.tr-wait { opacity: 0; }
.tr-top { display: flex; align-items: center; justify-content: space-between; }
.tr-n { font: 500 12px/1 "Geist Mono", ui-monospace, monospace; letter-spacing: .06em; color: var(--muted-fg, #9a97a6); }
.tr-skip { padding: 2px 4px; border: 0; background: none; color: var(--muted-fg, #9a97a6); font: inherit; font-size: 13px; cursor: pointer; }
.tr-skip:hover { color: var(--fg, #f2f0fa); }
.tr-t { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
.tr-b { margin: 0; font-size: 14px; line-height: 1.45; color: var(--muted-fg, #b8b5c6); }
.tr-act { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; }
.tr-btn { height: 34px; padding: 0 14px; border: 1px solid var(--border, #2d2a38); border-radius: 10px; background: transparent; color: var(--fg, #f2f0fa); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.tr-btn:hover { background: var(--muted, rgba(127, 127, 127, .12)); }
.tr-go { border: 0; background: var(--primary, #14F195); color: var(--primary-fg, #0b0a12); font-weight: 600; }
.tr-go:hover { background: var(--primary, #14F195); filter: brightness(1.05); }
.tr-btn:focus-visible, .tr-skip:focus-visible { outline: 2px solid var(--purple, #b98cff); outline-offset: 2px; }
@media (max-width: 640px) {
  .tr-card { left: 16px !important; right: 16px; top: auto !important; bottom: 16px; width: auto; }
}
@media (prefers-reduced-motion: reduce) { .tr-spot, .tr-card { transition: none; } }`;
  document.head.append(s);
}
