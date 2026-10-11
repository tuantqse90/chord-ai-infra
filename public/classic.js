// Classic strategies screen (#agents/classic, #agents/classic/<id>), loaded by bots.js on first use. Pick a textbook strategy,
// the market, the venue (Perpl perps or Monad spot), the timeframe, the window, where the signals come from, the size and the
// parameters; Backtest replays it on Binance, OKX, Hyperliquid and Perpl data side by side (POST /v1/classic/backtest,
// source "all"); Start runs it as a paper agent (POST /v1/agents, type "classic"). Every server string is escaped.
const SRC = [["binance", "Binance"], ["okx", "OKX"], ["hyperliquid", "Hyperliquid"], ["perpl", "Perpl"]];
const SRC_NAME = Object.fromEntries(SRC);
const TFS = ["15m", "1h", "4h", "1d"], WINDOWS = [30, 90, 180, 365];
const SPOT = ["BTC", "ETH", "MON"];

let C = null;
export function renderClassic(el, ctx) {
  const { ui, route } = ctx;
  C = { el, ctx, ui, cat: null, symbols: null, err: null, sel: route.strategy, f: null, res: null, resKey: null, busy: false, msg: null, tab: "binance", startBusy: false };
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
  const s = C.cat?.find((x) => x.id === C.sel) ?? C.cat?.[0];
  if (s) pick(s.id, prefill);
  paint();
}
const strat = () => C.cat?.find((x) => x.id === C.sel) ?? null;
function pick(id, prefill) {
  const s = C.cat.find((x) => x.id === id); if (!s) return;
  C.sel = id;
  const p = prefill && prefill.strategy === id ? prefill : null;
  const params = Object.fromEntries(s.params.map((x) => [x.key, p?.params?.[x.key] ?? x.default]));
  C.f = { symbol: p?.symbol ?? C.f?.symbol ?? "BTC", venue: p?.venue ?? (s.sides === "long" ? C.f?.venue ?? "perpl" : C.f?.venue ?? "perpl"), tf: p?.tf ?? s.tf, days: s.days, source: p?.signalSource ?? C.f?.source ?? "binance", sizeUsd: p?.sizeUsd ?? C.f?.sizeUsd ?? 100, leverage: p?.leverage ?? C.f?.leverage ?? 1, params };
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
  body.innerHTML = `<header class="cl-h"><h1>Classic strategies</h1><span class="ag-net" title="Paper trading on Monad"><i aria-hidden="true"></i>Monad</span>${info("<p>Each strategy turns closed candles into a position: long, short or flat (the grid holds a share of the size). The backtest trades each signal at the next candle's open with the venue's fee, a slippage allowance and every funding print of the data source; the size is fixed, nothing compounds. Started, the agent does the same on each new candle in paper mode, and every fill is committed to its record on Monad.</p>", "How classic strategies work")}</header>
    <div class="cl-pick" role="tablist" aria-label="Strategy">${C.cat.map((x) => `<button type="button" data-pick="${esc(x.id)}" class="${x.id === s.id ? "on" : ""}">${esc(x.title)}</button>`).join("")}</div>
    <section class="cl-card">
      <div class="cl-top"><div><h2>${esc(s.title)}</h2><p>${esc(s.line)}</p></div></div>
      <div class="cl-grid">
        ${box("Venue", seg("venue", [["perpl", "Perpl perps"], ["monad_spot", "Monad spot"]], f.venue, !!s.needsFunding))}
        ${field("Market", `<select class="b-in" data-f="symbol">${markets().map((m) => `<option value="${esc(m)}"${m === f.symbol ? " selected" : ""}>${esc(spot ? `${m} (${({ BTC: "cbBTC", ETH: "WETH", MON: "WMON" })[m]})` : `${m}-PERP`)}</option>`).join("")}</select>`, spot ? "Long only, through Chord's router" : perplErr ? esc(perplErr) : `Perpl taker fee ${C.symbols?.perpl?.markets?.[0]?.takerFeeBps ?? 3.45} bps`)}
        ${box("Timeframe", seg("tf", TFS.map((t) => [t, t]), f.tf))}
        ${box("Window", seg("days", WINDOWS.map((d) => [d, `${d}d`]), f.days))}
        ${field("Signals from", `<select class="b-in" data-f="source">${SRC.map(([v, l]) => `<option value="${v}"${v === f.source ? " selected" : ""}>${l}</option>`).join("")}</select>`, "Where the live agent reads its candles")}
        ${field("Size ($)", `<input class="b-in" type="number" data-f="sizeUsd" min="10" max="1000" step="10" value="${esc(f.sizeUsd)}" inputmode="decimal">`, "10 to 1,000 per position")}
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
  if (!ok.length) return `<section class="cl-card"><p class="cl-msg bad">${esc(Object.entries(r.errors ?? {}).map(([k, v]) => `${SRC_NAME[k]}: ${v}`).join(" · ") || "No source could replay this.")}</p></section>`;
  if (!rs[C.tab]) C.tab = ok[0][0];
  const any = rs[ok[0][0]];
  const row = ([k, l]) => {
    const x = rs[k];
    if (!x) return `<tr class="dim"><td>${l}</td><td colspan="9">${esc(r.errors?.[k] ?? "no replay")}</td></tr>`;
    return `<tr class="${k === C.tab ? "on" : ""}" data-tab="${k}"><td>${l}</td><td class="r ${cls(x.returnPct)}">${x.returnPct > 0 ? "+" : ""}${Number(x.returnPct).toFixed(2)}%</td><td class="r ${cls(x.pnlUsd)}">${signed(x.pnlUsd)}</td><td class="r">${x.buyHoldPct > 0 ? "+" : ""}${Number(x.buyHoldPct).toFixed(1)}%</td><td class="r">${Number(x.maxDrawdownPct).toFixed(1)}%</td><td class="r">${x.sharpe ?? "—"}</td><td class="r">${pct(x.winRate)}</td><td class="r">${int(x.tradeCount)}</td><td class="r">${usd(x.feesUsd)}</td><td class="r ${cls(x.fundingUsd)}">${signed(x.fundingUsd)}</td></tr>`;
  };
  const x = rs[C.tab];
  const trades = (x.trades ?? []).slice(-12).reverse();
  const when = (ms) => (ms ? new Date(ms).toISOString().slice(5, 16).replace("T", " ") : "open");
  return `<section class="cl-card">
      <div class="cl-rh"><h3>${esc(any.title)} · ${esc(any.symbol)} ${esc(any.tf)} · ${int(any.days)} days</h3><small>${esc(any.rule)}</small></div>
      <div class="cl-tw"><table class="cl-t"><thead><tr><th>Data</th><th class="r">Return</th><th class="r">PnL</th><th class="r" title="Holding the same size long over the window">Hold</th><th class="r">Max DD</th><th class="r">Sharpe</th><th class="r">Win</th><th class="r">Trades</th><th class="r">Fees</th><th class="r">Funding</th></tr></thead><tbody>${SRC.map(row).join("")}</tbody></table></div>
      ${r.note ? `<p class="cl-msg bad">${esc(r.note)}</p>` : r.agree ? `<p class="cl-msg">The four sources agree on the sign${r.spreadPct != null ? ` (spread ${r.spreadPct} points)` : ""}.</p>` : ""}
      <div class="cl-tabs">${ok.map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === C.tab ? "on" : ""}">${l}</button>`).join("")}</div>
      ${equityHtml((x.equity ?? []).map((p) => ({ ts: p.t, usd: p.usd })), `Equity on ${SRC_NAME[C.tab]} data`)}
      ${trades.length ? `<div class="cl-trades"><div class="cl-trh"><span>Side</span><span>Entry</span><span>Exit</span><span class="r">Entry</span><span class="r">Exit</span><span class="r">PnL</span></div>${trades.map((t) => `<div><span><em class="b-pside ${t.side === "short" ? "sell" : "buy"}">${t.side === "short" ? "Short" : "Long"}</em></span><span>${when(t.entryTs)}</span><span>${when(t.exitTs)}</span><span class="r">${usd(t.entryPx)}</span><span class="r">${t.exitPx != null ? usd(t.exitPx) : "—"}</span><span class="r ${cls(t.pnlUsd)}">${signed(t.pnlUsd)}</span></div>`).join("")}</div>` : `<p class="cl-msg">No trades in this window.</p>`}
      <details class="ag-notes cl-notes"><summary>Assumptions</summary><ul>${(x.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>
    </section>`;
}

const input = () => ({ strategy: C.sel, params: C.f.params, symbol: C.f.symbol, tf: C.f.tf, days: C.f.days, venue: C.f.venue, sizeUsd: Number(C.f.sizeUsd), leverage: C.f.venue === "perpl" ? Number(C.f.leverage) : 1 });
async function backtest(retry = 0) {
  C.busy = true; C.msg = null; paint();
  try {
    const r = await C.ctx.api("/v1/classic/backtest", { method: "POST", body: { ...input(), source: "all" } });
    C.res = r; C.busy = false; paint();
    C.el.querySelector("#clRes")?.scrollIntoView({ behavior: "smooth", block: "start" });
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

function onClick(e) {
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
  if (t.dataset.f) { C.f[t.dataset.f] = t.value; if (e.type === "change") { C.res = null; if (t.tagName === "SELECT") paint(); } }
  else if (t.dataset.p) { C.f.params[t.dataset.p] = t.value === "" ? "" : Number(t.value); }
}
