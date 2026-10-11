// LP agents screen (#agents/lp, #agents/lp/<pool>), loaded by bots.js on first use. The Monad pools this app can model
// (GET /v1/agents/lp/scan, Chord's LP index), then for one pool every range preset replayed against HODL on its own hours
// (POST /v1/agents/lp/backtest), then Start (POST /v1/agents, type "lp"). Every server string is escaped.
const PRESET_ORDER = ["tight", "balanced", "wide", "full"];
const DAYS = [1, 3, 7, 30];
const WIN = [[7, "1 week"], [30, "1 month"]];
let L = null;

export function renderLp(el, ctx) {
  L = { el, ctx, ui: ctx.ui, pools: null, err: null, sel: ctx.route.pool ?? null, f: { amountUsd: 1000, days: 30, rebalance: true }, res: null, busy: false, msg: null, preset: "balanced", startBusy: false, win: null };
  el.innerHTML = `${ctx.crumb()}<div id="lpBody"><div class="b-skel" style="height:44px;width:40%"></div><div class="b-skel" style="height:260px;margin-top:18px"></div></div>`;
  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  load();
}
async function load() {
  try { const j = await L.ctx.api("/v1/agents/lp/scan"); L.pools = j.pools ?? []; L.presets = j.presets; L.err = null; }
  catch (e) { L.err = e.message; }
  paint();
  // opened on one pool (a link, an agent page): land on its panel, not on the list above it
  if (L.sel && L.pools?.some((p) => p.pool === L.sel)) { backtest(); requestAnimationFrame(() => L?.el?.querySelector("#lpPanel")?.scrollIntoView({ block: "start" })); }
}
const poolOf = () => L.pools?.find((p) => p.pool === L.sel) ?? null;
const money = (v) => { const n = Number(v) || 0; return n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `$${n.toFixed(0)}`; };

function paint() {
  const body = L.el.querySelector("#lpBody"); if (!body) return;
  const { esc, ic, errBox, info } = L.ui;
  if (L.err && !L.pools) { body.innerHTML = `<header class="cl-h"><h1>LP agents</h1></header>${errBox(`Chord's LP index did not answer: ${L.err}`, "retry-lp")}`; return; }
  if (!L.pools) return;
  const p = poolOf();
  body.innerHTML = `<header class="cl-h"><h1>LP agents</h1>${info("<p>Paper liquidity in Monad pools, from Chord's LP index. A range is opened around the price; each hour of the pool's volume pays the position its share of the fee while the price stays in range, and the position's value follows the pool's price (impermanent loss included). Out of range for 6 hours, it can re-centre. Every fill is committed to the agent's record on Monad.</p>", "How LP agents work")}</header>
    <div class="lp-tw"><table class="cl-t lp-t"><thead><tr><th>Pool</th><th>DEX</th><th class="r">Fee</th><th class="r">TVL</th><th class="r">Volume 24h</th><th class="r">Fees 24h</th><th class="r" title="Chord's fee APR: 24 h fees over TVL, annualised">Fee APR</th><th class="r">Trades 24h</th></tr></thead>
      <tbody>${L.pools.map((x) => `<tr data-pool="${esc(x.pool)}" class="${x.pool === L.sel ? "on" : ""}"><td><b>${esc(x.pair)}</b>${x.concentrated ? "" : `<small class="cl-cov"> full range</small>`}</td><td>${esc(x.dex)}</td><td class="r">${(x.feeBps / 100).toFixed(2)}%</td><td class="r">${money(x.tvlUsd)}</td><td class="r">${money(x.volume24hUsd)}</td><td class="r">${money(x.fees24hUsd)}</td><td class="r">${x.feeAprPct != null ? `${Math.round(x.feeAprPct)}%` : "-"}</td><td class="r">${x.trades24h ?? "-"}</td></tr>`).join("")}</tbody></table></div>
    ${p ? panel(p) : `<p class="cl-msg">Pick a pool to replay every range on its recent hours.</p>`}`;
}
function panel(p) {
  const { esc, ic } = L.ui, f = L.f;
  const seg = (name, opts, cur) => `<div class="b-seg sm">${opts.map(([v, l]) => `<button type="button" data-seg="${name}" data-v="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  return `<section class="cl-card" id="lpPanel">
      <div class="cl-top"><div><h2>${esc(p.pair)} <small class="cl-cov">${esc(p.dex)}, ${(p.feeBps / 100).toFixed(2)}% fee</small></h2><p><a href="https://monadscan.com/address/${esc(p.pool)}" target="_blank" rel="noopener">${esc(p.pool.slice(0, 10))}…${esc(p.pool.slice(-6))}</a>, TVL ${money(p.tvlUsd)}, ${money(p.volume24hUsd)} traded in 24h</p></div></div>
      <div class="cl-grid">
        <label class="b-field cl-f" title="100 to 10,000"><span>Amount ($)</span><input class="b-in" type="number" data-f="amountUsd" min="100" max="10000" step="100" value="${esc(f.amountUsd)}" inputmode="decimal"></label>
        <div class="b-field cl-f"><span>Replay</span>${seg("days", DAYS.map((d) => [d, d === 30 ? "1M" : `${d}d`]), f.days)}</div>
        <div class="b-field cl-f"><span>Re-centre out of range</span>${seg("rebalance", [["1", "On"], ["0", "Off"]], f.rebalance ? "1" : "0")}</div>
      </div>
      <div class="cl-act"><button type="button" class="b-new" data-lp="bt"${L.busy ? " disabled" : ""}>${ic(L.busy ? "spin" : "chart")}${L.busy ? "Replaying…" : "Backtest every range"}</button>
        ${L.res ? `<button type="button" class="b-btn" data-lp="start"${L.startBusy ? " disabled" : ""}>${ic(L.startBusy ? "spin" : "play")}Start LP agent, ${esc(L.presets?.[L.preset]?.label ?? L.preset)}</button>` : ""}
        ${L.msg ? `<span class="cl-msg ${L.msg.bad ? "bad" : ""}">${esc(L.msg.text)}</span>` : ""}</div>
      <div id="lpWin">${winHtml()}</div>
      <div id="lpRes">${results()}</div>
    </section>`;
}
function results() {
  const r = L.res; if (!r) return "";
  const { esc, usd, signed, cls, equityHtml } = L.ui;
  const keys = PRESET_ORDER.filter((k) => r.byPreset[k]);
  if (!r.byPreset[L.preset]) L.preset = keys.includes("balanced") ? "balanced" : keys[0];
  const x = r.byPreset[L.preset];
  return `<div class="cl-rh" style="margin-top:16px"><h3 title="Pick a range: Start uses the selected row">${esc(r.pair)}, ${r.days} days, ${usd(r.amountUsd)}</h3></div>
    <div class="cl-tw"><table class="cl-t"><thead><tr><th>Range</th><th class="r">PnL</th><th class="r">Return</th><th class="r">Fees</th><th class="r" title="LP value against holding the deposited tokens">vs HODL</th><th class="r">In range</th><th class="r">Re-centres</th><th class="r" title="Fees only, annualised">Fee APR</th></tr></thead>
    <tbody>${keys.map((k) => { const v = r.byPreset[k]; return `<tr data-preset="${k}" class="${k === L.preset ? "on" : ""}"><td>${esc(L.presets?.[k]?.label ?? k)}</td><td class="r ${cls(v.pnlUsd)}">${signed(v.pnlUsd)}</td><td class="r ${cls(v.returnPct)}">${v.returnPct > 0 ? "+" : ""}${Number(v.returnPct).toFixed(2)}%</td><td class="r up">${usd(v.feesUsd)}</td><td class="r ${cls(v.ilUsd)}">${signed(v.ilUsd)}</td><td class="r">${Number(v.inRangePct).toFixed(0)}%</td><td class="r">${v.rebalances}</td><td class="r">${Math.round(v.aprPct)}%</td></tr>`; }).join("")}</tbody></table></div>
    ${equityHtml((x.equity ?? []).map((p) => ({ ts: p.t, usd: p.usd })), `PnL, ${L.presets?.[L.preset]?.label ?? L.preset}`)}
    <details class="ag-notes cl-notes"><summary>Assumptions</summary><ul>${(r.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`;
}

function winHtml() {
  const w = L.win, { esc, cls, signed, usd } = L.ui;
  if (!L.sel) return "";
  if (!w) return `<div class="cl-win"><h4>Last week and last month</h4><div class="b-skel" style="height:110px"></div></div>`;
  if (w.error) return `<div class="cl-win"><h4>Last week and last month</h4><p class="cl-msg bad">${esc(w.error)}</p></div>`;
  const keys = PRESET_ORDER.filter((k) => WIN.some(([d]) => w.byWindow?.[d]?.byPreset?.[k]));
  const cell = (v) => (v ? `<td class="r ${cls(v.pnlUsd)}">${signed(v.pnlUsd)}<small class="cl-cov"> ${v.returnPct > 0 ? "+" : ""}${Number(v.returnPct).toFixed(1)}%</small></td><td class="r up">${usd(v.feesUsd)}</td><td class="r ${cls(v.ilUsd)}">${signed(v.ilUsd)}</td>` : `<td class="r dim" colspan="3">-</td>`);
  return `<div class="cl-win"><h4>Last week and last month <small class="cl-cov">${usd(Number(L.f.amountUsd))} per range${WIN.map(([d, l]) => (w.byWindow?.[d] && w.byWindow[d].coveredDays < d - 0.5 ? `, ${l}: ${w.byWindow[d].coveredDays} days of history` : "")).join("")}</small></h4>
    <div class="cl-tw"><table class="cl-t"><thead><tr><th rowspan="2">Range</th>${WIN.map(([, l]) => `<th class="r" colspan="3">${l}</th>`).join("")}</tr><tr>${WIN.map(() => `<th class="r">PnL</th><th class="r">Fees</th><th class="r" title="LP value against holding the deposited tokens">vs HODL</th>`).join("")}</tr></thead>
    <tbody>${keys.map((k) => `<tr data-preset="${k}" class="${k === L.preset ? "on" : ""}"><td>${esc(L.presets?.[k]?.label ?? k)}</td>${WIN.map(([d]) => cell(w.byWindow?.[d]?.byPreset?.[k])).join("")}</tr>`).join("")}</tbody></table></div></div>`;
}
async function loadWin() {
  if (!L.sel) return;
  L.win = null; const el = L.el.querySelector("#lpWin"); if (el) el.innerHTML = winHtml();
  try { L.win = await L.ctx.api("/v1/agents/lp/windows", { method: "POST", body: { pool: L.sel, amountUsd: Number(L.f.amountUsd), rebalance: L.f.rebalance } }); }
  catch (e) { L.win = { error: e.message }; }
  const el2 = L.el.querySelector("#lpWin"); if (el2) el2.innerHTML = winHtml();
}
async function backtest(retry = 0) {
  if (!L.sel) return;
  if (!retry) loadWin();
  L.busy = true; L.msg = null; paint();
  try {
    L.res = await L.ctx.api("/v1/agents/lp/backtest", { method: "POST", body: { pool: L.sel, amountUsd: Number(L.f.amountUsd), days: L.f.days, rebalance: L.f.rebalance } });
    L.busy = false; paint();
  } catch (e) {
    if (/still replaying/i.test(e.message) && retry < 6) { setTimeout(() => backtest(retry + 1), 5000); return; }
    L.busy = false; L.res = null; L.msg = { text: e.message, bad: true }; paint();
  }
}
async function start() {
  L.startBusy = true; L.msg = null; paint();
  try {
    const j = await L.ctx.api("/v1/agents", { method: "POST", body: { type: "lp", mode: "paper", params: { pool: L.sel, amountUsd: Number(L.f.amountUsd), preset: L.preset, rebalance: L.f.rebalance } } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    L.ctx.onCreated(bot);
  } catch (e) { L.startBusy = false; L.msg = { text: e.message, bad: true }; paint(); }
}
function onClick(e) {
  const t = e.target.closest("[data-pool],[data-seg],[data-lp],[data-preset]"); if (!t || !L) return;
  if (t.dataset.pool) { if (L.sel !== t.dataset.pool) { L.sel = t.dataset.pool; L.res = null; L.msg = null; L.ctx.setHash?.(`#agents/lp/${t.dataset.pool}`); paint(); backtest(); requestAnimationFrame(() => L.el.querySelector("#lpPanel")?.scrollIntoView({ behavior: "smooth", block: "start" })); } return; }
  if (t.dataset.seg) { const k = t.dataset.seg, v = t.dataset.v; if (k === "days") L.f.days = Number(v); else if (k === "rebalance") { L.f.rebalance = v === "1"; L.win = null; } L.res = null; paint(); return; }
  if (t.dataset.preset) { if (L.preset !== t.dataset.preset) { L.preset = t.dataset.preset; paint(); } return; }
  if (t.dataset.lp === "bt") return void backtest();
  if (t.dataset.lp === "start") return void start();
}
function onInput(e) { if (e.target.dataset?.f === "amountUsd") { L.f.amountUsd = e.target.value; } }
