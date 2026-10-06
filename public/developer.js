// Developer console (Chord's /developer layout): signed out = the pitch, a sign-in with the Chord account and one live call;
// signed in = Overview · API keys · Usage · Account. The API reference is open to everyone. Keys are created and revoked
// through /v1/dev/* with the person's Privy access token; a new key is shown once.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ORIGIN = location.origin;
const VER = new URL(import.meta.url).search;
const root = $("dev");
const MARK = root.dataset.mark;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL = "So11111111111111111111111111111111111111112";

let cfg = null, privy = null, pstate = null, account = null, accountErr = null, fresh = null;
const TABS = [["overview", "Overview", "/developer"], ["keys", "API keys", "/developer/keys"], ["usage", "Usage", "/developer/usage"], ["account", "Account", "/developer/account"], ["reference", "Reference", "/developer/reference"]];
const tabOf = () => (TABS.find(([, , p]) => p === location.pathname.replace(/\/$/, "")) ?? TABS[0])[0];
const go = (path) => { history.pushState(null, "", path); render(); };
const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
const ago = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── data ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function token() { return privy?.state.authenticated ? privy.accessToken() : null; }
async function dev(path, init = {}) {
  const t = await token();
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
  return j;
}
async function loadAccount() {
  try { account = await dev("/v1/dev/account"); accountErr = null; } catch (e) { account = null; accountErr = e.message; }
  render();
}
async function loadPrivy() {
  if (!cfg?.privy) return null;
  if (privy) return privy;
  const m = await import(`/privy/privy.js${VER}`);
  privy = await m.mount({ appId: cfg.privy.appId, clientId: cfg.privy.clientId, dark: document.documentElement.dataset.theme !== "light" });
  privy.subscribe((s) => {
    const was = pstate?.authenticated;
    pstate = s;
    if (s.authenticated && !was) loadAccount();
    if (!s.authenticated && was) { account = null; render(); }
    else render();
  });
  return privy;
}
async function signIn() {
  const b = $("signin"); if (b) { b.disabled = true; b.textContent = "Loading…"; }
  try { const p = await loadPrivy(); await p.whenReady(); if (!p.state.authenticated) p.login(); }
  catch (e) { const m = $("signinMsg"); if (m) m.textContent = e.message; }
  finally { if (b) { b.disabled = false; b.textContent = "Sign in with your Chord account"; } }
}

// ── pieces ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const code = (s) => `<pre class="dcode"><button class="dcopy" type="button" data-copy="${esc(s)}">Copy</button>${esc(s)}</pre>`;
function curlAsk(key) {
  return `curl -N ${ORIGIN}/v1/ask \\
  -H 'Authorization: Bearer ${key}' \\
  -H 'Content-Type: application/json' \\
  -d '{"question":"What is trending on Solana DEXes right now?"}'`;
}
function jsAsk(key) {
  return `const res = await fetch("${ORIGIN}/v1/ask", {
  method: "POST",
  headers: { Authorization: "Bearer ${key}", "Content-Type": "application/json" },
  body: JSON.stringify({ question: "BTC funding and open interest today?" }),
});
// server-sent events: status, step, thinking, draft, answer, done
for await (const chunk of res.body) process.stdout.write(new TextDecoder().decode(chunk));`;
}
function pyAsk(key) {
  return `import requests, json
r = requests.post("${ORIGIN}/v1/ask", stream=True,
    headers={"Authorization": "Bearer ${key}"},
    json={"question": "Who holds BONK, and is supply concentrated?"})
for line in r.iter_lines():
    if line.startswith(b"data:"):
        ev = json.loads(line[5:])
        if ev.get("type") == "answer": print(ev["text"])`;
}

function liveCard() {
  return `<section class="dlive">
    <div class="dlh"><b>What this server reads right now</b><span class="dok"><i></i>live</span></div>
    <div class="dstats" id="liveStats"><div><small>Tools</small><b>…</b></div><div><small>Chains</small><b>…</b></div><div><small>Model</small><b>…</b></div></div>
    <p class="dsub">The same call your key would make, answered live:</p>
    <div class="dresp"><div class="drh"><span><b>GET</b> ${esc(ORIGIN)}/v1/trade/quote?chain=solana&amp;in=USDC&amp;out=SOL&amp;amount=5</span><span id="liveStatus">…</span></div><pre id="liveJson">Loading…</pre></div>
    <div class="dplans">
      <div><b>Free</b><small>${cfg?.pay?.unlimited ? "unlimited asks right now" : `${cfg?.pay?.freeAsks ?? 0} asks per session`}</small></div>
      <div><b>Pay per ask</b><small>${cfg?.pay?.solana ? `${cfg.pay.solana.price} USDC` : "0.1 USDC"} · ${cfg?.pay?.cardano ? `${cfg.pay.cardano.price} ADA` : "0.5 ADA"}</small></div>
      <div><b>Agents</b><small>X-Payment, per call, on-chain</small></div>
    </div>
  </section>`;
}
async function fillLive() {
  if (!$("liveJson")) return;
  const tools = cfg?.tools?.length ?? 0;
  const chains = 2 + (cfg?.indexChains?.filter((c) => c !== "solana").length ?? 0);
  $("liveStats").innerHTML = `<div><small>Tools</small><b>${fmt(tools)}</b></div><div><small>Chains</small><b>${chains}</b></div><div><small>Data sources</small><b>${new Set((cfg?.tools ?? []).map((t) => t.via)).size}</b></div>`;
  const t0 = performance.now();
  const r = await fetch(`/v1/trade/quote?chain=solana&in=${USDC}&out=${SOL}&amount=5&slippageBps=50`).catch(() => null);
  const ms = Math.round(performance.now() - t0);
  const j = r ? await r.json().catch(() => ({})) : { error: "connection lost" };
  if (!$("liveJson")) return;
  $("liveStatus").innerHTML = `<b class="${r?.ok ? "ok" : "bad"}">${r?.status ?? "—"} ${r?.ok ? "OK" : ""}</b> ${ms} ms`;
  const show = r?.ok ? { provider: j.provider, amountIn: j.amountIn, tokenIn: j.tokenIn?.symbol, amountOut: j.amountOut, tokenOut: j.tokenOut?.symbol, minAmountOut: j.minAmountOut, priceImpactPct: j.priceImpactPct, route: j.route, slippageBps: j.slippageBps, quoteId: j.quoteId } : j;
  $("liveJson").textContent = JSON.stringify(show, null, 2);
}

function signedOut() {
  return `<div class="dhero">
    <section class="dpitch">
      <span class="dmark">${MARK}</span>
      <h1>Developer<br>console</h1>
      <p class="dlead">One key, every endpoint. Sign in with your Chord account, create a key, and your first call is one curl away. ${cfg?.pay?.unlimited ? "Asks are unlimited while the hackathon runs." : ""}</p>
      ${cfg?.privy ? `<button class="dprimary" id="signin" type="button">Sign in with your Chord account</button><p class="dfine" id="signinMsg">Email sign-in, the same account as getchord.xyz. No card, no forms.</p>` : `<p class="dfine">Sign-in is not set up on this server; every endpoint still answers with X-Session or X-Payment.</p>`}
      <div class="dfacts">
        <div><b>${cfg?.pay?.unlimited ? "Unlimited" : "Free asks"}</b><span>${cfg?.pay?.unlimited ? "Every ask is free right now, keyed or not" : `${cfg?.pay?.freeAsks ?? 0} per session, then pay per ask`}</span></div>
        <div><b>No key needed</b><span>Send X-Session, or pay per call with X-Payment: a USDC or ADA transfer, checked on-chain</span></div>
        <div><b>Your wallet</b><span>Swaps come back as transactions you sign. We never hold funds</span></div>
      </div>
      <p class="dmore">Just reading? The <a href="/developer/reference" data-nav>API reference</a> needs no account.</p>
    </section>
    ${liveCard()}
  </div>`;
}

function sidebar(tab) {
  return `<aside class="dside">${TABS.map(([id, label, path]) => `<a href="${path}" data-nav class="${id === tab ? "on" : ""}">${label}</a>`).join("")}
    <div class="dwho"><small>Signed in</small><b>${esc(pstate?.email ?? "Chord account")}</b><button type="button" id="signout">Sign out</button></div></aside>`;
}
function stat(label, value, sub = "") { return `<div class="dstat"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ""}</div>`; }

function overview() {
  const a = account;
  const k = a?.keys?.[0];
  return `<h1>Overview</h1>
    <div class="dstatrow">${stat("Asks today", fmt(a?.usage?.today))}${stat("Asks, 30 days", fmt(a?.usage?.month))}${stat("Live keys", `${a?.keys?.length ?? 0}<small> / ${a?.limits?.maxKeys ?? 5}</small>`)}${stat("Plan", esc(a?.plan?.label ?? "…"), esc(a?.plan?.note ?? ""))}</div>
    <h2>Your first call</h2>
    <p class="dmuted">${k ? `Use the key you saved when you created <b>${esc(k.label)}</b> (${esc(k.masked)}). Keys are shown once; lost one? Create a new one and revoke the old.` : `Create a key on the <a href="/developer/keys" data-nav>API keys</a> tab, then:`}</p>
    <div class="dtabs" data-snip><button type="button" class="on" data-s="curl">curl</button><button type="button" data-s="js">JavaScript</button><button type="button" data-s="py">Python</button></div>
    <div id="snip">${code(curlAsk("ak_live_…"))}</div>
    <h2>Limits</h2>
    <p class="dmuted">${a?.limits?.rpm ?? 60} requests a minute per key, ${a?.limits?.maxKeys ?? 5} live keys per account. Every lookup the answer made comes back in the stream with its source.</p>`;
}
function keysTab() {
  const ks = account?.keys ?? [];
  return `<div class="dhead"><h1>API keys</h1><button class="dprimary sm" id="newKey" type="button"${ks.length >= (account?.limits?.maxKeys ?? 5) ? " disabled" : ""}>Create key</button></div>
    ${fresh ? `<div class="dfresh"><b>Your new key: ${esc(fresh.label)}</b><p>Copy it now. It is shown once; we only keep a hash.</p>${code(fresh.key)}</div>` : ""}
    ${ks.length ? `<div class="dtable"><table><tr><th>Label</th><th>Key</th><th>Created</th><th class="r">Today</th><th class="r">30 days</th><th></th></tr>${ks.map((k) => `<tr><td>${esc(k.label)}</td><td class="mono">${esc(k.masked)}</td><td>${ago(k.created)}</td><td class="r">${fmt(k.today)}</td><td class="r">${fmt(k.usage30d)}</td><td class="r"><button class="dlink" type="button" data-revoke="${esc(k.id)}">Revoke</button></td></tr>`).join("")}</table></div>` : `<p class="dmuted">No keys yet. A key works on every endpoint: send it as <code>Authorization: Bearer …</code> or <code>X-API-Key</code>.</p>`}
    <div class="dmodal" id="keyModal" hidden><div class="dcard"><h2>Create an API key</h2><label>Label<input id="keyLabel" maxlength="40" placeholder="e.g. trading bot" autocomplete="off"></label><p class="dmsg" id="keyMsg"></p><div class="drow"><button type="button" class="dghost" data-close>Cancel</button><button type="button" class="dprimary sm" id="keyCreate">Create</button></div></div></div>`;
}
function usageTab() {
  const days = account?.days ?? [];
  const max = Math.max(1, ...days.map((d) => d.n));
  const W = 720, H = 180, bw = W / Math.max(1, days.length);
  const bars = days.map((d, i) => `<rect x="${(i * bw + 2).toFixed(1)}" y="${(H - 20 - (d.n / max) * (H - 34)).toFixed(1)}" width="${Math.max(2, bw - 4).toFixed(1)}" height="${Math.max(d.n ? 2 : 0, (d.n / max) * (H - 34)).toFixed(1)}" rx="2"><title>${d.day}: ${d.n}</title></rect>`).join("");
  const labels = days.length ? `<text x="2" y="${H - 4}">${days[0].day}</text><text x="${W - 2}" y="${H - 4}" text-anchor="end">${days[days.length - 1].day}</text>` : "";
  return `<h1>Usage</h1><div class="dstatrow">${stat("Asks today", fmt(account?.usage?.today))}${stat("Asks, 30 days", fmt(account?.usage?.month))}</div>
    <div class="dchart"><div class="vh">Asks per day, all keys</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${labels}</svg></div>
    ${(account?.keys ?? []).length ? `<div class="dtable"><table><tr><th>Key</th><th class="r">Today</th><th class="r">30 days</th></tr>${account.keys.map((k) => `<tr><td>${esc(k.label)} <span class="mono dmuted">${esc(k.masked)}</span></td><td class="r">${fmt(k.today)}</td><td class="r">${fmt(k.usage30d)}</td></tr>`).join("")}</table></div>` : ""}`;
}
function accountTab() {
  const s = pstate ?? {};
  const row = (k, v) => `<div class="dkv"><small>${k}</small><span class="mono">${v ? esc(v) : "—"}</span></div>`;
  return `<h1>Account</h1><div class="dpanel">${row("Email", s.email)}${row("Account id", account?.owner)}${row("EVM wallet", s.evm)}${row("Solana wallet", s.sol)}${row("Plan", account?.plan ? `${account.plan.label} · ${account.plan.note}` : null)}</div>
    <p class="dmuted">The same Chord account and wallet as getchord.xyz/ask. Keys stay with Privy; this site never sees them.</p>`;
}

// ── reference (open to everyone) ─────────────────────────────────────────────────────────────────────────────────────
const REF = [
  ["Ask", [
    ["POST", "/v1/ask", "The analyst. Body { question, history? }. Answers as server-sent events: status and step for each lookup (with its source), thinking, draft (the answer as it is written), answer (text, sources, follow-ups, charts, price chips), done. Auth: Authorization: Bearer <key>, or X-Session, or X-Payment: solana:<signature> | cardano:<txhash>.", null],
    ["GET", "/v1/suggest?cat=crypto", "Suggested questions from live data. cat: crypto, macro, stocks, trending, solana, picks, tokens, holders, wallets, trade, chains, payments, chord.", "/v1/suggest?cat=crypto"],
    ["GET", "/v1/config", "What this server runs: tools and their sources, chains, payment terms.", "/v1/config"],
    ["GET", "/v1/session", "Free asks and credits left on a session. Header X-Session.", null],
    ["POST", "/v1/pay", "Redeem a payment for credits. Body { chain: solana | cardano, ref }. Each transaction counts once.", null],
  ]],
  ["Trade", [
    ["GET", "/v1/trade/chains", "Swap chains: Solana (Jupiter) and Base, BNB Chain, Avalanche, Monad, Robinhood Chain, Arc (Chord's router).", "/v1/trade/chains"],
    ["GET", "/v1/trade/tokens?chain=base&q=usdc", "Token list for a chain; q searches symbol, name or address.", "/v1/trade/tokens?chain=base&q=usdc"],
    ["GET", "/v1/trade/quote?chain=solana&in=…&out=…&amount=5", "Best route. amount in whole tokens; slippageBps (default 50). On EVM chains add taker=<wallet> to get the unsigned transaction, the approval to send first and a simulation from that wallet.", `/v1/trade/quote?chain=solana&in=${USDC}&out=${SOL}&amount=5&slippageBps=50`],
    ["POST", "/v1/trade/sol/build", "Solana: turn a quote into a transaction for a wallet. Body { quoteId, user }. Sign it in the wallet.", null],
    ["POST", "/v1/trade/sol/send", "Solana: relay a signed transaction. Only transactions this server built are accepted. Body { transaction } (base64).", null],
    ["GET", "/v1/trade/sol/status?sig=…", "Solana: confirmation status of a sent swap.", null],
  ]],
  ["Chats", [
    ["POST", "/v1/share", "Store a chat for a public link. Body { title, turns }. Returns { id, url }.", null],
    ["GET", "/v1/share/:id", "A shared chat.", null],
    ["POST", "/v1/feedback", "Rate an answer. Body { question, rating: up | down }. Header X-Session.", null],
  ]],
  ["Developer", [
    ["GET", "/v1/dev/account", "Your plan, usage and keys. Authorization: Bearer <Privy access token>.", null],
    ["POST", "/v1/dev/keys", "Create a key. Body { label }. The key is in this answer only.", null],
    ["DELETE", "/v1/dev/keys/:id", "Revoke a key.", null],
    ["GET", "/v1/status", "RPC calls this server made, by provider and method, and payment totals.", "/v1/status"],
  ]],
];
function reference() {
  return `<h1>API reference</h1><p class="dmuted">Base URL <code>${esc(ORIGIN)}</code>. JSON in, JSON out; /v1/ask streams server-sent events. Every read answers without a key.</p>
    ${REF.map(([group, eps]) => `<h2>${group}</h2>${eps.map(([m, p, d, tryPath], i) => `<div class="dep"><div class="deph"><span class="dm ${m.toLowerCase()}">${m}</span><code>${esc(p)}</code>${tryPath ? `<button class="dghost sm" type="button" data-try="${esc(tryPath)}">Try</button>` : ""}</div><p>${esc(d)}</p><pre class="dtry" hidden></pre></div>`).join("")}`).join("")}`;
}

// ── render ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function render() {
  const tab = tabOf();
  const signedIn = !!pstate?.authenticated;
  document.title = `${tab === "reference" ? "API reference" : "Developer console"} · Chord Ask`;
  if (tab === "reference" && !signedIn) {
    root.innerHTML = `<div class="dconsole open"><aside class="dside">${TABS.filter(([id]) => id === "reference").map(([, l, p]) => `<a href="${p}" data-nav class="on">${l}</a>`).join("")}<a href="/developer" data-nav>Get a key</a></aside><section class="dmain">${reference()}</section></div>`;
    return;
  }
  if (!signedIn) { root.innerHTML = signedOut(); fillLive(); return; }
  const body = accountErr ? `<h1>Console</h1><p class="dmsg bad">${esc(accountErr)}</p><button class="dghost" type="button" id="retry">Try again</button>`
    : !account && tab !== "reference" ? `<p class="dmuted">Loading your account…</p>`
    : tab === "keys" ? keysTab() : tab === "usage" ? usageTab() : tab === "account" ? accountTab() : tab === "reference" ? reference() : overview();
  root.innerHTML = `<div class="dconsole">${sidebar(tab)}<section class="dmain">${body}</section></div>`;
  if (tab === "usage" && account && !account.days) dev("/v1/dev/usage").then((u) => { account.days = u.days; render(); }).catch(() => {});
}

document.addEventListener("click", async (e) => {
  const nav = e.target.closest("a[data-nav]");
  if (nav && nav.origin === location.origin) { e.preventDefault(); go(nav.pathname); return; }
  const t = e.target;
  if (t.id === "signin") return signIn();
  if (t.id === "signout") { await privy?.logout().catch(() => {}); go("/developer"); return; }
  if (t.id === "retry") return loadAccount();
  if (t.closest("[data-copy]")) { const b = t.closest("[data-copy]"); await navigator.clipboard?.writeText(b.dataset.copy).catch(() => {}); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); return; }
  if (t.closest("[data-snip]") && t.dataset.s) {
    t.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === t));
    const key = "ak_live_…";
    $("snip").innerHTML = code(t.dataset.s === "js" ? jsAsk(key) : t.dataset.s === "py" ? pyAsk(key) : curlAsk(key));
    return;
  }
  if (t.id === "newKey") { $("keyModal").hidden = false; $("keyLabel").focus(); return; }
  if (t.closest("[data-close]") || t.id === "keyModal") { $("keyModal").hidden = true; return; }
  if (t.id === "keyCreate") {
    t.disabled = true;
    try { fresh = await dev("/v1/dev/keys", { method: "POST", body: JSON.stringify({ label: $("keyLabel").value }) }); account = null; await loadAccount(); }
    catch (err) { $("keyMsg").textContent = err.message; t.disabled = false; }
    return;
  }
  if (t.dataset.revoke) {
    if (!confirm("Revoke this key? Calls with it stop working right away.")) return;
    try { await dev(`/v1/dev/keys/${encodeURIComponent(t.dataset.revoke)}`, { method: "DELETE" }); fresh = null; await loadAccount(); } catch (err) { alert(err.message); }
    return;
  }
  if (t.dataset.try) {
    const pre = t.closest(".dep").querySelector(".dtry");
    pre.hidden = false; pre.textContent = "…";
    const t0 = performance.now();
    const r = await fetch(t.dataset.try).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    pre.textContent = `${r?.status ?? "—"} · ${Math.round(performance.now() - t0)} ms\n\n${JSON.stringify(j, null, 2).slice(0, 4000)}`;
  }
});
window.addEventListener("popstate", render);
$("themeBtn").addEventListener("click", () => { const n = document.documentElement.dataset.theme === "light" ? "dark" : "light"; document.documentElement.dataset.theme = n; try { localStorage.setItem("ask2049_theme", n); } catch {} });

(async () => {
  cfg = await fetch("/v1/config").then((r) => r.json()).catch(() => null);
  render();
  // A Privy session already in this browser: restore it without a click.
  try { if (cfg?.privy && Object.keys(localStorage).some((k) => k.startsWith("privy:"))) await loadPrivy(); } catch {}
})();
