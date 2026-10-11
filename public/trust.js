// Trust on Monad, in the page: an agent's ERC-8004 identity, its TrackRecord chain - re-hashed and rebuilt HERE, in the
// browser, then compared with the chain read straight from Monad's RPC (not through this server) - its validations and its
// reputation (rating = the person's own wallet signs giveFeedback on the canonical Reputation Registry). The Trust tab is
// the public dashboard of the whole layer. Every server string is escaped.
const RPC = "https://rpc.monad.xyz";
const EXPLORER = "https://monadscan.com";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const CHAIN_HEX = "0x8f"; // 143
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h, a = 6, b = 4) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h ?? "");
const txLink = (tx, label) => (tx ? `<a class="tr-ln${label ? "" : " mono"}" href="${EXPLORER}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(label ?? short(tx, 8, 6))}</a>` : "-");
const addrLink = (a) => (a ? `<a class="tr-ln mono" href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>` : "-");
const agoTxt = (ms) => { if (!ms) return "-"; const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const lagTxt = (ms) => (ms == null ? "-" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

// ── keccak-256 and a little ABI, in the browser ──────────────────────────────────────────────────────────────────────────
let K = null;
const keccakMod = () => (K ??= import("https://cdn.jsdelivr.net/npm/@noble/hashes@1.5.0/esm/sha3.js/+esm"));
const toHex = (b) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h) => { const s = h.replace(/^0x/, ""); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out; };
async function keccak(bytes) { const { keccak_256 } = await keccakMod(); return toHex(keccak_256(bytes)); }
const utf8 = (s) => new TextEncoder().encode(s);
const ZERO = `0x${"0".repeat(64)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
async function selector(sig) { return (await keccak(utf8(sig))).slice(0, 10); }

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? "RPC error");
  return j.result;
}
/** TrackRecord.chains(agentId), read from Monad directly. */
async function chainOnchain(track, agentId) {
  const data = `${await selector("chains(uint256)")}${word(agentId)}`;
  const out = (await rpc("eth_call", [{ to: track, data }, "latest"])).replace(/^0x/, "");
  return { head: `0x${out.slice(0, 64)}`, count: Number(BigInt(`0x${out.slice(64, 128)}`)), lastAt: Number(BigInt(`0x${out.slice(128, 192)}`)) * 1000 };
}

/** Re-hash every published document, rebuild the chain, compare with Monad. */
export async function verifyAgent(api, botId) {
  const t = await api(`/v1/trust/agents/${encodeURIComponent(botId)}`);
  if (!t.identity) return { ok: false, msg: "No ERC-8004 identity yet: the agent is registered on its first trade." };
  const f = await api(`/v1/trust/agents/${encodeURIComponent(botId)}/fills`);
  const fills = (f.fills ?? []).filter((x) => x.commitTx).sort((a, b) => a.seq - b.seq);
  let bad = 0, head = ZERO;
  for (const x of fills) {
    const h = await keccak(utf8(x.doc));
    if (h.toLowerCase() !== String(x.hash).toLowerCase()) bad++;
    head = await keccak(fromHex(`${head}${h.slice(2)}`));
  }
  const on = await chainOnchain(t.trackRecord, t.identity.agentId);
  const match = on.count === fills.length && on.head.toLowerCase() === head.toLowerCase();
  return { ok: match && !bad, docs: fills.length, bad, head, on,
    msg: match && !bad ? `Checked here: ${fills.length} document${fills.length === 1 ? "" : "s"} re-hashed, the chain rebuilt to ${short(head, 10, 6)}, equal to the head Monad holds for agent #${t.identity.agentId}.`
      : bad ? `${bad} document${bad === 1 ? "" : "s"} do not hash to what was committed.` : `The rebuilt chain (${fills.length} fills, ${short(head, 10, 6)}) differs from Monad's (${on.count} fills, ${short(on.head, 10, 6)}).` };
}

// ── rating from the person's wallet (giveFeedback on the canonical Reputation Registry) ──────────────────────────────────────
function encString(s) { const b = utf8(s); const len = word(b.length); const padded = toHex(b).slice(2).padEnd(Math.ceil(b.length / 32) * 64, "0"); return len + padded; }
async function giveFeedbackData(agentId, value, endpoint) {
  const sel = await selector("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)");
  const strs = ["starred", "", endpoint, ""];
  const head = [word(agentId), word(value), word(0)];
  let off = 32 * 8, tails = "";
  const offs = [];
  for (const s of strs) { offs.push(word(off)); const e = encString(s); tails += e; off += e.length / 2; }
  return `${sel}${head.join("")}${offs.join("")}${"0".repeat(64)}${tails}`;
}
async function ensureMonad(eth) {
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e) {
    if (e?.code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }] });
  }
}
export async function rateAgent(agentId, stars, endpoint) {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet in this browser: open the page in a browser with an EVM wallet (MetaMask, Rabby or another EVM wallet).");
  const [from] = await eth.request({ method: "eth_requestAccounts" });
  await ensureMonad(eth);
  const data = await giveFeedbackData(agentId, Math.max(1, Math.min(5, stars)) * 20, endpoint);
  return eth.request({ method: "eth_sendTransaction", params: [{ from, to: REPUTATION, data }] });
}

// ── the panel on an agent's page ──────────────────────────────────────────────────────────────────────────────────────
/** opts: { api, botId, icon?(name), onData?(trustAnswer) (each fresh answer, for the fills table), autoVerify? (check once loaded) } */
export function mountTrustPanel(el, { api, botId, icon, onData, autoVerify }) {
  const ic = (n) => (icon ? icon(n) : "");
  const st = { t: null, rep: null, err: null, verify: null, busy: null, msg: null, stars: 0 };
  async function load() {
    try {
      const [t, rep] = await Promise.all([api(`/v1/trust/agents/${encodeURIComponent(botId)}`), api(`/v1/trust/agents/${encodeURIComponent(botId)}/reputation`).catch(() => null)]);
      st.t = t; st.rep = rep; st.err = null;
      onData?.(t);
      if (t.identity?.agentId) st.gate = await api(`/v1/trust/gate/${encodeURIComponent(t.identity.agentId)}`).catch(() => null);
    } catch (e) { st.err = e.message; }
    paint();
  }
  async function verify() {
    if (st.busy) return;
    st.busy = "verify"; paint();
    try { st.verify = await verifyAgent(api, botId); } catch (err) { st.verify = { ok: false, msg: `Could not check: ${err.message}` }; }
    st.busy = null; paint();
  }
  function paint() {
    const t = st.t;
    const head = (state = "") => `<header class="tr-ch"><h3>Track record on Monad</h3>${state}</header>`;
    if (!t) { el.innerHTML = `<section class="tr-rec">${head()}${st.err ? `<p class="tr-note">${esc(st.err)}</p>` : `<div class="b-skel" style="height:120px"></div>`}</section>`; return; }
    const id = t.identity, committed = t.fills.filter((f) => f.commitTx), pending = t.fills.length - committed.length;
    const lastV = (t.validations ?? []).find((v) => v.response != null), openV = (t.validations ?? []).find((v) => v.response == null && !v.error);
    const live = (st.rep?.feedback ?? []).filter((f) => !f.revoked && f.tag1 === "starred");
    const avg = live.length ? live.reduce((a, f) => a + f.value, 0) / live.length / 20 : null;
    const lags = committed.map((f) => f.lagMs).filter((x) => x != null).sort((a, b) => a - b);
    const medLag = lags.length ? lags[Math.floor(lags.length / 2)] : null;
    const v = st.verify, state = st.busy === "verify" ? `<span class="tr-state run">Checking…</span>` : v ? `<span class="tr-state ${v.ok ? "ok" : "bad"}">${ic(v.ok ? "check" : "alert")}${v.ok ? "Verified" : "Mismatch"}</span>` : "";
    el.innerHTML = `<section class="tr-rec" aria-label="Track record on Monad">
      ${head(state)}
      <div class="tr-big"><b>${committed.length}</b><span>fill${committed.length === 1 ? "" : "s"} committed${pending ? ` <em>+${pending} pending</em>` : ""}</span></div>
      <p class="tr-sub">${medLag != null ? `Median ${lagTxt(medLag)} from fill to block` : id ? "Fills are committed within seconds" : "Registered with its first trade"}${t.chain.lastCommitTx ? `, last ${txLink(t.chain.lastCommitTx, agoTxt(t.chain.lastCommitAt))}` : ""}</p>
      <div class="tr-verify"><button type="button" class="b-new" data-tr="verify"${st.busy || !id ? " disabled" : ""}>${ic(st.busy === "verify" ? "spin" : "shield")}${st.busy === "verify" ? "Checking…" : v ? "Check again" : "Verify in your browser"}</button>
        ${v?.msg ? `<p class="tr-res ${v.ok ? "ok" : "bad"}">${esc(v.msg)}</p>` : ""}</div>
      <dl class="tr-list">
        <div><dt>Identity</dt><dd>${id ? `<a class="tr-ln" href="${EXPLORER}/token/${IDENTITY}?a=${esc(id.agentId)}" target="_blank" rel="noopener">ERC-8004 #${esc(id.agentId)}</a><small><a class="tr-ln" href="${esc(id.agentURI)}" target="_blank" rel="noopener">registration</a>, ${txLink(id.registerTx, "tx")}</small>` : `<span>Pending</span><small>${t.error ? esc(t.error) : "registered with its first trade"}</small>`}</dd></div>
        <div><dt>Chain head</dt><dd>${t.chain.head && t.chain.count ? `<span class="mono" title="${esc(t.chain.head)}">${esc(short(t.chain.head, 8, 6))}</span><small>${t.chain.count} in ${addrLink(t.trackRecord)}</small>` : `<span>Empty</span>`}</dd></div>
        <div><dt>Validation</dt><dd>${lastV ? `<b class="tr-score">${lastV.response}/100</b><small>fills #${lastV.range.fromSeq}–${lastV.range.toSeq}, <a class="tr-ln" href="${esc(lastV.responseURI)}" target="_blank" rel="noopener">report</a>, ${txLink(lastV.responseTx, "tx")}</small>` : openV ? `<span>Replaying…</span>` : `<span>None yet</span>`}${committed.length && !openV ? `<button type="button" class="b-btn sm" data-tr="validate"${st.busy ? " disabled" : ""}>${st.busy === "validate" ? "Asking…" : lastV ? "Validate new fills" : "Ask the validator"}</button>` : ""}</dd></div>
        <div><dt>TrustGate</dt><dd>${st.gate ? (st.gate.ok ? `<b class="tr-score">Trusted</b><small>${addrLink(st.gate.contract)}</small>` : `<span>Not yet</span><small>${esc((st.gate.missing ?? []).join(", ") || "the gate's policy is not met")}</small>`) : `<span>-</span>`}</dd></div>
        <div><dt>Reputation</dt><dd>${avg != null ? `<b>${avg.toFixed(1)} ★</b>` : `<span>No ratings</span>`}<small>${live.length} rating${live.length === 1 ? "" : "s"}</small>${id ? `<button type="button" class="b-btn sm" data-tr="rate"${st.busy && st.busy !== "rate" ? " disabled" : ""}>Rate</button>` : ""}</dd></div>
      </dl>
      ${st.busy === "rate" || st.stars ? `<div class="tr-rate">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="tr-star${n <= st.stars ? " on" : ""}" data-star="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}<button type="button" class="b-btn sm" data-tr="send-rate"${st.stars ? "" : " disabled"}>Sign with my wallet</button><small>Your wallet signs giveFeedback on Monad and pays its gas.</small></div>` : ""}
      ${st.msg ? `<p class="tr-note">${esc(st.msg)}</p>` : ""}
      <details class="tr-how"><summary>How this record is kept</summary><p>Each fill becomes a JSON document; its keccak-256 is appended on Monad to this agent's chain in <span class="mono">TrackRecord</span> seconds after the fill (head = keccak(previous head ‖ hash)). Nothing can be removed, edited or reordered without changing the head. A validator with its own key replays the fills from public data and answers on the ERC-8004 Validation Registry; ratings go to the canonical ERC-8004 Reputation Registry.</p></details>
    </section>`;
  }
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tr],[data-star]"); if (!b) return;
    if (b.dataset.star) { st.stars = Number(b.dataset.star); paint(); return; }
    const act = b.dataset.tr;
    if (act === "verify") return void verify();
    if (act === "validate") {
      st.busy = "validate"; st.msg = null; paint();
      try { await api(`/v1/trust/agents/${encodeURIComponent(botId)}/validate`, { method: "POST" }); st.msg = "Validation asked on-chain; the validator replays the fills and answers in a minute."; }
      catch (err) { st.msg = err.message; }
      st.busy = null; await load(); setTimeout(load, 20_000);
    } else if (act === "rate") { st.busy = st.busy === "rate" ? null : "rate"; if (!st.busy) st.stars = 0; paint(); }
    else if (act === "send-rate") {
      try { const tx = await rateAgent(st.t.identity.agentId, st.stars, location.href); st.msg = `Rating sent: ${tx}`; st.stars = 0; st.busy = null; setTimeout(load, 8_000); }
      catch (err) { st.msg = err.message ?? String(err); }
      paint();
    }
  });
  load().then(() => { if (autoVerify && st.t?.identity) verify(); });
  const timer = setInterval(() => { if (document.visibilityState === "visible" && !st.busy) load(); }, 20_000);
  return { refresh: load, verify, destroy: () => clearInterval(timer) };
}

// ── the Trust tab ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function renderTrustView(root, { api, openAgent }) {
  root.innerHTML = `<div class="tr-wrap"><header class="tr-head"><h1>Trust</h1><p>Every agent's record, checkable on Monad.</p></header><div id="trBody"><div class="b-skel" style="height:160px"></div></div></div>`;
  const body = root.querySelector("#trBody");
  async function load() {
    let s, outside = null;
    try { [s, outside] = await Promise.all([api("/v1/trust/status"), api("/v1/trust/outside").catch(() => null)]); }
    catch (e) { body.innerHTML = `<p class="tr-note">${esc(e.message)}</p>`; return; }
    const c = s.contracts;
    body.innerHTML = `<div class="tr-kpis">
        <div class="tr-tile"><small>Agents</small><b>${s.counts.agents}</b></div>
        <div class="tr-tile"><small>Fills on Monad</small><b>${s.counts.committed}</b><span>${s.counts.pending ? `${s.counts.pending} pending` : "none pending"}</span></div>
        <div class="tr-tile"><small>Validations</small><b>${s.counts.validations}</b></div>
        <div class="tr-tile"><small>Committer</small><b>${s.committer.enabled ? (s.committer.lastError ? "Waiting" : "Running") : "Off"}</b><span>${esc(s.committer.lastError ?? (s.committer.lastTickAt ? `last pass ${agoTxt(s.committer.lastTickAt)}` : ""))}</span></div>
      </div>
      <section class="tr-sec" id="trReg"><div class="b-sech"><h3>ERC-8004 registry</h3><small id="trRegN"></small></div>
        <div class="tr-kpis tr-regk" id="trRegK"></div>
        <div class="tr-regbar"><input class="b-in" id="trRegQ" placeholder="Search by name, id or owner (0x...)" aria-label="Search agents"><div class="b-seg sm" role="tablist" aria-label="Filter">${[["all", "All"], ["record", "With a record"], ["validated", "Validated"], ["card", "With a card"]].map(([v, l]) => `<button type="button" data-regf="${v}" class="${v === "all" ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <div id="trRegT"><div class="b-skel" style="height:160px"></div></div>
      </section>
      <section class="tr-sec"><div class="b-sech"><h3>Contracts</h3><small>chain ${s.chainId}</small></div>
        <table class="tr-tbl"><tbody>
          <tr><td>ERC-8004 Identity</td><td>${addrLink(c.identityRegistry)}</td><td>canonical</td></tr>
          <tr><td>ERC-8004 Reputation</td><td>${addrLink(c.reputationRegistry)}</td><td>canonical</td></tr>
          <tr><td>ERC-8004 Validation</td><td>${addrLink(c.validationRegistry)}</td><td>ours</td></tr>
          <tr><td>TrackRecord</td><td>${addrLink(c.trackRecord)}</td><td>ours</td></tr>
          <tr><td>TrustGate</td><td>${addrLink(s.open?.gate?.contract)}</td><td>${s.open?.gate?.checked ? `${s.open.gate.passing}/${s.open.gate.checked} agents pass` : "ours"}</td></tr>
          <tr><td>AgentVault</td><td>${addrLink(s.open?.gate?.vault)}</td><td>example</td></tr>
          <tr><td>Operator</td><td>${addrLink(s.operator?.address)}</td><td>${s.operator?.mon != null ? `${Number(s.operator.mon).toFixed(3)} MON` : ""}</td></tr>
          <tr><td>Validator</td><td>${addrLink(s.validator?.address)}</td><td>${s.validator?.mon != null ? `${Number(s.validator.mon).toFixed(3)} MON` : ""}</td></tr>
        </tbody></table></section>
      <section class="tr-sec"><div class="b-sech"><h3>Ask the gate</h3></div>
        <form class="tr-gate" data-gate><input class="b-in" name="agent" inputmode="numeric" placeholder="Any ERC-8004 agent id, e.g. 10333" aria-label="Agent id"><button class="b-btn" type="submit">Check</button></form>
        <p class="tr-note" id="trGateRes">${s.open?.gate ? "Passes at 3 fills, validation 90+, a commit in 3 days." : ""}</p>
      </section>
      <section class="tr-sec"><div class="b-sech"><h3>Outside agents</h3><small>${outside?.agents?.length ?? 0}</small></div>
        ${outside?.agents?.length ? `<table class="tr-tbl"><thead><tr><th>Agent</th><th>ERC-8004</th><th>On-chain fills</th><th>Published</th><th>Last commit</th><th></th></tr></thead><tbody>${outside.agents.map((a) => `<tr>
          <td>${esc(a.name ?? "Unnamed agent")}</td><td><a class="tr-ln" href="${EXPLORER}/token/${IDENTITY}?a=${esc(a.agentId)}" target="_blank" rel="noopener">#${esc(a.agentId)}</a></td><td>${a.fills}</td><td>${a.published}</td><td>${txLink(a.lastCommitTx, "tx")}</td>
          <td><a class="b-btn sm" href="${esc(a.fillsUrl)}" target="_blank" rel="noopener">Fills</a></td></tr>`).join("")}</tbody></table>` : `<p class="tr-note">No outside agent has committed yet.</p>`}
      </section>
      <section class="tr-sec"><div class="b-sech"><h3>Build on it</h3></div>
        <pre class="tr-code">curl -sO ${location.origin}/sdk/chord-verify.mjs
node chord-verify.mjs verify 10333     # re-hash the record, compare with Monad
node chord-verify.mjs gate 10333       # what TrustGate.check answers a contract

import { verify, gateCheck, commit, publish, askChordValidator } from "${location.origin}/sdk/trackrecord.mjs";

# for AI agents: the same checks as MCP tools (agent_record, verify_agent, gate_check, search_agents)
claude mcp add --transport http chord-trust ${location.origin}/mcp</pre>
      </section>`;
  }
  body.addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openAgent(b.dataset.open); });
  // the registry explorer: search, filter, page through every agent the canonical Identity Registry holds
  const R = { q: "", f: "all", page: 0, t: null };
  async function loadReg() {
    const el = body.querySelector("#trRegT"); if (!el) return;
    let j;
    try { j = await api(`/v1/trust/registry?q=${encodeURIComponent(R.q)}&filter=${R.f}&page=${R.page}&size=25`); } catch (e) { el.innerHTML = `<p class="tr-note">${esc(e.message)}</p>`; return; }
    const st = j.stats, k = body.querySelector("#trRegK"), n = body.querySelector("#trRegN");
    if (n) n.textContent = st.sync?.top ? `ids 0 to ${(st.sync.top - 1).toLocaleString("en-US")}` : "";
    if (k) k.innerHTML = [["Registered", st.agents], ["Owners", st.owners], ["Cards read", `${st.cardsOk.toLocaleString("en-US")}<small> of ${st.cardsRead.toLocaleString("en-US")}</small>`], ["With a record", st.withRecord], ["Validated", st.validated]]
      .map(([l, v]) => `<div class="tr-tile"><small>${l}</small><b>${typeof v === "number" ? v.toLocaleString("en-US") : v}</b></div>`).join("");
    const host = (u) => { try { return new URL(u).host; } catch { return u?.startsWith("data:") ? "inline" : u?.startsWith("ipfs://") ? "ipfs" : "-"; } };
    el.innerHTML = j.rows.length ? `<table class="tr-tbl"><thead><tr><th>Agent</th><th>ERC-8004</th><th>Owner</th><th>Card</th><th>Fills on TrackRecord</th><th>Validation</th></tr></thead><tbody>${j.rows.map((a) => `<tr>
        <td>${esc(a.name ?? (a.card === "unread" ? "Card not read yet" : "No card"))}${a.ours ? ` <small class="dim">Chord</small>` : ""}</td>
        <td><a class="tr-ln" href="${EXPLORER}/token/${IDENTITY}?a=${a.agentId}" target="_blank" rel="noopener">#${a.agentId}</a></td>
        <td>${a.owner ? addrLink(a.owner) : "-"}</td><td class="dim">${esc(host(a.uri))}</td>
        <td>${a.commits ? `<a class="tr-ln" href="/v1/trust/onchain/${a.agentId}/fills" target="_blank" rel="noopener">${a.commits}</a>` : `<span class="dim">-</span>`}</td>
        <td>${a.validations ? `<b class="tr-score">${a.avgScore}/100</b><small class="dim"> ${a.validations}</small>` : `<span class="dim">-</span>`}</td></tr>`).join("")}</tbody></table>
      <div class="tr-pg"><small class="dim">${(R.page * 25 + 1).toLocaleString("en-US")} to ${Math.min(j.total, (R.page + 1) * 25).toLocaleString("en-US")} of ${j.total.toLocaleString("en-US")}</small><span><button type="button" class="b-btn sm" data-regp="-1"${R.page ? "" : " disabled"}>Previous</button><button type="button" class="b-btn sm" data-regp="1"${(R.page + 1) * 25 < j.total ? "" : " disabled"}>Next</button></span></div>`
      : `<p class="tr-note">No agent matches.</p>`;
  }
  body.addEventListener("input", (e) => { if (e.target.id !== "trRegQ") return; clearTimeout(R.t); R.t = setTimeout(() => { R.q = e.target.value.trim(); R.page = 0; loadReg(); }, 250); });
  body.addEventListener("click", (e) => {
    const f = e.target.closest("[data-regf]"); if (f) { R.f = f.dataset.regf; R.page = 0; f.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === f)); loadReg(); return; }
    const p = e.target.closest("[data-regp]"); if (p && !p.disabled) { R.page = Math.max(0, R.page + Number(p.dataset.regp)); loadReg(); }
  });
  body.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-gate]"); if (!f) return;
    e.preventDefault();
    const id = String(new FormData(f).get("agent") ?? "").trim(), out = body.querySelector("#trGateRes");
    if (!/^\d{1,12}$/.test(id)) { out.textContent = "An agent id is a number, like 10333."; return; }
    out.textContent = "Reading TrustGate on Monad…";
    try {
      const g = await api(`/v1/trust/gate/${id}`);
      out.innerHTML = g.ok ? `<b class="tr-score">Trusted</b>: agent #${esc(id)} has ${g.fills} fills, ${g.validations} validation${g.validations === 1 ? "" : "s"} averaging ${g.avgScore}/100.`
        : `<b>Not yet</b>: agent #${esc(id)}, ${esc((g.missing ?? []).join(", "))}.`;
    } catch (err) { out.textContent = err.message; }
  });
  load().then(loadReg);
  return { refresh: () => load().then(loadReg) };
}
