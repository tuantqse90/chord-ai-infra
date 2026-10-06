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
let cfg = null, busy = false, cat = null;
let threads = store.get("ask2049_threads", []); // [{id, title, at, turns: [{q, a}]}]
let current = null;
const saveThreads = () => store.set("ask2049_threads", threads.slice(0, 60));

const CATS = [
  { id: "solana", label: "Solana", icon: "bolt", sugs: [
    "What does wallet 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9 hold, and what did it do recently?",
    "Explain Solana transaction 5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf",
    "Who holds BONK (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263)? Is supply concentrated?",
    "Does JUP (JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN) still have a mint or freeze authority?",
  ] },
  { id: "robinhood", label: "Robinhood", icon: "trend", chain: "robinhood", sugs: [
    "What were the most traded tokens on Robinhood Chain in the last 24 hours?",
    "How did Robinhood Chain DEX volume move over the last 7 days?",
    "Show the latest NVDA trades on Robinhood Chain (0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec)",
  ] },
  { id: "base", label: "Base", icon: "layers", chain: "base", sugs: [
    "Top tokens on Base in the last 24 hours, with their buy share",
    "Compare DEX volume on Base, BNB Chain and Avalanche over the last 3 days",
    "Latest AERO trades on Base (0x940181a94a35a4569e4529a3cdfb74e38fd98631)",
  ] },
  { id: "bnb", label: "BNB Chain", icon: "layers", chain: "bnb", sugs: [
    "What were the 5 most traded tokens on BNB Chain in the last 24 hours?",
    "Latest Cake trades on BNB Chain (0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82)",
  ] },
  { id: "avalanche", label: "Avalanche", icon: "layers", chain: "avalanche", sugs: [
    "What traded most on Avalanche today?",
    "How did Avalanche DEX volume move this week?",
  ] },
  { id: "arc", label: "Arc", icon: "globe", chain: "arc", sugs: [
    "What traded most on Arc in the last 24 hours?",
    "Latest cirBTC trades on Arc (0x171a4217b86a807a64eb94757db6849fb4bdbaa0)",
  ] },
  { id: "monad", label: "Monad", icon: "globe", chain: "monad", sugs: [
    "Latest WMON trades on Monad (0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A)",
  ] },
  { id: "payments", label: "Payments", icon: "check", sugs: [
    "Did Solana transaction 5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf pay 4azvt8Lo1pDmxhJ5FEJsAGX3fa1FwB51pgeA36ziaj41 at least 9 USDC?",
    "How do I pay for more asks here?",
  ] },
];

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  paintIcons();
  $("mascotHome").innerHTML = mascot();
  cfg = await fetch("/v1/config").then((r) => r.json()).catch(() => null);
  const chains = cfg?.indexChains ?? [];
  const cats = CATS.filter((c) => !c.chain || chains.includes(c.chain));
  cat = cats[0]?.id ?? null;
  $("cats").innerHTML = cats.map((c) => `<button type="button" class="cat${c.id === cat ? " on" : ""}" data-cat="${c.id}"><i data-i="${c.icon}"></i>${esc(c.label)}</button>`).join("");
  paintIcons($("cats"));
  renderSugs();
  if (cfg) {
    const sol = cfg.nownodes?.solana ? "NOWNodes" : (cfg.nownodes?.solanaEndpoint ?? "RPC");
    const evm = chains.filter((c) => c !== "solana").length;
    $("cardInfra").textContent = `Solana on-chain via ${sol}${evm ? `, plus Chord's index of ${evm} EVM chain${evm === 1 ? "" : "s"}` : ""}.`;
    const p = cfg.pay ?? {};
    $("cardPayText").textContent = p.unlimited ? "Asks are unlimited and free right now, signed in or not." : p.solana || p.cardano
      ? `${p.freeAsks} free asks, then ${[p.solana && `${p.solana.price} USDC on Solana`, p.cardano && `${p.cardano.price} ADA on Cardano`].filter(Boolean).join(" or ")}, checked on-chain.`
      : `${p.freeAsks} free asks per session.`;
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

function renderSugs() {
  const c = CATS.find((x) => x.id === cat);
  $("sugs").innerHTML = (c?.sugs ?? []).map((q) => `<button type="button" class="sug" data-q="${esc(q)}"><span>${esc(q)}</span><i data-i="ne"></i></button>`).join("");
  paintIcons($("sugs"));
}

function credits(s) {
  if (!s) return;
  if (s.unlimited) { $("creditsText").innerHTML = `Unlimited<span class="unit"> asks</span>`; $("credits").title = "Unlimited asks"; return; }
  const [n, unit] = s.freeLeft > 0 ? [s.freeLeft, ` free ask${s.freeLeft === 1 ? "" : "s"}`] : [s.credits, ` credit${s.credits === 1 ? "" : "s"}`];
  $("creditsText").innerHTML = `${n}<span class="unit">${unit}</span>`;
  $("credits").title = `${n}${unit}`;
}
function setTitle() {
  const t = threads.find((x) => x.id === current);
  $("title").textContent = t ? t.title : "";
  $("threadActs").hidden = !(t && t.turns.some((x) => x.a));
  document.title = t ? `${t.title} · Chord Ask` : "Chord Ask";
}

// ── chats list ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderThreads() {
  const f = $("chatSearch").value.trim().toLowerCase();
  const list = threads.filter((t) => !f || t.title.toLowerCase().includes(f) || t.turns.some((x) => x.q.toLowerCase().includes(f)));
  if (!list.length) { $("threads").innerHTML = `<div class="empty">${f ? "No chat matches." : "Your questions show up here."}</div>`; return; }
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
function showView(v) {
  $("home").hidden = v !== "home"; $("chat").hidden = v !== "chat"; $("tradev").hidden = v !== "trade";
  $("railChat").classList.toggle("active", v !== "trade"); $("railTrade").classList.toggle("active", v === "trade");
  if (v === "trade") { $("title").textContent = "Trade"; document.title = "Trade · Chord Ask"; } else setTitle();
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
      out.push(`<div class="tbl"><table>${head ? `<thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` : ""}<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
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
// ── steps and cards, as on getchord.xyz/ask: label, what it was about, how long; the tokens / posts / pages it found ──
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const SPIN = `<svg class="sspin" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" stroke-width="2.4"/><path d="M9 2 A7 7 0 0 1 16 9" fill="none" stroke="var(--hi)" stroke-width="2.4" stroke-linecap="round"/></svg>`;
const LENS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
function stepRow(s, running) {
  return `<div class="srow">${running ? SPIN : `<span class="sdot${s.ok === false ? " bad" : ""}"></span>`}<span class="slbl">${esc(s.label)}${running ? "…" : ""}</span>${s.via ? `<span class="svia">${esc(s.via)}</span>` : ""}${s.detail ? `<span class="schip">${LENS}<span>${esc(s.detail)}</span></span>` : ""}${!running && s.ms ? `<span class="sms">${secs(s.ms)}</span>` : ""}</div>${!running && s.ok === false && s.summary ? `<div class="serr">${esc(s.summary)}</div>` : ""}`;
}
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
    return `<a class="tcard"${href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : ""}><div class="tch"><span class="tlogo"><b>${esc(String(c.symbol ?? "?")[0])}</b>${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span><span class="tcn"><b>${esc(sym)}</b><small>${esc(c.name)}${c.chainName ? ` · ${esc(c.chainName)}` : ""}</small></span><span class="tcp"><small>Price</small><b>${fmtPrice(c.price)}</b>${ch != null ? `<small class="${ch >= 0 ? "up" : "down"}">${ch > 0 ? "+" : ""}${ch.toFixed(2)}%</small>` : ""}</span></div>${figs.length ? `<div class="tcf" style="grid-template-columns:repeat(${figs.length},minmax(0,1fr))">${figs.map(([k, v]) => `<span><small>${k}</small><b>${fmtUsd(v)}</b></span>`).join("")}</div>` : ""}</a>`;
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
  let html = `<div class="wtime">Working · <span class="wt">${secs(Date.now() - st.t0)}</span></div>`;
  if (!rounds.length) html += `<div class="think live">Thinking…</div>`;
  for (const r of rounds) {
    const R = st.rounds.get(r);
    if (R.thinking) html += R.steps.length ? `<details class="thought"><summary>Thought complete</summary><p>${esc(R.thinking)}</p></details>` : `<div class="think live">Thinking…<p>${esc(R.thinking)}</p></div>`;
    for (const x of R.steps) html += stepRow(x, !x.done) + (x.done ? cardsHtml(x.cards) : "");
  }
  const last = rounds.length ? st.rounds.get(rounds[rounds.length - 1]) : null;
  if (last?.steps.length && last.steps.every((x) => x.done)) html += `<div class="think live">Thinking…</div>`;
  el.work.innerHTML = html;
}

const KIND = { account: "W", tx: "T", token: "$", "ada-address": "A", "ada-tx": "T", index: "C", web: "↗" };

// Tables and X post feeds the tools returned (Chord's `viz`). Headlines and posts open their source; other tables sit
// folded under the answer, which already quotes the numbers that matter.
const safeUrl = (u) => (/^https:\/\//.test(String(u ?? "")) ? String(u) : null);
const cell = (v) => (v == null ? "" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(v));
// ── charts (Chord's line / bar / donut viz) as plain SVG ──
const PALETTE = ["var(--hi)", "var(--purple)", "#f5a524", "#4aa3ff", "#ff6b8a", "#9ad0ff"];
const vfmt = (n, unit) => (n == null || !Number.isFinite(n) ? "" : unit === "usd" || (unit === "price" && Math.abs(n) >= 1000) ? fmtUsd(n) : unit === "pct" ? `${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%` : unit === "price" ? fmtPrice(n) : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${+n.toFixed(2)}`);
function chartSvg(v) {
  const W = 640, H = 220, L = 62, R = 24, T = 12, B = 26;
  const xs = v.x ?? [], series = (v.series ?? []).slice(0, 6);
  const n = xs.length || Math.max(0, ...series.map((s) => s.values?.length ?? 0));
  if (!n || !series.length) return "";
  let vals = series.flatMap((s) => (s.values ?? []).filter((x) => x != null && Number.isFinite(x)));
  if (v.kind === "bar" && v.stacked) vals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.values?.[i] ?? 0), 0)).concat(0);
  if (v.kind === "bar") vals.push(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "";
  if (lo === hi) { lo -= Math.abs(lo) * 0.05 || 1; hi += Math.abs(hi) * 0.05 || 1; }
  const pad = (hi - lo) * 0.06; if (v.kind === "line") { lo -= pad; hi += pad; }
  const y = (val) => T + (H - T - B) * (1 - (val - lo) / (hi - lo));
  const xw = (W - L - R) / n, xc = (i) => L + xw * (i + 0.5);
  const ticks = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3);
  let g = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(vfmt(t, v.unit))}</text>`).join("");
  const lab = [0, Math.floor((n - 1) / 2), n - 1].filter((v2, i, a) => a.indexOf(v2) === i);
  g += lab.map((i) => `<text x="${xc(i)}" y="${H - 6}" text-anchor="middle">${esc(String(xs[i] ?? "").slice(0, 14))}</text>`).join("");
  if (v.kind === "line") {
    g += series.map((s, k) => { const pts = (s.values ?? []).map((val, i) => (val == null ? null : `${xc(i).toFixed(1)},${y(val).toFixed(1)}`)).filter(Boolean); return pts.length ? `<polyline fill="none" stroke="${PALETTE[k]}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${pts.join(" ")}"/>` : ""; }).join("");
  } else {
    const bw = Math.max(2, (xw * 0.72) / (v.stacked ? 1 : series.length));
    for (let i = 0; i < n; i++) {
      let base = 0;
      series.forEach((s, k) => {
        const val = s.values?.[i]; if (val == null || !Number.isFinite(val)) return;
        const from = v.stacked ? base : 0, to = v.stacked ? base + val : val; if (v.stacked) base += val;
        const x0 = v.stacked ? xc(i) - bw / 2 : xc(i) - (bw * series.length) / 2 + bw * k;
        g += `<rect x="${x0.toFixed(1)}" y="${Math.min(y(from), y(to)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(to) - y(from))).toFixed(1)}" fill="${series.length > 1 ? PALETTE[k] : val < 0 ? "var(--bad)" : PALETTE[0]}" rx="1.5"/>`;
      });
    }
    g += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="zero"/>`;
  }
  const legend = series.length > 1 ? `<div class="vleg">${series.map((s, k) => `<span><i style="background:${PALETTE[k]}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  return `<div class="viz chart"><div class="vh">${esc(v.title)}</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(v.title)}">${g}</svg>${legend}</div>`;
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
  return `<a class="chip"${href ? ` href="${esc(href)}" target="_blank" rel="noopener"` : ""} title="${esc(c.label ?? c.symbol)}"><span class="tlogo"><b>${esc(String(c.symbol ?? "?")[0])}</b>${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span><b>${esc(c.symbol)}</b><span class="cp">${fmtPrice(c.price)}</span>${ch != null ? `<span class="${ch >= 0 ? "up" : "down"}">${ch > 0 ? "+" : ""}${ch.toFixed(2)}%</span>` : ""}</a>`;
}
function vizHtml(v) {
  if (v?.kind === "line" || v?.kind === "bar") return chartSvg(v);
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
    return `<td class="${v.align?.[j] === "r" ? "r" : ""}">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(cell(c))}</a>` : esc(cell(c))}</td>`;
  }).join("")}</tr>`).join("");
  return `<details class="viz"${links ? " open" : ""}><summary>${esc(v.title)}</summary><div class="vt"><table><tr>${(v.columns ?? []).map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows}</table></div></details>`;
}
function paintAnswer(el, a, collapsed) {
  el.work.innerHTML = "";
  el.body.innerHTML = md(a.text);
  const steps = a.steps ?? [];
  el.steps.innerHTML = steps.map((x, i) => stepRow(x, false) + cardsHtml(a.cards?.[i])).join("");
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
  const vz = (a.viz ?? []).map(vizHtml).filter(Boolean);
  if (vz.length) { const box = document.createElement("div"); box.className = "vizbox"; box.innerHTML = vz.join(""); el.body.after(box); }
  el.root.querySelector(".swapcards")?.remove();
  if (a.swaps?.length) {
    const box = document.createElement("div"); box.className = "swapcards";
    box.innerHTML = a.swaps.map((c, i) => `<div class="swapc"><div class="t">Swap ${esc(c.amount)} ${esc(c.tokenIn?.symbol)} for ${esc(c.tokenOut?.symbol)}<small>${esc(CHAIN_NAMES[c.chain] ?? c.chain)} · review and sign in your own wallet</small></div><button type="button" data-i="${i}">Review swap</button></div>`).join("");
    box.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) openTrade(a.swaps[Number(b.dataset.i)]); });
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
  const history = thread.turns.filter((x) => x.a).slice(-3).flatMap((x) => [{ role: "user", content: x.q }, { role: "assistant", content: x.a.text }]);
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
$("sugs").addEventListener("click", (e) => { const b = e.target.closest(".sug"); if (b) send(b.dataset.q); });
$("threads").addEventListener("click", (e) => { const b = e.target.closest(".t"); if (b) openThread(b.dataset.t); });
$("chatSearch").addEventListener("input", renderThreads);
$("newChat").addEventListener("click", newChat);
$("railChat").addEventListener("click", () => (current ? openThread(current) : newChat()));
for (const id of ["railTrade", "tradeBtnM"]) $(id).addEventListener("click", () => openTrade());
$("toggleSide").addEventListener("click", () => $("app").classList.toggle("noside"));
$("menuBtn").addEventListener("click", () => $("app").classList.toggle("noside"));
$("searchBtn").addEventListener("click", () => { $("app").classList.remove("noside"); $("chatSearch").focus(); });
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("app").classList.remove("noside"); $("chatSearch").focus(); } });
$("themeBtn").addEventListener("click", () => { const t = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = t; try { localStorage.setItem("ask2049_theme", t); } catch {} });
for (const id of ["credits", "payBtn", "railPay"]) $(id).addEventListener("click", () => openPay());
for (const id of ["agentPill", "railAgent"]) $(id).addEventListener("click", () => { $("agent").hidden = false; });
document.querySelectorAll(".sheet").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s || e.target.closest("[data-close]")) s.hidden = true; }));
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
    .then((p) => { p.subscribe((s) => { renderAccount(s); tradeMod?.privyChanged(s); }); return p; })
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
  const shared = new URLSearchParams(location.search).get("s");
  if (shared && /^[0-9a-f]{12}$/.test(shared)) openShared(shared);
});
