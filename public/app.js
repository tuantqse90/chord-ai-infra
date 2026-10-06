// The page: one composer, a live list of lookups per answer, sources that open the explorer, and a pay sheet.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SESSION = (() => {
  try {
    let s = localStorage.getItem("ask2049_session");
    if (!s) { s = "web:" + crypto.randomUUID(); localStorage.setItem("ask2049_session", s); }
    return s;
  } catch { return "web:" + crypto.randomUUID(); }
})();
const history = [];
let cfg = null;
let busy = false;

const EXAMPLES = [
  ["Solana wallet", "What does wallet 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9 hold, and what did it do recently?"],
  ["Transaction", "Explain Solana transaction 5zpWe5sy5Ph1pyK9tuUc1eQ2B933UjgqpBf29XyPzk4wq4mNyi1r9xyd3FDLoTnaUv9kwSieu7RrwBLCSQ1nJ3Tf"],
  ["Token", "Who holds BONK (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263)? Is supply concentrated?"],
  ["Market", "What traded most on Solana in the last 24 hours?"],
];

function credits(s) {
  if (!s) return;
  $("credits").textContent = s.freeLeft > 0 ? `${s.freeLeft} free ask${s.freeLeft === 1 ? "" : "s"}` : `${s.credits} credit${s.credits === 1 ? "" : "s"}`;
}

async function boot() {
  cfg = await fetch("/v1/config").then((r) => r.json()).catch(() => null);
  if (cfg) {
    $("appName").textContent = `${cfg.appName} Ask`;
    document.title = `${cfg.appName} Ask`;
    const live = cfg.nownodes.solana;
    $("infra").classList.toggle("live", live);
    $("infraText").textContent = live ? `NOWNodes · ${cfg.nownodes.solanaEndpoint}` : `RPC · ${cfg.nownodes.solanaEndpoint}`;
  }
  credits(await fetch("/v1/session", { headers: { "X-Session": SESSION } }).then((r) => r.json()).catch(() => null));
  $("chips").innerHTML = EXAMPLES.filter(([k]) => k !== "Market" || cfg?.databases?.solana).map(([k, q]) => `<button class="chip" type="button" data-q="${esc(q)}"><small>${esc(k)}</small>${esc(q)}</button>`).join("");
  $("chips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) { $("q").value = b.dataset.q; send(); } });
}

// Small markdown: headings, bullets, pipe tables, bold, inline code. Escaped first, so model text never becomes HTML.
function md(text) {
  const lines = esc(text).split("\n");
  const out = [];
  let list = null, table = null;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const flush = () => {
    if (list) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = null; }
    if (table) {
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => inline(c.trim())));
      const [head, ...body] = rows;
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      table = null;
    }
  };
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) { if (list) flush(); (table ??= []).push(l); continue; }
    if (/^\s*[-*•]\s+/.test(l)) { if (table) flush(); (list ??= []).push(l.replace(/^\s*[-*•]\s+/, "")); continue; }
    flush();
    if (/^#{1,4}\s+/.test(l)) out.push(`<h3>${inline(l.replace(/^#{1,4}\s+/, ""))}</h3>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  flush();
  return out.join("");
}

function turnEls(question) {
  $("hero")?.remove();
  const q = document.createElement("div"); q.className = "q"; q.innerHTML = `<div>${esc(question)}</div>`;
  const a = document.createElement("div"); a.className = "a";
  a.innerHTML = `<ul class="steps"></ul><div class="body"></div><div class="srcs"></div><div class="meta"></div>`;
  $("thread").append(q, a);
  return { steps: a.querySelector(".steps"), body: a.querySelector(".body"), srcs: a.querySelector(".srcs"), meta: a.querySelector(".meta") };
}

const shortId = (s) => (s && s.length > 14 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s ?? "");

async function send() {
  const question = $("q").value.trim();
  if (!question || busy) return;
  busy = true; $("send").disabled = true; $("q").value = "";
  const el = turnEls(question);
  el.body.innerHTML = `<p class="muted">Thinking…</p>`;
  const running = new Map();
  try {
    const res = await fetch("/v1/ask", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SESSION }, body: JSON.stringify({ question, history }) });
    if (res.status === 402) { const j = await res.json(); el.body.innerHTML = `<p>${esc(j.message)}.</p>`; credits(j.session); openPay(j.pay); return; }
    if (!res.ok || !res.body) { el.body.innerHTML = `<p class="err">Request failed (${res.status}).</p>`; return; }
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
          const li = document.createElement("li"); li.className = "run";
          li.innerHTML = `<span class="via">${esc(e.via)}</span><span class="lbl">${esc(e.label)}</span><span class="det">${esc(shortId(e.detail))}</span>`;
          el.steps.append(li); running.set(`${e.tool}:${e.detail}`, li); el.body.innerHTML = "";
        } else if (ev === "step") {
          const li = running.get(`${e.tool}:${e.detail}`) ?? el.steps.appendChild(document.createElement("li"));
          li.className = e.ok ? "" : "bad";
          li.innerHTML = `<span class="via">${esc(e.via)}</span><span class="lbl">${esc(e.label)}</span><span class="det">${esc(e.summary)}</span><span class="ms">${(e.ms / 1000).toFixed(1)}s</span>`;
        } else if (ev === "answer") {
          el.body.innerHTML = md(e.text);
          el.srcs.innerHTML = e.sources.map((s) => s.url ? `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>` : `<span class="src">${esc(s.label)}</span>`).join("");
          el.meta.textContent = `${e.steps.length} lookup${e.steps.length === 1 ? "" : "s"} · ${(e.elapsedMs / 1000).toFixed(1)}s`;
          history.push({ role: "user", content: question }, { role: "assistant", content: e.text });
          credits(e.session);
        } else if (ev === "error") {
          el.body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
        } else if (ev === "done") {
          credits(e.session);
        }
      }
    }
  } catch (err) {
    el.body.innerHTML = `<p class="err">Connection lost: ${esc(err.message)}</p>`;
  } finally {
    busy = false; $("send").disabled = false; $("q").focus();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
}

function openPay(pay) {
  const p = pay ?? cfg?.pay ?? {};
  const opt = (name, o, unit) => o ? `<div class="opt"><b>${esc(o.price)} ${esc(unit)} on ${name}</b> per ask
      <div class="addr"><span>${esc(o.treasury)}</span><button type="button" data-copy="${esc(o.treasury)}">Copy</button></div></div>` : "";
  const html = opt("Solana", p.solana, "USDC") + opt("Cardano", p.cardano, "ADA");
  $("payOptions").innerHTML = html || `<p class="muted">Payments are not set up on this server yet.</p>`;
  $("payMsg").textContent = ""; $("payMsg").className = "msg";
  $("pay").hidden = false;
}
$("payOptions").addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; }); });
$("payClose").addEventListener("click", () => { $("pay").hidden = true; });
$("credits").addEventListener("click", () => openPay());
$("payGo").addEventListener("click", async () => {
  const ref = $("payRef").value.trim(); if (!ref) return;
  $("payMsg").className = "msg"; $("payMsg").textContent = "Checking on-chain through NOWNodes…";
  const r = await fetch("/v1/pay", { method: "POST", headers: { "Content-Type": "application/json", "X-Session": SESSION }, body: JSON.stringify({ chain: $("payChain").value, ref }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { $("payMsg").className = "msg ok"; $("payMsg").textContent = `Verified: ${j.paid} ${j.asset}, ${j.credits} ask${j.credits === 1 ? "" : "s"} added.`; credits(j.session); }
  else { $("payMsg").className = "msg bad"; $("payMsg").textContent = j.message ?? `Rejected (${r.status}).`; }
});

$("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("q").addEventListener("input", () => { const t = $("q"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; });
boot();
