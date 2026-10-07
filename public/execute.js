// Execute an agent's signal for real, semi-auto and non-custodial (ask2049-notes/PROMPT-agents-marketplace.md C).
// mountExecute(root, deps) lists the agent's open signals (its filled BUY / SELL fills younger than 2 minutes, polled every
// 5 s), each with Sign & execute: the server quotes on Jupiter and simulates on NOWNodes, the person's own wallet signs here,
// the server sends through NOWNodes and follows the status there. Nothing is signed or sent without the wallet's prompt.
// Auto-trade (src/autoTrade.ts) sits on top: once the person grants a Privy session signer on their Chord account's Solana
// wallet and sets limits, every BUY / SELL of an agent marked auto-execute is executed for them, within those limits.
// Self-contained: its own styles (class prefix ex-), injected once.
//   deps: { botId, session: string | () => string, api?(path, opts), wallet?: Wallet | null | () => Wallet | null, onDone?(execution) }
//   wallet omitted = pageSolanaWallet() at every render (the Chord account's Solana wallet, else a connected extension).
//   Wallet = { address, label?, signTransaction(base64) → Promise<signed base64> }
const API = "/v1/agents/execute";
const AUTO = "/v1/agents/auto";
const AUTO_DEFAULTS = { perTradeUsd: "5", dailyUsd: "25", slippagePct: "1", days: "7" };
const SIGNAL_MS = 120_000;
const POLL_MS = 5_000;
const SOLSCAN = "https://solscan.io/tx/";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const WEB3 = "https://esm.sh/@solana/web3.js@1.98.0?bundle";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s) => (s && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? "");
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const cancelled = (e) => e?.code === 4001 || /user rejected|rejected the request|denied|exited|cancel/i.test(e?.message ?? "");
const toMs = (t) => (Number(t) < 1e12 ? Number(t) * 1000 : Number(t));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const amt = (x) => { const n = Number(x); if (!Number.isFinite(n)) return esc(x); return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : n.toPrecision(4).replace(/0+$/, "").replace(/\.$/, ""); };
const usd = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
const symOf = (f) => (f.symbol ? String(f.symbol).replace(/^\$/, "") : short(f.mint));
const ago = (ms) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);
const left = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`; };
const venue = (v) => String(v).replace(/_\d+$/, "");
const ICON = {
  done: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`,
  bad: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`,
  now: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" /></svg>`,
};

const extensions = () => [["Phantom", window.phantom?.solana], ["Solflare", window.solflare], ["Backpack", window.backpack]].filter(([, p]) => p);

/** The Solana wallet this page can sign with right now: the Chord account's embedded wallet (Privy), else a browser
 *  extension that is already connected (Phantom, Solflare, Backpack). Same signing path as the Trade view. Null = none. */
export function pageSolanaWallet() {
  const pv = window.askPrivy?.state;
  if (pv?.authenticated && pv.sol) {
    return { address: pv.sol, label: "Chord wallet", signTransaction: async (b64) => bytesToB64(await window.askPrivy.signSol(b64ToBytes(b64))) };
  }
  for (const [name, p] of extensions()) {
    const key = p.isConnected === false ? null : p.publicKey?.toString?.();
    if (!key) continue;
    return {
      address: key, label: name,
      signTransaction: async (b64) => {
        const web3 = await import(WEB3);
        const tx = web3.VersionedTransaction.deserialize(b64ToBytes(b64));
        return bytesToB64((await p.signTransaction(tx)).serialize());
      },
    };
  }
  return null;
}

const STYLE = `
.ex { display: flex; flex-direction: column; gap: 10px; min-width: 0; margin-top: 16px; }
.ex-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ex-head { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 2px 8px; }
.ex-head h3 { margin: 0; font-size: 16.5px; font-weight: 600; }
.ex-head small { font-size: 12.5px; color: var(--muted-fg, #9a97a6); }
.ex-note { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 12px 14px; border: 1px solid var(--border, #2d2a38); border-radius: 12px; background: var(--card, transparent); font-size: 14px; color: var(--muted-fg, #9a97a6); }
.ex-note > span { flex: 1 1 220px; min-width: 0; }
.ex-note > .ex-pill { flex: none; }
.ex-note b { color: var(--fg, inherit); font-weight: 500; }
.ex-note.ex-off { align-items: flex-start; border-style: dashed; background: transparent; font-size: 13.5px; line-height: 1.5; }
.ex-pill { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 22px; padding: 0 9px; border: 1px solid var(--border, #2d2a38); border-radius: 999px; font: 500 11.5px "Geist Mono", monospace; color: var(--fg, inherit); white-space: nowrap; }
.ex-pill i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-fg, #9a97a6); }
.ex-note.ex-sk { flex-direction: column; align-items: stretch; gap: 8px; }
.ex-note.ex-sk .b-skel { flex: none; height: 12px; border-radius: 6px; }
.ex-note.ex-sk .b-skel + .b-skel { width: 60%; }
.ex-list { display: flex; flex-direction: column; gap: 8px; }
.ex-row { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--border, #2d2a38); border-radius: 12px; background: var(--card, transparent); }
.ex-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ex-side { flex: none; width: 44px; padding: 2px 0; border-radius: 6px; text-align: center; font: 600 10.5px/1.6 "Geist Mono", ui-monospace, monospace; letter-spacing: .05em; }
.ex-side.buy { color: var(--hi, #14F195); background: color-mix(in srgb, var(--hi, #14F195) 13%, transparent); }
.ex-side.sell { color: var(--bad, #e5534b); background: color-mix(in srgb, var(--bad, #e5534b) 13%, transparent); }
.ex-what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ex-what b { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ex-what small { font-size: 12.5px; color: var(--muted-fg, #9a97a6); }
.ex-left { flex: none; font: 12.5px "Geist Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--muted-fg, #9a97a6); }
.ex-left.soon { color: var(--bad, #e5534b); }
.ex-act { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ex-amt { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px; border: 1px solid var(--border, #2d2a38); border-radius: 10px; background: var(--bg, transparent); }
.ex-amt:focus-within { border-color: var(--purple, #b98cff); }
.ex-amt input { width: 60px; min-width: 0; border: 0; outline: 0; background: transparent; font: 14px "Geist Mono", ui-monospace, monospace; text-align: right; color: var(--fg, inherit); }
.ex-amt span { font-size: 12.5px; color: var(--muted-fg, #9a97a6); }
.ex-sub { flex: 1 1 160px; min-width: 0; font-size: 13px; color: var(--muted-fg, #9a97a6); }
.ex-go { margin-left: auto; height: 36px; padding: 0 14px; border: 0; border-radius: 10px; background: var(--primary, #14F195); color: var(--primary-fg, #0b0a12); font-size: 14px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.ex-go:disabled { opacity: .5; cursor: default; }
.ex-btn { height: 32px; padding: 0 12px; border: 1px solid var(--border, #2d2a38); border-radius: 10px; background: transparent; font-size: 13.5px; font-weight: 500; white-space: nowrap; cursor: pointer; }
.ex-btn:hover { background: var(--muted, rgba(127,127,127,.12)); }
.ex-steps { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 10px 0 0; border-top: 1px solid var(--border-soft, rgba(127,127,127,.2)); list-style: none; font-size: 13.5px; }
.ex-steps li { display: flex; align-items: flex-start; gap: 8px; line-height: 1.45; min-width: 0; overflow-wrap: anywhere; }
.ex-steps li svg { flex: none; width: 16px; height: 16px; margin-top: 2px; }
.ex-steps li.done svg { color: var(--hi, #14F195); }
.ex-steps li.bad { color: var(--bad, #e5534b); }
.ex-steps li.now svg { color: var(--muted-fg, #9a97a6); animation: ex-spin .9s linear infinite; }
.ex-steps small { display: block; color: var(--muted-fg, #9a97a6); font-size: 12.5px; }
.ex a { color: var(--purple, #b98cff); text-decoration: none; }
.ex a:hover { text-decoration: underline; }
.ex .ex-mono { font-family: "Geist Mono", ui-monospace, monospace; }
.ex-hist { display: flex; flex-direction: column; border: 1px solid var(--border, #2d2a38); border-radius: 12px; overflow: hidden; }
.ex-hist h4 { margin: 0; padding: 10px 14px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--border-soft, rgba(127,127,127,.2)); }
.ex-hrow { display: grid; grid-template-columns: 56px 44px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 9px 14px; font-size: 13px; }
.ex-hrow + .ex-hrow { border-top: 1px solid var(--border-soft, rgba(127,127,127,.2)); }
.ex-hrow .t { font: 12.5px "Geist Mono", ui-monospace, monospace; color: var(--muted-fg, #9a97a6); }
.ex-hrow .w { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-st { font: 600 11px/1.6 "Geist Mono", ui-monospace, monospace; letter-spacing: .03em; color: var(--muted-fg, #9a97a6); }
.ex-st.ok { color: var(--hi, #14F195); }
.ex-st.bad { color: var(--bad, #e5534b); }
.ex-auto { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--border, #2d2a38); border-radius: 12px; background: var(--card, transparent); }
.ex-ahead { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
.ex-ahead b { font-size: 14.5px; font-weight: 600; }
.ex-ahead small { font-size: 12.5px; color: var(--muted-fg, #9a97a6); }
.ex-pill.on i { background: var(--hi, #14F195); }
.ex-pill.warn i { background: var(--bad, #e5534b); }
.ex-form { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 8px; }
.ex-fld { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; color: var(--muted-fg, #9a97a6); }
.ex-fld .ex-amt input { width: 52px; }
.ex-why { font-size: 13px; line-height: 1.45; color: var(--muted-fg, #9a97a6); overflow-wrap: anywhere; }
.ex-why.bad { color: var(--bad, #e5534b); }
.ex-row2 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; font-size: 13.5px; }
.ex-tog { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.ex-tog input { appearance: none; position: relative; width: 32px; height: 18px; margin: 0; border-radius: 999px; background: var(--muted, rgba(127,127,127,.3)); cursor: pointer; transition: background .15s; }
.ex-tog input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--fg, #fff); transition: transform .15s; }
.ex-tog input:checked { background: var(--hi, #14F195); }
.ex-tog input:checked::after { transform: translateX(14px); background: var(--primary-fg, #0b0a12); }
.ex-tog input:disabled { opacity: .5; cursor: default; }
.ex-meter { flex: 1 1 140px; min-width: 120px; display: flex; flex-direction: column; gap: 4px; font: 12.5px "Geist Mono", ui-monospace, monospace; color: var(--muted-fg, #9a97a6); }
.ex-meter span:first-child b { color: var(--fg, inherit); font-weight: 500; }
.ex-bar { height: 4px; border-radius: 2px; background: var(--muted, rgba(127,127,127,.2)); overflow: hidden; }
.ex-bar i { display: block; height: 100%; background: var(--hi, #14F195); }
.ex-off2 { margin-left: auto; }
.ex-runs { display: flex; flex-direction: column; border-top: 1px solid var(--border-soft, rgba(127,127,127,.2)); }
.ex-runs .ex-hrow { padding: 8px 0; }
@keyframes ex-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) {
  .ex-go { flex: 1 0 100%; margin-left: 0; height: 40px; }
  .ex-amt { flex: 1 1 auto; }
  .ex-amt input { flex: 1; width: auto; }
  .ex-hrow { grid-template-columns: 44px minmax(0, 1fr) auto auto; }
  .ex-hrow .t { display: none; }
}
`;
function injectStyle() {
  if (document.getElementById("ex-style")) return;
  const s = document.createElement("style");
  s.id = "ex-style";
  s.textContent = STYLE;
  document.head.append(s);
}

/** Render the agent's open signals inside `root` with Sign & execute. Returns { refresh, destroy }. */
export function mountExecute(root, deps = {}) {
  injectStyle();
  const D = deps;
  const st = { lane: null, laneMsg: "", type: null, fills: [], execs: [], cards: new Map(), loaded: false, loadErr: null, skew: 0, sig: "", walletAddr: undefined, stopped: false,
    auto: null, autoBusy: null, autoErr: null, autoNote: null, autoForm: { ...AUTO_DEFAULTS } };
  const now = () => Date.now() + st.skew;
  const wallet = () => (typeof D.wallet === "function" ? D.wallet() : D.wallet === undefined ? pageSolanaWallet() : D.wallet);
  const busy = () => [...st.cards.values()].some((c) => ["preparing", "signing", "sending"].includes(c.phase));

  root.classList.add("ex");
  root.innerHTML = `<div class="ex-head"><h3>Execute</h3><details class="ag-i"><summary aria-label="About execution" title="About execution"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/></svg></summary><div class="ag-ip">On-chain, semi-auto and non-custodial: your wallet signs each swap. Quoted on Jupiter, simulated and sent through NOWNodes. Each new BUY or SELL from this agent can be executed for 2 minutes.</div></details></div><div class="ex-body"></div>`;
  const body = root.querySelector(".ex-body");

  async function call(method, path, payload, headers = {}) {
    const s = typeof D.session === "function" ? D.session() : D.session;
    if (!s && typeof D.api === "function") {
      try { return { ok: true, status: 200, j: await D.api(path, { method, body: payload }) }; }
      catch (e) { const m = e?.message ?? String(e); return { ok: false, status: 0, j: { message: m, error: /NOWNodes key not set/i.test(m) ? "nownodes_off" : undefined } }; }
    }
    let r;
    try {
      r = await fetch(path, { method, headers: { ...(s ? { "X-Session": s } : {}), ...(payload ? { "Content-Type": "application/json" } : {}), ...headers }, body: payload ? JSON.stringify(payload) : undefined });
    } catch { return { ok: false, status: 0, j: { message: "Connection lost. Check your network and try again." } }; }
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, j: j ?? { message: `The server answered ${r.status}.` }, date: r.headers.get("date") };
  }

  // ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function load() {
    if (st.stopped) return;
    if (!root.isConnected) { if (st.loaded) destroy(); return; }
    if (document.visibilityState === "hidden" && st.loaded) return;
    const [a, m, au] = await Promise.all([call("GET", `/v1/agents/${encodeURIComponent(D.botId)}`), call("GET", `${API}/mine?botId=${encodeURIComponent(D.botId)}`),
      call("GET", `${AUTO}/status?botId=${encodeURIComponent(D.botId)}`)]);
    if (a.ok) {
      const srv = a.date ? Date.parse(a.date) : NaN;
      if (Number.isFinite(srv) && Math.abs(srv - Date.now()) > 5_000) st.skew = srv - Date.now();
      st.type = a.j.bot?.type ?? null;
      st.fills = (a.j.fills ?? []).filter((f) => f.status === "filled" && (f.side === "buy" || f.side === "sell") && !f.kind);
      st.loadErr = null;
    } else st.loadErr = a.j?.message ?? "could not load this agent";
    if (m.ok) {
      st.lane = !!m.j.lane?.on;
      st.laneMsg = m.j.lane?.message ?? "";
      st.execs = m.j.executions ?? [];
    }
    if (au.ok) st.auto = au.j;
    st.loaded = true;
    paint();
  }

  const execOf = (fillId) => st.execs.find((e) => e.fillId === fillId && e.status !== "failed") ?? null;
  function visible() {
    const t = now();
    const active = (id) => (st.cards.get(id)?.phase ?? "idle") !== "idle";
    const rows = st.fills.filter((f) => t - toMs(f.ts) < SIGNAL_MS || active(f.id) || (execOf(f.id) && t - execOf(f.id).at < 10 * 60_000));
    for (const c of st.cards.values()) if (c.phase !== "idle" && !rows.some((f) => f.id === c.fill.id)) rows.push(c.fill);
    return rows.sort((x, y) => toMs(y.ts) - toMs(x.ts)).slice(0, 8);
  }

  // ── render ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function step(state, html) { return `<li class="${state}">${ICON[state]}<span>${html}</span></li>`; }
  function quoteLine(p) {
    const q = p.quote, imp = q.priceImpactPct;
    const route = q.route?.length ? [...new Set(q.route.map(venue))].join(" › ") : "direct";
    const what = p.side === "sell" && p.sell ? `${p.sell.pct}% of your ${amt(p.sell.walletBalance)} ${esc(q.inToken.symbol)}: ` : "";
    return `Jupiter: ${what}<span class="ex-mono">${amt(q.inAmount)}</span> ${esc(q.inToken.symbol)} → <span class="ex-mono">${amt(q.outAmount)}</span> ${esc(q.outToken.symbol)}`
      + `<small>Minimum ${amt(q.minOutAmount)} ${esc(q.outToken.symbol)} · impact ${imp == null ? "n/a" : `${imp < 0.01 ? "<0.01" : imp.toFixed(2)}%`} · ${esc(route)}</small>`;
  }
  function stepsOf(c) {
    const out = [];
    const p = c.prep;
    if (c.phase === "preparing") return [step("now", "Quoting on Jupiter, simulating on NOWNodes")];
    if (p) {
      out.push(step("done", quoteLine(p)));
      const s = p.simulation;
      out.push(s.ok
        ? step("done", `Simulated on NOWNodes: OK${s.unitsConsumed ? `<small>${Number(s.unitsConsumed).toLocaleString("en-US")} compute units</small>` : ""}`)
        : step("bad", `Simulated on NOWNodes: failed: ${esc(s.err)}${s.hint ? `<small>${esc(s.hint)}</small>` : ""}`));
    }
    if (c.phase === "signing") out.push(step("now", `Confirm in your ${esc(c.walletLabel ?? "wallet")}`));
    if (["sending", "waiting", "done"].includes(c.phase) || (c.phase === "error" && c.signed)) out.push(step("done", `Signed in your ${esc(c.walletLabel ?? "wallet")}`));
    if (c.phase === "sending") out.push(step("now", "Sending through NOWNodes"));
    if (c.sig) out.push(step("done", `Sent through NOWNodes · <a href="${SOLSCAN}${esc(c.sig)}" target="_blank" rel="noopener" class="ex-mono">${esc(short(c.sig))} ↗</a>`));
    if (c.phase === "waiting") out.push(step("now", "Waiting for Solana to confirm"));
    if (c.phase === "done") out.push(step("done", `${c.status === "finalized" ? "Finalized" : "Confirmed"} on Solana · <a href="${SOLSCAN}${esc(c.sig)}" target="_blank" rel="noopener">View on Solscan ↗</a>`));
    if (c.phase === "error" && c.err) out.push(step("bad", esc(c.err)));
    return out;
  }
  function rowHtml(f, w) {
    const t = now(), age = t - toMs(f.ts), fresh = age < SIGNAL_MS;
    const c = st.cards.get(f.id), ex = execOf(f.id);
    const sell = f.side === "sell";
    const who = sell ? `Agent sold for ${usd(f.usd)}` : `Agent bought ${usd(f.usd)}`;
    const head = `<div class="ex-top"><span class="ex-side ${sell ? "sell" : "buy"}">${sell ? "SELL" : "BUY"}</span>
      <div class="ex-what"><b>${esc(symOf(f))}</b><small>${who} · ${ago(age)}</small></div>
      ${fresh && !ex ? `<span class="ex-left${SIGNAL_MS - age < 20_000 ? " soon" : ""}" data-deadline="${toMs(f.ts) + SIGNAL_MS}">${left(SIGNAL_MS - age)}</span>` : ""}</div>`;
    // auto-trade has taken this signal and it is not done yet: no manual button (one signal, one execution)
    const ar = autoRunOf(f.id);
    if (!ex && ar && ["queued", "running", "sent"].includes(ar.outcome) && (!c || c.phase === "idle")) {
      return `<div class="ex-row" data-row="${esc(f.id)}">${head}<ol class="ex-steps">${step("now", ar.outcome === "sent" ? "Auto-trade sent it through NOWNodes, waiting for Solana" : "Auto-trade is executing it from your Chord wallet")}</ol></div>`;
    }
    // already executed (this session or an earlier one) and nothing running here
    if (ex && (!c || c.phase === "idle")) {
      const ok = ex.status === "confirmed" || ex.status === "finalized";
      return `<div class="ex-row" data-row="${esc(f.id)}">${head}<ol class="ex-steps">${step(ok ? "done" : "now", `${ok ? "Executed" : "Sent"} from ${esc(short(ex.wallet))} through NOWNodes: ${esc(ex.status)} · <a href="${SOLSCAN}${esc(ex.signature)}" target="_blank" rel="noopener">View on Solscan ↗</a>`)}</ol></div>`;
    }
    const phase = c?.phase ?? "idle";
    const running = ["preparing", "signing", "sending", "waiting"].includes(phase);
    const retry = phase === "error" || phase === "simfail";
    let act = "";
    if (phase !== "done" && !running && fresh && w) { // no wallet: the note above the list says what to do
      const input = sell
        ? `<span class="ex-sub" title="${f.mint === SOL_MINT ? "Sells native SOL in the share the agent sold, keeping 0.01 SOL for fees" : `Sells your ${esc(symOf(f))} in the share the agent sold`}">Same share</span>`
        : `<label class="ex-amt" title="USDC to spend"><input data-usd="${esc(f.id)}" inputmode="decimal" autocomplete="off" aria-label="USDC to spend" value="${esc(c?.usd ?? String(Number(f.usd.toFixed(2))))}"><span>USDC</span></label>`;
      act = `<div class="ex-act">${input}<button type="button" class="ex-go" data-ex="go" data-id="${esc(f.id)}"${busy() ? " disabled" : ""}>${retry ? "Try again" : "Sign &amp; execute"}</button></div>`;
    } else if (retry && !fresh) act = `<div class="ex-act"><span class="ex-sub" title="A signal can be executed for 2 minutes">Expired</span></div>`;
    const steps = c && phase !== "idle" ? `<ol class="ex-steps">${stepsOf(c).join("")}</ol>` : "";
    return `<div class="ex-row" data-row="${esc(f.id)}">${head}${act}${steps}</div>`;
  }
  function historyHtml() {
    const rows = st.execs.slice(0, 5);
    if (!rows.length) return "";
    const tm = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `<div class="ex-hist"><h4>Executed</h4>${rows.map((e) => {
      const ok = e.status === "confirmed" || e.status === "finalized", bad = e.status === "failed";
      const what = e.side === "buy" ? `${e.inAmount ? `${amt(e.inAmount)} USDC → ` : ""}${esc(e.symbol ?? short(e.mint))}` : `${esc(e.symbol ?? short(e.mint))}${e.outAmount ? ` → ${amt(e.outAmount)} USDC` : ""}`;
      return `<div class="ex-hrow"><span class="t">${tm(e.at)}</span><span class="ex-side ${e.side === "sell" ? "sell" : "buy"}">${e.side === "sell" ? "SELL" : "BUY"}</span><span class="w" title="${esc(e.err ?? (e.mode === "auto" ? "Executed by auto-trade" : ""))}">${what}${e.mode === "auto" ? ` <span class="ex-st">AUTO</span>` : ""}</span><span class="ex-st${ok ? " ok" : bad ? " bad" : ""}">${esc(e.status.toUpperCase())}</span><a href="${SOLSCAN}${esc(e.signature)}" target="_blank" rel="noopener">Solscan ↗</a></div>`;
    }).join("")}</div>`;
  }
  function walletNote() {
    const pv = window.askPrivy?.state;
    const btns = [];
    if (pv?.authenticated && !pv.sol) btns.push(`<button type="button" class="ex-btn" data-ex="create">Create your Solana wallet</button>`);
    else if (window.askPrivy && !pv?.authenticated) btns.push(`<button type="button" class="ex-btn" data-ex="signin">Sign in</button>`);
    for (const [name] of extensions()) btns.push(`<button type="button" class="ex-btn" data-ex="connect" data-w="${esc(name)}">Connect ${esc(name)}</button>`);
    return `<div class="ex-note"><span title="It signs each swap itself; this app never holds keys or funds."><b>Connect a Solana wallet</b></span>${btns.join("")}</div>`;
  }
  // ── auto-trade ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const autoRunOf = (fillId) => (st.auto?.recent ?? []).find((r) => r.fillId === fillId) ?? null;
  const OUT = { queued: "QUEUED", running: "RUNNING", sent: "SENT", confirmed: "CONFIRMED", failed: "FAILED", refused: "SKIPPED" };
  const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  function autoRunsHtml() {
    const rows = (st.auto?.recent ?? []).slice(0, 5);
    if (!rows.length) return "";
    const tm = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `<div class="ex-runs">${rows.map((r) => {
      const sym = r.symbol ? String(r.symbol).replace(/^\$/, "") : short(r.mint);
      const what = r.side === "buy" ? `${r.usd != null ? `${usd(r.usd)} → ` : ""}${esc(sym)}` : `${esc(sym)}${r.usd != null ? ` → ${usd(r.usd)}` : ""}`;
      const ok = r.outcome === "confirmed", bad = r.outcome === "failed" || r.outcome === "refused";
      const link = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Solscan ↗</a>` : `<span></span>`;
      return `<div class="ex-hrow"><span class="t">${tm(r.at)}</span><span class="ex-side ${r.side === "sell" ? "sell" : "buy"}">${r.side === "sell" ? "SELL" : "BUY"}</span><span class="w" title="${esc(r.reason ?? "")}">${what}${r.reason ? ` · ${esc(r.reason)}` : ""}</span><span class="ex-st${ok ? " ok" : bad ? " bad" : ""}">${OUT[r.outcome] ?? esc(r.outcome)}</span>${link}</div>`;
    }).join("")}</div>`;
  }
  function autoHtml() {
    const a = st.auto;
    if (!a) return "";
    if (!a.on) return `<div class="ex-note ex-off"><span class="ex-pill"><i></i>Manual only</span><span>${esc(a.message ?? "Auto-trade is not switched on for this server yet")}</span></div>`;
    const g = a.grant, busy = !!st.autoBusy;
    const err = st.autoErr ? `<div class="ex-why bad">${esc(st.autoErr)}</div>` : st.autoNote ? `<div class="ex-why">${esc(st.autoNote)}</div>` : "";
    if (g?.enabled) {
      const pct = g.dailyUsd > 0 ? Math.min(100, (a.spentTodayUsd / g.dailyUsd) * 100) : 0;
      const on = !!a.agent?.autoExecute;
      return `<div class="ex-auto">
        <div class="ex-ahead"><b>Auto-trade</b><span class="ex-pill on"><i></i>On</span><small title="Your Chord account's Solana wallet signs through a session signer, within these limits">${esc(short(g.wallet))} · until ${day(g.expiresAt)}</small>
          <button type="button" class="ex-btn ex-off2" data-ex="auto-off"${busy ? " disabled" : ""} title="Stops auto-trade at once and takes the signer off your wallet">${st.autoBusy === "disabling" ? "Disabling…" : "Disable"}</button></div>
        <div class="ex-row2">
          <label class="ex-tog" title="Each new BUY or SELL of this agent is executed from your wallet within your limits"><input type="checkbox" data-ex="auto-agent"${on ? " checked" : ""}${busy ? " disabled" : ""}><span>Auto-execute</span></label>
          <div class="ex-meter" title="USDC spent by auto buys today (UTC); sells are not counted"><span>Today <b>${usd(a.spentTodayUsd)}</b> of ${usd(g.dailyUsd)}</span><span class="ex-bar"><i style="width:${pct.toFixed(1)}%"></i></span></div>
          <span class="ex-sub">Per trade ${usd(g.perTradeUsd)} · slippage ${(g.slippageBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%</span>
        </div>${err}${autoRunsHtml()}</div>`;
    }
    const pv = window.askPrivy?.state;
    const f = st.autoForm;
    const fld = (k, label, unit, title) => `<label class="ex-fld" title="${esc(title)}">${label}<span class="ex-amt"><input data-af="${k}" inputmode="decimal" autocomplete="off" aria-label="${esc(label)}" value="${esc(f[k])}"><span>${unit}</span></span></label>`;
    const why = g && !g.enabled && g.disabledReason && g.disabledReason !== "switched off" ? `<div class="ex-why bad">Switched off: ${esc(g.disabledReason)}</div>` : "";
    const canSignIn = !!window.askPrivy || !!document.getElementById("signInBtn");
    const btn = !pv?.authenticated ? (canSignIn ? `<button type="button" class="ex-go" data-ex="auto-signin" title="Auto-trade runs on your Chord account's Solana wallet">Sign in</button>` : `<span class="ex-sub">Sign-in is not available here</span>`)
      : `<button type="button" class="ex-go" data-ex="auto-on"${busy ? " disabled" : ""} title="Approve a session signer on your Chord wallet once; this agent then executes on its own within these limits">${st.autoBusy === "approving" ? "Approve in wallet…" : st.autoBusy === "enabling" ? "Enabling…" : "Enable auto-trade"}</button>`;
    return `<div class="ex-auto">
      <div class="ex-ahead"><b>Auto-trade</b><span class="ex-pill"><i></i>Off</span><small>No approval per trade, within your limits</small></div>
      <div class="ex-form">${fld("perTradeUsd", "Per trade", "$", "USDC per trade, 1 to 100")}${fld("dailyUsd", "Per day", "$", "USDC a day, 1 to 500")}${fld("slippagePct", "Slippage", "%", "At most 3%")}${fld("days", "Days", "d", "1 to 30 days, then it switches off")}${btn}</div>${why}${err}${autoRunsHtml()}</div>`;
  }
  function autoLimits() {
    const f = st.autoForm, n = (k) => Number(String(f[k]).replace(/,/g, ""));
    const v = { perTradeUsd: n("perTradeUsd"), dailyUsd: n("dailyUsd"), slippageBps: Math.round(n("slippagePct") * 100), days: n("days") };
    if (!(v.perTradeUsd >= 1 && v.perTradeUsd <= 100)) return { err: "Per trade: 1 to 100 USDC." };
    if (!(v.dailyUsd >= 1 && v.dailyUsd <= 500)) return { err: "Per day: 1 to 500 USDC." };
    if (!(v.slippageBps >= 10 && v.slippageBps <= 300)) return { err: "Slippage: 0.1% to 3%." };
    if (!(Number.isInteger(v.days) && v.days >= 1 && v.days <= 30)) return { err: "Days: a whole number from 1 to 30." };
    return { v };
  }
  async function enableAuto() {
    const pv = window.askPrivy;
    if (!pv?.state?.authenticated) { if (pv) pv.login(); else document.getElementById("signInBtn")?.click(); return; }
    const lim = autoLimits();
    if (lim.err) { st.autoErr = lim.err; return paint(); }
    st.autoBusy = "enabling"; st.autoErr = null; st.autoNote = null; paint();
    try {
      const wallet = pv.state.sol || await pv.ensureSol();
      const body = { ...lim.v, wallet };
      const token = await pv.accessToken();
      if (!token) throw new Error("Sign in again: your session ended.");
      let r = await call("POST", `${AUTO}/enable`, body, { "X-Privy-Token": token });
      // our signer is not on the wallet yet (or not under our policy): approve it in the wallet, then record the limits
      if (!r.ok && r.j?.error === "signer_missing") {
        st.autoBusy = "approving"; paint();
        if (r.j.fix === "replace") await pv.removeSolSigners();
        await pv.addSolSigner(r.j.quorumId, [r.j.policyId]);
        r = await call("POST", `${AUTO}/enable`, body, { "X-Privy-Token": (await pv.accessToken()) ?? token });
      }
      if (!r.ok) throw new Error(r.j?.message ?? "Could not enable auto-trade.");
      const t = await call("POST", `${AUTO}/agents/${encodeURIComponent(D.botId)}`, { on: true });
      if (!t.ok) st.autoErr = t.j?.message ?? null;
    } catch (e) {
      st.autoErr = cancelled(e) ? "Cancelled in the wallet. Auto-trade stays off." : (e?.message ?? String(e));
    }
    st.autoBusy = null;
    await load();
  }
  async function disableAuto() {
    st.autoBusy = "disabling"; st.autoErr = null; paint();
    const r = await call("POST", `${AUTO}/disable`);
    if (!r.ok) { st.autoErr = r.j?.message ?? "Could not switch auto-trade off."; st.autoBusy = null; return paint(); }
    st.autoNote = null;
    if (r.j?.removeSigners) {
      if (window.askPrivy?.state?.authenticated) {
        try { await window.askPrivy.removeSolSigners(); } catch (e) { st.autoNote = `Auto-trade is off. The signer is still on your wallet: ${e?.message ?? e}`; }
      } else st.autoNote = "Auto-trade is off. Sign in to take the signer off your wallet.";
    }
    st.autoBusy = null;
    await load();
  }
  async function toggleAgent(on) {
    st.autoBusy = "toggling"; st.autoErr = null; paint();
    const r = await call("POST", `${AUTO}/agents/${encodeURIComponent(D.botId)}`, { on });
    if (!r.ok) st.autoErr = r.j?.message ?? "Could not change auto-execute.";
    st.autoBusy = null;
    await load();
  }

  function paint() {
    if (st.stopped) return;
    const w = wallet();
    st.walletAddr = w?.address ?? null;
    // keep the caret where it was when the list re-renders under someone typing an amount
    const a = document.activeElement, focus = a && root.contains(a) && (a.dataset?.usd || a.dataset?.af) ? { id: a.dataset.usd, af: a.dataset.af, pos: a.selectionStart } : null;
    let html;
    if (!st.loaded) html = `<div class="ex-note ex-sk" aria-busy="true"><span class="b-skel"></span><span class="b-skel"></span></div>`;
    else if (st.lane === false) html = `<div class="ex-note ex-off" title="${esc(st.laneMsg || "It switches on with the NOWNodes swap lane; until then the agent keeps trading on paper and nothing is signed or sent.")}"><span class="ex-pill"><i></i>Paper only</span><span><b>Execution off</b></span></div>`;
    else if (st.type === "lp" || st.type === "alert") html = `<div class="ex-note"><span>No swaps to execute</span></div>`;
    else {
      const rows = visible();
      html = [
        autoHtml(),
        !w ? walletNote() : "",
        st.loadErr ? `<div class="ex-note"><span title="Retrying">Signals failed: ${esc(st.loadErr)}</span></div>` : "",
        rows.length ? `<div class="ex-list">${rows.map((f) => rowHtml(f, w)).join("")}</div>`
          : `<div class="ex-note"><span title="Each new BUY or SELL from this agent shows here for 2 minutes">No open signals${w ? ` · <span class="ex-mono">${esc(short(w.address))}</span>` : ""}</span></div>`,
        historyHtml(),
      ].join("");
    }
    st.sig = html;
    body.innerHTML = html;
    if (focus) {
      const el = body.querySelector(focus.af ? `input[data-af="${CSS.escape(focus.af)}"]` : `input[data-usd="${CSS.escape(focus.id)}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(focus.pos, focus.pos); } catch { /* not a text input */ } }
    }
  }
  /** Countdowns every second; a full paint only when a row expires or the wallet changes. */
  function tick() {
    if (st.stopped) return;
    if (!root.isConnected) { if (st.loaded) destroy(); return; }
    let expired = false;
    for (const el of body.querySelectorAll("[data-deadline]")) {
      const ms = Number(el.dataset.deadline) - now();
      if (ms <= 0) { expired = true; break; }
      el.textContent = left(ms);
      el.classList.toggle("soon", ms < 20_000);
    }
    const addr = wallet()?.address ?? null;
    if (expired || (st.loaded && addr !== st.walletAddr)) paint();
  }

  // ── actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function go(id) {
    if (busy()) return;
    const f = st.fills.find((x) => x.id === id) ?? st.cards.get(id)?.fill;
    const w = wallet();
    if (!f || !w) return paint();
    const c = { fill: f, phase: "preparing", prep: null, sig: null, status: null, err: null, signed: false, walletLabel: w.label ?? "wallet", usd: st.cards.get(id)?.usd };
    st.cards.set(id, c);
    const payload = { botId: D.botId, fillId: id, wallet: w.address };
    if (f.side === "buy") {
      const v = Number(String(c.usd ?? f.usd).replace(/,/g, ""));
      if (!(v >= 0.1 && v <= 10_000)) { c.phase = "error"; c.err = "Enter between 0.1 and 10,000 USDC."; return paint(); }
      if (Math.abs(v - f.usd) > 1e-9) payload.usd = v;
    }
    paint();
    const r = await call("POST", `${API}/prepare`, payload);
    if (!r.ok) {
      if (r.j?.error === "nownodes_off") { st.lane = false; st.cards.delete(id); return paint(); }
      if (r.j?.error === "already_executed") { st.cards.delete(id); await load(); return; }
      c.phase = "error"; c.err = r.j?.message ?? "Could not prepare this swap."; return paint();
    }
    c.prep = r.j;
    if (!r.j.simulation?.ok) { c.phase = "simfail"; return paint(); }
    c.phase = "signing"; paint();
    let signed;
    try { signed = await w.signTransaction(r.j.tx); } catch (e) {
      c.phase = "error"; c.err = cancelled(e) ? "You cancelled in the wallet. Nothing was sent." : `The wallet did not sign: ${e?.message ?? e}`; return paint();
    }
    c.signed = true; c.phase = "sending"; paint();
    const s = await call("POST", `${API}/send`, { prepareId: r.j.prepareId, signedTx: signed });
    if (!s.ok) {
      if (s.j?.error === "nownodes_off") { st.lane = false; st.cards.delete(id); return paint(); }
      c.phase = "error"; c.err = s.j?.error === "expired" ? "The prepared swap expired before it was signed. Try again for a fresh quote." : s.j?.message ?? "NOWNodes did not take the transaction."; return paint();
    }
    c.sig = s.j.signature; c.status = "pending"; c.phase = "waiting"; paint();
    await follow(c);
  }
  async function follow(c) {
    for (let i = 0; i < 90 && !st.stopped; i++) {
      await sleep(i < 40 ? 2_000 : 5_000);
      const r = await call("GET", `${API}/status/${encodeURIComponent(c.sig)}`);
      if (!r.ok) { if (r.status === 404 || r.j?.error === "nownodes_off") break; continue; }
      c.status = r.j.status;
      if (r.j.status === "confirmed" || r.j.status === "finalized") { c.phase = "done"; break; }
      if (r.j.status === "failed") { c.phase = "error"; c.err = `Failed on Solana: ${r.j.err ?? "unknown error"}`; break; }
    }
    if (c.phase === "waiting") { c.phase = "error"; c.err = "Still not confirmed. Check it on Solscan before trying again."; }
    await load();
    try { D.onDone?.({ fillId: c.fill.id, signature: c.sig, status: c.status }); } catch { /* the caller's problem */ }
  }

  async function onClick(e) {
    const b = e.target.closest?.("[data-ex]");
    if (!b || !root.contains(b)) return;
    const act = b.dataset.ex;
    if (act === "go") return go(b.dataset.id);
    if (act === "auto-on") return enableAuto();
    if (act === "auto-signin") { if (window.askPrivy) window.askPrivy.login(); else document.getElementById("signInBtn")?.click(); return; }
    if (act === "auto-off") return disableAuto();
    if (act === "auto-agent") return toggleAgent(!!b.checked);
    try {
      if (act === "connect") { const p = extensions().find(([n]) => n === b.dataset.w)?.[1]; if (p) await p.connect(); }
      else if (act === "create") { b.disabled = true; b.textContent = "Creating…"; await window.askPrivy.ensureSol(); }
      else if (act === "signin") window.askPrivy.login();
    } catch { /* cancelled in the wallet */ }
    paint();
  }
  function onInput(e) {
    const af = e.target?.dataset?.af;
    if (af) { e.target.value = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"); st.autoForm[af] = e.target.value; return; }
    const id = e.target?.dataset?.usd;
    if (!id) return;
    e.target.value = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    const f = st.fills.find((x) => x.id === id);
    const c = st.cards.get(id) ?? (f ? { fill: f, phase: "idle" } : null);
    if (!c) return;
    c.usd = e.target.value;
    st.cards.set(id, c);
  }

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  const offPrivy = window.askPrivy?.subscribe?.(() => { if (st.loaded) paint(); });
  const pollT = setInterval(load, POLL_MS);
  const tickT = setInterval(tick, 1_000);
  function destroy() {
    st.stopped = true;
    clearInterval(pollT); clearInterval(tickT);
    try { offPrivy?.(); } catch { /* gone */ }
    root.removeEventListener("click", onClick);
    root.removeEventListener("input", onInput);
  }
  paint();
  load();
  return { refresh: load, destroy };
}
