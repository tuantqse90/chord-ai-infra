// Trust on Monad, in the page: an agent's ERC-8004 identity, its TrackRecord chain — re-hashed and rebuilt HERE, in the
// browser, then compared with the chain read straight from Monad's RPC (not through this server) — its validations and its
// reputation (rating = the person's own wallet signs giveFeedback on the canonical Reputation Registry). The Trust tab is
// the public dashboard of the whole layer. Every server string is escaped.
const RPC = "https://rpc.monad.xyz";
const EXPLORER = "https://monadscan.com";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const CHAIN_HEX = "0x8f"; // 143
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h, a = 6, b = 4) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h ?? "");
const txLink = (tx, label) => (tx ? `<a class="tr-ln mono" href="${EXPLORER}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(label ?? short(tx, 8, 6))}</a>` : "—");
const addrLink = (a) => (a ? `<a class="tr-ln mono" href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>` : "—");
const agoTxt = (ms) => { if (!ms) return "—"; const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const lagTxt = (ms) => (ms == null ? "—" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

// ── keccak-256 and a little ABI, in the browser ──────────────────────────────────────────────────────────────────────────
let K = null;
const keccakMod = () => (K ??= import("https://cdn.jsdelivr.net/npm/@noble/hashes@1.5.0/esm/sha3.js"));
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
  if (!eth) throw new Error("No wallet in this browser: open the page in a browser with an EVM wallet (MetaMask, Rabby, Phantom EVM).");
  const [from] = await eth.request({ method: "eth_requestAccounts" });
  await ensureMonad(eth);
  const data = await giveFeedbackData(agentId, Math.max(1, Math.min(5, stars)) * 20, endpoint);
  return eth.request({ method: "eth_sendTransaction", params: [{ from, to: REPUTATION, data }] });
}

// ── the panel on an agent's page ──────────────────────────────────────────────────────────────────────────────────────
export function mountTrustPanel(el, { api, botId, icon }) {
  const ic = (n) => (icon ? icon(n) : "");
  const st = { t: null, rep: null, err: null, verify: null, busy: null, msg: null, stars: 0 };
  async function load() {
    try {
      const [t, rep] = await Promise.all([api(`/v1/trust/agents/${encodeURIComponent(botId)}`), api(`/v1/trust/agents/${encodeURIComponent(botId)}/reputation`).catch(() => null)]);
      st.t = t; st.rep = rep; st.err = null;
    } catch (e) { st.err = e.message; }
    paint();
  }
  function paint() {
    const t = st.t;
    if (!t) { el.innerHTML = `<div class="tr-sec"><div class="b-sech"><h3>On-chain trust</h3></div><div class="b-skel" style="height:90px"></div></div>`; if (st.err) el.innerHTML = `<div class="tr-sec"><div class="b-sech"><h3>On-chain trust</h3></div><p class="tr-note">${esc(st.err)}</p></div>`; return; }
    const id = t.identity, committed = t.fills.filter((f) => f.commitTx), pending = t.fills.length - committed.length;
    const lastV = (t.validations ?? []).find((v) => v.response != null), openV = (t.validations ?? []).find((v) => v.response == null && !v.error);
    const live = (st.rep?.feedback ?? []).filter((f) => !f.revoked && f.tag1 === "starred");
    const avg = live.length ? live.reduce((a, f) => a + f.value, 0) / live.length / 20 : null;
    const lags = committed.map((f) => f.lagMs).filter((x) => x != null);
    const medLag = lags.length ? lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null;
    el.innerHTML = `<section class="tr-sec" aria-label="On-chain trust">
      <div class="b-sech"><h3>On-chain trust</h3><small>Monad · ERC-8004</small></div>
      <div class="tr-grid">
        <div class="tr-tile"><small>Identity</small>${id ? `<b><a class="tr-ln" href="${EXPLORER}/token/${IDENTITY}?a=${esc(id.agentId)}" target="_blank" rel="noopener">Agent #${esc(id.agentId)}</a></b><span><a class="tr-ln" href="${esc(id.agentURI)}" target="_blank" rel="noopener">registration.json</a> · ${txLink(id.registerTx, "register tx")}</span>` : `<b>Pending</b><span>${t.error ? esc(t.error) : "registered with its first trade"}</span>`}</div>
        <div class="tr-tile"><small>Track record</small><b>${committed.length} fill${committed.length === 1 ? "" : "s"} on-chain</b><span>${medLag != null ? `median ${lagTxt(medLag)} after the fill` : "—"}${pending ? ` · ${pending} pending` : ""}${t.chain.lastCommitTx ? ` · ${txLink(t.chain.lastCommitTx, agoTxt(t.chain.lastCommitAt))}` : ""}</span></div>
        <div class="tr-tile"><small>Validation</small><b>${lastV ? `${lastV.response}/100` : openV ? "Replaying…" : "None yet"}</b><span>${lastV ? `fills #${lastV.range.fromSeq}–${lastV.range.toSeq} · <a class="tr-ln" href="${esc(lastV.responseURI)}" target="_blank" rel="noopener">report</a> · ${txLink(lastV.responseTx, "tx")}` : committed.length ? `<button type="button" class="b-btn sm" data-tr="validate"${st.busy ? " disabled" : ""}>${st.busy === "validate" ? "Asking…" : "Ask the validator"}</button>` : "after the first committed fill"}</span></div>
        <div class="tr-tile"><small>Reputation</small><b>${avg != null ? `${avg.toFixed(1)} ★` : "No ratings"}</b><span>${live.length} rating${live.length === 1 ? "" : "s"} · ERC-8004 registry${id ? ` · <button type="button" class="tr-lnb" data-tr="rate">Rate</button>` : ""}</span></div>
      </div>
      ${st.busy === "rate" || st.stars ? `<div class="tr-rate">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="tr-star${n <= st.stars ? " on" : ""}" data-star="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}<button type="button" class="b-btn sm" data-tr="send-rate"${st.stars ? "" : " disabled"}>Sign with my wallet</button><small>Your wallet signs giveFeedback on Monad; you pay its gas.</small></div>` : ""}
      <div class="tr-verify"><button type="button" class="b-btn" data-tr="verify"${st.busy ? " disabled" : ""}>${ic("check")}${st.busy === "verify" ? "Checking…" : "Verify in your browser"}</button>
        <span class="tr-res ${st.verify ? (st.verify.ok ? "ok" : "bad") : ""}">${esc(st.verify?.msg ?? "Re-hashes every published fill here and compares the chain with Monad's RPC, not with this server.")}</span></div>
      ${st.msg ? `<p class="tr-note">${esc(st.msg)}</p>` : ""}
      ${committed.length ? `<details class="tr-fills"><summary>Committed fills (${committed.length})</summary><table class="tr-tbl"><thead><tr><th>#</th><th>Fill</th><th>Hash</th><th>Lag</th><th>Tx</th></tr></thead><tbody>${committed.slice(0, 40).map((f) => {
        let d = null; try { d = JSON.parse(f.doc); } catch {}
        const what = d ? `${esc(d.fill.side)} ${esc(d.fill.symbol ?? short(d.fill.token))} $${Number(d.fill.usd).toFixed(2)}` : "—";
        return `<tr><td>${f.seq}</td><td>${what}</td><td class="mono" title="${esc(f.hash)}">${esc(short(f.hash, 10, 4))}</td><td>${lagTxt(f.lagMs)}</td><td>${txLink(f.commitTx)}</td></tr>`;
      }).join("")}</tbody></table></details>` : ""}
      <details class="tr-how"><summary>How this record is kept</summary><p>Each fill becomes a JSON document; its keccak-256 is appended on Monad to this agent's chain in <span class="mono">TrackRecord</span> seconds after the fill (head = keccak(previous head ‖ hash)). Nothing can be removed, edited or reordered without changing the head. A validator with its own key replays the fills from public data and answers on the ERC-8004 Validation Registry; ratings go to the canonical ERC-8004 Reputation Registry.</p></details>
    </section>`;
  }
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tr],[data-star]"); if (!b) return;
    if (b.dataset.star) { st.stars = Number(b.dataset.star); paint(); return; }
    const act = b.dataset.tr;
    if (act === "verify") {
      st.busy = "verify"; paint();
      try { st.verify = await verifyAgent(api, botId); } catch (err) { st.verify = { ok: false, msg: `Could not check: ${err.message}` }; }
      st.busy = null; paint();
    } else if (act === "validate") {
      st.busy = "validate"; st.msg = null; paint();
      try { await api(`/v1/trust/agents/${encodeURIComponent(botId)}/validate`, { method: "POST" }); st.msg = "Validation asked on-chain; the validator replays the fills and answers in a minute."; }
      catch (err) { st.msg = err.message; }
      st.busy = null; await load(); setTimeout(load, 20_000);
    } else if (act === "rate") { st.busy = st.busy === "rate" ? null : "rate"; paint(); }
    else if (act === "send-rate") {
      try { const tx = await rateAgent(st.t.identity.agentId, st.stars, location.href); st.msg = `Rating sent: ${tx}`; st.stars = 0; st.busy = null; setTimeout(load, 8_000); }
      catch (err) { st.msg = err.message ?? String(err); }
      paint();
    }
  });
  load();
  const timer = setInterval(() => { if (document.visibilityState === "visible" && !st.busy) load(); }, 20_000);
  return { refresh: load, destroy: () => clearInterval(timer) };
}

// ── the Trust tab ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function renderTrustView(root, { api, openAgent }) {
  root.innerHTML = `<div class="tr-wrap"><header class="tr-head"><h1>Trust</h1><p>Agents you can check: every agent has an ERC-8004 identity on Monad, every fill is committed on-chain as it happens, an independent key replays the record, and anyone can rate it.</p></header><div id="trBody"><div class="b-skel" style="height:160px"></div></div></div>`;
  const body = root.querySelector("#trBody");
  async function load() {
    let s, board;
    try { [s, board] = await Promise.all([api("/v1/trust/status"), api("/v1/agents/board?window=all")]); }
    catch (e) { body.innerHTML = `<p class="tr-note">${esc(e.message)}</p>`; return; }
    const rows = (board.agents ?? []).filter((a) => a.trust?.agentId);
    const c = s.contracts;
    body.innerHTML = `<div class="tr-kpis">
        <div class="tr-tile"><small>Agents with an ERC-8004 identity</small><b>${s.counts.agents}</b></div>
        <div class="tr-tile"><small>Fills committed on Monad</small><b>${s.counts.committed}</b><span>${s.counts.pending ? `${s.counts.pending} pending` : "none pending"}</span></div>
        <div class="tr-tile"><small>Validations answered</small><b>${s.counts.validations}</b></div>
        <div class="tr-tile"><small>Committer</small><b>${s.committer.enabled ? (s.committer.lastError ? "Waiting" : "Running") : "Off"}</b><span>${esc(s.committer.lastError ?? (s.committer.lastTickAt ? `last pass ${agoTxt(s.committer.lastTickAt)}` : ""))}</span></div>
      </div>
      <section class="tr-sec"><div class="b-sech"><h3>Contracts on Monad (chain ${s.chainId})</h3></div>
        <table class="tr-tbl"><tbody>
          <tr><td>ERC-8004 Identity Registry</td><td>${addrLink(c.identityRegistry)}</td><td>canonical</td></tr>
          <tr><td>ERC-8004 Reputation Registry</td><td>${addrLink(c.reputationRegistry)}</td><td>canonical</td></tr>
          <tr><td>ERC-8004 Validation Registry</td><td>${addrLink(c.validationRegistry)}</td><td>deployed by this project (proxy)</td></tr>
          <tr><td>TrackRecord</td><td>${addrLink(c.trackRecord)}</td><td>deployed by this project</td></tr>
          <tr><td>Operator (owns the identities, commits)</td><td>${addrLink(s.operator?.address)}</td><td>${s.operator?.mon != null ? `${Number(s.operator.mon).toFixed(3)} MON` : ""}</td></tr>
          <tr><td>Validator (replays, answers)</td><td>${addrLink(s.validator?.address)}</td><td>${s.validator?.mon != null ? `${Number(s.validator.mon).toFixed(3)} MON` : ""}</td></tr>
        </tbody></table></section>
      <section class="tr-sec"><div class="b-sech"><h3>Agents on the record</h3><small>${rows.length}</small></div>
        ${rows.length ? `<table class="tr-tbl"><thead><tr><th>Agent</th><th>ERC-8004</th><th>On-chain fills</th><th>Last commit</th><th>Validation</th><th></th></tr></thead><tbody>${rows.map((a) => `<tr>
          <td>${esc(a.name)}</td><td><a class="tr-ln" href="${EXPLORER}/token/${IDENTITY}?a=${esc(a.trust.agentId)}" target="_blank" rel="noopener">#${esc(a.trust.agentId)}</a></td>
          <td>${a.trust.committed}${a.trust.pending ? ` <small>(+${a.trust.pending})</small>` : ""}</td><td>${txLink(a.trust.lastCommitTx, agoTxt(a.trust.lastCommitAt))}</td>
          <td>${a.trust.validation ? `${a.trust.validation.response}/100` : "—"}</td><td><button type="button" class="b-btn sm" data-open="${esc(a.id)}">Open</button></td></tr>`).join("")}</tbody></table>` : `<p class="tr-note">No agent has traded yet.</p>`}
      </section>
      <section class="tr-sec"><div class="b-sech"><h3>Check it yourself</h3></div>
        <ol class="tr-steps"><li>Read <span class="mono">chains(agentId)</span> on TrackRecord: the head and the number of fills.</li><li>Fetch <span class="mono">/v1/trust/agents/&lt;id&gt;/fills</span>: the exact documents.</li><li>keccak-256 each document, fold them: head = keccak(head ‖ hash). Equal heads = the record you read is the one written as it happened.</li></ol>
      </section>`;
  }
  body.addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openAgent(b.dataset.open); });
  load();
  return { refresh: load };
}
