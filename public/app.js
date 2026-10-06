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
    $("cardPayText").textContent = p.solana || p.cardano
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
  const [n, unit] = s.freeLeft > 0 ? [s.freeLeft, ` free ask${s.freeLeft === 1 ? "" : "s"}`] : [s.credits, ` credit${s.credits === 1 ? "" : "s"}`];
  $("creditsText").innerHTML = `${n}<span class="unit">${unit}</span>`;
  $("credits").title = `${n}${unit}`;
}
function setTitle() {
  const t = threads.find((x) => x.id === current);
  $("title").textContent = t ? t.title : "";
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
  a.innerHTML = `<div class="av">${mascot()}</div><div class="bbody"><div class="pills"></div><ul class="steps"></ul><div class="md"></div><div class="srcs" hidden></div><div class="meta"></div></div>`;
  $("thread").append(q, a);
  return { root: a, pills: a.querySelector(".pills"), steps: a.querySelector(".steps"), body: a.querySelector(".md"), srcs: a.querySelector(".srcs"), meta: a.querySelector(".meta") };
}
const shortId = (s) => (s && s.length > 14 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s ?? "");
const stepHtml = (e) => `<span class="via">${esc(e.via)}</span><span class="lbl">${esc(e.label)}</span><span class="det">${esc(e.summary ?? shortId(e.detail))}</span>${e.ms != null ? `<span class="ms">${(e.ms / 1000).toFixed(1)}s</span>` : ""}`;

const KIND = { account: "W", tx: "T", token: "$", "ada-address": "A", "ada-tx": "T", index: "C" };
function paintAnswer(el, a, collapsed) {
  el.body.innerHTML = md(a.text);
  el.steps.innerHTML = (a.steps ?? []).map((s) => `<li class="${s.ok ? "" : "bad"}">${stepHtml(s)}</li>`).join("");
  el.steps.hidden = collapsed;
  const n = a.sources?.length ?? 0;
  el.srcs.innerHTML = (a.sources ?? []).map((s) => s.url ? `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>` : `<span class="src">${esc(s.label)}</span>`).join("");
  el.pills.innerHTML = `<button type="button" class="pill work"><i class="ok">${icon("check")}</i>Work complete in ${(a.elapsedMs / 1000).toFixed(1)}s<i>${icon("chev-d")}</i></button>`
    + (n ? `<button type="button" class="pill srcp"><span class="dots">${[...new Set((a.sources ?? []).map((s) => KIND[s.kind] ?? "•"))].slice(0, 3).map((k) => `<b>${k}</b>`).join("")}</span>${n} Source${n === 1 ? "" : "s"}</button>` : "");
  el.pills.querySelector(".work").onclick = () => { el.steps.hidden = !el.steps.hidden; };
  const sp = el.pills.querySelector(".srcp"); if (sp) sp.onclick = () => { el.srcs.hidden = !el.srcs.hidden; };
  el.meta.textContent = `${(a.steps ?? []).length} lookup${(a.steps ?? []).length === 1 ? "" : "s"}`;
  el.root.querySelector(".swapcards")?.remove();
  if (a.swaps?.length) {
    const box = document.createElement("div"); box.className = "swapcards";
    box.innerHTML = a.swaps.map((c, i) => `<div class="swapc"><div class="t">Swap ${esc(c.amount)} ${esc(c.tokenIn?.symbol)} for ${esc(c.tokenOut?.symbol)}<small>${esc(CHAIN_NAMES[c.chain] ?? c.chain)} · review and sign in your own wallet</small></div><button type="button" data-i="${i}">Review swap</button></div>`).join("");
    box.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) openTrade(a.swaps[Number(b.dataset.i)]); });
    el.body.after(box);
  }
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
  el.pills.innerHTML = `<span class="pill"><i class="spin">${icon("spin")}</i><span class="wl">Working…</span></span>`;
  el.body.innerHTML = "";
  $("scroller").scrollTop = $("scroller").scrollHeight;
  const running = new Map();
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
        if (ev === "status") {
          const li = document.createElement("li"); li.className = "run"; li.innerHTML = stepHtml({ ...e, summary: shortId(e.detail) });
          el.steps.append(li); running.set(`${e.tool}:${e.detail}`, li);
          el.pills.querySelector(".wl").textContent = e.label + "…";
        } else if (ev === "step") {
          const li = running.get(`${e.tool}:${e.detail}`) ?? el.steps.appendChild(document.createElement("li"));
          li.className = e.ok ? "" : "bad"; li.innerHTML = stepHtml(e);
          el.pills.querySelector(".wl").textContent = "Writing the answer…";
        } else if (ev === "answer") {
          turn.a = { text: e.text, sources: e.sources, steps: e.steps, elapsedMs: e.elapsedMs, swaps: e.swaps ?? [] };
          paintAnswer(el, turn.a, true); buildToc(); credits(e.session);
        } else if (ev === "error") {
          turn.err = e.message; el.pills.innerHTML = ""; el.body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
        } else if (ev === "done") {
          credits(e.session);
        }
      }
    }
  } catch (err) {
    turn.err = `Connection lost: ${err.message}`; el.pills.innerHTML = ""; el.body.innerHTML = `<p class="err">${esc(turn.err)}</p>`;
  } finally {
    busy = false; saveThreads(); renderThreads();
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
  try {
    const p = await loadPrivy();
    await p.whenReady();
    if (p.state.authenticated) $("account").hidden = false; else p.login();
  } catch (e) {
    $("acctEmail").textContent = ""; $("acctWallets").innerHTML = "";
    $("acctMsg").className = "msg bad"; $("acctMsg").textContent = e?.message ?? String(e);
    $("signOutBtn").hidden = true; $("account").hidden = false;
  } finally { btn.disabled = false; }
}
$("signInBtn").addEventListener("click", () => { $("signOutBtn").hidden = false; $("acctMsg").className = "msg"; signIn(); });
$("signOutBtn").addEventListener("click", async () => { await window.askPrivy?.logout().catch(() => {}); $("account").hidden = true; });
$("acctWallets").addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; }); });

if (matchMedia("(max-width: 900px)").matches) $("app").classList.add("noside");
boot().then(async () => {
  tradeMod = await import(`./trade.js${VER}`);
  await tradeMod.initTrade({ icon: (n) => iconTag(n), showView, loadPrivy, privyConfigured: () => !!cfg?.privy });
  if (window.askPrivy) tradeMod.privyChanged(window.askPrivy.state);
  if (location.hash === "#trade") openTrade();
});
