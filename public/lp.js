// LP pools screen (#agents/lp, #agents/lp/<pool>), loaded by bots.js on first use.
// List: the Monad pools this app can model (GET /v1/agents/lp/scan, Chord's LP index) with what they paid in 24 h, and the
// paper LP agents already running in them (GET /v1/agents/board, type "lp") with their PnL so far.
// Pool page: every range preset replayed against HODL on the pool's own hours (POST /v1/agents/lp/backtest, /windows), the
// range drawn around today's price, then Start (POST /v1/agents, type "lp") or Copy an agent already in the pool.
// Every number on this screen comes from those answers; every server string is escaped.
const PRESET_ORDER = ["tight", "balanced", "wide", "full"];
const DAYS = [1, 3, 7, 30];
const WIN = [[7, "1 week"], [30, "1 month"]];
const AMOUNTS = [500, 1000, 2000, 5000];
const SORTS = [["feeAprPct", "APR"], ["volume24hUsd", "Volume"], ["tvlUsd", "TVL"], ["fees24hUsd", "Fees"]];
const DEX = { uniswap_v3: "Uniswap V3", capricorn: "Capricorn", nadfun_dex: "nad.fun", atlantis: "Atlantis", pancake_v3: "PancakeSwap V3" };
const STABLE = new Set(["USDC", "AUSD", "USDT0", "USDT", "USDm"]);
// how a range looks next to the others: the share of a ±50% price span it covers, and how tall its liquidity stands
const SHAPE = { tight: [0.05, 1], balanced: [0.15, 0.64], wide: [0.4, 0.42], full: [1, 0.26] };
let L = null;

export function renderLp(el, ctx) {
  L = { el, ctx, ui: ctx.ui, pools: null, agents: [], err: null, sel: ctx.route.pool ?? null, f: { amountUsd: 1000, days: 30, rebalance: true }, res: null, busy: false, msg: null, preset: "balanced", picked: false, startBusy: false, copyBusy: null, win: null, q: "", sort: "feeAprPct", timer: null };
  el.innerHTML = `<div id="lpCrumb">${ctx.crumb()}</div><div id="lpBody" class="lp"><div class="b-skel" style="height:86px"></div><div class="b-skel" style="height:150px;margin-top:18px"></div><div class="b-skel" style="height:320px;margin-top:18px"></div></div>`;
  el.addEventListener("click", onClick);
  el.addEventListener("input", onInput);
  load();
}
async function load() {
  const me = L;
  const [scan, board] = await Promise.allSettled([me.ctx.api("/v1/agents/lp/scan"), me.ctx.api("/v1/agents/board?window=all")]);
  if (L !== me) return;
  if (scan.status === "fulfilled") { L.pools = scan.value.pools ?? []; L.presets = scan.value.presets; L.err = null; }
  else L.err = scan.reason?.message ?? "no answer";
  if (board.status === "fulfilled") L.agents = (board.value.agents ?? []).filter((a) => a.type === "lp" && a.status === "running" && a.params?.pool);
  paint();
  if (L.sel && poolOf()) backtest();
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────
const poolOf = (addr = L.sel) => L.pools?.find((p) => p.pool === addr) ?? null;
const money = (v) => { const n = Number(v) || 0; return n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `$${n.toFixed(0)}`; };
const pctTxt = (v, d = 2) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(Number(v)).toFixed(d)}%`;
/** a price with four figures that matter, whatever its size: 84,007 / 0.02653 / 0.00008216 */
const px = (v) => { const n = Number(v); if (!(n > 0)) return "-"; return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 100 ? 2 : 4 }) : n.toFixed(Math.min(12, 3 - Math.floor(Math.log10(n)))); };
const age = (ms) => { const h = (Date.now() - Number(ms)) / 3600e3; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`; };
const capOf = (a) => Number(a.params?.amountUsd) || 0;
const retOf = (a) => (capOf(a) > 0 ? ((Number(a.pnlAll) || 0) / capOf(a)) * 100 : null);
const agentsOf = (pool) => L.agents.filter((a) => a.params.pool === pool).sort((x, y) => (Number(y.pnlAll) || 0) - (Number(x.pnlAll) || 0));
const presetName = (k) => String(L.presets?.[k]?.label ?? k).replace(/\s*±.*$/, "").replace(/\s+range$/i, "");
const presetSpan = (k) => (L.presets?.[k]?.width != null ? `±${Math.round(L.presets[k].width * 100)}%` : "all prices");
const dayLabel = (d) => (d === 30 ? "1 month" : d === 7 ? "1 week" : `${d} day${d === 1 ? "" : "s"}`);
/** the anchor token's dollar price: 1 for a stable, else the price of its own pool against a stable (WMON/USDC) */
function anchorUsd(p) {
  if (STABLE.has(p.anchor.symbol)) return 1;
  const ref = L.pools.find((x) => x.side.address === p.anchor.address && STABLE.has(x.anchor.symbol) && x.priceUsd > 0);
  return ref ? ref.priceUsd : null;
}
/** today's price in the pool's own terms (anchor per side token), the unit a range is opened in */
const poolPrice = (p) => { const a = anchorUsd(p); return a && p.priceUsd > 0 ? p.priceUsd / a : null; };
const pairLogos = (x) => `<span class="lp-pl">${L.ui.tokLogo(x.side.symbol, x.side.logo ?? null, "", x.side.address)}${L.ui.tokLogo(x.anchor.symbol, x.anchor.logo ?? null, "", x.anchor.address)}</span>`;
const chips = (x) => `<span class="lp-ch"><i class="lp-dex">${L.ui.esc(DEX[x.dex] ?? x.dex)}</i><i>${(x.feeBps / 100).toFixed(2)}%</i>${x.concentrated ? "" : "<i>full range</i>"}</span>`;
function spark(a) {
  const v = (a ?? []).map(Number).filter(Number.isFinite);
  if (v.length < 2) return "";
  const lo = Math.min(...v, 0), hi = Math.max(...v, 0), w = 120, h = 40, k = (hi - lo) || 1;
  const line = v.map((x, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * w).toFixed(1)} ${(h - 2 - ((x - lo) / k) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="mkc-spk ${v[v.length - 1] > 0 ? "up" : v[v.length - 1] < 0 ? "down" : ""}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${line} L${w} ${h} L0 ${h} Z" fill="currentColor" fill-opacity=".09" stroke="none"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
/** a range as bars over a ±50% price span: n bars, the price in the middle, the bars the range covers standing on each side */
function bars(k, n, cls = "") {
  const [w, h] = SHAPE[k] ?? SHAPE.balanced, mid = (n - 1) / 2, reach = w >= 1 ? mid : Math.max(1, Math.round((w / 0.5) * mid));
  let out = "";
  for (let i = 0; i < n; i++) {
    const inside = Math.abs(i - mid) <= reach;
    out += `<i class="${i === mid ? "m" : inside ? (i < mid ? "a" : "b") : "o"}" style="height:${inside ? Math.round(h * 100) : 6}%"></i>`;
  }
  return `<span class="lp-bars ${cls}" aria-hidden="true">${out}</span>`;
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function paint() {
  const body = L.el.querySelector("#lpBody"), crumb = L.el.querySelector("#lpCrumb"); if (!body) return;
  const { errBox, info, ic } = L.ui;
  if (L.err && !L.pools) { body.innerHTML = `<header class="cl-h"><h1>LP pools</h1></header>${errBox(`Chord's LP index did not answer: ${L.err}`, "retry-lp")}`; return; }
  if (!L.pools) return;
  const p = poolOf();
  if (crumb) crumb.innerHTML = p ? `<div class="b-crumb"><button type="button" data-lp="back">${ic("back")}LP pools</button></div>` : L.ctx.crumb();
  if (p) { body.innerHTML = poolPage(p); paintDyn(); return; }
  body.innerHTML = `<header class="cl-h"><h1>LP pools</h1>${info("<p>Paper liquidity in Monad pools, from Chord's LP index. A range is opened around the price; each hour of the pool's volume pays the position its share of the fee while the price stays in range, and the position's value follows the pool's price (impermanent loss included). Out of range for 6 hours, it can re-centre. Every fill is committed to the agent's record on Monad.</p>", "How LP agents work")}</header>
    ${kpis()}${agentCards()}
    <section class="lp-sec"><header class="lp-bar"><h2>Pools</h2><small>${L.pools.length} on Monad</small><input class="b-in lp-q" id="lpQ" type="search" placeholder="Search pool or token" aria-label="Search pools" value="${L.ui.esc(L.q)}"><div class="b-seg sm" role="tablist" aria-label="Sort">${SORTS.map(([k, l]) => `<button type="button" data-sort="${k}" class="${k === L.sort ? "on" : ""}">${l}</button>`).join("")}</div></header>
      <div class="lp-tw"><table class="cl-t lp-t"><thead><tr><th>Pool</th><th class="r" title="24 h fees over TVL, annualised">Fee APR</th><th class="r">TVL</th><th class="r">Volume 24h</th><th class="r">Fees 24h</th><th class="r">Trades 24h</th><th class="r" title="A paper LP agent running in this pool: its PnL so far over its deposit">Live agent</th></tr></thead><tbody id="lpRows">${rows()}</tbody></table></div></section>`;
}
function kpis() {
  const { esc, cls, signed } = L.ui, ps = L.pools, sum = (k) => ps.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const top = [...ps].sort((a, b) => (b.feeAprPct ?? 0) - (a.feeAprPct ?? 0))[0];
  const ag = L.agents, win = ag.filter((a) => (Number(a.pnlAll) || 0) > 0).length, pnl = ag.reduce((s, a) => s + (Number(a.pnlAll) || 0), 0);
  return `<div class="ag-kpis lp-k">
    <div class="ag-kpi"><small>Fees paid 24h</small><b>${money(sum("fees24hUsd"))}</b></div>
    <div class="ag-kpi"><small>Volume 24h</small><b>${money(sum("volume24hUsd"))}</b></div>
    <div class="ag-kpi"><small>TVL</small><b>${money(sum("tvlUsd"))}</b></div>
    ${top ? `<div class="ag-kpi"><small title="${esc(top.pair)}, ${esc(DEX[top.dex] ?? top.dex)}">Top fee APR</small><b class="up">${Math.round(top.feeAprPct ?? 0)}%</b></div>` : ""}
    ${ag.length ? `<div class="ag-kpi"><small title="Paper LP agents whose PnL so far is above zero">LP agents in profit</small><b>${win}<em class="ag-ks">/${ag.length}</em></b></div>
    <div class="ag-kpi"><small title="Paper PnL of every running LP agent, since each started">LP agents PnL</small><b class="${cls(pnl)}">${signed(pnl)}</b></div>` : ""}
  </div>`;
}
function agentCards() {
  const { esc, cls, signed } = L.ui;
  const ag = [...L.agents].filter((a) => retOf(a) != null).sort((a, b) => retOf(b) - retOf(a)).slice(0, 4);
  if (!ag.length) return "";
  return `<section class="lp-sec"><header class="lp-bar"><h2>Live LP agents</h2><small>paper, on real pool hours</small></header>
    <div class="lp-ag">${ag.map((a) => { const x = poolOf(a.params.pool), r = retOf(a), busy = L.copyBusy === a.id;
      return `<div class="lp-agc" data-pool="${esc(a.params.pool)}" role="button" tabindex="0" title="${esc(a.name)}">
        <span class="lp-agh">${x ? pairLogos(x) : ""}<span class="lp-agt"><b>${esc(x?.pair ?? a.name)}</b><small>${esc(presetName(a.params.preset))} ${esc(presetSpan(a.params.preset))}, ${money(capOf(a))}</small></span><button type="button" class="b-btn sm lp-cpy" data-copy="${esc(a.id)}"${busy ? " disabled" : ""} title="Start a paper LP agent with the same pool, range and size">${busy ? "Copying…" : "Copy"}</button></span>
        <span class="lp-agn"><span><b class="${cls(r)}">${pctTxt(r)}</b><small>${signed(a.pnlAll)} in ${age(a.createdAt)}</small></span>${spark(a.spark)}</span>
      </div>`; }).join("")}</div></section>`;
}
function rows() {
  const { esc, cls } = L.ui, q = L.q.trim().toLowerCase();
  const list = L.pools.filter((x) => !q || `${x.pair} ${x.dex} ${DEX[x.dex] ?? ""} ${x.pool} ${x.side.address} ${x.anchor.address}`.toLowerCase().includes(q))
    .sort((a, b) => (Number(b[L.sort]) || 0) - (Number(a[L.sort]) || 0));
  if (!list.length) return `<tr class="lp-none"><td colspan="7">No pool matches</td></tr>`;
  const maxApr = Math.max(1, ...L.pools.map((x) => x.feeAprPct ?? 0));
  return list.map((x) => { const a = agentsOf(x.pool)[0], r = a ? retOf(a) : null;
    return `<tr data-pool="${esc(x.pool)}"><td><span class="lp-pc">${pairLogos(x)}<span class="lp-pn"><b>${esc(x.pair)}</b>${chips(x)}</span></span></td>
      <td class="r"><span class="lp-apr"><b>${x.feeAprPct != null ? `${Math.round(x.feeAprPct)}%` : "-"}</b><i><u style="width:${Math.round(((x.feeAprPct ?? 0) / maxApr) * 100)}%"></u></i></span></td>
      <td class="r">${money(x.tvlUsd)}</td><td class="r">${money(x.volume24hUsd)}</td><td class="r">${money(x.fees24hUsd)}</td><td class="r">${x.trades24h != null ? Number(x.trades24h).toLocaleString("en-US") : "-"}</td>
      <td class="r">${r != null ? `<a class="lp-ar ${cls(r)}" href="#agents/public/${esc(a.id)}" title="${esc(`${a.name}: ${L.ui.signed(a.pnlAll)} on ${money(capOf(a))} in ${age(a.createdAt)}, paper`)}">${pctTxt(r)}</a>` : `<span class="dim">-</span>`}</td></tr>`; }).join("");
}

// ── one pool ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function poolPage(p) {
  const { esc } = L.ui, f = L.f;
  const seg = (name, opts, cur) => `<div class="b-seg sm">${opts.map(([v, l]) => `<button type="button" data-seg="${name}" data-v="${v}" class="${String(v) === String(cur) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const stat = (l, v, c = "") => `<div><dt>${l}</dt><dd class="${c}">${v}</dd></div>`;
  return `<section id="lpPanel">
    <header class="lp-ph">
      <div class="lp-pt">${pairLogos(p)}<div><h1>${esc(p.pair)}</h1><span class="lp-pm">${chips(p)}<a href="https://monadscan.com/address/${esc(p.pool)}" target="_blank" rel="noopener" title="${esc(p.pool)}">${esc(p.pool.slice(0, 6))}…${esc(p.pool.slice(-4))}</a></span></div></div>
      <dl class="lp-ps">${stat("Price", `$${px(p.priceUsd)}`)}${stat("TVL", money(p.tvlUsd))}${stat("Volume 24h", money(p.volume24hUsd))}${stat("Volume 7d", money(p.volume7dUsd))}${stat("Fees 24h", money(p.fees24hUsd))}${stat("Fee APR", p.feeAprPct != null ? `${Math.round(p.feeAprPct)}%` : "-", "up")}</dl>
    </header>
    <div class="lp-pg">
      <div class="lp-main"><div id="lpRes"></div><div id="lpIn"></div><div id="lpWin"></div></div>
      <aside class="lp-cp" aria-label="New LP agent">
        <h3>New LP agent</h3>
        <div class="lp-st"><i>1</i>Amount</div>
        <label class="lp-amt" title="100 to 10,000"><span>$</span><input type="number" data-f="amountUsd" min="100" max="10000" step="100" value="${esc(f.amountUsd)}" inputmode="decimal" aria-label="Amount in dollars"></label>
        <div class="lp-q4" id="lpAmts"></div>
        <div class="lp-st"><i>2</i>Range<small id="lpRgN"></small></div>
        <div class="lp-rg" id="lpRanges"></div>
        <div id="lpViz"></div>
        <div class="lp-st"><i>3</i>Replay</div>
        <div class="lp-rw">${seg("days", DAYS.map((d) => [d, d === 30 ? "1M" : `${d}d`]), f.days)}<span title="After 6 hours out of range, close and reopen around the price">Re-centre${seg("rebalance", [["1", "On"], ["0", "Off"]], f.rebalance ? "1" : "0")}</span></div>
        <button type="button" class="b-new lp-go" data-lp="start" id="lpGo"></button>
        <p class="lp-msg" id="lpMsg"></p>
      </aside>
    </div>
  </section>`;
}
/** everything on the pool page that follows the replay, the picked range or the amount; the amount field itself is left alone */
function paintDyn() {
  const p = poolOf(), $ = (id) => L.el.querySelector(`#${id}`); if (!p || !$("lpPanel")) return;
  const { esc, cls, ic } = L.ui, r = L.res;
  const keys = r ? PRESET_ORDER.filter((k) => r.byPreset[k]) : p.concentrated ? PRESET_ORDER : ["full"];
  if (!keys.includes(L.preset)) L.preset = keys.includes("balanced") ? "balanced" : keys[0];
  $("lpAmts").innerHTML = AMOUNTS.map((a) => `<button type="button" data-amt="${a}" class="${Number(L.f.amountUsd) === a ? "on" : ""}">${money(a)}</button>`).join("");
  $("lpRgN").textContent = r ? `return over ${dayLabel(r.days)}` : "";
  $("lpRanges").innerHTML = keys.map((k) => { const v = r?.byPreset[k];
    return `<button type="button" class="lp-rc${k === L.preset ? " on" : ""}" data-preset="${k}">${bars(k, 11)}<b>${esc(presetName(k))}</b><small>${esc(presetSpan(k))}</small><em class="${v ? cls(v.returnPct) : "dim"}">${v ? pctTxt(v.returnPct) : L.busy ? "…" : "-"}</em></button>`; }).join("");
  $("lpViz").innerHTML = viz(p);
  $("lpRes").innerHTML = results(p);
  $("lpIn").innerHTML = inPool(p);
  $("lpWin").innerHTML = winHtml();
  const go = $("lpGo"); go.disabled = L.startBusy; go.innerHTML = `${ic(L.startBusy ? "spin" : "play")}${L.startBusy ? "Starting…" : "Start LP agent"}`;
  const m = $("lpMsg"); m.textContent = L.msg?.text ?? ""; m.className = `lp-msg${L.msg?.bad ? " bad" : ""}`;
}
/** the picked range drawn around today's price, with its bounds in the pool's own terms when the anchor's price is known */
function viz(p) {
  const { esc } = L.ui, w = L.presets?.[L.preset]?.width ?? null, P = poolPrice(p), unit = `${p.anchor.symbol} per ${p.side.symbol}`;
  const box = (l, v, d) => `<div><small>${l}</small><b>${v}</b><span>${d}</span></div>`;
  return `<div class="lp-vz"><div class="lp-vp"><small>Price</small><b>${P ? px(P) : `$${px(p.priceUsd)}`}</b><span>${esc(P ? unit : "dollars")}</span></div>${bars(L.preset, 41, "big")}</div>
    <div class="lp-mm">${w == null ? `${box("Min price", "0", "all prices")}${box("Max price", "∞", "all prices")}` : `${box("Min price", P ? px(P * (1 - w)) : `-${Math.round(w * 100)}%`, P ? `-${Math.round(w * 100)}%` : "below the price")}${box("Max price", P ? px(P * (1 + w)) : `+${Math.round(w * 100)}%`, P ? `+${Math.round(w * 100)}%` : "above the price")}`}</div>`;
}
function results(p) {
  const r = L.res, { esc, usd, signed, cls, equityHtml } = L.ui;
  if (!r) return L.busy ? `<div class="b-skel" style="height:92px"></div><div class="b-skel" style="height:300px;margin-top:14px"></div>` : "";
  const x = r.byPreset[L.preset]; if (!x) return "";
  const tile = (l, v, c = "", t = "") => `<div${t ? ` title="${esc(t)}"` : ""}><small>${l}</small><b class="${c}">${v}</b></div>`;
  return `<div class="lp-rh"><h3>${esc(L.presets?.[L.preset]?.label ?? L.preset)}</h3><small>${usd(r.amountUsd)} replayed over ${dayLabel(r.days)}</small></div>
    <div class="lp-tl">${tile("Return", pctTxt(x.returnPct), cls(x.returnPct))}${tile("PnL", signed(x.pnlUsd), cls(x.pnlUsd))}${tile("Fees earned", usd(x.feesUsd), "up")}${tile("vs HODL", signed(x.ilUsd), cls(x.ilUsd), "LP value against holding the deposited tokens")}${tile("In range", `${Number(x.inRangePct).toFixed(0)}%`)}${tile("Re-centres", x.rebalances)}</div>
    ${equityHtml((x.equity ?? []).map((q) => ({ ts: q.t, usd: q.usd })), `PnL, ${p.pair}`)}
    <details class="ag-notes cl-notes"><summary>Assumptions</summary><ul>${(r.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`;
}
/** paper LP agents already in this pool: what they made so far, one click to run the same */
function inPool(p) {
  const { esc, cls, signed } = L.ui, ag = agentsOf(p.pool);
  if (!ag.length) return "";
  return `<div class="lp-in"><h4>LP agents in this pool</h4>${ag.map((a) => { const r = retOf(a), busy = L.copyBusy === a.id;
    return `<div class="lp-ir"><a href="#agents/public/${esc(a.id)}"><b>${esc(a.name)}</b><small>${esc(presetName(a.params.preset))} ${esc(presetSpan(a.params.preset))}, ${money(capOf(a))}, ${age(a.createdAt)}</small></a><span class="${cls(a.pnlAll)}"><b>${signed(a.pnlAll)}</b><small>${r != null ? pctTxt(r) : ""}</small></span><button type="button" class="b-btn sm lp-cpy" data-copy="${esc(a.id)}"${busy ? " disabled" : ""}>${busy ? "Copying…" : "Copy"}</button></div>`; }).join("")}</div>`;
}
function winHtml() {
  const w = L.win, { esc, cls, signed, usd } = L.ui;
  if (!L.sel) return "";
  if (!w) return `<div class="cl-win"><h4>Every range</h4><div class="b-skel" style="height:110px"></div></div>`;
  if (w.error) return `<div class="cl-win"><h4>Every range</h4><p class="cl-msg bad">${esc(w.error)}</p></div>`;
  const keys = PRESET_ORDER.filter((k) => WIN.some(([d]) => w.byWindow?.[d]?.byPreset?.[k]));
  const cell = (v) => (v ? `<td class="r ${cls(v.pnlUsd)}">${signed(v.pnlUsd)}<small class="cl-cov"> ${pctTxt(v.returnPct, 1)}</small></td><td class="r up">${usd(v.feesUsd)}</td><td class="r ${cls(v.ilUsd)}">${signed(v.ilUsd)}</td>` : `<td class="r dim" colspan="3">-</td>`);
  return `<div class="cl-win"><h4>Every range <small class="cl-cov">${usd(Number(L.f.amountUsd))} each${WIN.map(([d, l]) => (w.byWindow?.[d] && w.byWindow[d].coveredDays < d - 0.5 ? `, ${l}: ${w.byWindow[d].coveredDays} days of history` : "")).join("")}</small></h4>
    <div class="cl-tw"><table class="cl-t"><thead><tr><th rowspan="2">Range</th>${WIN.map(([, l]) => `<th class="r" colspan="3">${l}</th>`).join("")}</tr><tr>${WIN.map(() => `<th class="r">PnL</th><th class="r">Fees</th><th class="r" title="LP value against holding the deposited tokens">vs HODL</th>`).join("")}</tr></thead>
    <tbody>${keys.map((k) => `<tr data-preset="${k}" class="${k === L.preset ? "on" : ""}"><td>${esc(L.presets?.[k]?.label ?? k)}</td>${WIN.map(([d]) => cell(w.byWindow?.[d]?.byPreset?.[k])).join("")}</tr>`).join("")}</tbody></table></div></div>`;
}

// ── data ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadWin() {
  const me = L, pool = L.sel; if (!pool) return;
  L.win = null; paintDyn();
  let w;
  try { w = await L.ctx.api("/v1/agents/lp/windows", { method: "POST", body: { pool, amountUsd: Number(L.f.amountUsd), rebalance: L.f.rebalance } }); }
  catch (e) { w = { error: e.message }; }
  if (L !== me || L.sel !== pool) return;
  L.win = w; paintDyn();
}
async function backtest(retry = 0) {
  const me = L, pool = L.sel; if (!pool) return;
  if (!retry) loadWin();
  L.busy = true; L.msg = null; paintDyn();
  try {
    const r = await L.ctx.api("/v1/agents/lp/backtest", { method: "POST", body: { pool, amountUsd: Number(L.f.amountUsd), days: L.f.days, rebalance: L.f.rebalance } });
    if (L !== me || L.sel !== pool) return;
    if (!L.picked) { const best = PRESET_ORDER.filter((k) => r.byPreset[k]).sort((a, b) => r.byPreset[b].returnPct - r.byPreset[a].returnPct)[0]; if (best) L.preset = best; }
    L.res = r; L.busy = false; paintDyn();
  } catch (e) {
    if (L !== me || L.sel !== pool) return;
    if (/still replaying/i.test(e.message) && retry < 6) { setTimeout(() => { if (L === me && L.sel === pool) backtest(retry + 1); }, 5000); return; }
    L.busy = false; L.res = null; L.msg = { text: e.message, bad: true }; paintDyn();
  }
}
/** the amount, the window or the re-centre rule changed: replay again */
function rerun() { L.res = null; backtest(); }
async function start() {
  L.startBusy = true; L.msg = null; paintDyn();
  try {
    const j = await L.ctx.api("/v1/agents", { method: "POST", body: { type: "lp", mode: "paper", params: { pool: L.sel, amountUsd: Number(L.f.amountUsd), preset: L.preset, rebalance: L.f.rebalance } } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    L.ctx.onCreated(bot);
  } catch (e) { L.startBusy = false; L.msg = { text: e.message, bad: true }; paintDyn(); }
}
async function copy(id) {
  if (L.copyBusy) return;
  L.copyBusy = id; poolOf() ? paintDyn() : paint();
  try {
    const j = await L.ctx.api(`/v1/agents/${encodeURIComponent(id)}/copy`, { method: "POST", body: {} });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The copy was created but the answer had no id. Check My agents.");
    L.ctx.onCreated(bot);
  } catch (e) { L.copyBusy = null; L.ctx.toast?.(e.message); poolOf() ? (L.msg = { text: e.message, bad: true }, paintDyn()) : paint(); }
}
function open(pool) {
  if (L.sel === pool || !poolOf(pool)) return;
  L.sel = pool; L.res = null; L.win = null; L.msg = null; L.picked = false;
  L.ctx.setHash?.(`#agents/lp/${pool}`);
  paint(); backtest();
  L.el.scrollIntoView({ block: "start" });
}
function onClick(e) {
  if (!L) return;
  const c = e.target.closest("[data-copy]"); if (c) { e.preventDefault(); return void copy(c.dataset.copy); }
  if (e.target.closest("a[href]")) return; // an agent's own link opens the agent, not the pool under it
  const t = e.target.closest("[data-pool],[data-seg],[data-lp],[data-preset],[data-sort],[data-amt]"); if (!t) return;
  if (t.dataset.pool) return void open(t.dataset.pool);
  if (t.dataset.sort) { if (L.sort !== t.dataset.sort) { L.sort = t.dataset.sort; t.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === t)); const tb = L.el.querySelector("#lpRows"); if (tb) tb.innerHTML = rows(); } return; }
  if (t.dataset.amt) { L.f.amountUsd = Number(t.dataset.amt); const i = L.el.querySelector('[data-f="amountUsd"]'); if (i) i.value = L.f.amountUsd; return void rerun(); }
  if (t.dataset.seg) { const k = t.dataset.seg, v = t.dataset.v; if (k === "days") L.f.days = Number(v); else if (k === "rebalance") L.f.rebalance = v === "1"; t.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === t)); return void rerun(); }
  if (t.dataset.preset) { L.picked = true; if (L.preset !== t.dataset.preset) { L.preset = t.dataset.preset; paintDyn(); } return; }
  if (t.dataset.lp === "start") return void start();
  if (t.dataset.lp === "back") { L.sel = null; L.res = null; L.win = null; L.msg = null; L.ctx.setHash?.("#agents/lp"); paint(); L.el.scrollIntoView({ block: "start" }); }
}
function onInput(e) {
  if (!L) return;
  if (e.target.id === "lpQ") { L.q = e.target.value; const tb = L.el.querySelector("#lpRows"); if (tb) tb.innerHTML = rows(); return; }
  if (e.target.dataset?.f === "amountUsd") { L.f.amountUsd = e.target.value; clearTimeout(L.timer); const me = L; L.timer = setTimeout(() => { if (L === me && L.sel) rerun(); }, 700); }
}
