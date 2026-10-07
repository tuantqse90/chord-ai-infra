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
// Syntax colours, kept to what helps reading: comments, strings, flags and variables (shell); comments, strings and numbers
// (JavaScript, Python); keys, strings, numbers and literals (JSON). Text is escaped piece by piece.
const HL = {
  sh: /((?:^|(?<=\s))#[^\n]*)|('[^'\n]*'|"(?:[^"\\\n]|\\.)*")|((?<=\s)--?[A-Za-z][\w-]*)|(\$\([^)\n]*\)|\$[A-Za-z_]\w*)/gm,
  js: /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|()(\b\d+(?:\.\d+)?\b)/gm,
  py: /((?:^|(?<=\s))#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|()(\b\d+(?:\.\d+)?\b)/gm,
};
const CLS = ["c-com", "c-str", "c-flag", "c-var"];
function hl(src, lang) {
  const text = String(src ?? "");
  if (lang === "json") return esc(text).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g, (m, str, colon, lit, num) => str ? `<span class="${colon ? "c-key" : "c-str"}">${str}</span>${colon ?? ""}` : lit ? `<span class="c-lit">${lit}</span>` : `<span class="c-num">${num}</span>`);
  const re = HL[lang]; if (!re) return esc(text);
  let out = "", at = 0;
  for (const m of text.matchAll(re)) {
    const k = m.slice(1).findIndex((g) => g); if (k < 0 || !m[0]) continue;
    out += esc(text.slice(at, m.index)) + `<span class="${lang === "sh" ? CLS[k] : k === 3 ? "c-num" : CLS[k]}">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return out + esc(text.slice(at));
}
const LANG = { sh: "Shell", js: "JavaScript", py: "Python", json: "JSON" };
const code = (s, lang = "sh", title = LANG[lang]) => `<div class="dblock"><div class="dbh"><span>${esc(title)}</span><button class="dcopy" type="button" data-copy="${esc(s)}">Copy</button></div><pre class="dcode">${hl(s, lang)}</pre></div>`;
const STATUS = { 200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Unavailable", 504: "Timeout" };
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
/** A framed answer: method and path, HTTP status, time and size, Copy, then the JSON. */
function respPanel(method, path, { status, ms, bytes, body } = {}) {
  const ok = status >= 200 && status < 300;
  const head = status == null ? `<span class="d-sk" style="width:64px"></span><span class="d-sk" style="width:44px"></span>`
    : `<b class="dst ${ok ? "ok" : "bad"}">${status || "No answer"}${status ? ` ${STATUS[status] ?? ""}` : ""}</b><span>${ms} ms</span>${bytes != null ? `<span>${kb(bytes)}</span>` : ""}`;
  const copy = body != null ? `<button class="dcopy" type="button" data-copy="${esc(body)}">Copy</button>` : "";
  const pre = body == null ? `<div class="dres-sk"><span class="d-sk" style="width:38%"></span><span class="d-sk" style="width:62%"></span><span class="d-sk" style="width:54%"></span><span class="d-sk" style="width:46%"></span></div>` : `<pre class="dres-b">${hl(body, "json")}</pre>`;
  return `<div class="dres"><div class="dres-h"><span class="dres-u"><span class="dm ${method.toLowerCase()}">${method}</span><code>${esc(path)}</code></span><span class="dres-m">${head}${copy}</span></div>${pre}</div>`;
}
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

/** the paid plans, only when this server really takes payments (not while asks are unlimited, not without a treasury) */
function payPlans() {
  const p = cfg?.pay ?? {};
  if (p.unlimited || !(p.solana || p.cardano)) return "";
  const prices = [p.solana && `${p.solana.price} USDC`, p.cardano && `${p.cardano.price} ADA`].filter(Boolean).join(" · ");
  return `<div><b>Pay per ask</b><small>${prices}</small></div><div><b>Agents</b><small>X-Payment, per call, on-chain</small></div>`;
}
function liveCard() {
  return `<section class="dlive">
    <div class="dlh"><b>What this server reads right now</b><span class="dok"><i></i>live</span></div>
    <div class="dstats" id="liveStats"><div><small>Tools</small><b><span class="d-sk" style="width:64px;height:26px"></span></b></div><div><small>Chains</small><b><span class="d-sk" style="width:30px;height:26px"></span></b></div><div><small>Data sources</small><b><span class="d-sk" style="width:44px;height:26px"></span></b></div></div>
    <p class="dsub">The same call your key would make, answered live:</p>
    <div id="liveResp">${respPanel("GET", LIVE_PATH)}</div>
    <div class="dplans">
      <div><b>Free</b><small>${cfg?.pay?.unlimited ? "unlimited asks right now" : `${cfg?.pay?.freeAsks ?? 0} asks per session`}</small></div>
      ${payPlans()}
    </div>
  </section>`;
}
const LIVE_PATH = `/v1/trade/quote?chain=solana&in=${USDC}&out=${SOL}&amount=5&slippageBps=50`;
async function fillLive() {
  if (!$("liveResp")) return;
  const tools = cfg?.tools?.length ?? 0;
  const chains = 2 + (cfg?.indexChains?.filter((c) => c !== "solana").length ?? 0);
  $("liveStats").innerHTML = `<div><small>Tools</small><b>${fmt(tools)}</b></div><div><small>Chains</small><b>${chains}</b></div><div><small>Data sources</small><b>${new Set((cfg?.tools ?? []).map((t) => t.via)).size}</b></div>`;
  const t0 = performance.now();
  const r = await fetch(LIVE_PATH).catch(() => null);
  const ms = Math.round(performance.now() - t0);
  const raw = r ? await r.text().catch(() => "") : "";
  let j; try { j = JSON.parse(raw); } catch { j = { error: r ? "not JSON" : "connection lost" }; }
  if (!$("liveResp")) return;
  const show = r?.ok ? { provider: j.provider, amountIn: j.amountIn, tokenIn: j.tokenIn?.symbol, amountOut: j.amountOut, tokenOut: j.tokenOut?.symbol, minAmountOut: j.minAmountOut, priceImpactPct: j.priceImpactPct, route: j.route, slippageBps: j.slippageBps, quoteId: j.quoteId } : j;
  $("liveResp").innerHTML = respPanel("GET", LIVE_PATH, { status: r?.status ?? 0, ms, bytes: new TextEncoder().encode(raw).length, body: JSON.stringify(show, null, 2) });
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
  return `<aside class="dside">${TABS.map(([id, label, path]) => `<a href="${path}" data-nav class="${id === tab ? "on" : ""}">${label}</a>${id === "reference" && tab === "reference" ? refIndex() : ""}`).join("")}
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
    ${fresh ? `<div class="dfresh"><b>Your new key: ${esc(fresh.label)}</b><p>Copy it now. It is shown once; we only keep a hash.</p>${code(fresh.key, "", "API key")}</div>` : ""}
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
  ["Agents", [
    ["GET", "/v1/agents/stats", "Every public agent right now: live count, paper trades and skips in 24 h, paper PnL, best agent, fastest reaction to a followed wallet.", "/v1/agents/stats"],
    ["GET", "/v1/agents/board?window=today", "The leaderboard: PnL in the window (today, 7d, all) and all-time, equity sparkline, win rate, copies, template. No owners.", "/v1/agents/board?window=today"],
    ["GET", "/v1/agents/feed", "Server-sent events: every public agent's buy, sell, skip (with the check that said no) and LP move as it happens, with the trigger in words and the reaction time. A 50-item backlog on connect.", null],
    ["GET", "/v1/agents/smart-now", "Tokens Solana smart traders bought in the last 15 minutes: wallets, dollars in, price move since the first buy.", "/v1/agents/smart-now"],
    ["GET", "/v1/agents/templates", "Ready strategies with their own 3-day replay (PnL, trades, win rate) and how many agents run each.", "/v1/agents/templates"],
    ["POST", "/v1/agents", "Start an agent (paper). Body { type: copy | alert | lp | custom, name?, params }. custom: params { strategy } from /v1/strategies; lp: { pool, amountUsd, preset }. Auth: Bearer <key> or X-Session; 5 agents per account.", null],
    ["GET", "/v1/agents", "Your agents with live stats.", null],
    ["GET", "/v1/agents/:id", "One of your agents: positions, fills (each with the trade that fired it), skips and why, events; LP agents add their range and chart points.", null],
    ["GET", "/v1/agents/:id/stream", "Server-sent events for one of your agents: fill, event, stats.", null],
    ["POST", "/v1/agents/:id/pause", "Pause (also /resume, DELETE /v1/agents/:id).", null],
    ["POST", "/v1/agents/:id/copy", "Fork a public agent into yours (paper).", null],
    ["GET", "/v1/agents/traders?days=1", "Chord's Solana smart-traders board (1, 3 or 7 days): the wallets copy agents follow.", "/v1/agents/traders?days=1&limit=5"],
    ["GET", "/v1/agents/lp/scan?limit=5", "Solana pools for an LP agent: TVL, volume, fee APR (estimate, with its source), LP flows, volatility, every flag.", "/v1/agents/lp/scan?limit=5"],
    ["GET", "/v1/agents/lp/range?pool=…", "Tight, balanced and wide ranges for a pool from its hourly volatility, with how often each held.", null],
    ["POST", "/v1/agents/lp/backtest", "Replay an LP position over 1, 3 or 7 days: LP vs HODL vs all in the quote token, estimated fees, IL, rebalances. Body { pool, amountUsd, preset | rangePct, days }.", null],
  ]],
  ["Strategies", [
    ["POST", "/v1/strategies/compile", "Words in, a validated Strategy JSON out (trigger, filters, action, exits, limits) with one plain line per block and the questions still open. Body { text }.", null],
    ["POST", "/v1/strategies/validate", "Check a strategy: defaults filled, or errors that name the block and field. Body { strategy }.", null],
    ["GET", "/v1/strategies/templates", "The template gallery as Strategy JSON with their plain-words explanation.", "/v1/strategies/templates"],
    ["POST", "/v1/strategies/backtest", "Replay a strategy on Chord's Solana tape and candles over 1, 3 or 7 days: signals, trades, skips, PnL, win rate, drawdown, equity, notes on what could not be replayed. Body { strategy, days }.", null],
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
const AGENT_IN_3 = () => `# 1. words → strategy
curl -s ${ORIGIN}/v1/strategies/compile \\
  -H 'content-type: application/json' \\
  -d '{"text":"Buy $15 when 3 of the top 20 smart traders buy the same token within 15 minutes, liquidity above $30k"}' \\
  > s.json

# 2. replay it on the last 3 days
curl -s ${ORIGIN}/v1/strategies/backtest \\
  -H 'content-type: application/json' \\
  -d "{\\"strategy\\": $(jq .strategy s.json), \\"days\\": 3}" \\
  | jq '{signals, trades, realizedUsd, winRate}'

# 3. start it (paper) and watch it trade
curl -s ${ORIGIN}/v1/agents \\
  -H "Authorization: Bearer $CHORD_KEY" \\
  -H 'content-type: application/json' \\
  -d "{\\"type\\":\\"custom\\",\\"params\\":{\\"strategy\\": $(jq .strategy s.json)}}"
curl -N ${ORIGIN}/v1/agents/feed`;
const slug = (g) => `ref-${g.toLowerCase()}`;
const pathHtml = (p) => esc(p).replace(/(:[a-z]+)/gi, '<span class="dp-p">$1</span>').replace(/(\?.*)$/, '<span class="dp-q">$1</span>');
const PLAY = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5Z" fill="currentColor"/></svg>`;
/** The reference's own index: the 3-call start, then each group with its endpoint count. */
const refIndex = () => `<nav class="dindex" aria-label="Reference sections"><a href="#ref-start" class="on">An agent in 3 calls</a>${REF.map(([g, eps]) => `<a href="#${slug(g)}">${g}<small>${eps.length}</small></a>`).join("")}</nav>`;
function reference() {
  const n = REF.reduce((a, [, eps]) => a + eps.length, 0), tries = REF.reduce((a, [, eps]) => a + eps.filter((e) => e[3]).length, 0);
  return `<h1>API reference</h1><p class="dmuted">Base URL <code>${esc(ORIGIN)}</code>. JSON in, JSON out; /v1/ask and the agent feeds stream server-sent events. Every read answers without a key. ${n} endpoints, ${tries} of them with a live Try.</p>
    <section class="dsec" id="ref-start"><h2>An agent in 3 calls</h2><p class="dmuted">Words become a strategy, the strategy is replayed on the last 3 days of the Solana tape, then a paper agent trades it live.</p>${code(AGENT_IN_3(), "sh", "Shell · compile, replay, start")}</section>
    ${REF.map(([group, eps]) => `<section class="dsec" id="${slug(group)}"><h2>${group}<small>${eps.length}</small></h2><div class="deps">${eps.map(([m, p, d, tryPath]) => `<div class="dep"><div class="deph"><span class="dm ${m.toLowerCase()}">${m}</span><code class="dpath">${pathHtml(p)}</code>${tryPath ? `<button class="dtryb" type="button" data-try="${esc(tryPath)}">${PLAY}Try</button>` : ""}</div><p>${esc(d)}</p><div class="dtry" hidden></div></div>`).join("")}</div></section>`).join("")}`;
}
// The index follows the section in view.
function spyRef() {
  const links = [...document.querySelectorAll(".dindex a")];
  if (!links.length) return;
  let cur = null;
  for (const sec of document.querySelectorAll(".dsec")) if (sec.getBoundingClientRect().top < Math.min(240, innerHeight * 0.3)) cur = sec.id;
  cur ??= "ref-start";
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = document.querySelector(".dsec:last-of-type")?.id ?? cur;
  links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${cur}`));
}
let spyRaf = 0;
addEventListener("scroll", () => { cancelAnimationFrame(spyRaf); spyRaf = requestAnimationFrame(spyRef); }, { passive: true });

// ── render ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function afterRef() {
  const at = location.hash && document.getElementById(location.hash.slice(1));
  if (at) at.scrollIntoView({ block: "start" });
  spyRef();
}
function render() {
  const tab = tabOf();
  const signedIn = !!pstate?.authenticated;
  document.title = `${tab === "reference" ? "API reference" : "Developer console"} · Chord Ask`;
  if (tab === "reference" && !signedIn) {
    root.innerHTML = `<div class="dconsole open"><aside class="dside"><div class="dside-h">Reference</div>${refIndex()}<a class="dside-cta" href="/developer" data-nav>Get a key</a></aside><section class="dmain dref">${reference()}</section></div>`;
    afterRef();
    return;
  }
  if (!signedIn) { root.innerHTML = signedOut(); fillLive(); return; }
  const body = accountErr ? `<h1>Console</h1><p class="dmsg bad">${esc(accountErr)}</p><button class="dghost" type="button" id="retry">Try again</button>`
    : !account && tab !== "reference" ? `<p class="dmuted">Loading your account…</p>`
    : tab === "keys" ? keysTab() : tab === "usage" ? usageTab() : tab === "account" ? accountTab() : tab === "reference" ? reference() : overview();
  root.innerHTML = `<div class="dconsole${tab === "reference" ? " open" : ""}">${sidebar(tab)}<section class="dmain${tab === "reference" ? " dref" : ""}">${body}</section></div>`;
  if (tab === "reference") afterRef();
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
    $("snip").innerHTML = t.dataset.s === "js" ? code(jsAsk(key), "js") : t.dataset.s === "py" ? code(pyAsk(key), "py") : code(curlAsk(key));
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
  const ix = t.closest(".dindex a");
  if (ix) {
    e.preventDefault();
    const id = ix.getAttribute("href").slice(1);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    return;
  }
  const tb = t.closest("[data-try]");
  if (tb) {
    const box = tb.closest(".dep").querySelector(".dtry"), path = tb.dataset.try;
    box.hidden = false; box.innerHTML = respPanel("GET", path); tb.disabled = true;
    const t0 = performance.now();
    const r = await fetch(path).catch(() => null);
    const raw = r ? await r.text().catch(() => "") : "";
    const ms = Math.round(performance.now() - t0);
    let body; try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { body = raw || "(no body)"; }
    if (body.length > 6000) body = `${body.slice(0, 6000)}\n… cut here, ${kb(body.length)} in all`;
    box.innerHTML = respPanel("GET", path, { status: r?.status ?? 0, ms, bytes: new TextEncoder().encode(raw).length, body });
    tb.disabled = false;
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
