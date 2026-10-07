// Auto-trade for the whole account (src/autoTrade.ts, /v1/agents/auto): one card on the Agents home and on the Wallet page, so
// switching it on never needs an agent page. Off: the limits + a tick list of the person's trading agents + one button (Sign in,
// then Enable auto-trade = one signature in the Chord wallet, then auto-execute on every ticked agent). On: spent today, a switch
// per agent, the last runs with Solscan, Turn off. `compact` (Agents home) folds it to one line until Set up / Manage.
// The agent page keeps its own block (execute.js), which enables through enableGrant() below.
//   mountAutoTrade(root, { session, compact?, onNewAgent?(), openAgent?(id) }) → { refresh, destroy }
const AUTO = "/v1/agents/auto";
export const AUTO_DEFAULTS = { perTradeUsd: "1", dailyUsd: "10", slippagePct: "1", days: "7" };
const TRADING = new Set(["copy", "custom"]);
const POLL_MS = 10_000;
const SOLSCAN = "https://solscan.io/tx/";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s) => (s && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? "");
const usd = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
const cancelled = (e) => e?.code === 4001 || /user rejected|rejected the request|denied|exited|cancel/i.test(e?.message ?? "");
const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const tm = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const OUT = { queued: "QUEUED", running: "RUNNING", sent: "SENT", confirmed: "DONE", failed: "FAILED", refused: "SKIPPED" };
const signIn = () => { if (window.askPrivy) window.askPrivy.login(); else document.getElementById("signInBtn")?.click(); };

/** Limits as the API wants them, or { err } in words. */
export function limitsOf(f) {
  const n = (k) => Number(String(f[k]).replace(/,/g, ""));
  const v = { perTradeUsd: n("perTradeUsd"), dailyUsd: n("dailyUsd"), slippageBps: Math.round(n("slippagePct") * 100), days: n("days") };
  if (!(v.perTradeUsd >= 1 && v.perTradeUsd <= 100)) return { err: "Per trade: 1 to 100 USDC." };
  if (!(v.dailyUsd >= 1 && v.dailyUsd <= 500)) return { err: "Per day: 1 to 500 USDC." };
  if (v.dailyUsd < v.perTradeUsd) return { err: "Per day must be at least one trade." };
  if (!(v.slippageBps >= 10 && v.slippageBps <= 300)) return { err: "Slippage: 0.1% to 3%." };
  if (!(Number.isInteger(v.days) && v.days >= 1 && v.days <= 30)) return { err: "Days: a whole number from 1 to 30." };
  return { v };
}

/** Grant our session signer on the Chord account's Solana wallet and record the limits. `call(method, path, body, headers)`
 *  → { ok, j }. onPhase("approving") while the wallet asks. Throws in words (a cancel in the wallet included). */
export async function enableGrant(call, limits, onPhase = () => {}) {
  const pv = window.askPrivy;
  if (!pv?.state?.authenticated) throw new Error("Sign in first.");
  const wallet = pv.state.sol || await pv.ensureSol();
  const body = { ...limits, wallet };
  const token = await pv.accessToken();
  if (!token) throw new Error("Sign in again: your session ended.");
  let r = await call("POST", `${AUTO}/enable`, body, { "X-Privy-Token": token });
  // our signer is not on the wallet yet (or not under our policy): approve it in the wallet, then record the limits
  if (!r.ok && r.j?.error === "signer_missing") {
    onPhase("approving");
    if (r.j.fix === "replace") await pv.removeSolSigners();
    await pv.addSolSigner(r.j.quorumId, [r.j.policyId]);
    r = await call("POST", `${AUTO}/enable`, body, { "X-Privy-Token": (await pv.accessToken()) ?? token });
  }
  if (!r.ok) throw new Error(r.j?.message ?? "Could not enable auto-trade.");
  return r.j;
}

export function mountAutoTrade(root, deps = {}) {
  injectStyle();
  const D = deps;
  const st = { status: null, bots: null, form: { ...AUTO_DEFAULTS }, picks: null, open: false, busy: null, err: null, note: null, stopped: false, sig: "" };

  async function call(method, path, payload, headers = {}) {
    const s = typeof D.session === "function" ? D.session() : D.session;
    let r;
    try {
      r = await fetch(path, { method, headers: { ...(s ? { "X-Session": s } : {}), ...(payload ? { "Content-Type": "application/json" } : {}), ...headers }, body: payload ? JSON.stringify(payload) : undefined });
    } catch { return { ok: false, status: 0, j: { message: "Connection lost. Check your network and try again." } }; }
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, j: j ?? { message: `The server answered ${r.status}.` } };
  }
  async function load() {
    if (st.stopped) return;
    if (!root.isConnected) return; // its page is closed: the same card is put back when the page opens again
    if (document.visibilityState === "hidden" && st.status) return;
    const [a, b] = await Promise.all([call("GET", `${AUTO}/status`), call("GET", "/v1/agents")]);
    if (a.ok) st.status = a.j;
    if (b.ok) st.bots = (b.j.bots ?? []).filter((x) => x?.id && TRADING.has(x.type) && x.status !== "deleted");
    // every trading agent is ticked until the person changes the ticks
    if (st.bots && !st.picks) st.picks = new Set(st.bots.filter((x) => x.status === "running").map((x) => x.id));
    paint();
  }

  // ── actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function enable() {
    if (!window.askPrivy?.state?.authenticated) return signIn();
    const lim = limitsOf(st.form);
    if (lim.err) { st.err = lim.err; return paint(true); }
    st.busy = "enabling"; st.err = null; st.note = null; paint(true);
    try {
      await enableGrant(call, lim.v, (p) => { st.busy = p; paint(true); });
      const ids = [...(st.picks ?? [])];
      const res = await Promise.all(ids.map((id) => call("POST", `${AUTO}/agents/${encodeURIComponent(id)}`, { on: true })));
      const bad = res.find((r) => !r.ok);
      if (bad) st.err = bad.j?.message ?? null;
      st.open = true;
    } catch (e) {
      st.err = cancelled(e) ? "Cancelled in the wallet. Auto-trade stays off." : (e?.message ?? String(e));
    }
    st.busy = null;
    await load();
  }
  async function disable() {
    st.busy = "disabling"; st.err = null; paint(true);
    const r = await call("POST", `${AUTO}/disable`);
    if (!r.ok) { st.err = r.j?.message ?? "Could not switch auto-trade off."; st.busy = null; return paint(true); }
    st.note = null;
    if (r.j?.removeSigners) {
      if (window.askPrivy?.state?.authenticated) {
        try { await window.askPrivy.removeSolSigners(); } catch (e) { st.note = `Auto-trade is off. The signer is still on your wallet: ${e?.message ?? e}`; }
      } else st.note = "Auto-trade is off. Sign in to take the signer off your wallet.";
    }
    st.busy = null;
    await load();
  }
  async function toggle(id, on) {
    st.busy = `agent:${id}`; st.err = null; paint(true);
    const r = await call("POST", `${AUTO}/agents/${encodeURIComponent(id)}`, { on });
    if (!r.ok) st.err = r.j?.message ?? "Could not change auto-execute.";
    st.busy = null;
    await load();
  }

  // ── render ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const fld = (k, label, unit, title) => `<label class="at-fld" title="${esc(title)}">${label}<span class="at-amt">${unit === "$" ? `<span>$</span>` : ""}<input data-af="${k}" inputmode="decimal" autocomplete="off" value="${esc(st.form[k])}" aria-label="${esc(label)}">${unit !== "$" ? `<span>${unit}</span>` : ""}</span></label>`;
  const msg = () => (st.err ? `<p class="at-msg bad">${esc(st.err)}</p>` : st.note ? `<p class="at-msg">${esc(st.note)}</p>` : "");
  const runsHtml = (runs) => {
    const rows = (runs ?? []).slice(0, 5);
    if (!rows.length) return "";
    return `<div class="at-runs">${rows.map((r) => {
      const sym = r.symbol ? String(r.symbol).replace(/^\$/, "") : short(r.mint);
      const what = r.side === "buy" ? `${r.usd != null ? `${usd(r.usd)} → ` : ""}${esc(sym)}` : `${esc(sym)}${r.usd != null ? ` → ${usd(r.usd)}` : ""}`;
      const ok = r.outcome === "confirmed", bad = r.outcome === "failed" || r.outcome === "refused";
      return `<div class="at-run"><span class="t">${tm(r.at)}</span><span class="at-side ${r.side === "sell" ? "sell" : "buy"}">${r.side === "sell" ? "SELL" : "BUY"}</span><span class="w" title="${esc(r.reason ?? "")}">${what}${r.reason && bad ? `<small>${esc(r.reason)}</small>` : ""}</span><span class="o ${ok ? "ok" : bad ? "bad" : ""}">${OUT[r.outcome] ?? esc(r.outcome)}</span>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Solscan ↗</a>` : "<span></span>"}</div>`;
    }).join("")}</div>`;
  };
  const noAgents = () => `<div class="at-none"><span>No trading agent yet.</span>${D.onNewAgent ? `<button type="button" class="at-link" data-at="new">New agent</button>` : ""}</div>`;
  const agentName = (b) => D.openAgent ? `<button type="button" class="at-name" data-at="open" data-id="${esc(b.id)}">${esc(b.name)}</button>` : `<span class="at-name">${esc(b.name)}</span>`;
  const kind = (b) => `<small>${b.type === "custom" ? "Strategy" : "Copy trader"}${b.status !== "running" ? ` · ${esc(b.status)}` : ""}</small>`;

  function onHtml(a, g) {
    const pct = g.dailyUsd > 0 ? Math.min(100, (a.spentTodayUsd / g.dailyUsd) * 100) : 0;
    const autoSet = new Set(a.agents ?? []), bots = st.bots ?? [];
    const nOn = bots.filter((b) => autoSet.has(b.id)).length;
    const head = `<div class="at-head"><b>Auto-trade</b><span class="at-pill on"><i></i>On</span><small title="Your Chord wallet signs through a session signer, within these limits">${esc(short(g.wallet))} · until ${day(g.expiresAt)}</small>
      ${D.compact ? `<span class="at-sum">${usd(a.spentTodayUsd)} of ${usd(g.dailyUsd)} today · ${nOn} agent${nOn === 1 ? "" : "s"}</span><button type="button" class="at-btn" data-at="fold" aria-expanded="${st.open}">${st.open ? "Hide" : "Manage"}</button>` : ""}
      <button type="button" class="at-btn at-off" data-at="off"${st.busy ? " disabled" : ""} title="Stops auto-trade at once and takes the signer off your wallet">${st.busy === "disabling" ? "Turning off…" : "Turn off"}</button></div>`;
    if (D.compact && !st.open) return head + msg();
    const meter = `<div class="at-meter" title="USDC spent by auto buys today (UTC); sells are not counted"><span>Today <b>${usd(a.spentTodayUsd)}</b> of ${usd(g.dailyUsd)} · ${usd(g.perTradeUsd)} a trade · slippage ${(g.slippageBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%</span><span class="at-bar"><i style="width:${pct.toFixed(1)}%"></i></span></div>`;
    const list = bots.length ? `<div class="at-agents">${bots.map((b) => {
      const on = autoSet.has(b.id), busy = st.busy === `agent:${b.id}`;
      return `<div class="at-agent">${agentName(b)}${kind(b)}<label class="at-tog" title="Each new BUY or SELL of this agent is executed from your wallet within your limits"><input type="checkbox" data-at="agent" data-id="${esc(b.id)}"${on ? " checked" : ""}${busy || (st.busy && st.busy !== `agent:${b.id}`) ? " disabled" : ""} aria-label="${esc(`Auto-execute ${b.name}`)}"><span>${on ? "On" : "Off"}</span></label></div>`;
    }).join("")}</div>` : noAgents();
    return head + meter + list + msg() + runsHtml(a.recent);
  }
  function offHtml(a, g) {
    const pv = window.askPrivy?.state, signed = !!pv?.authenticated;
    const head = `<div class="at-head"><b>Auto-trade</b><span class="at-pill"><i></i>Off</span><small>Your agents trade from your Chord wallet. No approval per trade.</small>
      ${D.compact && !st.open ? `<button type="button" class="at-go" data-at="fold">Set up</button>` : ""}</div>`;
    if (D.compact && !st.open) return head;
    const why = g && !g.enabled && g.disabledReason && g.disabledReason !== "switched off" ? `<p class="at-msg">Was switched off: ${esc(g.disabledReason)}</p>` : "";
    const bots = st.bots ?? [], picks = st.picks ?? new Set();
    const list = bots.length ? `<div class="at-agents"><span class="at-lbl">Agents that execute</span>${bots.map((b) => `<label class="at-agent at-pick"><input type="checkbox" data-at="pick" data-id="${esc(b.id)}"${picks.has(b.id) ? " checked" : ""}><span class="at-box" aria-hidden="true"></span><span class="at-name">${esc(b.name)}</span>${kind(b)}</label>`).join("")}</div>` : noAgents();
    const n = bots.filter((b) => picks.has(b.id)).length;
    const label = st.busy === "approving" ? "Approve in your wallet…" : st.busy === "enabling" ? "Enabling…" : signed ? (n ? `Enable for ${n} agent${n === 1 ? "" : "s"}` : "Enable auto-trade") : "Sign in to enable";
    return `${head}<div class="at-form">${fld("perTradeUsd", "Per trade", "$", "USDC per trade, 1 to 100")}${fld("dailyUsd", "Per day", "$", "USDC a day, 1 to 500")}${fld("slippagePct", "Slippage", "%", "At most 3%")}${fld("days", "For", "days", "The signer expires after this many days")}</div>
      ${list}<div class="at-cta"><button type="button" class="at-go big" data-at="${signed ? "on" : "signin"}"${st.busy ? " disabled" : ""}>${label}</button><small>${signed ? "One signature in your Chord wallet. Turn it off any time." : "Sign in with your Chord account. Its Solana wallet does the trades."}</small></div>${why}${msg()}`;
  }
  function paint(force) {
    if (st.stopped) return;
    const a = st.status;
    let html;
    if (!a) html = D.compact ? "" : `<div class="at-card at-sk"><span class="b-skel"></span><span class="b-skel"></span></div>`;
    else if (!a.on) html = D.compact ? "" : `<div class="at-card"><div class="at-head"><b>Auto-trade</b><span class="at-pill"><i></i>Unavailable</span><small>${esc(a.message ?? "Not switched on for this server yet.")}</small></div></div>`;
    else html = `<div class="at-card${D.compact ? " compact" : ""}">${a.grant?.enabled ? onHtml(a, a.grant) : offHtml(a, a.grant)}</div>`;
    // a poll with the same answer leaves the card alone (focus in an input, a half-typed amount)
    const sig = `${html}`;
    if (!force && sig === st.sig) return;
    const act = document.activeElement, af = act && root.contains(act) ? act.dataset?.af : null, pos = af ? act.selectionStart : null;
    st.sig = sig;
    root.innerHTML = html;
    if (af) { const el = root.querySelector(`[data-af="${af}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* number-like input */ } } }
  }

  function onClick(e) {
    const b = e.target.closest?.("[data-at]");
    if (!b || !root.contains(b)) return;
    const act = b.dataset.at;
    if (act === "fold") { st.open = !st.open; return paint(true); }
    if (act === "signin") return signIn();
    if (act === "on") return enable();
    if (act === "off") return disable();
    if (act === "new") return D.onNewAgent?.();
    if (act === "open") return D.openAgent?.(b.dataset.id);
  }
  function onChange(e) {
    const t = e.target, act = t?.dataset?.at;
    if (act === "agent") return toggle(t.dataset.id, !!t.checked);
    if (act === "pick") { st.picks ??= new Set(); if (t.checked) st.picks.add(t.dataset.id); else st.picks.delete(t.dataset.id); return paint(true); }
  }
  function onInput(e) {
    const k = e.target?.dataset?.af;
    if (!k) return;
    e.target.value = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
    st.form[k] = e.target.value;
    st.err = null;
  }
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  const onPrivy = () => { if (root.isConnected) paint(true); };
  const offPrivy = window.askPrivy?.subscribe?.(onPrivy);
  addEventListener("askprivy", onPrivy);
  const pollT = setInterval(load, POLL_MS);
  function destroy() {
    if (st.stopped) return;
    st.stopped = true;
    clearInterval(pollT);
    try { offPrivy?.(); } catch { /* gone */ }
    removeEventListener("askprivy", onPrivy);
    root.removeEventListener("click", onClick);
    root.removeEventListener("change", onChange);
    root.removeEventListener("input", onInput);
  }
  paint(true);
  load();
  return { refresh: () => { paint(true); return load(); }, destroy };
}

function injectStyle() {
  if (document.getElementById("at-style")) return;
  const s = document.createElement("style");
  s.id = "at-style";
  s.textContent = `
.at-card { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 14px 16px; border: 1px solid var(--border, #2d2a38); border-radius: 14px; background: var(--card, transparent); }
.at-card.compact { padding: 12px 14px; }
.at-sk { gap: 8px; } .at-sk .b-skel { height: 16px; } .at-sk .b-skel + .b-skel { width: 60%; }
.at-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; min-width: 0; }
.at-head b { font-size: 15px; font-weight: 600; }
.at-head small { flex: 1 1 220px; min-width: 0; font-size: 13px; color: var(--muted-fg, #9a97a6); }
.at-sum { font: 12.5px "Geist Mono", ui-monospace, monospace; color: var(--muted-fg, #9a97a6); }
.at-pill { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 22px; padding: 0 9px; border: 1px solid var(--border, #2d2a38); border-radius: 999px; font: 500 11.5px "Geist Mono", monospace; white-space: nowrap; }
.at-pill i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-fg, #9a97a6); }
.at-pill.on i { background: var(--hi, #14F195); }
.at-go { height: 36px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--primary, #14F195); color: var(--primary-fg, #0b0a12); font-size: 14px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.at-go.big { height: 42px; padding: 0 20px; font-size: 15px; }
.at-go:disabled { opacity: .55; cursor: default; }
.at-btn { height: 32px; padding: 0 12px; border: 1px solid var(--border, #2d2a38); border-radius: 10px; background: transparent; color: var(--fg, inherit); font-size: 13.5px; font-weight: 500; white-space: nowrap; cursor: pointer; }
.at-btn:hover:not(:disabled) { background: var(--muted, rgba(127,127,127,.12)); }
.at-btn:disabled { opacity: .5; cursor: default; }
.at-form { display: flex; flex-wrap: wrap; gap: 8px; }
.at-fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted-fg, #9a97a6); }
.at-amt { display: inline-flex; align-items: center; gap: 4px; height: 38px; padding: 0 10px; border: 1px solid var(--border, #2d2a38); border-radius: 10px; background: var(--bg, transparent); }
.at-amt:focus-within { border-color: var(--purple, #b98cff); }
.at-amt input { width: 52px; min-width: 0; border: 0; outline: 0; background: transparent; font: 15px "Geist Mono", ui-monospace, monospace; color: var(--fg, inherit); }
.at-amt span { font-size: 13px; color: var(--muted-fg, #9a97a6); }
.at-lbl { font-size: 12px; color: var(--muted-fg, #9a97a6); padding-bottom: 2px; }
.at-agents { display: flex; flex-direction: column; min-width: 0; }
.at-agent { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 9px 0; border-top: 1px solid var(--border-soft, rgba(127,127,127,.2)); font-size: 14px; }
.at-agent small { flex: none; font-size: 12px; color: var(--muted-fg, #9a97a6); }
.at-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; border: 0; background: none; color: var(--fg, inherit); font: inherit; text-align: left; }
button.at-name { cursor: pointer; } button.at-name:hover { text-decoration: underline; }
.at-pick { cursor: pointer; }
.at-pick input { position: absolute; opacity: 0; pointer-events: none; }
.at-box { flex: none; width: 18px; height: 18px; border: 1.5px solid var(--border, #2d2a38); border-radius: 5px; display: grid; place-items: center; }
.at-pick input:checked + .at-box { background: var(--hi, #14F195); border-color: var(--hi, #14F195); }
.at-pick input:checked + .at-box::after { content: ""; width: 9px; height: 5px; margin-top: -2px; border: solid var(--primary-fg, #0b0a12); border-width: 0 0 2px 2px; transform: rotate(-45deg); }
.at-pick input:focus-visible + .at-box { outline: 2px solid var(--purple, #b98cff); outline-offset: 2px; }
.at-tog { display: inline-flex; align-items: center; gap: 8px; flex: none; font-size: 12.5px; color: var(--muted-fg, #9a97a6); cursor: pointer; user-select: none; }
.at-tog input { appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--muted, rgba(127,127,127,.3)); cursor: pointer; transition: background .15s; }
.at-tog input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--fg, #fff); transition: transform .15s; }
.at-tog input:checked { background: var(--hi, #14F195); }
.at-tog input:checked::after { transform: translateX(14px); background: var(--primary-fg, #0b0a12); }
.at-tog input:disabled { opacity: .5; cursor: default; }
.at-tog span { width: 22px; }
.at-none { display: flex; align-items: center; gap: 10px; font-size: 13.5px; color: var(--muted-fg, #9a97a6); }
.at-link { padding: 0; border: 0; background: none; color: var(--fg, inherit); font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
.at-cta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
.at-cta small { flex: 1 1 200px; font-size: 12.5px; color: var(--muted-fg, #9a97a6); }
.at-msg { margin: 0; font-size: 13px; line-height: 1.45; color: var(--muted-fg, #9a97a6); overflow-wrap: anywhere; }
.at-msg.bad { color: var(--bad, #e5534b); }
.at-meter { display: flex; flex-direction: column; gap: 5px; font: 12.5px "Geist Mono", ui-monospace, monospace; color: var(--muted-fg, #9a97a6); }
.at-meter b { color: var(--fg, inherit); font-weight: 500; }
.at-bar { height: 4px; border-radius: 2px; background: var(--muted, rgba(127,127,127,.2)); overflow: hidden; }
.at-bar i { display: block; height: 100%; background: var(--hi, #14F195); }
.at-off { margin-left: auto; }
.at-runs { display: flex; flex-direction: column; border-top: 1px solid var(--border-soft, rgba(127,127,127,.2)); }
.at-run { display: grid; grid-template-columns: 44px 40px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 8px 0; font-size: 13px; }
.at-run + .at-run { border-top: 1px solid var(--border-soft, rgba(127,127,127,.2)); }
.at-run .t { font: 12px "Geist Mono", ui-monospace, monospace; color: var(--muted-fg, #9a97a6); }
.at-run .w { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.at-run .w small { margin-left: 8px; color: var(--muted-fg, #9a97a6); }
.at-run .o { font: 600 11px "Geist Mono", ui-monospace, monospace; color: var(--muted-fg, #9a97a6); }
.at-run .o.ok { color: var(--hi, #14F195); } .at-run .o.bad { color: var(--bad, #e5534b); }
.at-run a { font-size: 12.5px; color: var(--fg, inherit); white-space: nowrap; }
.at-side { font: 600 11px "Geist Mono", ui-monospace, monospace; }
.at-side.buy { color: var(--hi, #14F195); } .at-side.sell { color: var(--bad, #e5534b); }
@media (max-width: 560px) {
  .at-head small { flex-basis: 100%; order: 3; }
  .at-off { margin-left: 0; }
  .at-go.big { width: 100%; }
  .at-run { grid-template-columns: 40px minmax(0, 1fr) auto; }
  .at-run .t, .at-run a { display: none; }
}`;
  document.head.append(s);
}
