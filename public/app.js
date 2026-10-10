// Chord Ask page: chats kept in this browser, chain categories with starter questions, a live work pill per answer
// (each lookup and the provider that served it), sources, and the "Sections of Research" outline.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ── icons (24px stroke set) ─────────────────────────────────────────────────────────────────────────────────────────────
const P = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d="M5.5 8h1M5.5 11h1"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.6-5.1A8.5 8.5 0 1 1 21 11.5Z"/><path d="m12 8 1 2.5 2.5 1-2.5 1L12 15l-1-2.5-2.5-1 2.5-1Z"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M16 15h2"/><path d="M6 6V5a2 2 0 0 1 2-2h8"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  bot: '<rect x="5" y="8" width="14" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 9.3A6 6 0 1 1 9.3 15.5"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor"/>',
  "chev-r": '<path d="m9 6 6 6-6 6"/>',
  "chev-d": '<path d="m6 9 6 6 6-6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  ne: '<path d="M7 17 17 7M8 7h9v9"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  spin: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  flip: '<path d="M8 4v16m0 0-3-3m3 3 3-3M16 20V4m0 0-3 3m3-3 3 3"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  bots: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13h2M20 13h2"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.6 2.2-4.8.3 1.6 1 2.6 2.3 3C11 9 12 6 12 3Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  "a-copy": '<path d="M8 8h11v11H8zM5 16V5h11"/>',
  "a-up": '<path d="M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7"/>',
  "a-down": '<path d="M17 13V4h3v9h-3Zm0 0-4 7a2 2 0 0 1-3-2l1-5H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 7.2 4H17"/>',
  "a-share": '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/>',
  "a-retry": '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[n] ?? ""}</svg>`;
const iconTag = (n) => `<i data-i="${n}">${icon(n)}</i>`;
const paintIcons = (root = document) => root.querySelectorAll("i[data-i]").forEach((el) => { if (!el.firstChild) el.innerHTML = icon(el.dataset.i); });

let mascotN = 0;
function mascot() {
  const id = `cc${++mascotN}`;
  const blob = [[100, 106, 50], [100, 66.8, 33], [135, 78.5, 29], [149.3, 106, 27], [132.5, 131.6, 27], [100, 141.3, 29], [67.5, 131.6, 27], [50.7, 106, 27], [65, 78.5, 29]];
  const cs = (fill, grow = 0) => blob.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r + grow}" fill="${fill}"/>`).join("");
  return `<svg viewBox="0 0 200 200" aria-hidden="true"><defs><clipPath id="${id}">${cs("#000")}</clipPath></defs>${cs("#0C0E0B", 3.2)}${cs("#E8ECE0")}<g clip-path="url(#${id})"><g transform="translate(0 -7)">${cs("#FFFFFF")}</g></g><rect x="79" y="89" width="12" height="30" rx="6" fill="#0C0E0B"/><rect x="109" y="89" width="12" height="30" rx="6" fill="#0C0E0B"/></svg>`;
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SESSION = (() => { let s = store.get("ask2049_session", null); if (!s) { s = "web:" + crypto.randomUUID(); store.set("ask2049_session", s); } return s; })();
let cfg = null, busy = false, cat = null, payable = false;
let threads = store.get("ask2049_threads", []); // [{id, title, at, turns: [{q, a}]}]
let current = null;
const saveThreads = () => store.set("ask2049_threads", threads.slice(0, 60));

// Chord Ask's categories (live suggestions from /v1/suggest) plus this app's Solana, Chains and Payments sets.
const CATS = [
  { id: "crypto", label: "Crypto", icon: "bolt" },
  { id: "macro", label: "Macro", icon: "globe" },
  { id: "stocks", label: "Stocks", icon: "trend" },
  { id: "trending", label: "Trending", icon: "flame" },
  { id: "solana", label: "Solana", icon: "sun" },
  { id: "picks", label: "Picks", icon: "star" },
  { id: "tokens", label: "Tokens", icon: "coins" },
  { id: "holders", label: "Holders", icon: "eye" },
  { id: "wallets", label: "Wallets", icon: "wallet" },
  { id: "trade", label: "Trade", icon: "swap" },
  { id: "chains", label: "Chains", icon: "layers" },
  { id: "payments", label: "Payments", icon: "check" },
  { id: "chord", label: "Chord", icon: "lock" },
];

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  paintIcons();
  $("mascotHome").innerHTML = mascot();
  // Chord Ask's rotating hero line, one per page load (plus this app's own).
  const heroes = ["What's moving today?", "Which stock or coin today?", "What are we watching today?", "Gold, BTC or NVDA today?", "Wallets, tokens or payments?"];
  $("headline").textContent = heroes[Math.floor(Math.random() * heroes.length)];
  const note = document.querySelector(".sidenote");
  if (note) { note.title = "Your chats stay in this browser."; note.textContent = "Stored locally"; }
  cfg = await fetch("/v1/config").then((r) => r.json()).catch(() => null);
  const chains = cfg?.indexChains ?? [];
  const cats = CATS.filter((c) => !c.chain || chains.includes(c.chain));
  cat = cats[0]?.id ?? null;
  $("cats").innerHTML = cats.map((c) => `<button type="button" class="cat${c.id === cat ? " on" : ""}" data-cat="${c.id}"><i data-i="${c.icon}"></i>${esc(c.label)}</button>`).join("");
  paintIcons($("cats"));
  renderSugs();
  // the sidebar in figures; the full sentences sit in each line's title
  if (cfg) {
    const sol = cfg.nownodes?.solana ? "NOWNodes" : (cfg.nownodes?.solanaEndpoint ?? "RPC");
    const evm = chains.filter((c) => c !== "solana").length;
    $("cardInfra").title = `Solana on-chain via ${sol}${evm ? `, plus Chord's index of ${evm} EVM chain${evm === 1 ? "" : "s"}` : ""}.`;
    $("cardInfra").textContent = `Solana · ${sol}${evm ? ` · ${evm} EVM` : ""}`;
    const p = cfg.pay ?? {};
    // Pay shows only when an ask can really be paid for: never while asks are unlimited, never without a treasury to pay to
    payable = !p.unlimited && !!(p.solana || p.cardano);
    for (const id of ["payBtn", "railPay", "cardPay"]) $(id).hidden = !payable;
    $("credits").classList.toggle("static", !payable);
    $("cardPayText").title = p.unlimited ? "Asks are unlimited and free right now, signed in or not." : p.solana || p.cardano
      ? `${p.freeAsks} free asks, then ${[p.solana && `${p.solana.price} USDC on Solana`, p.cardano && `${p.cardano.price} ADA on Cardano`].filter(Boolean).join(" or ")}, checked on-chain.`
      : `${p.freeAsks} free asks per session.`;
    $("cardPayText").textContent = p.unlimited ? "Unlimited · free" : p.solana || p.cardano
      ? `${p.freeAsks} free · then ${[p.solana && `${p.solana.price} USDC`, p.cardano && `${p.cardano.price} ADA`].filter(Boolean).join(" / ")}`
      : `${p.freeAsks} free / session`;
  }
  if (cfg?.privy) { $("signInBtn").hidden = false; if (privySession()) loadPrivy().catch(() => {}); }
  credits(await fetch("/v1/session", { headers: { "X-Session": SESSION } }).then((r) => r.json()).catch(() => null));
  renderThreads();
  setTitle();
  $("agentCode").textContent = `curl -N ${location.origin}/v1/ask \\
  -H 'Content-Type: application/json' \\
  -H 'X-Payment: solana:<signature of your USDC transfer>' \\
  -d '{"question":"What were the most traded tokens on Base in the last 24 hours?"}'`;
}

const sugCache = new Map();
// Money and percent figures in a suggestion's live line are set in tabular numerals.
const figs = (html) => html.replace(/(^|[\s(])([+\u2212-]?(?:\$\d[\d,]*(?:\.\d+)?[kKMB]?|\d[\d,]*(?:\.\d+)?%))(?=[\s.,;:)?!]|$)/g, '$1<span class="fig">$2</span>');
const SUG_SK = `<div class="sug sk" aria-hidden="true"><span class="w-sk" style="width:88%"></span><span class="w-sk" style="width:56%"></span></div>`;
async function renderSugs() {
  const want = cat;
  const hit = sugCache.get(want);
  if (!hit || Date.now() - hit.at > 60_000) {
    if (!hit) { $("sugs").innerHTML = SUG_SK.repeat(4); $("sugs").setAttribute("aria-busy", "true"); }
    const r = await fetch(`/v1/suggest?cat=${want}`).then((x) => x.json()).catch(() => ({ items: [] }));
    sugCache.set(want, { at: Date.now(), items: r.items ?? [] });
  }
  if (want !== cat) return;
  const items = sugCache.get(want).items;
  $("sugs").removeAttribute("aria-busy");
  $("sugs").innerHTML = items.map((x, i) => `<button type="button" class="sug" data-i="${i}"><span class="sgt">${x.pill ? `<span class="spill">${tlogo(x.pill.symbol, x.pill.logo)}<b>${esc(x.pill.symbol)}</b>${x.pill.name && x.pill.name !== x.pill.symbol ? `<small>${esc(x.pill.name)}</small>` : ""}</span> ` : ""}${figs(esc(x.text))}</span><i data-i="ne"></i></button>`).join("");
  $("sugs").dataset.cat = want;
  paintIcons($("sugs"));
}

function credits(s) {
  if (!s) return;
  if (s.unlimited) { $("creditsText").innerHTML = `<span class="unit">Unlimited asks</span><span class="ushort" aria-hidden="true">∞</span>`; $("credits").title = "Unlimited asks"; return; }
  const [n, unit] = s.freeLeft > 0 ? [s.freeLeft, ` free ask${s.freeLeft === 1 ? "" : "s"}`] : [s.credits, ` credit${s.credits === 1 ? "" : "s"}`];
  $("creditsText").innerHTML = `${n}<span class="unit">${unit}</span>`;
  $("credits").title = `${n}${unit}`;
}
function setTitle() {
  const t = threads.find((x) => x.id === current);
  $("title").textContent = t ? t.title : "";
  $("threadActs").hidden = !(t && t.turns.some((x) => x.a));
  document.title = t ? `${t.title} · Chord Agents` : "Chord Agents on Monad";
}

// ── chats list ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderThreads() {
  const f = $("chatSearch").value.trim().toLowerCase();
  const list = threads.filter((t) => !f || t.title.toLowerCase().includes(f) || t.turns.some((x) => x.q.toLowerCase().includes(f)));
  if (!list.length) { $("threads").innerHTML = `<div class="empty">${f ? "No match" : "No chats yet"}</div>`; return; }
  const today = new Date().toDateString();
  const groups = [["Today", list.filter((t) => new Date(t.at).toDateString() === today)], ["Earlier", list.filter((t) => new Date(t.at).toDateString() !== today)]];
  $("threads").innerHTML = groups.filter(([, xs]) => xs.length).map(([g, xs]) => `<div class="grp">${g}</div>` + xs.map((t) =>
    `<button type="button" class="t${t.id === current ? " on" : ""}" data-t="${t.id}"><b>${esc(t.title)}</b><small>${ago(t.at)} · ${t.turns.length} turn${t.turns.length === 1 ? "" : "s"}</small></button>`).join("")).join("");
}
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(ms).toLocaleDateString(); };

function openThread(id) {
  const t = threads.find((x) => x.id === id);
  if (!t) return;
  current = id;
  showChat();
  $("thread").innerHTML = "";
  for (const turn of t.turns) { const el = turnEls(turn.q); if (turn.a) paintAnswer(el, turn.a, true); else el.body.innerHTML = `<p class="err">${esc(turn.err ?? "No answer.")}</p>`; }
  renderThreads(); setTitle(); buildToc();
  $("scroller").scrollTop = $("scroller").scrollHeight;
  closeSideOnPhone();
}
function newChat() {
  current = null;
  showView("home");
  $("thread").innerHTML = ""; $("toc").hidden = true;
  renderThreads(); setTitle(); closeSideOnPhone();
  $("qHome").focus();
}
let tradeMod = null;
// The chats sidebar belongs to Chat: Trade, Agents and Wallet open full width (the sidebar button or ⌘K still opens it there),
// and back in Chat it is open or closed the way the person left it.
let chatSideOpen = true;
// Tooltip tours (tour.js, loaded on first use): Chat's ends on "Click here to try Agents", Agents' starts on its home (bots.js)
let tourP = null;
const tourMod = () => (tourP ??= import(`./tour.js${VER}`).catch((e) => { tourP = null; throw e; }));
function startChatTour(force) {
  tourMod().then((m) => m.startTour("chat", { force, onCta: () => { closeSideOnPhone(); openBotsView(); } })).catch(() => {});
}
function showView(v) {
  // a tour belongs to its view: leaving the view closes it
  tourP?.then((m) => { if ((m.tourActive("chat") && v !== "home") || (m.tourActive("agents") && v !== "bots")) m.endTour(true); }).catch(() => {});
  const app = $("app"), tool = v === "trade" || v === "bots" || v === "wallet", wasTool = app.classList.contains("tool");
  if (tool && !wasTool) { chatSideOpen = !app.classList.contains("noside"); app.classList.add("noside"); }
  if (!tool && wasTool) app.classList.toggle("noside", !chatSideOpen || matchMedia("(max-width: 900px)").matches);
  app.classList.toggle("tool", tool);
  $("home").hidden = v !== "home"; $("chat").hidden = v !== "chat"; $("tradev").hidden = v !== "trade"; $("botsv").hidden = v !== "bots"; $("walletv").hidden = v !== "wallet";
  $("railChat").classList.toggle("active", v !== "trade" && v !== "bots" && v !== "wallet"); $("railTrade").classList.toggle("active", v === "trade"); $("railBots").classList.toggle("active", v === "bots"); $("railWallet").classList.toggle("active", v === "wallet");
  if (v === "trade") { $("title").textContent = "Trade"; document.title = "Trade · Chord Agents"; $("threadActs").hidden = true; }
  else if (v === "bots") { $("title").textContent = "Agents"; document.title = "Agents · Chord Agents"; $("threadActs").hidden = true; }
  else if (v === "wallet") { $("title").textContent = "Trust"; document.title = "Trust · Chord Agents"; $("threadActs").hidden = true; }
  else setTitle();
  viewUrl(v);
}
/** each view is a history entry (Back / Forward): chat = the bare address, trade = #trade, the Trust tab = #trust (the view
 *  keeps its old "wallet" id: #wallet still opens it); bots.js owns #agents/… */
const TRUST_RE = /^#(trust|wallet)(\/|$)/;
function viewUrl(v) {
  if (v === "bots") return;
  if (v === "wallet" && TRUST_RE.test(location.hash)) return;
  const want = v === "trade" ? "#trade" : v === "wallet" ? "#trust" : "";
  if (location.hash === want) return;
  try { history.pushState(null, "", location.pathname + location.search + want); } catch {}
}
addEventListener("popstate", () => {
  const h = location.hash;
  if (/^#(agents|bots)(\/|$)/.test(h)) { if (!botsP) openBotsView(); return; } // once loading, bots.js renders its own entries
  if (h === "#trade") { if ($("tradev").hidden) openTrade(); return; }
  if (TRUST_RE.test(h)) { openWalletView(h); return; }
  if (!$("botsv").hidden || !$("tradev").hidden || !$("walletv").hidden) showView(current ? "chat" : "home");
});
let botsMod = null, botsP = null;
async function openBotsView(opts) {
  botsP ??= import(`./bots.js${new URL(import.meta.url).search}`).then((m) => { m.initBots({ showView, session: SESSION }); return (botsMod = m); }).catch((e) => { botsP = null; throw e; });
  (await botsP).openBots(opts);
}
let walletMod = null, walletP = null;
/** The Trust tab (trust.js, loaded on first open): the ERC-8004 identities, the fills committed on Monad, validations. */
async function openWalletView() {
  walletP ??= import(`./trust.js${new URL(import.meta.url).search}`).then((m) => (walletMod = m)).catch((e) => { walletP = null; throw e; });
  closeSideOnPhone();
  const m = await walletP;
  showView("wallet");
  const api = async (path) => { const r = await fetch(path, { headers: { "X-Session": SESSION } }); const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error(j?.message ?? `HTTP ${r.status}`); return j; };
  m.renderTrustView($("walletv"), { api, openAgent: (id) => { location.hash = `#agents/public/${encodeURIComponent(id)}`; } });
}
function showChat() { showView("chat"); }
async function openTrade(prefill) {
  if (!tradeMod) return;
  closeSideOnPhone();
  await tradeMod.openTrade(prefill);
}
const closeSideOnPhone = () => { if (matchMedia("(max-width: 900px)").matches) $("app").classList.add("noside"); };

// ── markdown (escaped first; model text never becomes HTML) ─────────────────────────────────────────────────────────────
let hN = 0;
const plain = (h) => String(h ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
const FIG = /^[~≈]?[+\u2212-]?\$?\d[\d,]*(?:\.\d+)?\s?(?:[kKMBT]|%|x|×|bps)?$/;
const isFig = (t) => t.split(/\s*\/\s*/).every((x) => FIG.test(x));
const signOf = (t) => (/^[+]\$?\d/.test(t) ? "up" : /^[\u2212-]\$?\d/.test(t) ? "down" : "");
const ADDR = /^(?:[1-9A-HJ-NP-Za-km-z]{2,8}(?:…|\.\.\.)[1-9A-HJ-NP-Za-km-z]{2,8}|0x[0-9a-fA-F]{2,8}(?:…|\.\.\.)[0-9a-fA-F]{2,8})$/;
function md(text) {
  const lines = esc(text).split("\n");
  const out = []; let list = null, olist = null, table = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const flush = () => {
    if (list) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = null; }
    if (olist) { out.push(`<ol>${olist.map((l) => `<li>${inline(l)}</li>`).join("")}</ol>`); olist = null; }
    if (table) {
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => inline(c.trim())));
      let [head, ...body] = rows;
      if (head.every((c) => !c.trim())) { head = null; }
      // Figures line up: a column that is mostly numbers is right-aligned; signed figures take the up / down colour;
      // shortened addresses are set in mono.
      const ncol = Math.max(head?.length ?? 0, ...body.map((r) => r.length));
      const numCol = Array.from({ length: ncol }, (_, j) => { const xs = body.map((r) => plain(r[j])).filter(Boolean); return xs.length > 0 && xs.filter(isFig).length / xs.length >= 0.6; });
      const td = (c, j) => { const t = plain(c), cls = [numCol[j] && "r", signOf(t), ADDR.test(t) && "addr"].filter(Boolean).join(" "); return `<td${cls ? ` class="${cls}"` : ""}>${c}</td>`; };
      out.push(`<div class="tbl"><table>${head ? `<thead><tr>${head.map((c, j) => `<th${numCol[j] ? ' class="r"' : ""}>${c}</th>`).join("")}</tr></thead>` : ""}<tbody>${body.map((r) => `<tr>${r.map(td).join("")}</tr>`).join("")}</tbody></table></div>`);
      table = null;
    }
  };
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) { if (list || olist) flush(); (table ??= []).push(l); continue; }
    if (/^\s*[-*•]\s+/.test(l)) { if (table || olist) flush(); (list ??= []).push(l.replace(/^\s*[-*•]\s+/, "")); continue; }
    if (/^\s*\d+[.)]\s+/.test(l)) { if (table || list) flush(); (olist ??= []).push(l.replace(/^\s*\d+[.)]\s+/, "")); continue; }
    flush();
    if (/^#{1,4}\s+/.test(l)) out.push(`<h3 id="h${++hN}">${inline(l.replace(/^#{1,4}\s+/, ""))}</h3>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return out.join("");
}

// ── one turn ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function turnEls(question) {
  const q = document.createElement("div"); q.className = "uq"; q.innerHTML = `<div>${esc(question)}</div>`;
  const a = document.createElement("div"); a.className = "bot";
  a.innerHTML = `<div class="av">${mascot()}</div><div class="bbody"><div class="pills"></div><div class="wv"></div><details class="thought" hidden><summary>Thought complete</summary><p></p></details><div class="steps" hidden></div><div class="md"></div><div class="srcs" hidden></div><div class="follow"></div><div class="acts"></div><div class="meta"></div></div>`;
  $("thread").append(q, a);
  const f = (c) => a.querySelector(c);
  return { question, root: a, pills: f(".pills"), work: f(".wv"), thought: f(".thought"), steps: f(".steps"), body: f(".md"), srcs: f(".srcs"), follow: f(".follow"), acts: f(".acts"), meta: f(".meta") };
}
const shortId = (s) => (s && s.length > 14 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s ?? "");
// ── token pictures: Solana mints go through this site's /v1/logo/solana/<mint> (Jupiter's icon); every picture sits on a
// monogram (two letters on a hue taken from the mint) that stays when the image fails ──
const B58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const CHORD_SOL_LOGO = new RegExp(`^https://api\\.getchord\\.xyz/v1/logo/solana/(${B58})(?:[?#].*)?$`);
const SOL_HREF = new RegExp(`/(?:trade|token)/(${B58})(?:\\?[^#]*chain=solana|$)`);
const SOL_ID = new RegExp(`^sol:(${B58})$`);
const mintOf = (...xs) => { for (const x of xs) { const s = String(x ?? ""); const m = CHORD_SOL_LOGO.exec(s) ?? SOL_HREF.exec(s) ?? SOL_ID.exec(s); if (m) return m[1]; } return null; };
const hueOf = (s) => { let h = 7; for (const ch of String(s ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (sym) => (String(sym ?? "").replace(/^\$/, "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
/** A token picture: a Solana mint we know goes through the same-origin route first (it reads IPFS pictures through gateways
 *  that answer; a browser asking ipfs.io directly mostly gets 429), the third-party URL is the second try; over a monogram
 *  that shows while it loads and stays when both fail. */
function tlogo(sym, logo, ...hints) {
  const mint = mintOf(logo, ...hints);
  const own = mint ? `/v1/logo/solana/${mint}` : null;
  const third = logo && !CHORD_SOL_LOGO.test(String(logo)) ? logo : null;
  const src = own ?? third;
  const alt = own && third ? third : null;
  return `<span class="tlogo" style="--mh:${hueOf(mint ?? sym)}"><b>${esc(initials(sym))}</b>${src ? `<img data-tl src="${esc(src)}"${alt ? ` data-alt="${esc(alt)}"` : ""} alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}
document.addEventListener("load", (e) => { if (e.target instanceof HTMLImageElement && e.target.hasAttribute("data-tl")) e.target.classList.add("on"); }, true);
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.hasAttribute("data-tl")) return;
  const alt = img.dataset.alt;
  if (alt) { img.removeAttribute("data-alt"); img.src = alt; } else img.remove();
}, true);
// ── steps and cards, as on getchord.xyz/ask: label, what it was about, how long; the tokens / posts / pages it found ──
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const SPIN = `<svg class="sspin" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" stroke-width="2.4"/><path d="M9 2 A7 7 0 0 1 16 9" fill="none" stroke="var(--hi)" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const LENS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
const LONG_ID = /^(?:[1-9A-HJ-NP-Za-km-z]{32,88}|0x[0-9a-fA-F]{40,64})$/;
const stepMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
/** One lookup on the timeline: node, what it did, the source that served it, what it was about, and how long it took (a bar
 *  scaled to the slowest lookup of the answer). Cards it found sit under it. */
function stepRow(s, running, max = 0, cards = null) {
  const ms = !running && s.ms ? s.ms : 0;
  const det = s.detail ? (LONG_ID.test(s.detail) ? shortId(s.detail) : s.detail) : null;
  const sum = !running && s.ok !== false && s.summary && /\d/.test(s.summary) && s.summary.length <= 90 ? s.summary : null;
  return `<div class="tl${running ? " run" : s.ok === false ? " bad" : ""}"><span class="tl-node">${running ? SPIN : ""}</span><div class="tl-main"><div class="tl-head"><span class="slbl">${esc(s.label)}</span>${s.via ? `<span class="svia">${esc(s.via)}</span>` : ""}${det ? `<span class="schip"${det !== s.detail ? ` title="${esc(s.detail)}"` : ""}>${LENS}<span>${esc(det)}</span></span>` : ""}</div>${sum ? `<div class="tl-sum">${esc(sum)}</div>` : ""}${!running && s.ok === false && s.summary ? `<div class="serr">${esc(s.summary)}</div>` : ""}</div><span class="tl-ms">${running ? `<span class="w-sk"></span>` : ms ? `${max ? `<i style="--w:${Math.max(4, Math.round((ms / max) * 100))}%"></i>` : ""}<b>${stepMs(ms)}</b>` : ""}</span>${cards ? cardsHtml(cards) : ""}</div>`;
}
/** A round's header, only when the answer took more than one round of lookups. */
const roundHead = (r, n) => `<div class="tl-round"><b>Round ${r}</b><span>${n} lookup${n === 1 ? "" : "s"}</span></div>`;
const fmtPrice = (p) => (p == null ? "—" : p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : p >= 1 ? `$${p.toFixed(p >= 100 ? 2 : 3)}` : `$${p.toPrecision(4)}`);
const fmtUsd = (n) => (n == null ? "—" : Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`);
const hrefOf = (h) => (/^https:\/\//.test(String(h ?? "")) ? h : String(h ?? "").startsWith("/") ? `https://getchord.xyz${h}` : null);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
function cardHtml(c) {
  if (c.kind === "token") {
    const ch = c.change24hPct;
    const figs = [["FDV", c.fdvUsd], ["Market cap", c.marketCapUsd], ["Liquidity", c.liquidityUsd], ["Vol 24h", c.volume24hUsd]].filter(([, v]) => v != null);
    const sym = !c.assetKind || ["crypto", "token", "perp"].includes(c.assetKind) ? `$${c.symbol}` : c.symbol;
    const href = hrefOf(c.href);
    return `<a class="tcard"${href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : ""}><div class="tch">${tlogo(c.symbol, c.logo, c.href, c.chain === "solana" && c.address ? `sol:${c.address}` : null)}<span class="tcn"><b>${esc(sym)}</b><small>${esc(c.name)}${c.chainName ? ` · ${esc(c.chainName)}` : ""}</small></span><span class="tcp"><small>Price</small><b>${fmtPrice(c.price)}</b>${ch != null ? `<small class="${ch >= 0 ? "up" : "down"}">${ch > 0 ? "+" : ""}${ch.toFixed(2)}%</small>` : ""}</span></div>${figs.length ? `<div class="tcf" style="grid-template-columns:repeat(${figs.length},minmax(0,1fr))">${figs.map(([k, v]) => `<span><small>${k}</small><b>${fmtUsd(v)}</b></span>`).join("")}</div>` : ""}</a>`;
  }
  if (c.kind === "post") {
    const href = hrefOf(c.url);
    return `<a class="pcard"${href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : ""}><span class="pa">${/^https:\/\/pbs\.twimg\.com\//.test(c.avatar ?? "") ? `<img src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<b>${esc(c.name)}</b><small>@${esc(c.handle)}</small></span><span class="pt">${esc(c.text)}</span>${c.likes != null ? `<small>♥ ${Number(c.likes).toLocaleString("en-US")}</small>` : ""}</a>`;
  }
  const href = hrefOf(c.url);
  return `<a class="lcard"${href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : ""}><span class="lf">${esc((c.host || hostOf(c.url) || "?")[0].toUpperCase())}</span><span class="lt"><b>${esc(c.title)}</b><small>${esc(c.host || hostOf(c.url))}${c.snippet ? ` · ${esc(c.snippet)}` : ""}</small></span></a>`;
}
function cardsHtml(cards) {
  if (!cards?.length) return "";
  const by = (k) => cards.filter((c) => c.kind === k);
  return `<div class="scards">${by("token").length ? `<div class="sgrid">${by("token").map(cardHtml).join("")}</div>` : ""}${by("post").length ? `<div class="sgrid">${by("post").map(cardHtml).join("")}</div>` : ""}${by("link").map(cardHtml).join("")}</div>`;
}
/** The live view while Ask works: timer, the reasoning of each round, every lookup with its cards. */
function renderWork(el, st) {
  const rounds = [...st.rounds.keys()].sort((a, b) => a - b);
  const max = Math.max(0, ...rounds.flatMap((r) => st.rounds.get(r).steps.filter((x) => x.done).map((x) => x.ms ?? 0)));
  let html = `<div class="wtime"><span class="wdot"></span>Working<span class="wt">${secs(Date.now() - st.t0)}</span></div>`;
  if (!rounds.length) html += `<div class="think live">Thinking…</div>`;
  for (const r of rounds) {
    const R = st.rounds.get(r);
    if (R.thinking) html += R.steps.length ? `<details class="thought"><summary>Thought complete</summary><p>${esc(R.thinking)}</p></details>` : `<div class="think live">Thinking…<p>${esc(R.thinking)}</p></div>`;
    if (R.steps.length) html += (rounds.length > 1 ? roundHead(r, R.steps.length) : "") + `<div class="tlg">${R.steps.map((x) => stepRow(x, !x.done, max, x.done ? x.cards : null)).join("")}</div>`;
  }
  const last = rounds.length ? st.rounds.get(rounds[rounds.length - 1]) : null;
  if (last?.steps.length && last.steps.every((x) => x.done)) html += `<div class="think live">Thinking…</div>`;
  el.work.innerHTML = html;
}

const KIND = { account: "W", tx: "T", token: "$", "ada-address": "A", "ada-tx": "T", index: "C", web: "↗" };

// Tables and X post feeds the tools returned (Chord's `viz`). Headlines and posts open their source; other tables sit
// folded under the answer, which already quotes the numbers that matter.
const safeUrl = (u) => (/^https:\/\//.test(String(u ?? "")) ? String(u) : null);
// Table numbers: whole figures with separators from 1,000 up, four significant digits under 1 (a $0.000003692 price stays
// readable), up to four decimals in between.
const cell = (v) => (v == null ? "" : typeof v === "number" ? (!Number.isFinite(v) ? "" : v === 0 ? "0" : Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : Math.abs(v) >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v.toLocaleString("en-US", { maximumSignificantDigits: 4 })) : String(v));
// ── charts (Chord's line / bar / donut viz) as plain SVG, drawn at the box's real width (no stretched text) ──
const PALETTE = ["var(--hi)", "var(--purple)", "#f5a524", "#4aa3ff", "#ff6b8a", "#9ad0ff"];
const vfmt = (n, unit) => (n == null || !Number.isFinite(n) ? "" : unit === "usd" || (unit === "price" && Math.abs(n) >= 1000) ? fmtUsd(n) : unit === "pct" ? `${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%` : unit === "price" ? fmtPrice(n) : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : Math.abs(n) < 1 && n !== 0 ? `${+n.toPrecision(3)}` : `${+n.toFixed(2)}`);
const xfmt = (s) => String(s ?? "").replace(/^(\d{2,4}-\d{2}(?:-\d{2})?)T(\d{2}:\d{2}).*$/, "$1 $2").slice(0, 16);
/** A one-series line: its last value and the move from its first value (not for percentages). */
function chartStats(v) {
  if (v.kind !== "line" || (v.series ?? []).length !== 1) return null;
  const vals = (v.series[0].values ?? []).filter((x) => x != null && Number.isFinite(x));
  if (vals.length < 2) return null;
  const first = vals[0], last = vals[vals.length - 1];
  return { last, chg: v.unit !== "pct" && first > 0 ? (last / first - 1) * 100 : null };
}
const CH = 200;
// Axis labels of sub-cent prices in the terminal style: $0.000003881 → $0.0₅3881 (five zeros after the point).
const tiny = (t) => String(t).replace(/^(-?\$?)0\.(0{4,})(\d+)$/, (_, p, z, d) => `${p}0.0${[...String(z.length)].map((c) => "₀₁₂₃₄₅₆₇₈₉"[c]).join("")}${d}`);
function chartSvg(v, W = 640) {
  const H = CH, R = 10, T = 10, B = 24;
  const xs = v.x ?? [], series = (v.series ?? []).slice(0, 6);
  const n = xs.length || Math.max(0, ...series.map((s) => s.values?.length ?? 0));
  if (!n || !series.length) return null;
  let vals = series.flatMap((s) => (s.values ?? []).filter((x) => x != null && Number.isFinite(x)));
  if (v.kind === "bar" && v.stacked) vals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.values?.[i] ?? 0), 0)).concat(0);
  if (v.kind === "bar") vals.push(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo === hi) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1; }
  const pad = (hi - lo) * 0.06; if (v.kind === "line") { lo -= pad; hi += pad; }
  const ticks = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3);
  const tl = ticks.map((t) => tiny(vfmt(t, v.unit)));
  const L = Math.ceil(Math.max(...tl.map((t) => t.length)) * 6.4) + 12;
  const y = (val) => T + (H - T - B) * (1 - (val - lo) / (hi - lo));
  const xw = (W - L - R) / n, xc = (i) => L + xw * (i + 0.5);
  const st = chartStats(v);
  const one = st ? (st.chg != null && st.chg < 0 ? "var(--bad)" : "var(--hi)") : null;
  let g = ticks.map((t, k) => `<line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/><text x="${L - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(tl[k])}</text>`).join("");
  const lab = (W < 440 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1]).filter((v2, i, a) => a.indexOf(v2) === i);
  g += lab.map((i, k) => `<text x="${(k === 0 ? Math.max(L, xc(i) - xw / 2) : k === lab.length - 1 && i === n - 1 ? W - R : xc(i)).toFixed(1)}" y="${H - 7}" text-anchor="${k === 0 && lab.length > 1 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(xfmt(xs[i]))}</text>`).join("");
  if (v.kind === "line") {
    g += series.map((s, k) => { const pts = (s.values ?? []).map((val, i) => (val == null ? null : `${xc(i).toFixed(1)},${y(val).toFixed(1)}`)).filter(Boolean); return pts.length ? `<polyline fill="none" stroke="${one ?? PALETTE[k]}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/>` : ""; }).join("");
  } else {
    const bw = Math.max(1.5, (xw * 0.72) / (v.stacked ? 1 : series.length));
    for (let i = 0; i < n; i++) {
      let base = 0;
      series.forEach((s, k) => {
        const val = s.values?.[i]; if (val == null || !Number.isFinite(val)) return;
        const from = v.stacked ? base : 0, to = v.stacked ? base + val : val; if (v.stacked) base += val;
        const x0 = v.stacked ? xc(i) - bw / 2 : xc(i) - (bw * series.length) / 2 + bw * k;
        g += `<rect x="${x0.toFixed(1)}" y="${Math.min(y(from), y(to)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(to) - y(from))).toFixed(1)}" fill="${series.length > 1 ? PALETTE[k] : val < 0 ? "var(--bad)" : PALETTE[0]}" rx="1.5"/>`;
      });
    }
    g += `<line x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/>`;
  }
  return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(v.title)}">${g}</svg>`, geo: { L, R, T, B, H, W, n, xw, lo, hi, line: v.kind === "line", one } };
}
function chartBox(v, i) {
  const series = (v.series ?? []).slice(0, 6);
  const drawn = chartSvg(v);
  if (!drawn) return "";
  const st = chartStats(v);
  const legend = series.length > 1 ? `<div class="vleg">${series.map((s, k) => `<span><i style="background:${PALETTE[k]}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  const head = st ? `<span class="vlast"><b>${esc(vfmt(st.last, v.unit))}</b>${st.chg != null ? `<small class="${st.chg >= 0 ? "up" : "down"}">${st.chg > 0 ? "+" : ""}${st.chg.toFixed(2)}%</small>` : ""}</span>` : "";
  return `<div class="viz chart" data-vi="${i}"><div class="vh"><span class="vt1">${esc(v.title)}</span>${head}</div><div class="vplot">${drawn.svg}<span class="vxh" hidden></span><span class="vdot" hidden></span><div class="vtip" hidden></div></div>${legend}</div>`;
}
const chartRO = typeof ResizeObserver === "function" ? new ResizeObserver((es) => { for (const e of es) if (e.target._chart) drawChart(e.target._chart); }) : null;
function drawChart(node) {
  const plot = node.querySelector(".vplot"); const W = Math.round(plot?.clientWidth ?? 0);
  if (!W || W === node._w || !node._v) return;
  const d = chartSvg(node._v, W); if (!d) return;
  node._w = W; node._geo = d.geo;
  plot.querySelector("svg")?.remove(); plot.insertAdjacentHTML("afterbegin", d.svg);
}
/** Hover (or touch) a chart: a crosshair, the point and its value with its x label. */
function mountChart(node, v) {
  node._v = v;
  node.querySelector(".vplot")._chart = node;
  if (chartRO) chartRO.observe(node.querySelector(".vplot")); else drawChart(node);
  const plot = node.querySelector(".vplot"), xh = plot.querySelector(".vxh"), dot = plot.querySelector(".vdot"), tip = plot.querySelector(".vtip");
  const hide = () => { xh.hidden = dot.hidden = tip.hidden = true; };
  plot.addEventListener("pointerleave", hide);
  plot.addEventListener("pointermove", (e) => {
    const g = node._geo; if (!g) return;
    const px = e.clientX - plot.getBoundingClientRect().left;
    const i = Math.max(0, Math.min(g.n - 1, Math.floor((px - g.L) / g.xw)));
    const x = g.L + g.xw * (i + 0.5);
    const series = (v.series ?? []).slice(0, 6);
    const vals = series.map((s) => s.values?.[i]).map((val) => (val == null || !Number.isFinite(val) ? null : val));
    if (vals.every((val) => val == null)) return hide();
    xh.hidden = false; xh.style.left = `${x}px`;
    const first = vals.find((val) => val != null);
    if (g.line && series.length === 1 && first != null) { dot.hidden = false; dot.style.left = `${x}px`; dot.style.top = `${g.T + (g.H - g.T - g.B) * (1 - (first - g.lo) / (g.hi - g.lo))}px`; dot.style.background = g.one; } else dot.hidden = true;
    tip.innerHTML = `<small>${esc(xfmt(v.x?.[i]))}</small>${series.map((s, k) => (vals[k] == null ? "" : `<span>${series.length > 1 ? `<i style="background:${PALETTE[k]}"></i>${esc(s.name)} ` : ""}<b>${esc(vfmt(vals[k], v.unit))}</b></span>`)).join("")}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(g.L, Math.min(g.W - g.R - tw, x + 10 + tw > g.W - g.R ? x - tw - 10 : x + 10))}px`;
  });
}
function donutSvg(v) {
  const sl = (v.slices ?? []).filter((x) => x.value > 0).slice(0, 8);
  const tot = sl.reduce((a, x) => a + x.value, 0);
  if (!tot) return "";
  let a0 = -Math.PI / 2, g = "";
  const C = 90, r1 = 80, r0 = 52;
  sl.forEach((x, k) => {
    const a1 = a0 + (x.value / tot) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (r, a) => `${(C + r * Math.cos(a)).toFixed(2)},${(C + r * Math.sin(a)).toFixed(2)}`;
    g += sl.length === 1 ? `<circle cx="${C}" cy="${C}" r="${(r0 + r1) / 2}" fill="none" stroke="${PALETTE[k]}" stroke-width="${r1 - r0}"/>` : `<path d="M${p(r1, a0)} A${r1},${r1} 0 ${big} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 ${big} 0 ${p(r0, a0)} Z" fill="${PALETTE[k % PALETTE.length]}"/>`;
    a0 = a1;
  });
  return `<div class="viz chart donut"><div class="vh">${esc(v.title)}</div><div class="dw"><svg viewBox="0 0 180 180" role="img" aria-label="${esc(v.title)}">${g}</svg><div class="vleg col">${sl.map((x, k) => `<span><i style="background:${PALETTE[k % PALETTE.length]}"></i>${esc(x.name)} <b>${v.unit === "usd" ? fmtUsd(x.value) : `${((x.value / tot) * 100).toFixed(1)}%`}</b></span>`).join("")}</div></div></div>`;
}
/** A price chip for an asset the answer names (Chord's asset row). */
function chipHtml(c) {
  const ch = c.change24hPct, href = hrefOf(c.href);
  return `<a class="chip"${href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : ""} title="${esc(c.label ?? c.symbol)}">${tlogo(c.symbol, c.logo, c.href, c.id)}<b>${esc(c.symbol)}</b><span class="cp">${fmtPrice(c.price)}</span>${ch != null ? `<span class="${ch >= 0 ? "up" : "down"}">${ch > 0 ? "+" : ""}${ch.toFixed(2)}%</span>` : ""}</a>`;
}
function vizHtml(v, vi) {
  if (v?.kind === "line" || v?.kind === "bar") return chartBox(v, vi);
  if (v?.kind === "donut") return donutSvg(v);
  if (v?.kind !== "table") return "";
  if (v.posts?.items?.length) {
    return `<div class="viz posts"><div class="vh">${esc(v.posts.label ?? v.title)}</div>${v.posts.items.slice(0, 8).map((p) => {
      const href = safeUrl(p.url);
      const stats = [p.likes != null && `${cell(p.likes)} likes`, p.reposts != null && `${cell(p.reposts)} reposts`, p.views != null && `${cell(p.views)} views`].filter(Boolean).join(" · ");
      return `<a class="post" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ""}><b>${esc(p.name)}</b> <small>@${esc(p.handle)}${p.followers != null ? ` · ${cell(p.followers)} followers` : ""}</small><span>${esc(String(p.text ?? "").slice(0, 280))}</span>${stats ? `<small>${esc(stats)}</small>` : ""}</a>`;
    }).join("")}</div>`;
  }
  const links = Array.isArray(v.links) && v.links.some(Boolean);
  const rows = (v.rows ?? []).slice(0, 25).map((r, i) => `<tr>${r.map((c, j) => {
    const href = links && j === (v.linkCol ?? 0) ? safeUrl(v.links[i]) : null;
    const cls = [v.align?.[j] === "r" && "r", typeof c === "string" && signOf(c.trim())].filter(Boolean).join(" ");
    return `<td${cls ? ` class="${cls}"` : ""}>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(cell(c))}</a>` : esc(cell(c))}</td>`;
  }).join("")}</tr>`).join("");
  const nr = (v.rows ?? []).length;
  return `<details class="viz"${links ? " open" : ""}><summary><span class="vt1">${esc(v.title)}</span><small>${nr} row${nr === 1 ? "" : "s"}</small></summary><div class="vt"><table><tr>${(v.columns ?? []).map((c, j) => `<th${v.align?.[j] === "r" ? ' class="r"' : ""}>${esc(c)}</th>`).join("")}</tr>${rows}</table></div></details>`;
}
function paintAnswer(el, a, collapsed) {
  el.work.innerHTML = "";
  el.body.innerHTML = md(a.text);
  const steps = a.steps ?? [];
  const smax = Math.max(0, ...steps.map((x) => x.ms ?? 0));
  const rounds = [...new Set(steps.map((x) => x.round ?? 1))];
  el.steps.innerHTML = rounds.map((r) => {
    const idx = steps.map((x, i) => ((x.round ?? 1) === r ? i : -1)).filter((i) => i >= 0);
    return (rounds.length > 1 ? roundHead(r, idx.length) : "") + `<div class="tlg">${idx.map((i) => stepRow(steps[i], false, smax, a.cards?.[i])).join("")}</div>`;
  }).join("");
  el.steps.hidden = collapsed;
  if (a.thinking) { el.thought.hidden = false; el.thought.querySelector("p").textContent = a.thinking; } else el.thought.hidden = true;
  const n = a.sources?.length ?? 0;
  el.srcs.innerHTML = (a.sources ?? []).map((x) => safeUrl(x.url) ? `<a class="src" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>` : `<span class="src">${esc(x.label)}</span>`).join("");
  el.root.querySelector(".chips")?.remove();
  if (a.assets?.length) { const row = document.createElement("div"); row.className = "chips"; row.innerHTML = a.assets.map(chipHtml).join(""); el.pills.after(row); }
  el.pills.innerHTML = `<button type="button" class="pill work"><i class="ok">${icon("check")}</i>Work complete in ${(a.elapsedMs / 1000).toFixed(1)}s<i>${icon("chev-d")}</i></button>`
    + (n ? `<button type="button" class="pill srcp"><span class="dots">${[...new Set((a.sources ?? []).map((x) => KIND[x.kind] ?? "•"))].slice(0, 3).map((k) => `<b>${k}</b>`).join("")}</span>${n} Source${n === 1 ? "" : "s"}</button>` : "");
  el.pills.querySelector(".work").onclick = () => { el.steps.hidden = !el.steps.hidden; };
  const sp = el.pills.querySelector(".srcp"); if (sp) sp.onclick = () => { el.srcs.hidden = !el.srcs.hidden; };
  el.meta.textContent = `${steps.length} lookup${steps.length === 1 ? "" : "s"}`;
  el.root.querySelector(".vizbox")?.remove();
  const vz = (a.viz ?? []).map((v, i) => vizHtml(v, i)).filter(Boolean);
  if (vz.length) {
    const box = document.createElement("div"); box.className = "vizbox"; box.innerHTML = vz.join(""); el.body.after(box);
    box.querySelectorAll(".viz.chart[data-vi]").forEach((n) => mountChart(n, a.viz[Number(n.dataset.vi)]));
  }
  el.root.querySelector(".swapcards")?.remove();
  if (a.swaps?.length) {
    const box = document.createElement("div"); box.className = "swapcards";
    // a swap to review, or an agent the chat just started (its page in My agents)
    const KIND_LABEL = { copy: "Copy trader", custom: "Strategy", lp: "LP agent", alert: "Alert" };
    box.innerHTML = a.swaps.map((c, i) => c?.kind === "agent"
      ? `<div class="swapc agentc"><div class="t">${esc(c.name)}<small>${esc(KIND_LABEL[c.type] ?? "Agent")} · ${c.mode === "live" ? "live" : "paper"} · running in My agents</small></div><button type="button" data-agent="${esc(c.id)}">Open agent</button></div>`
      : `<div class="swapc"><div class="t">Swap ${esc(c.amount)} ${esc(c.tokenIn?.symbol)} for ${esc(c.tokenOut?.symbol)}<small>${esc(CHAIN_NAMES[c.chain] ?? c.chain)} · review and sign in your own wallet</small></div><button type="button" data-i="${i}">Review swap</button></div>`).join("");
    box.addEventListener("click", (e) => {
      const ag = e.target.closest("button[data-agent]"); if (ag) { closeSideOnPhone(); location.hash = `#agents/${encodeURIComponent(ag.dataset.agent)}`; return; }
      const b = e.target.closest("button[data-i]"); if (b) openTrade(a.swaps[Number(b.dataset.i)]);
    });
    el.body.after(box);
  }
  el.root.querySelector(".clarify")?.remove();
  if (a.clarify) {
    // Chord's ask-back card: pick one (or several), or type your own; the answer is the next question.
    const c = a.clarify, box = document.createElement("div"); box.className = "clarify";
    box.innerHTML = `<div class="cq">${esc(c.question)}</div><div class="copts">${c.options.map((o, i) => `<button type="button" data-o="${i}"><b>${esc(o.label)}</b>${o.detail ? `<small>${esc(o.detail)}</small>` : ""}</button>`).join("")}</div>${c.allowOther ? `<form class="cother"><input placeholder="Or type your own answer" maxlength="300"><button type="submit">Send</button></form>` : ""}`;
    const picked = new Set();
    box.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-o]"); if (!b || busy) return;
      const label = c.options[Number(b.dataset.o)].label;
      if (c.multi) { b.classList.toggle("on"); picked.has(label) ? picked.delete(label) : picked.add(label); if (!box.querySelector(".cgo")) { const go = document.createElement("button"); go.type = "button"; go.className = "cgo"; go.textContent = "Send"; go.onclick = () => picked.size && send([...picked].join(", ")); box.append(go); } }
      else send(label);
    });
    box.querySelector(".cother")?.addEventListener("submit", (ev) => { ev.preventDefault(); const v = ev.target.querySelector("input").value.trim(); if (v && !busy) send(v); });
    el.body.after(box);
  }
  const fu = a.followUps ?? [];
  el.follow.innerHTML = fu.length ? `<div class="fh">Related questions</div>${fu.map((q, i) => `<button type="button" data-q="${i}"><span>${esc(q)}</span>${icon("ne")}</button>`).join("")}` : "";
  el.follow.onclick = (e) => { const b = e.target.closest("[data-q]"); if (b && !busy) send(fu[Number(b.dataset.q)]); };
  el.acts.innerHTML = [["copy", "Copy"], ["up", "Good answer"], ["down", "Bad answer"], ["share", "Share"], ["retry", "Ask again"]].map(([k, t]) => `<button type="button" data-a="${k}" title="${t}" aria-label="${t}" class="${a.rating === k ? "on" : ""}">${icon(`a-${k}`)}</button>`).join("");
  el.acts.onclick = async (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return;
    const k = b.dataset.a;
    if (k === "copy") { await navigator.clipboard?.writeText(a.text).catch(() => {}); b.classList.add("on"); setTimeout(() => b.classList.remove("on"), 1200); }
    else if (k === "up" || k === "down") {
      a.rating = a.rating === k ? null : k; saveThreads();
      el.acts.querySelectorAll("[data-a=up],[data-a=down]").forEach((x) => x.classList.toggle("on", x.dataset.a === a.rating));
      if (a.rating) fetch("/v1/feedback", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SESSION }, body: JSON.stringify({ question: el.question, rating: a.rating }) }).catch(() => {});
    } else if (k === "share") {
      const text = `${el.question}\n\n${a.text}\n\n${location.origin}`;
      if (navigator.share) navigator.share({ title: el.question, text }).catch(() => {}); else { await navigator.clipboard?.writeText(text).catch(() => {}); b.classList.add("on"); setTimeout(() => b.classList.remove("on"), 1200); }
    } else if (k === "retry" && !busy) send(el.question);
  };
}
const CHAIN_NAMES = { solana: "Solana", base: "Base", bnb: "BNB Chain", avalanche: "Avalanche", monad: "Monad", robinhood: "Robinhood Chain", arc: "Arc" };

function buildToc() {
  const answers = [...$("thread").querySelectorAll(".bot .md")];
  const last = answers[answers.length - 1];
  const hs = last ? [...last.querySelectorAll("h3")] : [];
  if (hs.length < 2) { $("toc").hidden = true; return; }
  $("tocList").innerHTML = hs.map((h, i) => `<li data-h="${h.id}" class="${i === 0 ? "on" : ""}"><span class="n">${i + 1}</span>${esc(h.textContent)}</li>`).join("");
  $("toc").hidden = false;
}

async function send(question) {
  question = question.trim();
  if (!question || busy) return;
  busy = true;
  if (!current) {
    const t = { id: crypto.randomUUID(), title: question.length > 70 ? question.slice(0, 68) + "…" : question, at: Date.now(), turns: [] };
    threads.unshift(t); current = t.id;
  }
  const thread = threads.find((x) => x.id === current);
  const history = thread.turns.filter((x) => x.a).slice(-3).flatMap((x) => [{ role: "user", content: x.q }, { role: "assistant", content: x.a.historyText ?? x.a.text }]);
  const turn = { q: question, a: null };
  thread.turns.push(turn); thread.at = Date.now(); saveThreads();
  showChat(); renderThreads(); setTitle();
  const el = turnEls(question);
  el.body.innerHTML = "";
  const st = { t0: Date.now(), rounds: new Map() };
  const roundOf = (r) => { if (!st.rounds.has(r)) st.rounds.set(r, { thinking: "", steps: [] }); return st.rounds.get(r); };
  renderWork(el, st);
  const tick = setInterval(() => { const t = el.work.querySelector(".wt"); if (t) t.textContent = secs(Date.now() - st.t0); }, 200);
  $("scroller").scrollTop = $("scroller").scrollHeight;
  try {
    const res = await fetch("/v1/ask", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SESSION }, body: JSON.stringify({ question, history }) });
    if (res.status === 402) {
      const j = await res.json(); turn.err = j.message; el.pills.innerHTML = "";
      el.body.innerHTML = `<p>You have used this session's free asks. Pay with USDC or ADA to keep going.</p>`; credits(j.session); openPay(j.pay); return;
    }
    if (!res.ok || !res.body) { turn.err = `Request failed (${res.status}).`; el.pills.innerHTML = ""; el.body.innerHTML = `<p class="err">${turn.err}</p>`; return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        const e = JSON.parse(data);
        if (ev === "draft") {
          const s2 = $("scroller"), atEnd = s2.scrollHeight - s2.scrollTop - s2.clientHeight < 140;
          el.body.innerHTML = e.text ? md(e.text) : ""; el.body.classList.toggle("drafting", !!e.text);
          if (atEnd) s2.scrollTop = s2.scrollHeight;
        } else if (ev === "thinking") {
          roundOf(e.round).thinking = e.text; renderWork(el, st);
        } else if (ev === "status") {
          roundOf(e.round).steps.push({ ...e, done: false }); renderWork(el, st);
        } else if (ev === "step") {
          const R = roundOf(e.round);
          const x = R.steps.find((y) => !y.done && y.tool === e.tool && (y.detail ?? null) === (e.detail ?? null));
          if (x) Object.assign(x, e, { done: true }); else R.steps.push({ ...e, done: true });
          renderWork(el, st);
        } else if (ev === "answer") {
          clearInterval(tick);
          const all = [...st.rounds.keys()].sort((p, q) => p - q).flatMap((r) => st.rounds.get(r).steps);
          const cards = (e.steps ?? []).map((x) => all.find((y) => y.done && y.tool === x.tool && y.round === x.round && (y.detail ?? null) === (x.detail ?? null))?.cards ?? []);
          el.body.classList.remove("drafting");
          turn.a = { text: e.text, sources: e.sources, steps: e.steps, elapsedMs: e.elapsedMs, swaps: e.swaps ?? [], viz: e.viz ?? [], followUps: e.followUps ?? [], thinking: e.thinking ?? "", cards, assets: e.assets ?? [] };
          paintAnswer(el, turn.a, true); buildToc(); credits(e.session);
        } else if (ev === "clarify") {
          clearInterval(tick); el.body.classList.remove("drafting");
          turn.a = { text: e.text, historyText: e.historyText, clarify: e.clarify, steps: e.steps, elapsedMs: e.elapsedMs, sources: [], cards: [] };
          paintAnswer(el, turn.a, true);
        } else if (ev === "error") {
          clearInterval(tick); el.work.innerHTML = "";
          turn.err = e.message; el.pills.innerHTML = ""; el.body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
        } else if (ev === "done") {
          credits(e.session);
        }
      }
    }
  } catch (err) {
    turn.err = `Connection lost: ${err.message}`; el.pills.innerHTML = ""; el.work.innerHTML = ""; el.body.innerHTML = `<p class="err">${esc(turn.err)}</p>`;
  } finally {
    clearInterval(tick);
    busy = false; setTitle(); saveThreads(); renderThreads();
    (el.root.previousElementSibling ?? el.root).scrollIntoView({ behavior: "smooth", block: "start" });
    $("qChat").focus();
  }
}

// ── pay + agent sheets ──────────────────────────────────────────────────────────────────────────────────────────────────
function openPay(pay) {
  const p = pay ?? cfg?.pay ?? {};
  const opt = (name, o, unit) => o ? `<div class="opt"><b>${esc(o.price)} ${esc(unit)} on ${name}</b> per ask
      <div class="addr"><span>${esc(o.treasury)}</span><button type="button" data-copy="${esc(o.treasury)}">Copy</button></div></div>` : "";
  const html = opt("Solana", p.solana, "USDC") + opt("Cardano", p.cardano, "ADA");
  $("payOptions").innerHTML = html || `<p class="muted">Payments are not set up on this server yet. Every session gets ${esc(p.freeAsks ?? 0)} free asks.</p>`;
  $("payMsg").textContent = ""; $("payMsg").className = "msg";
  $("pay").hidden = false;
}

// ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const grow = (t) => { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; t.closest(".composer").classList.toggle("ready", !!t.value.trim()); };
for (const [form, ta] of [["composerHome", "qHome"], ["composerChat", "qChat"]]) {
  $(form).addEventListener("submit", (e) => { e.preventDefault(); const v = $(ta).value; $(ta).value = ""; grow($(ta)); send(v); });
  $(ta).addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $(form).requestSubmit(); } });
  $(ta).addEventListener("input", () => grow($(ta)));
}
document.querySelectorAll(".ctool").forEach((b) => b.addEventListener("click", () => { const t = $("qHome"); t.value = b.dataset.fill; t.focus(); grow(t); }));
$("cats").addEventListener("click", (e) => { const b = e.target.closest(".cat"); if (!b) return; cat = b.dataset.cat; $("cats").querySelectorAll(".cat").forEach((x) => x.classList.toggle("on", x === b)); renderSugs(); });
$("sugs").addEventListener("click", (e) => { const b = e.target.closest(".sug[data-i]"); const items = sugCache.get($("sugs").dataset.cat)?.items; if (b && items) send(items[Number(b.dataset.i)].q); });
$("threads").addEventListener("click", (e) => { const b = e.target.closest(".t"); if (b) openThread(b.dataset.t); });
$("chatSearch").addEventListener("input", renderThreads);
$("newChat").addEventListener("click", newChat);
$("railChat").addEventListener("click", () => (current ? openThread(current) : newChat()));
for (const id of ["railTrade", "tradeBtnM", "sideTrade"]) $(id).addEventListener("click", () => { closeSideOnPhone(); openTrade(); });
for (const id of ["railBots", "sideBots"]) $(id).addEventListener("click", () => { closeSideOnPhone(); openBotsView(); });
for (const id of ["railWallet", "sideWallet"]) $(id).addEventListener("click", () => openWalletView(""));
$("toggleSide").addEventListener("click", () => $("app").classList.toggle("noside"));
$("menuBtn").addEventListener("click", () => $("app").classList.toggle("noside"));
$("searchBtn").addEventListener("click", () => { $("app").classList.remove("noside"); $("chatSearch").focus(); });
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("app").classList.remove("noside"); $("chatSearch").focus(); } });
$("themeBtn").addEventListener("click", () => { const t = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t; try { localStorage.setItem("ask2049_theme", t); } catch {} });
for (const id of ["credits", "payBtn", "railPay"]) $(id).addEventListener("click", () => { if (payable) openPay(); });
for (const id of ["agentPill", "railAgent"]) $(id).addEventListener("click", () => { $("agent").hidden = false; });
document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.hidden = true; }));
// Esc closes the sheet on top (token picker, wallets, account, pay, agent), as its × does
addEventListener("keydown", (e) => { if (e.key !== "Escape" || e.defaultPrevented) return; const top = [...document.querySelectorAll(".sheet")].filter((s) => !s.hidden).pop(); if (top) { e.preventDefault(); top.hidden = true; } });
$("payOptions").addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; }); });
$("tocList").addEventListener("click", (e) => { const li = e.target.closest("li"); if (!li) return; document.getElementById(li.dataset.h)?.scrollIntoView({ behavior: "smooth", block: "start" }); $("tocList").querySelectorAll("li").forEach((x) => x.classList.toggle("on", x === li)); });
$("payGo").addEventListener("click", async () => {
  const ref = $("payRef").value.trim(); if (!ref) return;
  $("payMsg").className = "msg"; $("payMsg").textContent = "Checking on-chain…";
  const r = await fetch("/v1/pay", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SESSION }, body: JSON.stringify({ chain: $("payChain").value, ref }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { $("payMsg").className = "msg ok"; $("payMsg").textContent = `Verified: ${j.paid} ${j.asset}, ${j.credits} ask${j.credits === 1 ? "" : "s"} added.`; credits(j.session); }
  else { $("payMsg").className = "msg bad"; $("payMsg").textContent = j.message ?? `Rejected (${r.status}).`; }
});
// ── sign-in: Chord's Privy app, the bundle loaded only on "Sign in" or when this browser already has a Privy session ──────
let privyP = null;
const VER = new URL(import.meta.url).search;
const privySession = () => { try { return Object.keys(localStorage).some((k) => k.startsWith("privy:")); } catch { return false; } };
function loadPrivy() {
  if (!cfg?.privy) return Promise.reject(new Error("Sign-in is not set up on this server."));
  privyP ??= import(`./privy/privy.js${VER}`)
    .then((m) => m.mount({ appId: cfg.privy.appId, clientId: cfg.privy.clientId, dark: document.documentElement.dataset.theme !== "light" }))
    .then((p) => { p.subscribe((s) => { renderAccount(s); tradeMod?.privyChanged(s); dispatchEvent(new CustomEvent("askprivy", { detail: s })); }); return p; })
    .catch((e) => { privyP = null; throw e; });
  return privyP;
}
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
function renderAccount(s) {
  const on = !!s?.authenticated;
  $("signInBtn").classList.toggle("on", on);
  $("signInText").textContent = on ? (s.email ?? "Account") : "Sign in";
  $("signInBtn").setAttribute("aria-label", on ? `Account ${s.email ?? ""}` : "Sign in");
  $("acctEmail").textContent = on ? `Signed in as ${s.email ?? "(no email)"}` : "";
  const row = (label, addr, empty) => `<div class="opt"><b>${label}</b><div class="addr">${addr ? `<span>${esc(addr)}</span><button type="button" data-copy="${esc(addr)}">Copy</button>` : `<span class="muted">${empty}</span>`}</div></div>`;
  $("acctWallets").innerHTML = on ? row("EVM wallet", s.evm, "Being set up…") + row("Solana wallet", s.sol, "Created the first time you swap on Solana.") : "";
  if (!$("account").hidden && !on) $("account").hidden = true;
}
async function signIn() {
  const btn = $("signInBtn");
  if (window.askPrivy?.state.authenticated) { $("acctMsg").textContent = ""; $("account").hidden = false; return; }
  btn.disabled = true;
  btn.classList.add("loading");
  if (!window.askPrivy?.state.ready) $("signInText").textContent = "Loading…"; // first load fetches Privy (a few seconds)
  try {
    const p = await loadPrivy();
    await p.whenReady();
    if (p.state.authenticated) $("account").hidden = false; else p.login();
  } catch (e) {
    $("acctEmail").textContent = ""; $("acctWallets").innerHTML = "";
    $("acctMsg").className = "msg bad"; $("acctMsg").textContent = e?.message ?? String(e);
    $("signOutBtn").hidden = true; $("account").hidden = false;
  } finally {
    btn.disabled = false; btn.classList.remove("loading");
    if (!window.askPrivy?.state.authenticated) $("signInText").textContent = "Sign in";
  }
}
$("signInBtn").addEventListener("click", () => { $("signOutBtn").hidden = false; $("acctMsg").className = "msg"; signIn(); });
$("signOutBtn").addEventListener("click", async () => { await window.askPrivy?.logout().catch(() => {}); $("account").hidden = true; });
$("acctWallets").addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; }); });

// ── export / share the open chat ──
function chatMarkdown(t) {
  const lines = [`# ${t.title}`, ""];
  for (const x of t.turns) {
    if (!x.a) continue;
    lines.push(`## ${x.q}`, "", x.a.text, "");
    const src = (x.a.sources ?? []).filter((s) => safeUrl(s.url));
    if (src.length) lines.push("Sources:", ...src.map((s) => `- [${s.label}](${s.url})`), "");
  }
  lines.push(`_Exported from ${location.host} on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC_`);
  return lines.join("\n");
}
function toast(msg) {
  let t = $("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.append(t); }
  t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2200);
}
$("exportBtn").addEventListener("click", () => {
  const t = threads.find((x) => x.id === current); if (!t) return;
  const blob = new Blob([chatMarkdown(t)], { type: "text/markdown" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `${t.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || "chat"}.md`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("shareBtn").addEventListener("click", async () => {
  const t = threads.find((x) => x.id === current); if (!t) return;
  const body = { title: t.title, turns: t.turns.filter((x) => x.a).map((x) => ({ q: x.q, a: { text: x.a.text, elapsedMs: x.a.elapsedMs, sources: x.a.sources, followUps: x.a.followUps, steps: x.a.steps, viz: x.a.viz, assets: x.a.assets } })) };
  const r = await fetch("/v1/share", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SESSION }, body: JSON.stringify(body) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok || !j.url) return toast(j.message ?? "Could not create a link.");
  if (navigator.share && matchMedia("(max-width: 900px)").matches) navigator.share({ title: t.title, url: j.url }).catch(() => {});
  else { await navigator.clipboard?.writeText(j.url).catch(() => {}); toast("Link copied"); }
});
/** /?s=<id>: a shared chat, copied into this browser's chats so the visitor can keep asking. */
async function openShared(id) {
  const r = await fetch(`/v1/share/${encodeURIComponent(id)}`).catch(() => null);
  if (!r?.ok) return toast("This shared chat is not available.");
  const s = await r.json();
  const t = { id: `shared-${id}`, title: s.title, at: Date.now(), turns: s.turns, shared: true };
  threads = [t, ...threads.filter((x) => x.id !== t.id)]; saveThreads();
  openThread(t.id);
  history.replaceState(null, "", location.pathname);
}

if (matchMedia("(max-width: 900px)").matches) $("app").classList.add("noside");
boot().then(async () => {
  tradeMod = await import(`./trade.js${VER}`);
  await tradeMod.initTrade({ icon: (n) => iconTag(n), showView, loadPrivy, privyConfigured: () => !!cfg?.privy });
  if (window.askPrivy) tradeMod.privyChanged(window.askPrivy.state);
  if (location.hash === "#trade") openTrade();
  if (/^#(agents|bots)(\/|$)/.test(location.hash)) openBotsView();
  if (TRUST_RE.test(location.hash)) openWalletView(location.hash);
  // a pasted #agents/… or #wallet/… link while another view is open
  window.addEventListener("hashchange", () => {
    if (!botsP && /^#(agents|bots)(\/|$)/.test(location.hash)) openBotsView();
    if (TRUST_RE.test(location.hash) && $("walletv").hidden) openWalletView(location.hash);
  });
  const shared = new URLSearchParams(location.search).get("s");
  if (shared && /^[0-9a-f]{12}$/.test(shared)) openShared(shared);
  // first visit on the Chat home: the tour, once (Agents' starts when that view opens)
  setTimeout(() => { if (!$("home").hidden && !current) startChatTour(false); }, 1200);
});
// "?" in the top bar: replay the tour of the view on screen (Chat's from any other view)
$("tourBtn").addEventListener("click", () => {
  if (!$("botsv").hidden) { tourMod().then((m) => m.startTour("agents", { force: true })).catch(() => {}); return; }
  if ($("home").hidden) newChat();
  startChatTour(true);
});
