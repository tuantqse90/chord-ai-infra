// Classic strategies screen (#agents/classic, #agents/classic/<id>), loaded by bots.js on first use. Pick a textbook strategy,
// the market, the venue (Perpl perps or Monad spot), the timeframe, the window, where the signals come from, the size and the
// parameters; Backtest replays it on Binance, OKX, Hyperliquid and Perpl data side by side (POST /v1/classic/backtest,
// source "all"); Start runs it as a paper agent (POST /v1/agents, type "classic"). Every server string is escaped.
const SRC = [["binance", "Binance"], ["okx", "OKX"], ["hyperliquid", "Hyperliquid"], ["perpl", "Perpl"]];
const SRC_NAME = Object.fromEntries(SRC);
const TFS = ["15m", "1h", "4h", "1d"], WINDOWS = [[30, "1M"], [90, "3M"], [180, "6M"], [365, "1Y"], [730, "2Y"], [1095, "3Y"]];
const BW = [[30, "1M"], [90, "3M"], [180, "6M"]];
const SPOT = ["BTC", "ETH", "MON"];

let C = null;
export function renderClassic(el, ctx) {
  const { ui, route } = ctx;
  C = { el, ctx, ui, cat: null, symbols: null, err: null, sel: route.strategy, f: null, res: null, resKey: null, busy: false, msg: null, tab: "binance", startBusy: false,
    board: null, bf: { symbol: "", tf: "", win: 180, positive: false, all: false }, win: null, bBusy: null,
    // opened on one strategy (a link, a board row): its form is the point, so the page lands on it, not on the board
    jumpUntil: route.strategy ? Date.now() + 6000 : 0 };
  el.innerHTML = `${ctx.crumb()}<div id="clBody"><div class="b-skel" style="height:44px;width:40%"></div><div class="b-skel" style="height:240px;margin-top:18px"></div></div>`;
  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  el.addEventListener("change", onInput);
  load(route.prefill);
}
async function load(prefill) {
  try {
    const [cat, sym] = await Promise.all([C.ctx.api("/v1/classic/strategies"), C.ctx.api("/v1/classic/symbols")]);
    C.cat = cat.strategies; C.symbols = sym;
  } catch (e) { C.err = e.message; }
  loadBoard();
  const s = C.cat?.find((x) => x.id === C.sel) ?? C.cat?.[0];
  if (s) pick(s.id, prefill);
  paint();
  jump();
  if (s && prefill?.symbol && prefill.strategy === s.id) backtest(); // a setup picked elsewhere (a board row, an agent's Fork): show its replay
}
function jump() {
  if (!C?.jumpUntil || Date.now() > C.jumpUntil) return;
  requestAnimationFrame(() => C?.el?.querySelector(".cl-h")?.scrollIntoView({ block: "start" }));
}
async function loadBoard() {
  try { C.board = await C.ctx.api("/v1/classic/board"); } catch { C.board = { rows: [], building: false, error: true }; }
  const el = C.el.querySelector("#clBoard"); if (el) el.innerHTML = boardHtml();
  jump();
  if (C.board?.building && !C.board.rows?.length) setTimeout(() => { if (C?.el?.isConnected) loadBoard(); }, 30_000);
}
const titleOf = (id) => C.cat?.find((x) => x.id === id)?.title ?? id;
const SRCS = { binance: "Binance", okx: "OKX", hyperliquid: "Hyperliquid", perpl: "Perpl" };
function cellHtml(cell, w) {
  const { cls } = C.ui;
  if (!cell || cell.median == null) return `<td class="r dim" title="No source covers this window">-</td>`;
  const tip = Object.entries(cell.bySource ?? {}).map(([k, v]) => `${SRCS[k] ?? k} ${v.returnPct > 0 ? "+" : ""}${v.returnPct}%${v.coveredDays < w * 0.9 ? ` (${v.coveredDays}d only)` : ""}`).join(", ");
  return `<td class="r ${cls(cell.median)}${cell.agree === false ? " cl-dis" : ""}" title="${C.ui.esc(tip)}${cell.agree === false ? ", the sources disagree" : ""}">${cell.median > 0 ? "+" : ""}${Number(cell.median).toFixed(1)}%</td>`;
}
function boardHtml() {
  const { esc, ic, int } = C.ui, b = C.board, f = C.bf;
  if (!b) return `<div class="b-skel" style="height:180px"></div>`;
  if (!b.rows?.length) return `<p class="cl-msg">${b.building ? "Building the board: every strategy on every Perpl market over the last 1, 3 and 6 months, on four data sources. It takes a few minutes." : b.error ? "The board did not load." : "No board yet."}</p>`;
  const m = (r, w) => r.windows?.[w]?.median;
  let rows = b.rows.filter((r) => (!f.symbol || r.symbol === f.symbol) && (!f.tf || r.tf === f.tf));
  if (f.positive) rows = rows.filter((r) => BW.every(([w]) => (m(r, w) ?? -1) > 0 && r.windows[w].agree !== false));
  rows = rows.filter((r) => m(r, f.win) != null).sort((a, c) => m(c, f.win) - m(a, f.win));
  const shown = f.all ? rows : rows.slice(0, 25);
  const ago = b.at ? Math.max(1, Math.round((Date.now() - b.at) / 60000)) : null;
  const seg = (name, opts, cur) => `<div class="b-seg sm">${opts.map(([v, l]) => `<button type="button" data-bf="${name}" data-v="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  return `<div class="cl-bh"><div><h2>Backtest board</h2><small>${int(b.rows.length)} setups, each replayed over 1, 3 and 6 months on 4 data sources${ago ? `, updated ${ago < 120 ? `${ago} min` : `${Math.round(ago / 60)} h`} ago` : ""}${b.building ? ", refreshing" : ""}</small></div>
      <div class="cl-bf"><select class="b-in" data-bsel="symbol"><option value="">All markets</option>${(b.markets ?? []).map((x) => `<option${x === f.symbol ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>${seg("tf", [["", "All"], ["1h", "1h"], ["4h", "4h"]], f.tf)}${seg("win", BW.map(([w, l]) => [w, `Sort ${l}`]), f.win)}${seg("positive", [["0", "All"], ["1", "Up in all 3"]], f.positive ? "1" : "0")}</div></div>
    <div class="cl-tw"><table class="cl-t cl-board"><thead><tr><th>Strategy</th><th>Market</th><th>TF</th>${BW.map(([w, l]) => `<th class="r${w === f.win ? " on" : ""}">${l}</th>`).join("")}<th class="r" title="Median max drawdown over 6 months">Max DD 6M</th><th class="r">Trades 6M</th><th class="r" title="Holding the market long over 6 months">Hold 6M</th><th></th></tr></thead>
      <tbody>${shown.map((r) => { const k = `${r.symbol}|${r.strategy}|${r.tf}`; return `<tr><td>${esc(titleOf(r.strategy))}</td><td><b>${esc(r.symbol)}</b></td><td>${esc(r.tf)}</td>${BW.map(([w]) => cellHtml(r.windows?.[w], w)).join("")}<td class="r">${r.windows?.[180]?.maxDrawdownPct != null ? `${Number(r.windows[180].maxDrawdownPct).toFixed(0)}%` : "-"}</td><td class="r">${r.windows?.[180]?.trades ?? "-"}</td><td class="r">${r.holdPct?.[180] != null ? `${r.holdPct[180] > 0 ? "+" : ""}${Number(r.holdPct[180]).toFixed(0)}%` : "-"}</td>
        <td class="r cl-ba"><button type="button" class="b-btn sm" data-bopen="${esc(k)}">Open</button><button type="button" class="b-btn sm pri" data-bstart="${esc(k)}"${C.bBusy === k ? " disabled" : ""}>${C.bBusy === k ? ic("spin") : ""}Start</button></td></tr>`; }).join("")}</tbody></table></div>
    ${rows.length > 25 ? `<button type="button" class="ag-lbmore" data-bf="all" data-v="${f.all ? "0" : "1"}">${f.all ? "Show the top 25" : `Show all ${int(rows.length)}`}</button>` : ""}
    <p class="cl-msg">Median of the sources that cover at least 90% of each window; hover a number for each source. $1,000 at 1x on Perpl, default parameters, fees and funding counted. History, not a forecast.</p>`;
}
const strat = () => C.cat?.find((x) => x.id === C.sel) ?? null;
// the strategy list, by family (an id the server adds later falls under Other)
const FAMILIES = [
  ["Trend", ["golden-cross", "ema-cross", "macd-cross", "triple-ma", "kama", "tsmom", "donchian", "keltner", "bollinger-breakout", "supertrend", "psar", "ichimoku", "adx"]],
  ["Mean reversion", ["rsi-reversion", "bollinger-reversion", "connors-rsi2", "stochastic"]],
  ["Grid", ["grid", "grid-trailing"]],
  ["Carry", ["funding-carry"]],
  ["Other", null],
];
const FAMILY_OF = new Set(FAMILIES.flatMap(([, ids]) => ids ?? []));
function pick(id, prefill) {
  const s = C.cat.find((x) => x.id === id); if (!s) return;
  C.sel = id;
  const p = prefill && prefill.strategy === id ? prefill : null;
  const params = Object.fromEntries(s.params.map((x) => [x.key, p?.params?.[x.key] ?? x.default]));
  C.f = { symbol: p?.symbol ?? C.f?.symbol ?? "BTC", venue: p?.venue ?? (s.sides === "long" ? C.f?.venue ?? "perpl" : C.f?.venue ?? "perpl"), tf: p?.tf ?? s.tf, days: s.days, source: p?.signalSource ?? C.f?.source ?? "binance", sizeUsd: p?.sizeUsd ?? C.f?.sizeUsd ?? 1000, leverage: p?.leverage ?? C.f?.leverage ?? 1, params };
  if (s.needsFunding) C.f.venue = "perpl";
  C.res = null; C.msg = null;
  C.ctx.setHash?.(`#agents/classic/${encodeURIComponent(id)}`);
}
const markets = () => (C.f.venue === "monad_spot" ? SPOT : (C.symbols?.perpl?.markets ?? []).map((m) => m.symbol));
const maxLev = () => Math.min(3, (C.symbols?.perpl?.markets ?? []).find((m) => m.symbol === C.f.symbol)?.maxLeverage ?? 3);
const seg = (name, opts, cur, dis = false) => `<div class="b-seg sm" role="radiogroup">${opts.map(([v, l]) => `<button type="button" data-seg="${name}" data-v="${v}" class="${String(v) === String(cur) ? "on" : ""}" role="radio" aria-checked="${String(v) === String(cur)}"${dis ? " disabled" : ""}>${l}</button>`).join("")}</div>`;
const field = (label, html, hint = "") => `<label class="b-field cl-f"><span>${label}</span>${html}${hint ? `<small>${hint}</small>` : ""}</label>`;
const box = (label, html) => `<div class="b-field cl-f"><span>${label}</span>${html}</div>`;

function paint() {
  const body = C.el.querySelector("#clBody"); if (!body) return;
  const { esc, ic, errBox, info } = C.ui;
  if (C.err && !C.cat) { body.innerHTML = errBox(C.err, "retry-cls"); return; }
  const s = strat(); if (!s) return;
  const f = C.f, spot = f.venue === "monad_spot";
  if (!markets().includes(f.symbol)) f.symbol = markets()[0] ?? "BTC";
  if (f.leverage > maxLev()) f.leverage = 1;
  const perplErr = C.symbols?.perpl?.error;
  const params = s.params.map((p) => p.key === "shorts"
    ? box("Shorts", seg("p:shorts", [[0, "Off"], [1, "On"]], spot ? 0 : f.params.shorts, spot))
    : field(esc(p.label), `<input class="b-in" type="number" data-p="${esc(p.key)}" min="${p.min}" max="${p.max}" step="${p.step}" value="${esc(f.params[p.key])}" inputmode="decimal">`, `${p.min} to ${p.max}`)).join("");
  body.innerHTML = `<section class="cl-card cl-boardc" id="clBoard">${boardHtml()}</section><header class="cl-h"><h1>Strategies</h1>${info("<p>Each strategy turns closed candles into a position: long, short or flat (the grid holds a share of the size). The backtest trades each signal at the next candle's open with the venue's fee, a slippage allowance and every funding print of the data source; the size is fixed, nothing compounds. Started, the agent does the same on each new candle in paper mode, and every fill is committed to its record on Monad.</p>", "How classic strategies work")}</header>
    <label class="cl-strat"><span>Strategy</span><select class="b-in" data-pickst aria-label="Strategy">${FAMILIES.map(([fam, ids]) => { const xs = C.cat.filter((x) => (ids ? ids.includes(x.id) : !FAMILY_OF.has(x.id))); return xs.length ? `<optgroup label="${esc(fam)}">${xs.map((x) => `<option value="${esc(x.id)}"${x.id === s.id ? " selected" : ""}>${esc(x.title)}</option>`).join("")}</optgroup>` : ""; }).join("")}</select></label>
    <section class="cl-card">
      <div class="cl-top"><div><h2>${esc(s.title)}</h2><p>${esc(s.line)}</p></div></div>
      <div class="cl-grid">
        ${box("Venue", seg("venue", [["perpl", "Perpl perps"], ["monad_spot", "Monad spot"]], f.venue, !!s.needsFunding))}
        ${field("Market", `<select class="b-in" data-f="symbol">${markets().map((m) => `<option value="${esc(m)}"${m === f.symbol ? " selected" : ""}>${esc(spot ? `${m} (${({ BTC: "cbBTC", ETH: "WETH", MON: "WMON" })[m]})` : `${m}-PERP`)}</option>`).join("")}</select>`, spot ? "Long only, through Chord's router" : perplErr ? esc(perplErr) : `Perpl taker fee ${C.symbols?.perpl?.markets?.[0]?.takerFeeBps ?? 3.45} bps`)}
        ${box("Timeframe", seg("tf", TFS.map((t) => [t, t]), f.tf))}
        ${box("Window", seg("days", WINDOWS, f.days))}
        ${field("Signals from", `<select class="b-in" data-f="source">${SRC.map(([v, l]) => `<option value="${v}"${v === f.source ? " selected" : ""}>${l}</option>`).join("")}</select>`, "Where the live agent reads its candles")}
        ${field("Size ($)", `<input class="b-in" type="number" data-f="sizeUsd" min="10" max="10000" step="100" value="${esc(f.sizeUsd)}" inputmode="decimal">`, "10 to 10,000 per position")}
        ${spot ? "" : box("Leverage", seg("leverage", [1, 2, 3].filter((x) => x <= maxLev()).map((x) => [x, `${x}x`]), f.leverage))}
        ${params}
      </div>
      <div class="cl-act"><button type="button" class="b-new" data-cl="bt"${C.busy ? " disabled" : ""}>${ic(C.busy ? "spin" : "chart")}${C.busy ? "Replaying on 4 sources…" : "Backtest on 4 sources"}</button>
        <button type="button" class="b-btn" data-cl="start"${C.startBusy ? " disabled" : ""}>${ic(C.startBusy ? "spin" : "play")}${spot ? "Start on Monad spot" : "Start on Perpl"}</button>
        ${C.msg ? `<span class="cl-msg ${C.msg.bad ? "bad" : ""}">${esc(C.msg.text)}</span>` : ""}</div>
    </section>
    <div id="clRes">${results()}</div>`;
}

function results() {
  const r = C.res; if (!r) return "";
  const { esc, usd, signed, cls, pct, int, equityHtml } = C.ui;
  const rs = r.results ?? {}, ok = SRC.filter(([k]) => rs[k]);
  if (!ok.length) return `<section class="cl-card"><p class="cl-msg bad">${esc(Object.entries(r.errors ?? {}).map(([k, v]) => `${SRC_NAME[k]}: ${v}`).join(", ") || "No source could replay this.")}</p></section>`;
  if (!rs[C.tab]) C.tab = ok[0][0];
  const any = rs[ok[0][0]];
  const row = ([k, l]) => {
    const x = rs[k];
    if (!x) return `<tr class="dim"><td>${l}</td><td colspan="9">${esc(r.errors?.[k] ?? "no replay")}</td></tr>`;
    return `<tr class="${k === C.tab ? "on" : ""}" data-tab="${k}"><td>${l}${x.coveredDays < x.days - 2 ? `<small class="cl-cov" title="This source's history covers ${int(x.coveredDays)} of the ${int(x.days)} days"> ${int(x.coveredDays)}d</small>` : ""}</td><td class="r ${cls(x.returnPct)}">${x.returnPct > 0 ? "+" : ""}${Number(x.returnPct).toFixed(2)}%</td><td class="r ${cls(x.pnlUsd)}">${signed(x.pnlUsd)}</td><td class="r">${x.buyHoldPct > 0 ? "+" : ""}${Number(x.buyHoldPct).toFixed(1)}%</td><td class="r">${Number(x.maxDrawdownPct).toFixed(1)}%</td><td class="r">${x.sharpe ?? "-"}</td><td class="r">${pct(x.winRate)}</td><td class="r">${int(x.tradeCount)}</td><td class="r">${usd(x.feesUsd)}</td><td class="r ${cls(x.fundingUsd)}">${signed(x.fundingUsd)}</td></tr>`;
  };
  const x = rs[C.tab];
  const trades = (x.trades ?? []).slice(-12).reverse();
  const when = (ms) => (ms ? new Date(ms).toISOString().slice(5, 16).replace("T", " ") : "open");
  return `<section class="cl-card">
      <div class="cl-rh"><h3>${esc(any.title)}, ${esc(any.symbol)} ${esc(any.tf)}, ${int(any.days)} days, ${usd(any.sizeUsd)}${any.venue === "perpl" ? ` at ${any.leverage}x` : ""}</h3><small>${esc(any.rule)}</small></div>
      <div class="cl-tw"><table class="cl-t"><thead><tr><th>Data</th><th class="r">Return</th><th class="r">PnL</th><th class="r" title="Holding the same size long over the window">Hold</th><th class="r">Max DD</th><th class="r">Sharpe</th><th class="r">Win</th><th class="r">Trades</th><th class="r">Fees</th><th class="r">Funding</th></tr></thead><tbody>${SRC.map(row).join("")}</tbody></table></div>
      ${r.note ? `<p class="cl-msg bad">${esc(r.note)}</p>` : r.agree ? `<p class="cl-msg">The four sources agree on the sign${r.spreadPct != null ? ` (spread ${r.spreadPct} points)` : ""}.</p>` : ""}
      <div class="cl-tabs">${ok.map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === C.tab ? "on" : ""}">${l}</button>`).join("")}</div>
      ${winHtml()}
      ${equityHtml((x.equity ?? []).map((p) => ({ ts: p.t, usd: p.usd })), `Equity on ${SRC_NAME[C.tab]} data`)}
      ${trades.length ? `<div class="cl-trades"><div class="cl-trh"><span>Side</span><span>Entry</span><span>Exit</span><span class="r">Entry</span><span class="r">Exit</span><span class="r">PnL</span></div>${trades.map((t) => `<div><span><em class="b-pside ${t.side === "short" ? "sell" : "buy"}">${t.side === "short" ? "Short" : "Long"}</em></span><span>${when(t.entryTs)}</span><span>${when(t.exitTs)}</span><span class="r">${usd(t.entryPx)}</span><span class="r">${t.exitPx != null ? usd(t.exitPx) : "-"}</span><span class="r ${cls(t.pnlUsd)}">${signed(t.pnlUsd)}</span></div>`).join("")}</div>` : `<p class="cl-msg">No trades in this window.</p>`}
      <details class="ag-notes cl-notes"><summary>Assumptions</summary><ul>${(x.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>
    </section>`;
}

function winHtml() {
  const w = C.win, { cls, esc } = C.ui;
  if (!w) return `<div class="cl-win"><h4>Last 1, 3 and 6 months</h4><div class="b-skel" style="height:90px"></div></div>`;
  if (w.error) return `<div class="cl-win"><h4>Last 1, 3 and 6 months</h4><p class="cl-msg bad">${esc(w.error)}</p></div>`;
  const cell = (v, d, cov) => (v == null ? `<td class="r dim">-</td>` : `<td class="r ${cls(v)}">${v > 0 ? "+" : ""}${Number(v).toFixed(1)}%${cov != null && cov < d * 0.9 ? `<small class="cl-cov"> ${cov}d</small>` : ""}</td>`);
  return `<div class="cl-win"><h4>Last 1, 3 and 6 months</h4><div class="cl-tw"><table class="cl-t"><thead><tr><th>Data</th>${BW.map(([, l]) => `<th class="r">${l}</th>`).join("")}</tr></thead><tbody>
    <tr><td><b>Median</b></td>${BW.map(([d]) => cell(w.byWindow?.[d]?.median, d, null)).join("")}</tr>
    ${SRC.map(([k, l]) => `<tr><td>${l}</td>${BW.map(([d]) => { const v = w.byWindow?.[d]?.bySource?.[k]; return cell(v?.returnPct, d, v?.coveredDays); }).join("")}</tr>`).join("")}
    <tr class="dim"><td>Hold</td>${BW.map(([d]) => cell(w.byWindow?.[d]?.holdPct, d, null)).join("")}</tr></tbody></table></div></div>`;
}
async function loadWindows() {
  const { days: _d, ...rest } = input();
  C.win = null;
  try { C.win = await C.ctx.api("/v1/classic/windows", { method: "POST", body: rest }); }
  catch (e) { C.win = { error: e.message }; }
  const r = C.el.querySelector("#clRes"); if (r && C.res) r.innerHTML = results();
}
const input = () => ({ strategy: C.sel, params: C.f.params, symbol: C.f.symbol, tf: C.f.tf, days: C.f.days, venue: C.f.venue, sizeUsd: Number(C.f.sizeUsd), leverage: C.f.venue === "perpl" ? Number(C.f.leverage) : 1 });
async function backtest(retry = 0) {
  C.busy = true; C.msg = null; paint();
  try {
    const r = await C.ctx.api("/v1/classic/backtest", { method: "POST", body: { ...input(), source: "all" } });
    C.res = r; C.busy = false; paint();
    C.el.querySelector("#clRes")?.scrollIntoView({ behavior: "smooth", block: "start" });
    loadWindows();
  } catch (e) {
    if (/still replaying/i.test(e.message) && retry < 6) { setTimeout(() => backtest(retry + 1), 5000); return; }
    C.busy = false; C.msg = { text: e.message, bad: true }; paint();
  }
}
async function start() {
  C.startBusy = true; C.msg = null; paint();
  try {
    const { days: _days, ...params } = input();
    const j = await C.ctx.api("/v1/agents", { method: "POST", body: { type: "classic", mode: "paper", params: { ...params, signalSource: C.f.source, templateId: C.sel } } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    C.ctx.onCreated(bot);
  } catch (e) { C.startBusy = false; C.msg = { text: e.message, bad: true }; paint(); }
}

async function boardStart(k, btn) {
  const [symbol, strategy, tf] = k.split("|");
  C.bBusy = k; const el = C.el.querySelector("#clBoard"); if (el) el.innerHTML = boardHtml();
  try {
    const j = await C.ctx.api("/v1/agents", { method: "POST", body: { type: "classic", mode: "paper", params: { strategy, symbol, tf, venue: "perpl", sizeUsd: 1000, leverage: 1, signalSource: "binance", templateId: strategy } } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    C.ctx.onCreated(bot);
  } catch (e) { C.bBusy = null; C.msg = { text: e.message, bad: true }; paint(); }
}
function onClick(e) {
  const bt = e.target.closest("[data-bf],[data-bopen],[data-bstart]");
  if (bt && C) {
    if (bt.dataset.bopen) {
      const [symbol, strategy, tf] = bt.dataset.bopen.split("|");
      pick(strategy); Object.assign(C.f, { symbol, tf, venue: "perpl", days: C.bf.win }); paint();
      C.el.querySelector(".cl-h")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return void backtest();
    }
    if (bt.dataset.bstart) return void boardStart(bt.dataset.bstart, bt);
    const k = bt.dataset.bf, v = bt.dataset.v;
    if (k === "win") C.bf.win = Number(v); else if (k === "positive") C.bf.positive = v === "1"; else if (k === "all") C.bf.all = v === "1"; else C.bf[k] = v;
    const el = C.el.querySelector("#clBoard"); if (el) el.innerHTML = boardHtml();
    return;
  }
  const t = e.target.closest("[data-pick],[data-seg],[data-cl],[data-tab]"); if (!t || !C) return;
  if (t.dataset.pick) { if (t.dataset.pick !== C.sel) { pick(t.dataset.pick); paint(); } return; }
  if (t.dataset.seg) {
    const k = t.dataset.seg, v = t.dataset.v;
    if (k.startsWith("p:")) C.f.params[k.slice(2)] = Number(v);
    else if (k === "venue") C.f.venue = v;
    else if (k === "days" || k === "leverage") C.f[k] = Number(v);
    else C.f[k] = v;
    C.res = null; paint(); return;
  }
  if (t.dataset.tab) { if (C.res && C.tab !== t.dataset.tab) { C.tab = t.dataset.tab; const r = C.el.querySelector("#clRes"); if (r) r.innerHTML = results(); } return; }
  if (t.dataset.cl === "bt") return void backtest();
  if (t.dataset.cl === "start") return void start();
}
function onInput(e) {
  const t = e.target; if (!C?.f) return;
  if (t.hasAttribute("data-pickst")) { if (e.type === "change" && t.value !== C.sel) { C.jumpUntil = 0; pick(t.value); paint(); } return; }
  if (t.dataset.bsel) { C.bf[t.dataset.bsel] = t.value; const el = C.el.querySelector("#clBoard"); if (el) el.innerHTML = boardHtml(); return; }
  if (t.dataset.f) { C.f[t.dataset.f] = t.value; if (e.type === "change") { C.res = null; if (t.tagName === "SELECT") paint(); } }
  else if (t.dataset.p) { C.f.params[t.dataset.p] = t.value === "" ? "" : Number(t.value); }
}
