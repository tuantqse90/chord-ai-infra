// Marketplace (#market): agents their owners listed, ranked by a score built from what anyone can check on Monad: fills
// committed to the agent's TrackRecord, the validator's replays, on-chain ratings, and the paper PnL (GET /v1/market).
// List one of your trading agents with a title and a pitch (#market/list, #market/list/<botId> from an agent page); Open
// goes to the agent page, Copy forks it into your agents. Every server string is escaped.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const idUrl = (id) => `https://monadscan.com/token/${IDENTITY}?a=${encodeURIComponent(id)}`;
const I = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  tag: '<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l8 8a1.4 1.4 0 0 1 0 2l-7.1 7.1a1.4 1.4 0 0 1-2 0Z"/><circle cx="8.2" cy="8.2" r="1.6"/>',
  spin: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
};
const ic = (n, sw = 1.8) => `<i class="b-i${n === "spin" ? " b-spin" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] ?? ""}</svg></i>`;
const MINUS = "-";
const usd = (v) => { const n = Number(v) || 0, a = Math.abs(n); return `${n < 0 ? MINUS : n > 0 ? "+" : ""}$${a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toFixed(2)}`; };
const cls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
const pct = (v) => (v == null ? "-" : `${Math.round(Number(v) * 100)}%`);
const TYPE = { copy: "Copy trader", custom: "Strategy", alert: "Alert" };
const SORTS = [["score", "Score"], ["pnl", "PnL 7d"], ["validated", "Validated"], ["new", "New"]];
const info = (html, label) => `<details class="ag-i"><summary aria-label="${esc(label)}" title="${esc(label)}">${ic("info", 2)}</summary><div class="ag-ip">${html}</div></details>`;
function spark(a) {
  const v = (a ?? []).map(Number).filter(Number.isFinite);
  if (v.length < 2) return `<span class="mk-spk none"></span>`;
  const lo = Math.min(...v, 0), hi = Math.max(...v, 0), w = 100, h = 28, k = (hi - lo) || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - ((x - lo) / k) * h).toFixed(1)}`).join(" ");
  return `<svg class="mk-spk ${cls(v[v.length - 1])}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

let M = null; // { root, api, session, openAgent, sort, data, err, busy: Set, msg: Map, modal }
export function renderMarketView(root, { api, session, openAgent }) {
  const first = !M || M.root !== root;
  M = { ...(M ?? {}), root, api, session, openAgent, sort: M?.sort ?? "score", busy: M?.busy ?? new Set(), msg: M?.msg ?? new Map() };
  if (first) {
    root.innerHTML = `<div class="mk">
      <header class="ag-top">
        <div class="ag-ttl"><h1>Marketplace</h1><span class="ag-mode">Agents ranked by their record on Monad</span><span id="mkInfo"></span></div>
        <button type="button" class="b-new" data-mk="list">${ic("plus", 2.2)}List your agent</button>
      </header>
      <div class="mk-bar"><div class="b-seg sm" role="tablist" aria-label="Sort">${SORTS.map(([k, l]) => `<button type="button" data-sort="${k}" class="${k === M.sort ? "on" : ""}">${l}</button>`).join("")}</div><small id="mkN"></small></div>
      <div id="mkList"><div class="b-skel" style="height:132px"></div><div class="b-skel" style="height:132px;margin-top:10px"></div></div>
    </div>`;
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
  }
  load();
  route();
}
/** #market/list[/<botId>] opens the listing form */
function route() {
  const m = /^#market\/list(?:\/([0-9a-f]{12}))?$/.exec(location.hash);
  if (m) openModal(m[1] ?? null);
}
export function onMarketHash() { if (M) route(); }

async function load() {
  try { M.data = await M.api(`/v1/market?sort=${M.sort}`); M.err = null; }
  catch (e) { M.err = e.message; }
  paint();
}
function paint() {
  const el = $("mkList"); if (!el) return;
  const d = M.data;
  const inf = $("mkInfo"); if (inf && d?.scoring && !inf.firstChild) inf.innerHTML = info(`<p>${esc(d.scoring)}</p><p>Owners list their own trading agents. Open any of them to check its record in your browser; Copy starts a paper agent with the same rules.</p>`, "How the ranking works");
  if (M.err && !d) { el.innerHTML = `<div class="ag-mempty"><b>The marketplace did not load</b><span>${esc(M.err)}</span><span class="ag-ebtns"><button type="button" class="b-btn" data-mk="retry">Try again</button></span></div>`; return; }
  if (!d) return;
  const n = $("mkN"); if (n) n.textContent = d.listings.length ? `${d.listings.length} listed` : "";
  if (!d.listings.length) {
    el.innerHTML = `<div class="ag-mempty"><b>No agents listed yet</b><span>List one of your trading agents: its record on Monad ranks it.</span><span class="ag-ebtns"><button type="button" class="b-new" data-mk="list">${ic("tag")}List your agent</button></span></div>`;
    return;
  }
  el.innerHTML = `<ol class="mk-list"><li class="mk-row head" aria-hidden="true"><span>#</span><span>Agent</span><span>Score</span><span>On Monad</span><span>Validation</span><span>Rating</span><span>PnL 7d</span><span>Win</span><span>Equity</span><span></span></li>${d.listings.map(card).join("")}</ol>`;
}
/** one listing, one row: the agent and its pitch, then the numbers the score is built from */
function card(l) {
  const r = l.record, p = l.perf, s = l.score, id = l.botId;
  const parts = `Evidence ${s.evidence} × (40% validation ${s.validation} + 40% results ${s.results} + 20% rating ${s.rating})`;
  const onMonad = r.agentId
    ? `<a class="ag-id" href="${esc(idUrl(r.agentId))}" target="_blank" rel="noopener" title="ERC-8004 agent #${esc(r.agentId)} on Monad">#${esc(r.agentId)}</a><small>${r.committed} fill${r.committed === 1 ? "" : "s"}</small>`
    : `<small title="No ERC-8004 identity yet: the agent gets one on Monad when the committer registers it">Not yet</small>`;
  const val = r.validation.avg == null ? `<span class="dim">-</span>` : `<span><span class="up">${Math.round(r.validation.avg)}</span><small>/100</small></span>`;
  const rate = r.rating.avg == null ? `<span class="dim">-</span>` : `<span>${(r.rating.avg / 20).toFixed(1)}</span><small>${r.rating.count} rating${r.rating.count === 1 ? "" : "s"}</small>`;
  const busy = M.busy.has(id), msg = M.msg.get(id);
  const kind = [TYPE[l.agent.type] ?? l.agent.type, l.agent.template && l.agent.template !== TYPE[l.agent.type] ? l.agent.template : "", l.agent.status !== "running" ? l.agent.status : "", l.mine ? "yours" : ""].filter(Boolean).join(", ");
  const acts = l.mine
    ? `<button type="button" class="b-btn sm" data-mk="edit" data-id="${esc(id)}">Edit</button><button type="button" class="b-btn sm danger" data-mk="unlist" data-id="${esc(id)}"${busy ? " disabled" : ""}>${busy ? ic("spin") : ""}Unlist</button>`
    : `<button type="button" class="b-btn sm ag-copy" data-mk="copy" data-id="${esc(id)}"${busy ? " disabled" : ""} title="Start a paper agent with the same rules">${busy ? ic("spin") : ""}Copy</button>`;
  return `<li class="mk-row">
    <span class="mk-rank">${l.rank}</span>
    <a class="mk-who" href="#agents/public/${esc(id)}" title="Open the agent: its fills, its record on Monad"><b>${esc(l.title)}</b><small>${esc(kind)}</small><span class="mk-pitch">${esc(l.pitch)}</span></a>
    <span class="mk-c mk-score" title="${esc(parts)}">${s.total}</span>
    <span class="mk-c">${onMonad}</span>
    <span class="mk-c">${val}</span>
    <span class="mk-c">${rate}</span>
    <span class="mk-c ${cls(p.pnl7dUsd)}">${usd(p.pnl7dUsd)}</span>
    <span class="mk-c">${pct(p.winRate)}<small>${p.trades} trade${p.trades === 1 ? "" : "s"}</small></span>
    <span class="mk-c mk-sp">${spark(p.spark)}</span>
    <span class="mk-acts">${acts}</span>
    ${msg ? `<p class="mk-msg">${esc(msg)}</p>` : ""}
  </li>`;
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function send(path, method, body) {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-Session": M.session }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
  return j;
}
async function onClick(e) {
  const s = e.target.closest("[data-sort]");
  if (s) { if (M.sort !== s.dataset.sort) { M.sort = s.dataset.sort; s.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === s)); load(); } return; }
  const a = e.target.closest("[data-mk]"); if (!a) return;
  const id = a.dataset.id, k = a.dataset.mk;
  if (k === "retry") return load();
  if (k === "list") return openModal(null);
  if (k === "edit") return openModal(id);
  if (k === "close" || (k === "backdrop" && e.target === a)) return closeModal();
  if (k === "publish") return publish();
  if (k === "copy" || k === "unlist") {
    M.busy.add(id); M.msg.delete(id); paint();
    try {
      if (k === "copy") { const bot = await send(`/v1/agents/${encodeURIComponent(id)}/copy`, "POST", {}); location.hash = `#agents/${encodeURIComponent(bot.id)}`; return; }
      await send(`/v1/market/listings/${encodeURIComponent(id)}`, "DELETE");
      await load();
    } catch (err) { M.msg.set(id, err.message); }
    finally { M.busy.delete(id); paint(); }
  }
}

// ── the listing form ─────────────────────────────────────────────────────────────────────────────────────────────────
const tradesOf = (b) => b?.type === "copy" || (b?.type === "custom" && ["buy", "sell"].includes(b?.params?.strategy?.action?.type));
let modalTok = 0;
async function openModal(botId) {
  closeModal();
  const tok = ++modalTok; // popstate and hashchange both fire for one link: only the latest open fills the form
  const wrap = document.createElement("div");
  wrap.className = "sheet"; wrap.id = "mkModal"; wrap.dataset.mk = "backdrop";
  wrap.innerHTML = `<div class="card mk-form" role="dialog" aria-modal="true" aria-labelledby="mkFormH"><div class="cardHead"><h2 id="mkFormH">List your agent</h2><button class="x" type="button" data-mk="close" aria-label="Close">×</button></div><div id="mkFormB"><div class="b-skel" style="height:120px;margin-top:14px"></div></div></div>`;
  M.root.appendChild(wrap);
  document.addEventListener("keydown", onEsc);
  let mine = [], listed = new Map();
  try {
    const [a, m] = await Promise.all([M.api("/v1/agents"), M.data ? Promise.resolve(M.data) : M.api(`/v1/market?sort=${M.sort}`)]);
    mine = (a.bots ?? []).filter(tradesOf);
    for (const l of m.listings ?? []) if (l.mine) listed.set(l.botId, l);
  } catch (e) { if (tok === modalTok && $("mkFormB")) $("mkFormB").innerHTML = `<p class="msg bad">${esc(e.message)}</p>`; return; }
  const body = $("mkFormB"); if (!body || tok !== modalTok) return;
  if (!mine.length) {
    body.innerHTML = `<p class="muted">You have no trading agent yet. Make one first (copy a Monad trader or start a template), then list it here.</p><div class="row"><a class="primary mk-a" href="#agents/new">Create an agent</a></div>`;
    return;
  }
  const pick = mine.find((b) => b.id === botId) ?? mine.find((b) => !listed.has(b.id)) ?? mine[0];
  body.innerHTML = `<p class="muted">Listed agents are ranked by their record on Monad. Anyone can open one and copy it; who owns it stays private.</p>
    <label class="field">Agent<select id="mkBot">${mine.map((b) => `<option value="${esc(b.id)}"${b.id === pick.id ? " selected" : ""}>${esc(b.name || "Untitled agent")}, ${esc(TYPE[b.type] ?? b.type)}${listed.has(b.id) ? ", listed" : ""}</option>`).join("")}</select></label>
    <label class="field">Title<input id="mkTitle" maxlength="60" autocomplete="off"></label>
    <label class="field">Pitch <small id="mkCnt"></small><textarea id="mkPitch" rows="3" maxlength="280" placeholder="What it does, in a line or two"></textarea></label>
    <p class="msg" id="mkFormMsg"></p>
    <div class="row"><button type="button" class="ghost" data-mk="close">Cancel</button><button type="button" class="primary" id="mkGo" data-mk="publish">Publish</button></div>`;
  const fill = () => {
    const id = $("mkBot").value, b = mine.find((x) => x.id === id), l = listed.get(id);
    $("mkTitle").value = l?.title ?? b?.name ?? "";
    $("mkPitch").value = l?.pitch ?? "";
    $("mkGo").textContent = l ? "Save" : "Publish";
    $("mkFormH").textContent = l ? "Edit your listing" : "List your agent";
    count();
  };
  $("mkBot").addEventListener("change", fill);
  fill();
  $("mkPitch").focus();
}
const count = () => { const t = $("mkPitch"), c = $("mkCnt"); if (t && c) c.textContent = `${t.value.trim().length}/280`; };
function onInput(e) { if (e.target.id === "mkPitch") count(); }
const onEsc = (e) => { if (e.key === "Escape") closeModal(); };
function closeModal() {
  $("mkModal")?.remove();
  document.removeEventListener("keydown", onEsc);
  if (/^#market\/list/.test(location.hash)) { try { history.replaceState(null, "", `${location.pathname}${location.search}#market`); } catch {} }
}
async function publish() {
  const go = $("mkGo"), msg = $("mkFormMsg"); if (!go) return;
  go.disabled = true; msg.className = "msg"; msg.textContent = "";
  try {
    await send("/v1/market/listings", "POST", { botId: $("mkBot").value, title: $("mkTitle").value, pitch: $("mkPitch").value });
    closeModal();
    M.sort = "score";
    M.root.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("on", b.dataset.sort === "score"));
    await load();
  } catch (e) { msg.className = "msg bad"; msg.textContent = e.message; go.disabled = false; }
}
