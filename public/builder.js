// Agents (Bots tab) › Builder (#bots/build, #bots/build/<templateId>, or #agents/…): describe a bot in words or start from a template, edit the Strategy as
// blocks (Trigger · Filters · Action · Exits · Limits) with live checks, backtest it, start it on paper. Loaded lazily by bots.js.
// Strategy JSON v1 + plan: ask2049-notes/PROMPT-bot-builder.md. API:
//   POST /v1/strategies/compile { text, answers? } → { strategy, explanation, warnings, questions }
//   POST /v1/strategies/validate { strategy }      → { ok, errors } (errors: "Block › field: message" strings or { path, message })
//   GET  /v1/strategies/templates                  → { templates: [{ id, title, line, risk, strategy }] }
//   POST /v1/strategies/backtest { strategy, days } → Backtest (same shape as the copy bot's)
//   POST /v1/agents { type: "custom", name, mode: "paper", params: { strategy } } → Bot
// Every server string is escaped; Monad addresses are compared in lower case. Classes: bb-* here, plus the b-* kit of bots.js.

const B58 = /^0x[0-9a-fA-F]{40}$/; // a Monad address (the name stays for the call sites)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);
const strs = (x) => arr(x).filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
const clone = (x) => JSON.parse(JSON.stringify(x));
const sig = (x) => { try { return JSON.stringify(x) ?? ""; } catch { return ""; } };
const short = (s, a = 4, b = 4) => { s = String(s ?? ""); return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
const fin = (v) => v !== "" && v != null && Number.isFinite(Number(v));
const MINUS = "-";
/** the example in the empty Describe box; Generate on an empty box builds it (it looked typed in, and an error was all one got) */
const EXAMPLE = `When 3 smart traders buy the same token within 15 minutes and it has $30k+ liquidity, buy $20. Take profit at 2x, stop at ${MINUS}30 %.`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ── icons (same 24px stroke set as bots.js) ─────────────────────────────────────────────────────────────────────────────
const I = {
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-3.8-5.9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  spin: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
};
const svg = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] ?? ""}</svg>`;
const ic = (n, sw) => `<i class="b-i${n === "spin" ? " b-spin" : ""}">${svg(n, sw)}</i>`;
/** notes behind a small (i) popover, closed by default (same markup and look as bots.js) */
const info = (html, label = "Notes") => (html ? `<details class="ag-i"><summary aria-label="${esc(label)}" title="${esc(label)}">${svg("info", 2)}</summary><div class="ag-ip">${html}</div></details>` : "");
const PAPER = `<em class="ag-pp" title="Paper mode: nothing is sent">Paper</em>`;

// ── vocabulary (Strategy v1) ────────────────────────────────────────────────────────────────────────────────────────────
// On Monad: no new-token or LP-event trigger (Chord has no Monad launch board or LP tape; the server refuses them)
const TRIGGERS = [["confluence", "Wallets agree", "users"], ["wallet_trade", "Wallet trades", "copy"], ["price", "Price move", "chart"], ["schedule", "Schedule", "clock"]];
const TRIG_HINT = {
  confluence: "Several followed wallets buy the same token within a window.",
  wallet_trade: "Any trade by a followed wallet.",
  new_token: "New-token launches. Not available on Monad.",
  price: "A token crosses a price, or moves by a percent.",
  schedule: "A timed buy on one token. Good for DCA.",
  lp_event: "Liquidity leaves or lands in a pool. Not available on Monad.",
};
// the fields Chord's API gives for Monad tokens (market cap, FDV, holders, top-10 share and organic score are not there)
const FIELDS = {
  liquidityUsd: ["Liquidity", "$"], volume24hUsd: ["Volume 24h", "$"], ageMin: ["Age", "min"],
  priceChange5mPct: ["Price change 5m", "%"], priceChange1hPct: ["Price change 1h", "%"],
  priceChange24hPct: ["Price change 24h", "%"], buyShare1hPct: ["Buy share 1h", "%"], smartBuyers1h: ["Smart buyers 1h", ""],
};
const OPS = [[">=", "at least"], [">", "above"], ["<=", "at most"], ["<", "below"], ["between", "between"]];
// EVM safety: verified = on Chord's curated Monad list; not flagged = no tax and a $10 round trip returns ≥ 90 %
const SAFETY = [["verified", "Verified token"], ["not_flagged", "Not flagged (no tax, sellable)"]];
const ACTIONS = [["buy", "Buy"], ["sell", "Sell"], ["alert", "Alert"], ["webhook", "Webhook"]];
const EVERY = [["15m", "15 min"], ["1h", "1 hour"], ["4h", "4 hours"], ["1d", "1 day"], ["1w", "1 week"]];
const EVERY_TXT = { "15m": "15 minutes", "1h": "hour", "4h": "4 hours", "1d": "day", "1w": "week" };
const LP_EVENTS = [["exodus", "Exodus"], ["large_remove", "Large remove"], ["large_add", "Large add"]];
const DAYS = [[1, "24h"], [3, "3d"], [7, "7d"]];
// the smart-money board has a 24 h and a 7-day window (a strategy stored with 3 reads the 7-day one)
const RANK_DAYS = [[1, "24h"], [7, "7d"]];
const BLOCK = { trigger: "Trigger", filters: "Filters", action: "Action", exits: "Exits", limits: "Limits", name: "Name" };
const BLOCK_KEY = { trigger: "trigger", filters: "filters", filter: "filters", action: "action", exits: "exits", exit: "exits", limits: "limits", limit: "limits", name: "name" };
const NUMK = new Set(["usd", "pct", "minUsd", "value", "top", "days", "minWallets", "windowMin", "takeProfitPct", "stopLossPct", "trailingPct", "maxHoldMin", "maxOpenPositions", "maxPerTokenUsd", "dailyBudgetUsd", "cooldownMin", "maxTradesPerDay"]);
const MAX_LIST = { "trigger.wallets.list": 10, "trigger.pools": 10, "trigger.mints": 10 };
const MINT_WORDS = ["trending", "held"]; // price.mint keywords: Chord's most traded Monad tokens, or the tokens the agent holds
const LP_MIN = { exodus: 1000, large_remove: 10000, large_add: 10000 }; // server defaults when minUsd is left out
const NAME_MAX = 40;

function trigFor(type, prev = {}) {
  const w = prev.wallets ?? { smartTraders: { top: 20, days: 1 } };
  switch (type) {
    case "wallet_trade": return { type, wallets: w, side: "buy" };
    case "confluence": return { type, wallets: w, minWallets: 3, windowMin: 15, side: "buy" };
    case "new_token": return { type, source: "graduation" };
    case "price": return { type, mint: prev.mint ?? "", op: "change_pct", value: 15, windowMin: 60 };
    case "schedule": return { type, every: "1d", mint: prev.mint ?? "" };
    case "lp_event": return { type, event: "exodus" };
    default: return { type };
  }
}
const actFor = (type, prev = {}) => (type === "buy" ? { type, usd: prev.usd ?? 20 } : type === "sell" ? { type, pct: 100 } : type === "webhook" ? { type, url: prev.url ?? "" } : { type });
const blank = () => ({
  version: 1, name: "My agent", trigger: trigFor("confluence"),
  filters: [{ field: "liquidityUsd", op: ">=", value: 20000 }, { safety: "not_flagged" }],
  action: { type: "buy", usd: 20 }, exits: { takeProfitPct: 100, stopLossPct: 30 },
  limits: { maxOpenPositions: 5, dailyBudgetUsd: 100, cooldownMin: 10, maxTradesPerDay: 20 },
});

// ── plain words (also used by bots.js for custom bot cards and detail) ───────────────────────────────────────────────────
const numTxt = (v) => (fin(v) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "?");
function usdTxt(v) {
  if (!fin(v)) return "$?";
  const n = Number(v), a = Math.abs(n), s = n < 0 ? MINUS : "";
  const f = (x, u) => `${s}$${+x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)}${u}`;
  return a >= 1e9 ? f(a / 1e9, "B") : a >= 1e6 ? f(a / 1e6, "M") : a >= 1e4 ? f(a / 1e3, "K") : `${s}$${a.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
function minTxt(v) {
  if (!fin(v)) return "? min";
  const m = Number(v);
  return m < 60 ? `${numTxt(m)} min` : m < 2880 ? `${+(m / 60).toFixed(1)} h` : `${+(m / 1440).toFixed(1)} days`;
}
const priceTxt = (v) => (!fin(v) ? "$?" : Number(v) >= 1 ? usdTxt(v) : `$${Number(v).toPrecision(3)}`);
const pctTxt = (v) => (fin(v) ? `${numTxt(v)}%` : "?%");
function valTxt(field, v) {
  const u = FIELDS[field]?.[1] ?? "";
  return u === "$" ? usdTxt(v) : u === "%" ? pctTxt(v) : u === "min" ? minTxt(v) : numTxt(v);
}
function who(w) {
  w = obj(w);
  if (w.smartTraders) { const s = obj(w.smartTraders); return `the top ${numTxt(s.top ?? 20)} smart traders (${Number(s.days ?? 1) === 1 ? "last 24 hours" : `last ${numTxt(s.days)} days`})`; }
  const l = arr(w.list);
  return l.length === 1 ? `wallet ${short(l[0])}` : `${l.length} picked wallets`;
}
function trigLine(t) {
  const tok = t.mint === "trending" ? "a token on Chord's trending board" : t.mint === "held" ? "a token the agent holds" : t.mint ? short(t.mint) : "a token (no mint yet)";
  switch (t.type) {
    case "wallet_trade": {
      const w = who(t.wallets), verb = t.side === "sell" ? "sells" : t.side === "any" ? "trades" : "buys";
      return `When ${/^wallet /.test(w) ? w : `one of ${w}`} ${verb} a token${fin(t.minUsd) && Number(t.minUsd) > 0 ? ` for ${usdTxt(t.minUsd)} or more` : ""}.`;
    }
    case "confluence": return `When ${numTxt(t.minWallets ?? 3)} of ${who(t.wallets)} ${t.side === "sell" ? "sell" : "buy"} the same token within ${minTxt(t.windowMin ?? 15)}.`;
    case "new_token": return "When a new token launches (not available on Monad).";
    case "price":
      if (t.op === "above") return `When ${tok} trades above ${priceTxt(t.value)}.`;
      if (t.op === "below") return `When ${tok} trades below ${priceTxt(t.value)}.`;
      return `When ${tok} ${Number(t.value) < 0 ? "falls" : "rises"} ${pctTxt(Math.abs(Number(t.value)))} or more within ${minTxt(t.windowMin ?? 60)}.`;
    case "schedule": return `Every ${EVERY_TXT[t.every] ?? String(t.every ?? "?")}, on ${tok}.`;
    case "lp_event": {
      const p = arr(t.pools), m = arr(t.mints);
      const where = p.length ? `${p.length} picked pool${p.length === 1 ? "" : "s"}` : m.length ? `the pools of ${m.length} picked token${m.length === 1 ? "" : "s"}` : "the pools of tokens the agent holds";
      const ev = t.event === "large_add" ? "a large liquidity add lands in" : t.event === "large_remove" ? "a large liquidity remove hits" : "liquidity leaves";
      return `When ${ev} ${where}${fin(t.minUsd) && Number(t.minUsd) > 0 ? ` (${usdTxt(t.minUsd)} or more)` : ""}.`;
    }
    default: return t.type ? `When ${String(t.type).replace(/_/g, " ")} fires.` : "No trigger yet.";
  }
}
function filtLine(fs) {
  const parts = [];
  for (const f of fs) {
    const o = obj(f);
    if (o.safety) { parts.push(SAFETY.find(([k]) => k === o.safety)?.[1].toLowerCase() ?? String(o.safety).replace(/_/g, " ")); continue; }
    if (!o.field) continue;
    const label = (FIELDS[o.field]?.[0] ?? String(o.field)).toLowerCase();
    if (o.op === "between") { const v = arr(o.value); parts.push(`${label} between ${valTxt(o.field, v[0])} and ${valTxt(o.field, v[1])}`); }
    else parts.push(`${label} ${OPS.find(([k]) => k === o.op)?.[1] ?? o.op} ${valTxt(o.field, Array.isArray(o.value) ? o.value[0] : o.value)}`);
  }
  return parts.length ? `Only if ${parts.join(", ")}.` : "None, every trigger acts.";
}
function actLine(a) {
  if (a.type === "buy") return `Buy ${usdTxt(a.usd)} on paper.`;
  if (a.type === "sell") return `Sell ${pctTxt(a.pct)} of the held position.`;
  if (a.type === "webhook") { let h = null; try { h = new URL(a.url).host; } catch {} return `Post each match to ${h ?? "a webhook"}. Nothing is bought.`; }
  if (a.type === "alert") return "Log an alert. Nothing is bought.";
  return "No action yet.";
}
function exitLine(x, t) {
  const p = [];
  if (fin(x.takeProfitPct)) p.push(`take profit at +${numTxt(x.takeProfitPct)}%`);
  if (fin(x.stopLossPct)) p.push(`stop at ${MINUS}${numTxt(Math.abs(Number(x.stopLossPct)))}%`);
  if (fin(x.trailingPct)) p.push(`trail ${numTxt(x.trailingPct)}% under the high`);
  if (fin(x.maxHoldMin)) p.push(`sell after ${minTxt(x.maxHoldMin)}`);
  if (x.sellWhen === "followed_sells" && ["wallet_trade", "confluence"].includes(t.type)) p.push("sell when the followed wallets sell");
  return p.length ? `${cap(p.join(", "))}.` : "None, positions stay open.";
}
function limLine(l, a) {
  const p = [];
  const buys = a.type === "buy";
  if (buys && fin(l.maxOpenPositions)) p.push(`${numTxt(l.maxOpenPositions)} open at most`);
  if (buys && fin(l.maxPerTokenUsd)) p.push(`${usdTxt(l.maxPerTokenUsd)} per token`);
  if (buys && fin(l.dailyBudgetUsd)) p.push(`${usdTxt(l.dailyBudgetUsd)} a day`);
  if (fin(l.maxTradesPerDay)) p.push(`${numTxt(l.maxTradesPerDay)} ${buys ? "trades" : "matches"} a day`);
  if (fin(l.cooldownMin) && Number(l.cooldownMin) > 0) p.push(`${minTxt(l.cooldownMin)} before the same token again`);
  return p.length ? `${cap(p.join(", "))}.` : "";
}
/** One plain line per block of a Strategy (v1), "Trigger: …" like the server's explanation. Never throws; unknown values read as "?". */
export function explain(st) {
  if (!st || typeof st !== "object") return [];
  const t = obj(st.trigger), a = obj(st.action), lo = (x) => (x ? x[0].toLowerCase() + x.slice(1) : x);
  const lim = limLine(obj(st.limits), a);
  return [`Trigger: ${lo(trigLine(t))}`, `Filters: ${lo(filtLine(arr(st.filters)))}`, `Action: ${lo(actLine(a))}`, a.type === "buy" ? `Exits: ${lo(exitLine(obj(st.exits), t))}` : "", lim ? `Limits: ${lo(lim)}` : ""].filter(Boolean);
}
const BLOCK_LINE = /^(Trigger|Filters|Action|Exits|Limits):\s*/;
/** a plain line with its block name set apart */
export const lineHtml = (x) => { const m = BLOCK_LINE.exec(x); return m ? `<b>${m[1]}</b><span>${esc(x.slice(m[0].length))}</span>` : `<span>${esc(x)}</span>`; };
/** A few words for a card subtitle: "Wallets agree · $20 a buy". */
export function summary(st) {
  const t = obj(obj(st).trigger), a = obj(obj(st).action);
  const tl = TRIGGERS.find(([k]) => k === t.type)?.[1] ?? "Custom";
  const al = a.type === "buy" ? `${usdTxt(a.usd)} a buy` : a.type === "sell" ? `sells ${pctTxt(a.pct)}` : a.type === "webhook" ? "webhook" : a.type === "alert" ? "alert only" : "";
  return [tl, al].filter(Boolean).join(", ");
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
let D = {}, host = null;
const T = { list: null, err: null, busy: false, miss: null };
const fresh = () => ({
  st: null, tplId: null, undo: null, stash: {}, pendingTpl: null,
  text: "", qa: [], qs: [], expl: null, compBusy: false, compErr: null, compNote: null,
  val: { busy: false, errs: [], err: null }, jsonOpen: false, jsonErr: null, pendingStrat: null,
  bt: null, btKey: null, btErr: null, btBusy: false, btDays: 7, btAll: false,
  startBusy: false, startErr: null, plainOpen: false,
});
let S = fresh();
let vTimer = null, vCtl = null, jTimer = null;
const q = (id) => host?.querySelector(`#${id}`) ?? null;
const at = (attr, v) => host?.querySelector(`[${attr}="${CSS.escape(v)}"]`) ?? null;
const setHash = (h) => D.setHash?.(h);
const session = () => (typeof D.session === "function" ? D.session() : D.session) ?? "";

// path helpers: "filters.2.value.0" → st.filters[2].value[0]
const keys = (p) => p.split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k));
function getP(o, p) { return keys(p).reduce((a, k) => (a == null || typeof a !== "object" ? undefined : a[k]), o); }
function setP(o, p, v) {
  const ks = keys(p);
  let a = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (a[ks[i]] == null || typeof a[ks[i]] !== "object") a[ks[i]] = typeof ks[i + 1] === "number" ? [] : {};
    a = a[ks[i]];
  }
  const last = ks[ks.length - 1];
  if (v === undefined && !Array.isArray(a)) delete a[last]; else a[last] = v;
}
/** "30k" → 30000, "1,500" → 1500, "-20" → -20; anything else stays the typed string so the checks name it. */
function parseNum(raw) {
  const t = String(raw ?? "").trim();
  const s = t.replace(/[,_\s$%+]/g, "").replace(/^[-–]/, "-");
  if (!s) return undefined;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))([kmb])?$/i.exec(s);
  if (!m) return t;
  const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1);
  return Number.isFinite(n) ? +n.toPrecision(12) : t;
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** deps: { session, api(path, { method, body }), setHash(h), onCreated(bot), ui: { esc, usd, signed, cls, pct, int, plural, daysLabel, toMs, rows, N,
 *  tile, equityHtml, fillsTable }, route?: { template?, strategy?, explanation?, text? } }. Renders into root; state survives re-renders. */
export function renderBuilder(root, deps) {
  D = deps ?? {};
  host = root;
  if (!host) return;
  const r = D.route ?? {};
  if (typeof r.text === "string" && r.text.trim()) S.text = r.text.trim().slice(0, 2000);
  if (r.template) { S.pendingTpl = String(r.template); S.pendingStrat = r.strategy && typeof r.strategy === "object" ? r.strategy : null; }
  else if (r.strategy && typeof r.strategy === "object") {
    loadStrategy(r.strategy, { label: r.strategy.name ? `“${String(r.strategy.name).slice(0, 48)}”` : "the strategy" });
    const ex = strs(r.explanation);
    if (ex.length) S.expl = { lines: ex, warnings: [], key: sig(S.st) };
  }
  if (!host.dataset.bb) {
    host.dataset.bb = "1";
    host.addEventListener("click", onClick);
    host.addEventListener("input", onInput);
    host.addEventListener("change", onChange);
    host.addEventListener("keydown", onKey);
    host.addEventListener("toggle", (e) => { if (e.target.classList?.contains("bb-pld")) S.plainOpen = e.target.open; }, true);
  }
  host.innerHTML = shellHtml();
  paintComp(); paintTpl(); paintEditor();
  if (!S.pendingTpl) setHash(S.tplId ? `#bots/build/${encodeURIComponent(S.tplId)}` : "#bots/build");
  if (T.list) { if (S.pendingTpl) { const id = S.pendingTpl; S.pendingTpl = null; applyTemplate(id, true); } }
  else loadTemplates();
  if (S.st) scheduleValidate(true);
}

function shellHtml() {
  return `${D.crumb?.() ?? `<div class="b-crumb"><button type="button" data-go="mine">${ic("back")}My agents</button></div>`}
    <div class="bb-head b-sech"><h2>Build an agent</h2>${PAPER}${info("Describe it in words or start from a template. Edit the blocks, backtest, then run it on paper: nothing is sent.", "About the builder")}</div>
    <section class="bb-card bb-desc">
        <label class="bb-lbl" for="bbText">Describe</label>
        <textarea id="bbText" rows="3" maxlength="2000" spellcheck="true" placeholder="${esc(EXAMPLE)}">${esc(S.text)}</textarea>
        <div class="bb-gbar"><button type="button" class="b-btn pri" data-bb="gen" id="bbGen"></button><small title="English or Vietnamese. Paper only, nothing is sent.">EN, VI</small></div>
        <div id="bbComp"></div>
    </section>
    <section class="bb-tpls"><div class="b-sech"><h3>Templates</h3><small id="bbTplN"></small></div><div id="bbTpl"></div></section>
    <div id="bbEd" class="bb-edw"></div>`;
}

// ── describe → compile ──────────────────────────────────────────────────────────────────────────────────────────────────
function paintComp() {
  const b = q("bbGen");
  if (b) { b.disabled = S.compBusy; b.innerHTML = S.compBusy ? `${ic("spin")}Generating…` : `${ic("arrow")}Generate`; }
  const el = q("bbComp"); if (!el) return;
  let h = "";
  if (S.compErr) h += `<p class="bb-cerr">${ic("alert")}<span>${esc(S.compErr)}</span></p>`;
  else if (S.compNote) h += `<p class="bb-cok">${ic("check")}<span>${esc(S.compNote)}</span></p>`;
  if (S.qs.length) {
    h += `<div class="bb-qs"><div class="bb-qh" title="Answer to tighten the strategy">${ic("help")}<b>${S.qs.length === 1 ? "1 question" : `${S.qs.length} questions`}</b></div>
      ${S.qs.map((x, i) => `<div class="bb-q"><label for="bbQa${i}">${esc(x.q)}</label>
        ${x.options.length ? `<div class="bb-qo">${x.options.map((o) => `<button type="button" data-bb="qopt" data-i="${i}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}
        <span class="b-in bb-txt"><input id="bbQa${i}" data-qa="${i}" autocomplete="off" placeholder="${esc(x.ph || "Your answer")}" value="${esc(x.a ?? "")}"></span></div>`).join("")}
      <div class="bb-qbar"><button type="button" class="b-btn pri" data-bb="answer"${S.compBusy ? " disabled" : ""}>${S.compBusy ? `${ic("spin")}Updating…` : "Update"}</button><span class="bb-qmsg" id="bbQMsg"></span></div></div>`;
  }
  el.innerHTML = h;
}
function readQuestions(list) {
  return arr(list).map((x) => {
    if (typeof x === "string") return x.trim() ? { q: x.trim(), options: [], ph: "", id: null } : null;
    const o = obj(x), text = o.question ?? o.q ?? o.text ?? o.message;
    if (typeof text !== "string" || !text.trim()) return null;
    return { q: text.trim(), id: o.id != null ? String(o.id) : null, options: strs(o.options ?? o.choices).slice(0, 6), ph: typeof o.placeholder === "string" ? o.placeholder : typeof o.example === "string" ? o.example : "" };
  }).filter(Boolean).slice(0, 6);
}
async function compile(withAnswers) {
  if (S.compBusy) return;
  if (!S.text.trim() && !withAnswers) { S.text = EXAMPLE; const ta = q("bbText"); if (ta) ta.value = EXAMPLE; }
  const text = S.text.trim();
  if (!text) { S.compErr = "Describe what the agent should do first."; S.compNote = null; paintComp(); q("bbText")?.focus(); return; }
  if (withAnswers) {
    const got = S.qs.map((x, i) => ({ id: x.id, question: x.q, answer: String(at("data-qa", String(i))?.value ?? x.a ?? "").trim() })).filter((x) => x.answer);
    if (!got.length) { const m = q("bbQMsg"); if (m) m.textContent = "Answer at least one question."; return; }
    S.qa = [...S.qa.filter((x) => !got.some((g) => g.question === x.question)), ...got];
  } else S.qa = [];
  const full = S.qa.length ? `${text}\n\nAnswers:\n${S.qa.map((x) => `- ${x.question} ${x.answer}`).join("\n")}` : text;
  S.compBusy = true; S.compErr = null; S.compNote = null; paintComp();
  try {
    const j = await D.api("/v1/strategies/compile", { method: "POST", body: { text: full, ...(S.qa.length ? { answers: S.qa } : {}) } });
    const strat = j?.strategy && typeof j.strategy === "object" && !Array.isArray(j.strategy) ? j.strategy : null;
    S.qs = readQuestions(j?.questions);
    if (strat) {
      loadStrategy(strat, { label: "the generated strategy" });
      S.expl = { lines: strs(j.explanation), warnings: strs(j.warnings), key: sig(S.st) };
      S.compNote = S.qs.length ? "Generated, answer to tighten" : "Generated";
      paintPlain();
      if (!S.qs.length) q("bbEd")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (!S.qs.length) S.compErr = "No strategy came back. Try saying what triggers it, what it buys and when it sells.";
  } catch (e) { S.compErr = e.message; }
  S.compBusy = false;
  paintComp();
}

// ── templates ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  if (T.busy) return;
  T.busy = true; T.err = null; paintTpl();
  try {
    const j = await D.api("/v1/strategies/templates");
    T.list = arr(Array.isArray(j) ? j : j?.templates).filter((x) => x && typeof x === "object" && x.strategy && typeof x.strategy === "object").map((x, i) => ({
      id: String(x.id ?? x.slug ?? i), title: String(x.title ?? x.name ?? x.strategy.name ?? "Template"),
      line: String(x.oneLine ?? x.line ?? x.summary ?? x.description ?? x.strategy.description ?? ""), risk: x.risk == null ? "" : String(x.risk),
      strategy: x.strategy, explanation: strs(x.explanation),
    }));
  } catch (e) { T.err = e.message; }
  T.busy = false;
  if (!host?.isConnected) return;
  paintTpl();
  if (S.pendingTpl && T.list) { const id = S.pendingTpl; S.pendingTpl = null; applyTemplate(id, true); }
  else if (S.pendingTpl && S.pendingStrat) { const fb = S.pendingStrat; S.pendingTpl = null; S.pendingStrat = null; loadStrategy(fb, { label: "the template" }); } // no gallery: the strategy still opens
}
const riskTxt = (r) => (/^(low|medium|med|high)$/i.test(r.trim()) ? `${cap(r.trim().toLowerCase().replace(/^med$/, "medium"))} risk` : r);
function paintTpl() {
  const el = q("bbTpl"), n = q("bbTplN"); if (!el) return;
  if (n) n.textContent = T.list?.length ? String(T.list.length) : "";
  if (!T.list) {
    el.innerHTML = T.err ? `<div class="bb-terr"><span>${esc(T.err)}</span><button type="button" class="b-btn sm" data-bb="tpl-retry">Try again</button></div>`
      : `<div class="bb-tlist">${`<div class="bb-tpl bb-tsk"><div class="b-skel" style="height:16px;width:55%"></div><div class="b-skel" style="height:12px;width:90%;margin-top:10px"></div><div class="b-skel" style="height:12px;width:70%;margin-top:6px"></div></div>`.repeat(6)}</div>`;
    return;
  }
  if (!T.list.length) { el.innerHTML = `<p class="bb-empty">No templates yet.</p>`; return; }
  el.innerHTML = `${T.miss ? `<p class="bb-cerr">${ic("alert")}<span>Template not found</span></p>` : ""}<div class="bb-tlist">${T.list.map((t) => {
    const on = S.tplId === t.id, ty = obj(t.strategy.trigger).type, icn = TRIGGERS.find(([k]) => k === ty)?.[2] ?? "chart";
    const tip = [t.line, t.risk ? `Risk: ${riskTxt(t.risk)}` : ""].filter(Boolean).join("\n\n");
    return `<button type="button" class="bb-tpl${on ? " on" : ""}" data-bb="tpl" data-v="${esc(t.id)}" aria-pressed="${on}"${tip ? ` title="${esc(tip)}"` : ""}>
      <span class="bb-tt"><span class="bb-tic">${ic(icn)}</span><b>${esc(t.title)}</b>${t.risk ? `<i class="bb-trf" aria-label="Has a risk note">${ic("alert")}</i>` : ""}${on ? `<span class="bb-ton">${ic("check", 2.4)}</span>` : ""}</span>
      <span class="bb-tsum">${esc(summary(t.strategy))}</span></button>`;
  }).join("")}</div>`;
}
function applyTemplate(id, fromRoute) {
  const t = T.list?.find((x) => x.id === id);
  if (!t) {
    if (!fromRoute) return;
    const fb = S.pendingStrat; S.pendingStrat = null;
    if (fb) { T.miss = null; loadStrategy(fb, { label: fb.name ? `“${String(fb.name).slice(0, 48)}”` : "the template" }); paintComp(); return; } // not in this gallery: its strategy still opens
    T.miss = id; paintTpl(); setHash("#bots/build"); return;
  }
  S.pendingStrat = null;
  T.miss = null;
  if (fromRoute && S.tplId === id && S.st) { setHash(`#bots/build/${encodeURIComponent(id)}`); paintTpl(); return; }
  loadStrategy(t.strategy, { tplId: id, label: `“${t.title}”` });
  S.qs = []; S.compNote = null; S.compErr = null;
  S.expl = t.explanation.length ? { lines: t.explanation, warnings: [], key: sig(S.st) } : null;
  paintComp(); paintTpl(); paintPlain();
  if (!fromRoute) q("bbEd")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── the strategy being edited ───────────────────────────────────────────────────────────────────────────────────────────
function normalize(st) {
  const s = obj(st);
  if (s.version == null) s.version = 1;
  if (typeof s.name !== "string") s.name = s.name == null ? "" : String(s.name);
  if (!s.trigger || typeof s.trigger !== "object") s.trigger = trigFor("confluence");
  if (!Array.isArray(s.filters)) s.filters = [];
  if (!s.action || typeof s.action !== "object") s.action = { type: "buy", usd: 20 };
  if (!s.limits || typeof s.limits !== "object") s.limits = {};
  return s;
}
function loadStrategy(st, { tplId = null, label = "", silent = false } = {}) {
  const prev = S.st, prevTpl = S.tplId;
  S.st = normalize(clone(st));
  S.tplId = tplId; S.stash = {};
  S.undo = !silent && prev && sig(prev) !== sig(S.st) ? { st: prev, tplId: prevTpl, label } : null;
  S.val = { busy: false, errs: [], err: null };
  S.bt = null; S.btKey = null; S.btErr = null; S.btAll = false; S.startErr = null; S.jsonErr = null;
  setHash(tplId ? `#bots/build/${encodeURIComponent(tplId)}` : "#bots/build");
  if (host?.isConnected) { paintEditor(); paintTpl(); scheduleValidate(true); }
}
/** after every edit made through the blocks or the JSON drawer */
function changed({ blocks = false, json = true, path = null } = {}) {
  if (S.undo) { S.undo = null; q("bbUndo")?.remove(); }
  if (path) S.val.errs = S.val.errs.filter((e) => e.key !== path);
  S.startErr = null;
  if (blocks) paintBlocks(); else paintErrs();
  paintPlain();
  if (json) syncJson();
  paintStale();
  scheduleValidate();
}

function paintEditor() {
  const el = q("bbEd"); if (!el) return;
  if (!S.st) {
    el.innerHTML = `<section class="bb-zero">
      <ol class="bb-steps" title="Generate a strategy from words or pick a template, and it shows up here as blocks you can edit.">${["Trigger", "Filters", "Action", "Exits", "Limits"].map((x, i) => `<li><span class="b-num">${i + 1}</span>${x}</li>`).join("")}</ol>
      <button type="button" class="b-btn" data-bb="blank">${ic("plus")}Blank</button></section>`;
    return;
  }
  el.innerHTML = `${S.undo ? `<div class="bb-undo" id="bbUndo">${ic("check")}<span>Loaded ${esc(S.undo.label || "a new strategy")}</span><button type="button" class="b-btn sm" data-bb="undo">${ic("undo")}Undo</button></div>` : ""}
    <div class="bb-ed">
      <label class="b-field bb-name"><span>Name</span><span class="b-in bb-txt"><input data-p="name" data-k="text" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" placeholder="Name your agent" value="${esc(S.st.name ?? "")}"></span><small class="bb-err" data-err="name"></small></label>
      <aside class="bb-side"><div class="bb-card bb-plainc">
        <div class="bb-ch"><h3>Summary</h3><span id="bbVal"></span></div>
        <p class="bb-sumln" id="bbSum"></p>
        <details class="ag-notes bb-pld"${S.plainOpen ? " open" : ""}><summary>Plain words</summary><ol class="bb-plain" id="bbPlain"></ol></details>
        <ul class="bb-warn" id="bbWarn" hidden></ul>
        <ul class="bb-gerr" id="bbGErr" hidden></ul>
        <div id="bbTplNote"></div>
      </div></aside>
      <div class="bb-blocks" id="bbBlocks"></div>
    </div>
    <section class="bb-json">
      <button type="button" class="bb-jt" data-bb="json" aria-expanded="${S.jsonOpen}" aria-controls="bbJsonB">${ic("code")}<span>JSON</span>${ic("chev")}</button>
      <div class="bb-jb" id="bbJsonB"${S.jsonOpen ? "" : " hidden"}>
        <textarea id="bbJsonTa" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Strategy JSON" rows="16"></textarea>
        <p class="bb-jerr" id="bbJsonErr"></p>
        <div class="bb-jbar"><small title="Edits here update the blocks, and the blocks update this.">Synced with the blocks</small><button type="button" class="b-btn sm" data-bb="jcopy">Copy</button></div>
      </div>
    </section>
    <section class="b-step bb-bts"><div class="b-sh"><span class="b-num">${ic("chart")}</span><div><h3>Backtest</h3></div>${info("Replay recent history with this strategy. Rules that need live data are noted under the result.", "About the backtest")}</div>
      <div class="b-bar"><div class="b-seg sm" role="group" aria-label="Backtest window">${DAYS.map(([d, l]) => `<button type="button" data-bb="btdays" data-v="${d}" class="${S.btDays === d ? "on" : ""}" aria-pressed="${S.btDays === d}">${l}</button>`).join("")}</div>
        <button type="button" class="b-btn pri" data-bb="bt" id="bbBtBtn"></button></div>
      <div id="bbBt"></div>
    </section>
    <div class="b-start"><div class="b-stn">${PAPER}<span class="b-msg" id="bbMsg"></span>${info("Paper mode: every buy is priced by a real router quote on Monad when the trigger fires. Nothing is sent; each fill is committed on-chain to the agent's ERC-8004 track record.", "Paper mode")}</div>
      <button type="button" class="b-cta" data-bb="start" id="bbGo"></button>
    </div>`;
  paintBlocks(); paintPlain(); syncJson(true); paintBt();
}

// form controls; data-p = the path in the strategy, data-k = how to read the input
function numF(path, label, { pre = "", suf = "", hint = "", tip = "", ph = "", neg = false, mode = "decimal" } = {}) {
  const v = getP(S.st, path);
  return `<label class="b-field"${tip ? ` title="${esc(tip)}"` : ""}><span>${esc(label)}${hint ? `<small class="b-fh">${hint}</small>` : ""}</span><span class="b-in">${pre ? `<i>${pre}</i>` : ""}<input data-p="${path}" data-k="num" inputmode="${neg ? "text" : mode}" autocomplete="off" spellcheck="false" value="${esc(Array.isArray(v) ? "" : v ?? "")}" placeholder="${esc(ph)}">${suf ? `<i>${suf}</i>` : ""}</span><small class="bb-err" data-err="${path}"></small></label>`;
}
function textF(path, label, { ph = "", hint = "", tip = "", k = "text", mono = false, mode = "text" } = {}) {
  const v = getP(S.st, path);
  return `<label class="b-field"${tip ? ` title="${esc(tip)}"` : ""}><span>${esc(label)}${hint ? `<small class="b-fh">${hint}</small>` : ""}</span><span class="b-in ${mono ? "bb-mono" : "bb-txt"}"><input data-p="${path}" data-k="${k}" inputmode="${mode}" autocomplete="off" spellcheck="false" value="${esc(v ?? "")}" placeholder="${esc(ph)}"></span><small class="bb-err" data-err="${path}"></small></label>`;
}
function selF(path, label, opts, { re = false, hint = "" } = {}) {
  const v = getP(S.st, path), known = opts.some(([k]) => String(k) === String(v));
  return `<label class="b-field"><span>${esc(label)}${hint ? `<small class="b-fh">${hint}</small>` : ""}</span><span class="b-in bb-sel"><select data-p="${path}"${re ? ' data-re="1"' : ""}>${v == null || known ? "" : `<option value="${esc(v)}" selected>${esc(v)}</option>`}${opts.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></span><small class="bb-err" data-err="${path}"></small></label>`;
}
function segF(path, label, opts, { num = false } = {}) {
  const v = getP(S.st, path), long = opts.length > 3 || opts.reduce((n, [, l]) => n + String(l).length, 0) > 16;
  return `<div class="b-field bb-segf${long ? " bb-full" : ""}"><span>${esc(label)}</span><div class="b-seg sm bb-seg" role="group" aria-label="${esc(label)}">${opts.map(([k, l]) => `<button type="button" data-bb="set" data-p="${path}" data-v="${esc(k)}"${num ? ' data-num="1"' : ""} class="${String(k) === String(v) ? "on" : ""}" aria-pressed="${String(k) === String(v)}">${esc(l)}</button>`).join("")}</div><small class="bb-err" data-err="${path}"></small></div>`;
}
function listF(path, ph) {
  const list = arr(getP(S.st, path));
  return `<div class="bb-list"><div class="b-add"><input class="mono" data-addl="${path}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off" aria-label="${esc(ph)}"><button type="button" class="b-btn" data-bb="addl" data-p="${path}">Add</button></div>
    <p class="b-hint" data-hint="${path}"></p>
    <div class="b-chips">${list.map((v) => `<span class="b-chip"><span class="mono" title="${esc(v)}">${esc(short(v, 5, 5))}</span><button type="button" data-bb="rml" data-p="${path}" data-v="${esc(v)}" aria-label="Remove ${esc(short(v))}">×</button></span>`).join("")}</div>
    <small class="bb-err" data-err="${path}"></small></div>`;
}
const blk = (k, n, title, sub, body) => `<section class="bb-blk" data-blk="${k}"><div class="b-sh"><span class="b-num">${n}</span><div><h3>${title}</h3></div>${info(esc(sub), `About: ${title}`)}</div><p class="bb-err bb-berr" data-err="${k}"></p>${body}</section>`;

function paintBlocks() {
  const el = q("bbBlocks"); if (!el || !S.st) return;
  const fsel = focusSel(document.activeElement);
  const st = S.st, a = obj(st.action), buys = a.type === "buy";
  el.innerHTML = blk("trigger", 1, "Trigger", "What starts it.", trigHtml(obj(st.trigger)))
    + blk("filters", 2, "Filters", "Every one must pass, or the token is skipped.", filtHtml(arr(st.filters)))
    + blk("action", 3, "Action", "What it does when a token passes.", actHtml(a))
    + (buys ? blk("exits", 4, "Exits", "When a paper position is sold. Empty means off.", exitHtml(obj(st.exits), obj(st.trigger))) : "")
    + blk("limits", buys ? 5 : 4, "Limits", "Caps that keep it small.", limHtml(buys));
  if (fsel) for (const s of fsel) { const x = host.querySelector(s); if (x) { x.focus({ preventScroll: true }); break; } }
  paintErrs();
}
/** selectors that find the focused control again after the blocks are redrawn (best match first) */
function focusSel(f) {
  if (!f || !host?.contains(f) || !f.dataset) return null;
  const a = (k) => `[data-${k}="${CSS.escape(f.dataset[k])}"]`;
  const out = [];
  if (f.dataset.p != null) { if (f.dataset.v != null) out.push(a("p") + a("v")); out.push(a("p")); }
  if (f.dataset.bb && f.dataset.v != null) out.push(`[data-bb="${CSS.escape(f.dataset.bb)}"]${a("v")}`);
  if (f.dataset.addl) out.push(a("addl"));
  if (f.dataset.safety) out.push(a("safety"));
  if (f.dataset.bb) out.push(`[data-bb="${CSS.escape(f.dataset.bb)}"]`);
  return out.length ? out : null;
}
function trigHtml(t) {
  const ty = t.type;
  const chips = `<div class="bb-types" role="group" aria-label="Trigger type">${TRIGGERS.map(([k, l, i]) => `<button type="button" data-bb="ttype" data-v="${k}" class="bb-type${k === ty ? " on" : ""}" aria-pressed="${k === ty}" title="${esc(TRIG_HINT[k] ?? "")}">${ic(i)}<span>${l}</span></button>`).join("")}</div>
    ${TRIG_HINT[ty] ? "" : `<p class="bb-thint">${esc(ty ? `Trigger “${ty}” has no form here. Edit it in the JSON below.` : "Pick a trigger")}</p>`}<small class="bb-err" data-err="trigger.type"></small>`;
  let body = "";
  if (ty === "wallet_trade" || ty === "confluence") {
    const w = obj(t.wallets), smart = !Array.isArray(w.list) || !!w.smartTraders;
    body = `<div class="bb-sub"><div class="bb-subh"><b>Wallets</b><div class="b-seg sm" role="group" aria-label="Wallets"><button type="button" data-bb="wmode" data-v="smart" class="${smart ? "on" : ""}" aria-pressed="${smart}">Top smart traders</button><button type="button" data-bb="wmode" data-v="list" class="${smart ? "" : "on"}" aria-pressed="${!smart}">My list</button></div></div>
      ${smart ? `<div class="b-grid">${numF("trigger.wallets.smartTraders.top", "How many", { hint: "1–50", tip: "Top 1 to 50 by realized profit", mode: "numeric" })}${segF("trigger.wallets.smartTraders.days", "Ranked over", RANK_DAYS, { num: true })}</div>`
        : listF("trigger.wallets.list", "Paste Monad wallet addresses (0x…)")}<small class="bb-err" data-err="trigger.wallets"></small></div>
      <div class="b-grid">${ty === "confluence"
        ? numF("trigger.minWallets", "Wallets needed", { hint: "2–10", mode: "numeric" }) + numF("trigger.windowMin", "Within", { suf: "min", hint: "1–240" }) + selF("trigger.side", "Side", [["buy", "Buy"], ["sell", "Sell"]])
        : selF("trigger.side", "Side", [["buy", "Buys"], ["sell", "Sells"], ["any", "Any trade"]]) + numF("trigger.minUsd", "Min trade size", { pre: "$", ph: "Any" })}</div>`;
  } else if (ty === "new_token") {
    body = `<div class="b-grid">${segF("trigger.source", "Source", [["launch", "Launches"], ["graduation", "Graduations"], ["any", "Both"]])}</div>`;
  } else if (ty === "price") {
    const chg = t.op === "change_pct", mm = MINT_WORDS.includes(t.mint) ? t.mint : "one";
    body = `<div class="bb-sub"><div class="bb-subh"><b>Token</b><div class="b-seg sm" role="group" aria-label="Token"><button type="button" data-bb="pmint" data-v="one" class="${mm === "one" ? "on" : ""}" aria-pressed="${mm === "one"}">One token</button><button type="button" data-bb="pmint" data-v="trending" class="${mm === "trending" ? "on" : ""}" aria-pressed="${mm === "trending"}" title="Every token on Chord's trending Solana board">Trending</button><button type="button" data-bb="pmint" data-v="held" class="${mm === "held" ? "on" : ""}" aria-pressed="${mm === "held"}" title="Every token the agent holds">Held</button></div></div>
      ${mm === "one" ? `<div class="bb-wide">${textF("trigger.mint", "Token mint", { ph: "Paste a token mint address", k: "addr", mono: true })}</div>` : `<small class="bb-err" data-err="trigger.mint"></small>`}</div>
      <div class="b-grid">${selF("trigger.op", "When the price", [["above", "goes above"], ["below", "goes below"], ["change_pct", "moves by %"]], { re: true })}
      ${chg ? numF("trigger.value", "Change", { suf: "%", neg: true, hint: "-20 = drop", tip: "Negative for a drop, e.g. -20" }) + numF("trigger.windowMin", "Within", { suf: "min", ph: "60" }) : numF("trigger.value", "Price", { pre: "$" })}</div>`;
  } else if (ty === "schedule") {
    body = `<div class="b-grid">${segF("trigger.every", "Every", EVERY)}</div><div class="bb-wide">${textF("trigger.mint", "Token mint", { ph: "Paste a token mint address", k: "addr", mono: true })}</div>`;
  } else if (ty === "lp_event") {
    const tgt = Array.isArray(t.pools) ? "pools" : Array.isArray(t.mints) ? "mints" : "held";
    body = `<div class="bb-sub"><div class="bb-subh"><b>Watch</b><div class="b-seg sm" role="group" aria-label="Watch"><button type="button" data-bb="lpt" data-v="held" class="${tgt === "held" ? "on" : ""}">Tokens it holds</button><button type="button" data-bb="lpt" data-v="mints" class="${tgt === "mints" ? "on" : ""}">Tokens</button><button type="button" data-bb="lpt" data-v="pools" class="${tgt === "pools" ? "on" : ""}">Pools</button></div></div>
      ${tgt === "held" ? "" : listF(`trigger.${tgt}`, tgt === "pools" ? "Paste pool addresses" : "Paste token mint addresses")}</div>
      <div class="b-grid">${selF("trigger.event", "Event", LP_EVENTS, { re: true })}${numF("trigger.minUsd", t.event === "exodus" ? "Min withdrawn" : "Min size", { pre: "$", ph: `Default ${usdTxt(LP_MIN[t.event] ?? 1000)}`, tip: t.event === "exodus" ? "Withdrawals over twice the deposits in an hour" : "One liquidity event" })}</div>`;
  }
  return chips + body;
}
function filtHtml(fs) {
  const on = new Set(fs.map((f) => obj(f).safety).filter(Boolean));
  const rows = fs.map((f, i) => (obj(f).field != null || !obj(f).safety ? frow(obj(f), i) : "")).join("");
  return `<div class="bb-frows">${rows || `<p class="bb-empty" title="Every token that triggers passes">No filters</p>`}</div>
    <button type="button" class="b-btn sm bb-addf" data-bb="fadd">${ic("plus")}Filter</button>
    <div class="bb-lbl">Safety</div>
    <div class="bb-chks">${SAFETY.map(([k, l]) => `<label class="bb-chk"><input type="checkbox" data-safety="${k}"${on.has(k) ? " checked" : ""}><span class="bb-box">${svg("check", 3)}</span><span>${l}</span></label>`).join("")}</div>
    <small class="bb-err" data-err="filters.safety"></small>`;
}
function frow(f, i) {
  const unit = FIELDS[f.field]?.[1] ?? "", between = f.op === "between", v = f.value;
  const inp = (p, val, ph, label) => `<span class="b-in">${unit === "$" ? "<i>$</i>" : ""}<input data-p="${p}" data-k="num" inputmode="text" autocomplete="off" spellcheck="false" value="${esc(Array.isArray(val) ? "" : val ?? "")}" placeholder="${ph}" aria-label="${label}">${unit && unit !== "$" ? `<i>${unit}</i>` : ""}</span>`;
  const fieldOpts = Object.entries(FIELDS).map(([k, [l]]) => [k, l]);
  const sel = (p, opts, cur, label, re) => `<span class="b-in bb-sel"><select data-p="${p}"${re ? ' data-re="1"' : ""} aria-label="${label}">${cur == null || opts.some(([k]) => k === cur) ? "" : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`}${opts.map(([k, l]) => `<option value="${esc(k)}"${k === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></span>`;
  return `<div class="bb-frow">
    <span class="bb-ff">${sel(`filters.${i}.field`, fieldOpts, f.field ?? null, "Filter", true)}</span>
    <span class="bb-fo">${sel(`filters.${i}.op`, OPS, f.op ?? null, "Condition", true)}</span>
    <span class="bb-fv${between ? " two" : ""}">${between ? `${inp(`filters.${i}.value.0`, arr(v)[0], "From", "From")}<em>and</em>${inp(`filters.${i}.value.1`, arr(v)[1], "To", "To")}` : inp(`filters.${i}.value`, Array.isArray(v) ? v[0] : v, "Value", "Value")}</span>
    <button type="button" class="bb-x" data-bb="frm" data-v="${i}" aria-label="Remove this filter">×</button>
    <small class="bb-err" data-err="filters.${i}"></small><small class="bb-err" data-err="filters.${i}.value"></small>
  </div>`;
}
function actHtml(a) {
  const segs = `<div class="b-seg sm bb-seg bb-acts" role="group" aria-label="Action">${ACTIONS.map(([k, l]) => `<button type="button" data-bb="atype" data-v="${k}" class="${a.type === k ? "on" : ""}" aria-pressed="${a.type === k}">${l}</button>`).join("")}</div><small class="bb-err" data-err="action.type"></small>`;
  let body = "";
  if (a.type === "buy") body = `<div class="b-grid">${numF("action.usd", "Amount", { pre: "$", hint: "1–1,000", tip: "Paper USDC per buy, 1 to 1,000" })}</div>`;
  else if (a.type === "sell") body = `<div class="b-grid">${numF("action.pct", "Sell", { suf: "%", hint: "1–100", tip: "Of the held position, 1 to 100" })}</div>`;
  else if (a.type === "webhook") body = `<div class="bb-wide">${textF("action.url", "Webhook URL", { ph: "https://…", mode: "url", tip: "Each match is posted here as JSON. https only." })}</div>`;
  else if (a.type === "alert") body = `<p class="bb-thint" title="Each match shows in the agent's log. Nothing is bought.">Log only</p>`;
  return segs + body;
}
function exitHtml(x, t) {
  const slNeg = fin(x.stopLossPct) && Number(x.stopLossPct) < 0;
  const wallets = ["wallet_trade", "confluence"].includes(t.type), on = x.sellWhen === "followed_sells";
  return `<div class="b-grid bb-g4">${numF("exits.takeProfitPct", "Take profit", { pre: "+", suf: "%", ph: "Off" })}${numF("exits.stopLossPct", "Stop loss", { pre: slNeg ? "" : MINUS, suf: "%", ph: "Off" })}
    ${numF("exits.trailingPct", "Trailing stop", { suf: "%", ph: "Off", tip: "Under the high" })}${numF("exits.maxHoldMin", "Max hold", { suf: "min", ph: "Off", hint: "1440 = 24h" })}</div>
    ${wallets ? `<div class="b-togs bb-togs"><button type="button" class="b-tog" role="switch" aria-checked="${on}" data-bb="sellwhen" title="Sell when followed wallets sell: when a wallet that triggered the buy sells the token, the agent sells it too."><span class="b-sw"></span><span><b>Follow sells</b></span></button></div>` : ""}
    <small class="bb-err" data-err="exits.sellWhen"></small>`;
}
function limHtml(buys) {
  const usdBuy = Number(obj(S.st.action).usd);
  return `<div class="b-grid">${buys ? numF("limits.maxOpenPositions", "Open at most", { mode: "numeric", ph: "5", hint: "1–50", tip: "Positions at once, 1 to 50" }) + numF("limits.maxPerTokenUsd", "Per token", { pre: "$", ph: fin(usdBuy) ? `${numTxt(usdBuy * 3)}` : "3× the buy", tip: "Adds to a held token stop here" }) + numF("limits.dailyBudgetUsd", "Daily budget", { pre: "$", ph: "100", tip: "Paper USDC spent a day" }) : ""}
    ${numF("limits.maxTradesPerDay", buys ? "Trades/day" : "Matches/day", { mode: "numeric", ph: "20" })}${numF("limits.cooldownMin", "Cooldown", { suf: "min", ph: "10", tip: "Before the same token again" })}</div>`;
}

// ── plain words + checks ────────────────────────────────────────────────────────────────────────────────────────────────
function paintPlain() {
  const el = q("bbPlain"); if (!el || !S.st) return;
  const cur = S.expl && S.expl.key === sig(S.st);
  const lines = cur && S.expl.lines.length ? S.expl.lines : explain(S.st);
  el.innerHTML = lines.map((l) => `<li>${lineHtml(l)}</li>`).join("");
  const sm = q("bbSum"); if (sm) sm.textContent = summary(S.st);
  const tn = q("bbTplNote"), tp = S.tplId ? T.list?.find((x) => x.id === S.tplId) : null;
  if (tn) tn.innerHTML = tp && (tp.line || tp.risk) ? `<details class="ag-notes bb-tpln"><summary>${tp.risk ? `${ic("alert")}Risk` : "Template"}</summary>${tp.line ? `<p>${esc(tp.line)}</p>` : ""}${tp.risk ? `<p>${esc(tp.risk)}</p>` : ""}</details>` : "";
  const w = q("bbWarn");
  const warns = cur ? S.expl.warnings : [];
  if (w) { w.hidden = !warns.length; w.innerHTML = warns.map((x) => `<li>${ic("alert")}<span>${esc(x)}</span></li>`).join(""); }
}
function localErrs(st) {
  const out = [];
  if (!st) return out;
  const walk = (v, path) => {
    if (typeof v === "string" && path && (NUMK.has(path.split(".").pop()) || /\.value\.\d+$/.test(path))) out.push({ key: path, msg: v.trim() ? "must be a number" : "needs a value" });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(st, "");
  const t = obj(st.trigger);
  if (["price", "schedule"].includes(t.type)) {
    const m = String(t.mint ?? "").trim();
    if (!m) out.push({ key: "trigger.mint", msg: "paste a token mint" });
    else if (!B58.test(m) && !(t.type === "price" && MINT_WORDS.includes(m))) out.push({ key: "trigger.mint", msg: "is not a Monad address" });
  }
  const a = obj(st.action);
  if (a.type === "webhook") { let u = null; try { u = new URL(String(a.url ?? "")); } catch {} if (!u || u.protocol !== "https:") out.push({ key: "action.url", msg: "must be a full https:// address" }); }
  return out.map((e) => ({ ...e, full: `${BLOCK[e.key.split(".")[0]] ?? "Strategy"} › ${e.key.split(".").filter((k) => !/^\d+$/.test(k)).pop()}: ${e.msg}` }));
}
/** "Filters › liquidityUsd: value must be a number" → { key: "filters.liquidityUsd", msg }; { path: ["trigger", "minWallets"], message } → { key: "trigger.minWallets", msg } */
function parseErr(e) {
  const norm = (p) => p.replace(/\[(\d+)\]/g, ".$1").replace(/\s*›\s*/g, ".").replace(/^\.+|\.+$/g, "").replace(/^strategy\./, "");
  if (e && typeof e === "object") {
    const msg = String(e.message ?? e.msg ?? e.error ?? "Not valid.");
    const p = Array.isArray(e.path) ? e.path.join(".") : typeof e.path === "string" ? e.path : typeof e.field === "string" ? e.field : "";
    if (p) { const key = norm(p); const m = /^[^:]*›[^:]*:\s*([\s\S]+)$/.exec(msg); return { key, msg: m ? m[1] : msg, full: m ? msg : `${BLOCK[key.split(".")[0]] ?? "Strategy"} › ${key.split(".").slice(1).join(" › ") || key}: ${msg}` }; }
    e = msg;
  }
  const m = String(e ?? "");
  const x = /^\s*([A-Za-z ]+?)\s*›\s*([^:]+?)\s*:\s*([\s\S]+)$/.exec(m);
  if (x) {
    const bl = x[1].trim().toLowerCase(), b = BLOCK_KEY[bl], f = x[2].trim();
    if (b === "filters") { const fm = /^filter (\d+)$/i.exec(f); return { key: fm ? `filters.${Number(fm[1]) - 1}` : /^safety\b/i.test(f) ? "filters.safety" : `filters.${f}`, msg: x[3], full: m }; }
    return { key: b ? `${b}.${norm(f)}` : bl === "strategy" ? norm(f) : null, msg: x[3], full: m };
  }
  const y = /^\s*(trigger|filters?|action|exits?|limits?|name)\s*:\s*([\s\S]+)$/i.exec(m);
  if (y) return { key: BLOCK_KEY[y[1].toLowerCase()], msg: y[2], full: m };
  return { key: null, msg: m, full: m };
}
/** the error slot nearest to a key: exact → same last field inside the block → shorter prefixes → the block → general */
function slotOf(e) {
  if (!e.key) return "general";
  let k = e.key;
  const ks = k.split("."), fs = arr(S.st?.filters);
  if (ks[0] === "filters" && ks[1] != null && !/^\d+$/.test(ks[1])) {
    if (FIELDS[ks[1]]) { const i = fs.findIndex((f) => obj(f).field === ks[1]); k = i >= 0 ? `filters.${i}.value` : "filters"; }
    else if (ks[1] === "safety" || SAFETY.some(([s]) => s === ks[1])) k = "filters.safety";
  }
  const slots = new Set([...host.querySelectorAll("[data-err]")].map((x) => x.dataset.err));
  if (slots.has(k)) return k;
  const last = k.split(".").pop(), blk = k.split(".")[0];
  if (k.includes(".") && !/^\d+$/.test(last)) { const m = [...slots].find((s) => s.startsWith(`${blk}.`) && s.endsWith(`.${last}`)); if (m) return m; }
  for (let p = k; p.includes("."); ) { p = p.slice(0, p.lastIndexOf(".")); if (slots.has(p)) return p; }
  return slots.has(blk) ? blk : "general";
}
function errsNow() {
  const loc = localErrs(S.st), lk = new Set(loc.map((e) => e.key));
  const all = [...loc.map((e) => ({ ...e, local: true })), ...S.val.errs.filter((e) => !lk.has(e.key))];
  if (!host?.isConnected) return all;
  const localSlots = new Set(all.filter((e) => e.local).map(slotOf)), seen = new Set();
  return all.filter((e) => {
    const s = slotOf(e), id = `${s}|${e.msg}`;
    if ((!e.local && localSlots.has(s) && s !== "general") || seen.has(id)) return false;
    seen.add(id); return true;
  });
}
function paintErrs() {
  if (!host || !S.st) return;
  host.querySelectorAll("[data-err]").forEach((el) => { el.textContent = ""; });
  host.querySelectorAll(".bb-bad").forEach((el) => el.classList.remove("bb-bad"));
  const all = errsNow(), by = new Map(), gen = [];
  for (const e of all) {
    const s = slotOf(e);
    if (s === "general") { gen.push(e.full || e.msg); continue; }
    const short1 = s.includes(".") || s === "name" ? cap(String(e.msg).trim()) : e.full || e.msg;
    if (!by.has(s)) by.set(s, []);
    if (!by.get(s).includes(short1)) by.get(s).push(short1);
  }
  for (const [s, msgs] of by) {
    const el = at("data-err", s); if (!el) continue;
    el.textContent = msgs.join(" ");
    const ins = host.querySelectorAll(`[data-p="${CSS.escape(s)}"], [data-p^="${CSS.escape(s)}."]`);
    if (ins.length) ins.forEach((x) => x.closest(".b-in")?.classList.add("bb-bad"));
    else (el.closest(".bb-frow") ?? el.closest(".b-field") ?? el.closest(".bb-list"))?.classList.add("bb-bad");
  }
  const g = q("bbGErr");
  if (g) { g.hidden = !gen.length; g.innerHTML = gen.map((x) => `<li>${ic("alert")}<span>${esc(x)}</span></li>`).join(""); }
  paintStatus(all.length);
  paintGates(all.length);
}
function paintStatus(n = errsNow().length) {
  const el = q("bbVal"); if (!el) return;
  el.className = "bb-stat"; el.removeAttribute("title");
  if (S.jsonErr) { el.classList.add("bad"); el.innerHTML = `${ic("alert")}JSON error`; el.title = S.jsonErr; }
  else if (n) { el.classList.add("bad"); el.innerHTML = `${ic("alert")}${n} to fix`; }
  else if (S.val.busy) { el.classList.add("busy"); el.innerHTML = `${ic("spin")}Checking`; }
  else if (S.val.err) { el.classList.add("off"); el.innerHTML = "Not checked"; el.title = S.val.err; }
  else { el.classList.add("ok"); el.innerHTML = `${ic("check", 2.4)}Valid`; }
}
function scheduleValidate(now) {
  clearTimeout(vTimer);
  vCtl?.abort(); vCtl = null;
  if (!S.st) return;
  S.val.busy = true; paintStatus();
  vTimer = setTimeout(validate, now ? 0 : 450);
}
async function validate() {
  vCtl?.abort();
  const ctl = (vCtl = new AbortController()), st = S.st, key = sig(st);
  let next;
  try {
    const r = await fetch("/v1/strategies/validate", { method: "POST", signal: ctl.signal, headers: { "X-Session": session(), "Content-Type": "application/json" }, body: JSON.stringify({ strategy: st }) });
    const j = await r.json().catch(() => null);
    if (ctl !== vCtl) return;
    const list = arr(j?.errors ?? j?.issues ?? (Array.isArray(j) ? j : null));
    if (r.ok || r.status === 400 || r.status === 422) {
      const errs = list.map(parseErr);
      if (!r.ok && !errs.length) errs.push(parseErr(j?.message ?? "This strategy is not valid."));
      if (r.ok && j?.ok === false && !errs.length) errs.push(parseErr(j?.message ?? "This strategy is not valid."));
      next = { busy: false, errs, err: null };
      const ex = strs(j?.explanation);
      if (!errs.length && ex.length && key === sig(S.st)) { const w = strs(j?.warnings); S.expl = { lines: ex, warnings: w.length ? w : S.expl?.key === key ? S.expl.warnings : [], key }; }
    } else next = { busy: false, errs: [], err: r.status === 404 ? "Checks are not available yet." : `The checker failed (${r.status}).` };
  } catch (e) {
    if (e?.name === "AbortError") return;
    next = { busy: false, errs: [], err: "Could not reach the checker." };
  }
  if (key !== sig(S.st) || !host?.isConnected) return;
  S.val = next;
  paintErrs(); paintPlain();
}

// ── JSON drawer ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function syncJson(force) {
  const ta = q("bbJsonTa"); if (!ta || !S.st) return;
  if (!force && document.activeElement === ta) return;
  ta.value = JSON.stringify(S.st, null, 2);
  S.jsonErr = null; paintJsonErr();
}
function paintJsonErr() { const el = q("bbJsonErr"); if (el) el.textContent = S.jsonErr ?? ""; q("bbJsonTa")?.classList.toggle("bb-bad", !!S.jsonErr); paintStatus(); paintGates(); }
function fromJson() {
  const ta = q("bbJsonTa"); if (!ta) return;
  let v;
  try { v = JSON.parse(ta.value); } catch (e) { S.jsonErr = `Not valid JSON: ${String(e.message ?? e).replace(/^JSON\.parse: /, "")}`; paintJsonErr(); return; }
  if (!v || typeof v !== "object" || Array.isArray(v)) { S.jsonErr = "The strategy must be one JSON object."; paintJsonErr(); return; }
  S.jsonErr = null; paintJsonErr();
  S.st = normalize(v);
  changed({ blocks: true, json: false });
}

// ── backtest ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const btSig = () => sig([S.st, S.btDays]);
function paintStale() { const el = q("bbStale"); if (el && S.bt) el.hidden = S.btKey === btSig(); }
function paintBt() {
  const el = q("bbBt"); if (!el) return;
  el.innerHTML = btHtml();
  paintStale(); paintGates();
}
function btHtml() {
  const u = D.ui ?? {};
  if (!S.bt) {
    if (S.btBusy) return `<div class="b-btwait"><div class="b-skel" style="height:180px"></div><p>${ic("spin")}Replaying ${esc(dTag(S.btDays))}…</p></div>`;
    if (S.btErr) return `<div class="b-errbox">${ic("alert")}<span>${esc(S.btErr)}</span><button type="button" class="b-btn" data-bb="bt">Try again</button></div>`;
    return `<div class="b-none">No run yet</div>`;
  }
  const N = u.N ?? ((x) => (fin(x) ? Number(x) : null)), bt = S.bt;
  const r = N(bt.realizedUsd) ?? 0, un = N(bt.unrealizedUsd) ?? 0, tot = r + un, dd = Math.abs(N(bt.maxDrawdownUsd) ?? 0), inv = N(bt.investedUsd) ?? 0;
  const fills = (u.rows ?? arr)(bt.fills).sort((a, b) => (u.toMs?.(b.ts) ?? 0) - (u.toMs?.(a.ts) ?? 0));
  const shown = S.btAll ? fills : fills.slice(0, 25);
  const notes = strs(bt.notes);
  const trades = N(bt.buys) != null || N(bt.sells) != null;
  const cov = fin(bt.coveredHours) && Number(bt.coveredHours) < Number(bt.days ?? S.btDays) * 24;
  return `<div class="b-btres${S.btBusy ? " b-dim" : ""}">
    ${S.btErr ? `<div class="b-banner bad">${ic("alert")}<span>${esc(S.btErr)}</span></div>` : ""}
    <p class="b-stale" id="bbStale" hidden>${ic("alert")}Strategy changed, run again</p>
    <div class="bb-rep">
      <div class="bb-lead">
        <small class="bb-rph"><em class="ag-rp"${cov ? ` title="${esc(`${dTag(bt.days ?? S.btDays)} asked: the new-token board keeps the last ${Number(bt.coveredHours)} hours`)}"` : ""}>${esc(u.replayTag ? u.replayTag(bt.days ?? S.btDays, bt.coveredHours) : `replay ${dTag(bt.days ?? S.btDays)}`)}</em>${u.walletsReadChip?.(bt) ?? ""}</small>
        <b class="bb-big ${u.cls(tot)}">${u.signed(tot)}</b>
        <span class="bb-on"><span>${inv ? `<b class="${u.cls(tot)}">${tot > 0 ? "+" : tot < 0 ? MINUS : ""}${Math.abs((tot / inv) * 100).toFixed(1)}%</b> <span title="invested">/ ${u.usd(inv)}</span>` : "-"}</span> <span>realized ${u.signed(r)}</span> <span>open ${u.signed(un)}</span></span>
        <dl class="bb-kv"><div><dt>Win rate</dt><dd>${u.pct(bt.winRate)}</dd></div><div><dt>Trades</dt><dd>${u.int(bt.trades)}</dd></div>${N(bt.signals) != null ? `<div><dt>Signals</dt><dd>${u.int(bt.signals)}</dd></div>` : ""}<div><dt>Drawdown</dt><dd class="${dd ? "b-down" : ""}">${dd ? `${MINUS}${u.usd(dd)}` : "$0.00"}</dd></div></dl>
        <p class="bb-sum">${trades ? `${u.int(bt.buys)} buy, ${u.int(bt.sells)} sell, ${u.int(bt.skipped)} skip` : `${u.int(bt.skipped)} skip`}</p>
      </div>
      <div class="bb-eq">${u.equityHtml(bt.equity, "Equity")}</div>
    </div>
    <div class="bb-src"><span title="${esc(`Checked against ${SRC_OF[bt.trigger ?? obj(obj(S.st).trigger).type] ?? "Chord's Monad trade feed"}`)}">${ic("check", 2.2)}${esc(SRC_TAG[bt.trigger ?? obj(obj(S.st).trigger).type] ?? "Solana tape")}</span>${notes.length ? `<details class="ag-notes bb-more"><summary>${notes.length} note${notes.length === 1 ? "" : "s"}</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}</div>
    ${fills.length ? `<div class="b-sech"><h3>Fills</h3><small>${u.int(fills.length)}</small></div>${u.fillsTable(shown, null, fills.length > shown.length ? `<button type="button" class="b-more" data-bb="bt-all">All ${u.int(fills.length)}</button>` : "")}` : `<div class="b-none">No trades in this window</div>`}
  </div>`;
}
const dTag = (d) => (Number(d) === 1 ? "24h" : `${Number(d)}d`);
/** the source, in two words */
const SRC_TAG = { wallet_trade: "Raw tape", confluence: "Raw tape", price: "Candles", schedule: "Candles", new_token: "New-token board", lp_event: "LP tape" };
/** what the backtest replays, per trigger (src/strategy/backtest.ts) */
const SRC_OF = { wallet_trade: "Chord's Monad trade feed: every swap of the followed wallets", confluence: "Chord's Monad trade feed: every swap of the smart traders", price: "Chord's candles of the token", schedule: "Chord's candles of the token", new_token: "Chord's new-token board and each token's pools", lp_event: "the LP tape of the watched pools" };
async function runBacktest() {
  if (S.btBusy || !S.st) return;
  if (S.jsonErr) return setMsg("Fix the JSON", true);
  if (errsNow().length) return setMsg("Fix the highlighted fields", true);
  S.btBusy = true; S.btErr = null; paintBt();
  const key = btSig(), st = S.st;
  try {
    const bt = await D.api("/v1/strategies/backtest", { method: "POST", body: { strategy: st, days: S.btDays } });
    S.bt = bt && typeof bt === "object" ? (bt.backtest && typeof bt.backtest === "object" ? bt.backtest : bt) : null;
    S.btKey = key; S.btAll = false;
    if (!S.bt) S.btErr = "The server sent a backtest this page cannot read.";
  } catch (e) { S.btErr = e.message; }
  S.btBusy = false;
  if (host?.isConnected) paintBt();
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function setMsg(text, bad) { const el = q("bbMsg"); if (el) { el.textContent = text; el.className = `b-msg${bad ? " bad" : ""}`; } }
function paintGates(n = errsNow().length) {
  if (S.jsonErr) n += 1; // the JSON drawer holds text that does not parse: nothing runs until it does
  const go = q("bbGo"), bb = q("bbBtBtn");
  if (bb) { bb.disabled = S.btBusy || !!n; bb.innerHTML = S.btBusy ? `${ic("spin")}Replaying…` : `${ic("chart")}Run backtest`; }
  if (go) { go.disabled = S.startBusy || !!n; go.innerHTML = S.startBusy ? `${ic("spin")}Starting…` : "Start agent"; }
  if (S.startErr) setMsg(S.startErr, true);
  else setMsg(S.jsonErr ? "Fix the JSON" : n ? `Fix ${n === 1 ? "1 field" : `${n} fields`}` : "", false);
}
async function start() {
  if (S.startBusy || !S.st) return;
  if (S.jsonErr || errsNow().length) return paintGates();
  S.startBusy = true; S.startErr = null; paintGates();
  try {
    const name = String(S.st.name ?? "").trim().slice(0, NAME_MAX);
    const params = { strategy: S.st, ...(S.tplId ? { templateId: S.tplId } : {}) }; // the gallery's "N running" counts it
    const j = await D.api("/v1/agents", { method: "POST", body: { type: "custom", ...(name ? { name } : {}), mode: "paper", params } });
    const bot = j?.bot ?? j;
    if (!bot?.id) throw new Error("The agent was created but the answer had no id. Check My agents.");
    const days = S.btDays;
    S = { ...fresh(), btDays: days };
    D.onCreated?.(bot);
  } catch (e) {
    S.startBusy = false; S.startErr = e.message;
    if (host?.isConnected) paintGates();
  }
}

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function addAddrs(path) {
  const inp = at("data-addl", path); if (!inp || !S.st) return;
  const toks = inp.value.trim().split(/[\s,;]+/).filter(Boolean);
  if (!toks.length) return;
  let list = getP(S.st, path);
  if (!Array.isArray(list)) { setP(S.st, path, []); list = getP(S.st, path); }
  const max = MAX_LIST[path] ?? 20, bad = toks.filter((x) => !B58.test(x));
  let dup = 0, full = 0;
  for (const x of toks.filter((t) => B58.test(t))) { if (list.includes(x)) dup++; else if (list.length >= max) full++; else list.push(x); }
  const msg = bad.length ? `${bad.length === 1 ? "That is" : `${bad.length} entries are`} not a Monad address (0x and 40 hex characters).` : full ? `Up to ${max} here.` : dup && dup === toks.length ? "Already in the list." : "";
  changed({ blocks: true, path });
  const ni = at("data-addl", path);
  if (ni) { ni.value = bad.join(" "); ni.focus({ preventScroll: true }); }
  const h = at("data-hint", path); if (h) { h.textContent = msg; h.className = `b-hint${msg ? " bad" : ""}`; }
}
function onClick(e) {
  const a = e.target.closest("[data-bb]");
  if (!a || !host.contains(a)) return;
  const ds = a.dataset, st = S.st;
  switch (ds.bb) {
    case "gen": return void compile(false);
    case "answer": return void compile(true);
    case "qopt": { const i = Number(ds.i), inp = at("data-qa", String(i)); if (inp) inp.value = ds.v; if (S.qs[i]) S.qs[i].a = ds.v; return; }
    case "tpl": return applyTemplate(ds.v, false);
    case "tpl-retry": T.err = null; return void loadTemplates();
    case "blank": loadStrategy(blank(), { label: "a blank strategy" }); return;
    case "undo": if (S.undo) { const u = S.undo; S.undo = null; S.st = u.st; S.tplId = u.tplId; S.bt = null; S.btKey = null; setHash(u.tplId ? `#bots/build/${encodeURIComponent(u.tplId)}` : "#bots/build"); paintEditor(); paintTpl(); scheduleValidate(true); } return;
    case "json": {
      S.jsonOpen = !S.jsonOpen; a.setAttribute("aria-expanded", String(S.jsonOpen));
      const b = q("bbJsonB"); if (b) b.hidden = !S.jsonOpen;
      if (S.jsonOpen) syncJson(true);
      return;
    }
    case "jcopy": { const ta = q("bbJsonTa"); if (ta) navigator.clipboard?.writeText(ta.value).then(() => { a.textContent = "Copied"; setTimeout(() => { a.textContent = "Copy"; }, 1400); }).catch(() => {}); return; }
    case "btdays": S.btDays = Number(ds.v); a.parentElement.querySelectorAll("button").forEach((x) => { x.classList.toggle("on", x === a); x.setAttribute("aria-pressed", String(x === a)); }); return paintStale();
    case "bt": return void runBacktest();
    case "bt-all": S.btAll = true; return paintBt();
    case "start": return void start();
  }
  if (!st) return;
  switch (ds.bb) {
    case "ttype": if (obj(st.trigger).type !== ds.v) { S.stash[`t:${obj(st.trigger).type}`] = st.trigger; st.trigger = S.stash[`t:${ds.v}`] ?? trigFor(ds.v, obj(st.trigger)); changed({ blocks: true, path: "trigger.type" }); } return;
    case "atype": if (obj(st.action).type !== ds.v) { S.stash[`a:${obj(st.action).type}`] = st.action; st.action = S.stash[`a:${ds.v}`] ?? actFor(ds.v, obj(st.action)); changed({ blocks: true, path: "action.type" }); } return;
    case "wmode": {
      const w = obj(st.trigger.wallets), smart = !Array.isArray(w.list) || !!w.smartTraders;
      if ((ds.v === "smart") === smart) return;
      S.stash[smart ? "w:smart" : "w:list"] = w;
      st.trigger.wallets = S.stash[ds.v === "smart" ? "w:smart" : "w:list"] ?? (ds.v === "smart" ? { smartTraders: { top: 20, days: 1 } } : { list: [] });
      return changed({ blocks: true, path: "trigger.wallets" });
    }
    case "pmint": {
      const cur = String(st.trigger.mint ?? "");
      if (!MINT_WORDS.includes(cur) && cur) S.stash["p:mint"] = cur;
      st.trigger.mint = ds.v === "one" ? S.stash["p:mint"] ?? "" : ds.v;
      return changed({ blocks: true, path: "trigger.mint" });
    }
    case "lpt": {
      const t = st.trigger;
      if (Array.isArray(t.pools)) S.stash["lp:pools"] = t.pools;
      if (Array.isArray(t.mints)) S.stash["lp:mints"] = t.mints;
      delete t.pools; delete t.mints;
      if (ds.v !== "held") t[ds.v] = S.stash[`lp:${ds.v}`] ?? [];
      return changed({ blocks: true, path: "trigger" });
    }
    case "set": { setP(st, ds.p, ds.num ? Number(ds.v) : ds.v); return changed({ blocks: true, path: ds.p }); }
    case "fadd": {
      if (!Array.isArray(st.filters)) st.filters = [];
      const used = new Set(st.filters.map((f) => obj(f).field));
      const field = Object.keys(FIELDS).find((k) => !used.has(k)) ?? "liquidityUsd";
      const at0 = st.filters.findIndex((f) => obj(f).safety);
      const row = { field, op: ">=", value: "" };
      if (at0 >= 0) st.filters.splice(at0, 0, row); else st.filters.push(row);
      changed({ blocks: true });
      const i = st.filters.indexOf(row);
      at("data-p", `filters.${i}.field`)?.focus();
      return;
    }
    case "frm": { st.filters.splice(Number(ds.v), 1); S.val.errs = S.val.errs.filter((x) => !String(x.key ?? "").startsWith("filters.")); return changed({ blocks: true }); }
    case "addl": return addAddrs(ds.p);
    case "rml": { const l = getP(st, ds.p); if (Array.isArray(l)) setP(st, ds.p, l.filter((x) => x !== ds.v)); return changed({ blocks: true, path: ds.p }); }
    case "sellwhen": {
      st.exits = obj(st.exits);
      if (st.exits.sellWhen === "followed_sells") delete st.exits.sellWhen; else st.exits.sellWhen = "followed_sells";
      return changed({ blocks: true, path: "exits.sellWhen" });
    }
  }
}
function onInput(e) {
  const t = e.target;
  if (t.id === "bbText") { S.text = t.value; if (S.compErr) { S.compErr = null; paintComp(); } return; }
  if (t.id === "bbJsonTa") { clearTimeout(jTimer); jTimer = setTimeout(fromJson, 300); return; }
  if (t.dataset?.qa != null) { const x = S.qs[Number(t.dataset.qa)]; if (x) x.a = t.value; const m = q("bbQMsg"); if (m) m.textContent = ""; return; }
  if (t.dataset?.addl) { const h = at("data-hint", t.dataset.addl); if (h) h.textContent = ""; return; }
  if (!S.st || !t.dataset?.p || t.tagName === "SELECT") return;
  const p = t.dataset.p, k = t.dataset.k;
  const v = k === "num" ? parseNum(t.value) : k === "addr" ? t.value.trim() : t.value;
  setP(S.st, p, v);
  changed({ path: p });
}
function onChange(e) {
  const t = e.target;
  if (!S.st) return;
  if (t.tagName === "SELECT" && t.dataset.p) {
    const p = t.dataset.p;
    const m = /^filters\.(\d+)\.op$/.exec(p);
    if (m) {
      const f = obj(S.st.filters[Number(m[1])]), was = f.op;
      f.op = t.value;
      if (t.value === "between" && was !== "between") f.value = [fin(f.value) ? Number(f.value) : "", ""];
      else if (t.value !== "between" && Array.isArray(f.value)) f.value = f.value[0] ?? "";
    } else setP(S.st, p, t.value);
    return changed({ blocks: !!t.dataset.re, path: p });
  }
  if (t.dataset?.safety) {
    const k = t.dataset.safety;
    if (!Array.isArray(S.st.filters)) S.st.filters = [];
    S.st.filters = t.checked ? [...S.st.filters.filter((f) => obj(f).safety !== k), { safety: k }] : S.st.filters.filter((f) => obj(f).safety !== k);
    return changed({ blocks: true, path: "filters.safety" });
  }
}
function onKey(e) {
  const t = e.target;
  if (t.id === "bbText" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); compile(false); }
  else if (e.key === "Enter" && t.dataset?.addl) { e.preventDefault(); addAddrs(t.dataset.addl); }
  else if (e.key === "Enter" && t.dataset?.qa != null) { e.preventDefault(); compile(true); }
}
