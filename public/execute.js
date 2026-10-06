// Execute an agent's signal for real, semi-auto and non-custodial (ask2049-notes/PROMPT-agents-marketplace.md C).
// mountExecute(root, deps) lists the agent's open signals (its filled BUY / SELL fills younger than 2 minutes, polled every
// 5 s), each with Sign & execute: the server quotes on Jupiter and simulates on NOWNodes, the person's own wallet signs here,
// the server sends through NOWNodes and follows the status there. Nothing is signed or sent without the wallet's prompt.
// Self-contained: its own styles (class prefix ex-), injected once.
//   deps: { botId, session: string | () => string, api?(path, opts), wallet?: Wallet | null | () => Wallet | null, onDone?(execution) }
//   wallet omitted = pageSolanaWallet() at every render (the Chord account's Solana wallet, else a connected extension).
//   Wallet = { address, label?, signTransaction(base64) → Promise<signed base64> }
const API = "/v1/agents/execute";
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
.ex { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ex-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ex-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 10px; }
.ex-head h3 { margin: 0; font-size: 16.5px; font-weight: 600; }
.ex-head small { font-size: 12.5px; color: var(--muted-fg, #9a97a6); }
.ex-note { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 12px 14px; border: 1px solid var(--border, #2d2a38); border-radius: 12px; background: var(--card, transparent); font-size: 14px; color: var(--muted-fg, #9a97a6); }
.ex-note > span { flex: 1 1 220px; min-width: 0; }
.ex-note b { color: var(--fg, inherit); font-weight: 500; }
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
  const st = { lane: null, laneMsg: "", type: null, fills: [], execs: [], cards: new Map(), loaded: false, loadErr: null, skew: 0, sig: "", walletAddr: undefined, stopped: false };
  const now = () => Date.now() + st.skew;
  const wallet = () => (typeof D.wallet === "function" ? D.wallet() : D.wallet === undefined ? pageSolanaWallet() : D.wallet);
  const busy = () => [...st.cards.values()].some((c) => ["preparing", "signing", "sending"].includes(c.phase));

  root.classList.add("ex");
  root.innerHTML = `<div class="ex-head"><h3>Execute on-chain</h3><small>Your wallet signs. Quoted on Jupiter, simulated and sent through NOWNodes.</small></div><div class="ex-body"></div>`;
  const body = root.querySelector(".ex-body");

  async function call(method, path, payload) {
    const s = typeof D.session === "function" ? D.session() : D.session;
    if (!s && typeof D.api === "function") {
      try { return { ok: true, status: 200, j: await D.api(path, { method, body: payload }) }; }
      catch (e) { const m = e?.message ?? String(e); return { ok: false, status: 0, j: { message: m, error: /NOWNodes key not set/i.test(m) ? "nownodes_off" : undefined } }; }
    }
    let r;
    try {
      r = await fetch(path, { method, headers: { ...(s ? { "X-Session": s } : {}), ...(payload ? { "Content-Type": "application/json" } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    } catch { return { ok: false, status: 0, j: { message: "Connection lost. Check your network and try again." } }; }
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, j: j ?? { message: `The server answered ${r.status}.` }, date: r.headers.get("date") };
  }

  // ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function load() {
    if (st.stopped) return;
    if (!root.isConnected) { if (st.loaded) destroy(); return; }
    if (document.visibilityState === "hidden" && st.loaded) return;
    const [a, m] = await Promise.all([call("GET", `/v1/agents/${encodeURIComponent(D.botId)}`), call("GET", `${API}/mine?botId=${encodeURIComponent(D.botId)}`)]);
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
        ? `<span class="ex-sub">${f.mint === SOL_MINT ? "Sells native SOL in the share the agent sold, keeping 0.01 SOL for fees" : `Sells your ${esc(symOf(f))} in the share the agent sold`}</span>`
        : `<label class="ex-amt" title="USDC to spend"><input data-usd="${esc(f.id)}" inputmode="decimal" autocomplete="off" aria-label="USDC to spend" value="${esc(c?.usd ?? String(Number(f.usd.toFixed(2))))}"><span>USDC</span></label>`;
      act = `<div class="ex-act">${input}<button type="button" class="ex-go" data-ex="go" data-id="${esc(f.id)}"${busy() ? " disabled" : ""}>${retry ? "Try again" : "Sign &amp; execute"}</button></div>`;
    } else if (retry && !fresh) act = `<div class="ex-act"><span class="ex-sub">This signal is past its 2 minutes and can no longer be executed.</span></div>`;
    const steps = c && phase !== "idle" ? `<ol class="ex-steps">${stepsOf(c).join("")}</ol>` : "";
    return `<div class="ex-row" data-row="${esc(f.id)}">${head}${act}${steps}</div>`;
  }
  function historyHtml() {
    const rows = st.execs.slice(0, 5);
    if (!rows.length) return "";
    const tm = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `<div class="ex-hist"><h4>Executed from your wallet</h4>${rows.map((e) => {
      const ok = e.status === "confirmed" || e.status === "finalized", bad = e.status === "failed";
      const what = e.side === "buy" ? `${e.inAmount ? `${amt(e.inAmount)} USDC → ` : ""}${esc(e.symbol ?? short(e.mint))}` : `${esc(e.symbol ?? short(e.mint))}${e.outAmount ? ` → ${amt(e.outAmount)} USDC` : ""}`;
      return `<div class="ex-hrow"><span class="t">${tm(e.at)}</span><span class="ex-side ${e.side === "sell" ? "sell" : "buy"}">${e.side === "sell" ? "SELL" : "BUY"}</span><span class="w" title="${esc(e.err ?? "")}">${what}</span><span class="ex-st${ok ? " ok" : bad ? " bad" : ""}">${esc(e.status.toUpperCase())}</span><a href="${SOLSCAN}${esc(e.signature)}" target="_blank" rel="noopener">Solscan ↗</a></div>`;
    }).join("")}</div>`;
  }
  function walletNote() {
    const pv = window.askPrivy?.state;
    const btns = [];
    if (pv?.authenticated && !pv.sol) btns.push(`<button type="button" class="ex-btn" data-ex="create">Create your Solana wallet</button>`);
    else if (window.askPrivy && !pv?.authenticated) btns.push(`<button type="button" class="ex-btn" data-ex="signin">Sign in</button>`);
    for (const [name] of extensions()) btns.push(`<button type="button" class="ex-btn" data-ex="connect" data-w="${esc(name)}">Connect ${esc(name)}</button>`);
    return `<div class="ex-note"><span><b>Connect a Solana wallet to execute.</b> It signs each swap itself; this app never holds keys or funds.</span>${btns.join("")}</div>`;
  }
  function paint() {
    if (st.stopped) return;
    const w = wallet();
    st.walletAddr = w?.address ?? null;
    // keep the caret where it was when the list re-renders under someone typing an amount
    const a = document.activeElement, focus = a && root.contains(a) && a.dataset?.usd ? { id: a.dataset.usd, pos: a.selectionStart } : null;
    let html;
    if (!st.loaded) html = `<div class="ex-note"><span>Loading signals…</span></div>`;
    else if (st.lane === false) html = `<div class="ex-note"><span><b>NOWNodes key not set on this server: execution is off.</b> The agent keeps trading on paper.</span></div>`;
    else if (st.type === "lp" || st.type === "alert") html = `<div class="ex-note"><span>This agent does not swap, so there are no signals to execute.</span></div>`;
    else {
      const rows = visible();
      html = [
        !w ? walletNote() : "",
        st.loadErr ? `<div class="ex-note"><span>Could not load this agent's signals: ${esc(st.loadErr)}. Retrying.</span></div>` : "",
        rows.length ? `<div class="ex-list">${rows.map((f) => rowHtml(f, w)).join("")}</div>`
          : `<div class="ex-note"><span>No open signals. Each new BUY or SELL from this agent shows here for 2 minutes, ready to execute from ${w ? `your wallet <span class="ex-mono">${esc(short(w.address))}</span>` : "your wallet"}.</span></div>`,
        historyHtml(),
      ].join("");
    }
    st.sig = html;
    body.innerHTML = html;
    if (focus) {
      const el = body.querySelector(`input[data-usd="${CSS.escape(focus.id)}"]`);
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
    try {
      if (act === "connect") { const p = extensions().find(([n]) => n === b.dataset.w)?.[1]; if (p) await p.connect(); }
      else if (act === "create") { b.disabled = true; b.textContent = "Creating…"; await window.askPrivy.ensureSol(); }
      else if (act === "signin") window.askPrivy.login();
    } catch { /* cancelled in the wallet */ }
    paint();
  }
  function onInput(e) {
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
