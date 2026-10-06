// Trade view: quote on Solana (Jupiter) or the EVM chains (Chord's router), then the person's own wallet signs.
// Solana: the server builds the transaction, the wallet signs it here, the server relays only what it built.
// EVM: the wallet switches chain, sends the approval if one is needed, then the swap.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s) => (s && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s ?? "");
const DEFAULT_PAIR = { solana: ["USDC", "SOL"], base: ["USDC", "ETH"], bnb: ["USDT", "BNB"], avalanche: ["USDC", "AVAX"], monad: ["USDC", "MON"], robinhood: ["USDG", "NVDA"], arc: ["USDC", "EURC"] };
const SOLSCAN = "https://solscan.io/tx/";

let D = null; // { icon, showView }
const S = { chain: "solana", chains: [], lists: {}, tin: null, tout: null, slip: 50, quote: null, quoteErr: null, loading: false, seq: 0, timer: null,
  sol: null, solKey: null, evm: null, busy: false, picking: null };

const chainDef = (k = S.chain) => S.chains.find((c) => c.key === k);
const isSol = () => S.chain === "solana";

export async function initTrade(deps) {
  D = deps;
  const r = await fetch("/v1/trade/chains").then((x) => x.json()).catch(() => ({ chains: [] }));
  S.chains = r.chains ?? [];
  $("chainList").innerHTML = S.chains.map((c) => `<button type="button" data-chain="${c.key}">${esc(c.name)} <small>${esc(c.provider)}</small></button>`).join("");
  $("chainBtn").addEventListener("click", () => { $("chainList").hidden = !$("chainList").hidden; });
  $("chainList").addEventListener("click", (e) => { const b = e.target.closest("[data-chain]"); if (b) { $("chainList").hidden = true; setChain(b.dataset.chain); } });
  $("slip").addEventListener("click", (e) => { const b = e.target.closest("[data-bps]"); if (!b) return; S.slip = Number(b.dataset.bps); $("slip").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); requote(); });
  $("amtIn").addEventListener("input", () => { $("amtIn").value = $("amtIn").value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"); requote(); });
  $("flipBtn").addEventListener("click", () => { [S.tin, S.tout] = [S.tout, S.tin]; if (S.quote) $("amtIn").value = S.quote.amountOut; renderTokens(); requote(); });
  $("tokInBtn").addEventListener("click", () => openPicker("in"));
  $("tokOutBtn").addEventListener("click", () => openPicker("out"));
  $("pickSearch").addEventListener("input", () => searchPicker());
  $("pickList").addEventListener("click", (e) => { const b = e.target.closest(".pick"); if (!b) return; const t = JSON.parse(b.dataset.t); if (S.picking === "in") { if (S.tout?.address === t.address) S.tout = S.tin; S.tin = t; } else { if (S.tin?.address === t.address) S.tin = S.tout; S.tout = t; } $("tokPick").hidden = true; renderTokens(); requote(); });
  $("goBtn").addEventListener("click", go);
  setInterval(() => { if (!$("tradev").hidden && !S.busy && S.quote && document.visibilityState === "visible") requote(true); }, 20_000);
  await setChain("solana");
}

/** Open the trade view, optionally prefilled from a chat swap card {chain, tokenIn, tokenOut, amount}. */
export async function openTrade(prefill) {
  D.showView("trade");
  if (prefill?.chain) {
    await setChain(prefill.chain, prefill.tokenIn && prefill.tokenOut ? [prefill.tokenIn, prefill.tokenOut] : null);
    if (prefill.amount) { $("amtIn").value = prefill.amount; requote(); }
  }
}

async function tokensOf(chain, q = "") {
  const key = `${chain}|${q}`;
  if (S.lists[key]) return S.lists[key];
  const r = await fetch(`/v1/trade/tokens?chain=${chain}${q ? `&q=${encodeURIComponent(q)}` : ""}`).then((x) => x.json()).catch(() => ({ tokens: [] }));
  return (S.lists[key] = r.tokens ?? []);
}

async function setChain(chain, pair) {
  S.chain = chain; S.quote = null; S.quoteErr = null;
  $("chainName").textContent = chainDef()?.name ?? chain;
  $("chainList").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.chain === chain));
  const list = await tokensOf(chain);
  const bySym = (s) => list.find((t) => t.symbol.toLowerCase() === s.toLowerCase());
  const [a, b] = DEFAULT_PAIR[chain] ?? [];
  S.tin = pair?.[0] ?? bySym(a) ?? list[0] ?? null;
  S.tout = pair?.[1] ?? bySym(b) ?? list[1] ?? null;
  $("txSteps").innerHTML = "";
  renderTokens(); requote();
}

const logo = (t) => `<span class="tlogo"><b>${esc((t?.symbol ?? "?").replace(/^\$/, "")[0] ?? "?")}</b>${t?.logoURI ? `<img src="${esc(t.logoURI)}" alt="" onerror="this.remove()">` : ""}</span>`;
const venue = (v) => String(v).replace(/_\d+$/, "").split("_").map((w) => (/^v\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
function renderTokens() {
  $("tokInBtn").innerHTML = S.tin ? `${logo(S.tin)}${esc(S.tin.symbol)}${D.icon("chev-d", true)}` : "Select";
  $("tokOutBtn").innerHTML = S.tout ? `${logo(S.tout)}${esc(S.tout.symbol)}${D.icon("chev-d", true)}` : "Select";
}

function requote(quiet) {
  clearTimeout(S.timer);
  const amount = $("amtIn").value.trim();
  if (!amount || Number(amount) <= 0 || !S.tin || !S.tout) { S.quote = null; S.quoteErr = null; renderQuote(); return; }
  if (!quiet) { S.loading = true; renderQuote(); }
  S.timer = setTimeout(async () => {
    const seq = ++S.seq;
    const qs = new URLSearchParams({ chain: S.chain, in: S.tin.address, out: S.tout.address, amount, slippageBps: String(S.slip) });
    if (!isSol() && S.evm) qs.set("taker", S.evm);
    const r = await fetch(`/v1/trade/quote?${qs}`).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : { message: "connection lost" };
    if (seq !== S.seq) return;
    S.loading = false;
    if (r?.ok) { S.quote = j; S.quoteErr = null; } else { S.quote = null; S.quoteErr = j.message ?? "no quote"; }
    renderQuote();
  }, quiet ? 0 : 350);
}

const fmt = (x) => { const n = Number(x); if (!Number.isFinite(n)) return String(x); return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : n.toPrecision(6).replace(/0+$/, "").replace(/\.$/, ""); };
function renderQuote() {
  const q = S.quote;
  $("amtOut").textContent = S.loading ? "…" : q ? fmt(q.amountOut) : "0";
  $("amtOut").classList.toggle("dim", !q);
  $("details").hidden = !q;
  if (q) {
    const rate = Number(q.amountOut) / Number(q.amountIn);
    const imp = q.priceImpactPct;
    $("details").innerHTML = [
      ["Rate", `1 ${esc(q.tokenIn.symbol)} = ${fmt(rate)} ${esc(q.tokenOut.symbol)}`],
      ["Price impact", imp == null ? "n/a" : `${imp < 0.01 ? "<0.01" : imp.toFixed(2)}%`, imp != null && imp > 3 ? "warn" : "good"],
      ["Minimum received", `${fmt(q.minAmountOut)} ${esc(q.tokenOut.symbol)}`],
      ["Route", esc(q.route?.length ? [...new Set(q.route.map(venue))].join(" · ") : "direct")],
      ["Provider", esc(q.provider)],
      ["Fee", q.feeBps ? `${(q.feeBps / 100).toFixed(2)}%` : "0%"],
    ].map(([k, v, cls]) => `<div><span>${k}</span><b class="${cls ?? ""}">${v}</b></div>`).join("");
  }
  const warns = (q?.warnings ?? []).filter((w) => !/INSUFFICIENT_BALANCE/.test(w) || S.evm);
  $("warns").innerHTML = S.quoteErr ? `<p>${esc(S.quoteErr)}</p>` : warns.map((w) => `<p>${esc(w.replace(/^[A-Z_]+:\s*/, ""))}</p>`).join("");
  renderGo();
}

function renderGo() {
  const b = $("goBtn");
  const amount = $("amtIn").value.trim();
  const connected = isSol() ? !!S.solKey : !!S.evm;
  b.disabled = S.busy;
  if (!connected) { b.textContent = isSol() ? "Connect Solana wallet" : "Connect wallet"; return; }
  if (!amount) { b.textContent = "Enter an amount"; b.disabled = true; return; }
  if (S.loading) { b.textContent = "Getting a quote…"; b.disabled = true; return; }
  if (!S.quote) { b.textContent = S.quoteErr ? "No route" : "Enter an amount"; b.disabled = true; return; }
  b.textContent = `Swap ${S.tin.symbol} for ${S.tout.symbol}`;
  $("fine").textContent = `${isSol() ? short(S.solKey) : short(S.evm)} signs. This app never holds keys or funds.`;
}

// ── picker ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function openPicker(which) {
  S.picking = which;
  $("pickSearch").value = "";
  $("tokPick").hidden = false;
  $("pickSearch").focus();
  renderPicker(await tokensOf(S.chain));
}
let pickTimer = null;
function searchPicker() {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(async () => { const q = $("pickSearch").value.trim(); renderPicker(await tokensOf(S.chain, q)); }, 250);
}
function renderPicker(list) {
  $("pickList").innerHTML = list.length ? list.map((t) => `<button type="button" class="pick" data-t='${esc(JSON.stringify(t))}'>${logo(t)}<span><b>${esc(t.symbol)}</b><small>${esc(t.name)}</small></span><span class="addr">${esc(short(t.address))}</span></button>`).join("")
    : `<p class="muted" style="padding:8px">No token matches. Paste the full address to look it up.</p>`;
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function step(text, state = "now") {
  const li = document.createElement("li");
  li.className = state;
  li.innerHTML = `${D.icon(state === "done" ? "check" : state === "bad" ? "x" : "spin", true)}<span>${text}</span>`;
  $("txSteps").append(li);
  return { done: (t) => { li.className = "done"; li.innerHTML = `${D.icon("check", true)}<span>${t ?? text}</span>`; }, fail: (t) => { li.className = "bad"; li.innerHTML = `${D.icon("x", true)}<span>${esc(t)}</span>`; } };
}
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function go() {
  if (S.busy) return;
  const connected = isSol() ? !!S.solKey : !!S.evm;
  try {
    if (!connected) return isSol() ? await connectSol() : await connectEvm();
    if (!S.quote) return;
    S.busy = true; renderGo();
    $("txSteps").innerHTML = "";
    if (isSol()) await swapSol(); else await swapEvm();
  } catch (e) {
    step(e?.message?.includes("User rejected") || e?.code === 4001 ? "You cancelled in the wallet." : esc(e?.message ?? String(e)), "bad");
  } finally {
    S.busy = false; renderGo();
  }
}

async function connectSol() {
  const p = window.phantom?.solana ?? window.solflare ?? window.backpack ?? window.solana;
  if (!p) throw new Error("No Solana wallet found in this browser. Install Phantom, Solflare or Backpack.");
  await p.connect();
  S.sol = p; S.solKey = p.publicKey.toString();
  renderGo();
}

async function connectEvm() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No EVM wallet found in this browser. Install MetaMask or Rabby.");
  const [a] = await eth.request({ method: "eth_requestAccounts" });
  S.evm = a;
  requote();
}

async function swapSol() {
  let s = step("Preparing the transaction");
  let built;
  const r = await fetch("/v1/trade/sol/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quoteId: S.quote.quoteId, user: S.solKey }) });
  built = await r.json();
  if (!r.ok) { requote(true); throw new Error(built.message ?? "could not prepare the swap"); }
  s.done("Transaction prepared");
  s = step("Confirm in your wallet");
  const web3 = await import("https://esm.sh/@solana/web3.js@1.98.0?bundle");
  const tx = web3.VersionedTransaction.deserialize(b64ToBytes(built.transaction));
  const signed = await S.sol.signTransaction(tx);
  s.done("Signed in your wallet");
  s = step("Sending to Solana");
  const sr = await fetch("/v1/trade/sol/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transaction: bytesToB64(signed.serialize()) }) });
  const sent = await sr.json();
  if (!sr.ok) throw new Error(sent.message ?? "the network refused the transaction");
  s.done(`Sent <a href="${SOLSCAN}${sent.signature}" target="_blank" rel="noopener">${short(sent.signature)} ↗</a>`);
  s = step("Waiting for confirmation");
  for (let i = 0; i < 45; i++) {
    await sleep(1500);
    const st = await fetch(`/v1/trade/sol/status?sig=${sent.signature}`).then((x) => x.json()).catch(() => null);
    if (st?.error) throw new Error(`The swap failed on chain: ${st.error}`);
    if (st?.status === "confirmed" || st?.status === "finalized") { s.done(`Swapped. <a href="${SOLSCAN}${sent.signature}" target="_blank" rel="noopener">View on Solscan ↗</a>`); requote(true); return; }
  }
  s.fail("Not confirmed after a minute. Check it on Solscan before trying again.");
}

async function ensureChain(q) {
  const eth = window.ethereum;
  const cur = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (cur === q.wallet.hex.toLowerCase()) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: q.wallet.hex }] });
  } catch (e) {
    if (e?.code !== 4902) throw e;
    if (!q.wallet.rpc) throw new Error(`Add ${q.wallet.name} to your wallet first, then try again.`);
    const native = q.wallet.native ?? { name: "USDC", symbol: "USDC", decimals: 18 };
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: q.wallet.hex, chainName: q.wallet.name, nativeCurrency: { name: native.name, symbol: native.symbol, decimals: native.decimals }, rpcUrls: [q.wallet.rpc], ...(q.wallet.explorer ? { blockExplorerUrls: [q.wallet.explorer.replace(/\/tx\/$/, "")] } : {}) }] });
  }
}

async function waitReceipt(hash) {
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const r = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (r) { if (r.status === "0x1") return r; throw new Error("The transaction reverted on chain."); }
  }
  throw new Error("No receipt after three minutes. Check the transaction in your wallet.");
}
const hex = (v) => (v == null ? undefined : String(v).startsWith("0x") ? String(v) : "0x" + BigInt(v).toString(16));

async function swapEvm() {
  const eth = window.ethereum;
  let s = step("Checking the network");
  await ensureChain(S.quote);
  s.done(`On ${esc(S.quote.wallet.name)}`);
  s = step("Getting the transaction for your wallet");
  const qs = new URLSearchParams({ chain: S.chain, in: S.tin.address, out: S.tout.address, amount: $("amtIn").value.trim(), slippageBps: String(S.slip), taker: S.evm });
  const r = await fetch(`/v1/trade/quote?${qs}`);
  const q = await r.json();
  if (!r.ok || !q.tx) throw new Error(q.message ?? "the router did not return a transaction");
  if (q.simulation && q.simulation.ok === false) throw new Error("The swap fails when simulated from your wallet. Nothing was sent.");
  S.quote = q; renderQuote();
  s.done("Transaction ready, simulated from your wallet");
  const explorer = q.wallet.explorer;
  const link = (h) => explorer ? `<a href="${explorer}${h}" target="_blank" rel="noopener">${short(h)} ↗</a>` : short(h);
  if (q.approval) {
    s = step(`Approve ${esc(q.tokenIn.symbol)} in your wallet`);
    const data = "0x095ea7b3" + q.approval.spender.slice(2).toLowerCase().padStart(64, "0") + BigInt(q.approval.amount).toString(16).padStart(64, "0");
    const ah = await eth.request({ method: "eth_sendTransaction", params: [{ from: S.evm, to: q.approval.token, data }] });
    s.done(`Approval sent ${link(ah)}`);
    s = step("Waiting for the approval");
    await waitReceipt(ah);
    s.done("Approved");
  }
  s = step("Confirm the swap in your wallet");
  const h = await eth.request({ method: "eth_sendTransaction", params: [{ from: S.evm, to: q.tx.to, data: q.tx.data, value: hex(q.tx.value ?? "0"), ...(q.tx.gas ?? q.tx.gasLimit ? { gas: hex(q.tx.gas ?? q.tx.gasLimit) } : {}) }] });
  s.done(`Swap sent ${link(h)}`);
  s = step("Waiting for the network");
  await waitReceipt(h);
  s.done(`Swapped. ${explorer ? `<a href="${explorer}${h}" target="_blank" rel="noopener">View the transaction ↗</a>` : ""}`);
  requote(true);
}
