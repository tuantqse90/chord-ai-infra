// Wallet view (ask2049-notes/PROMPT-solana-wallet.md, modelled on Chord's Ask wallet): the home chain is Solana. One account
// pill (Solana address + the EVM one under it), the total as one number, three actions (Deposit · Withdraw · Convert), then
// Holdings / Activity. Deposit = the address + a QR drawn here, or USDC on six EVM chains → USDC on Solana through Relay
// (quote → the EVM wallet signs → status until it lands). Withdraw = the server builds the transfer, the wallet signs, the
// server relays only what it built. Convert = the Jupiter lane of the Trade tab (/v1/trade/*), inline.
// API: /v1/wallet/* (src/walletRoutes.ts) + /v1/trade/*. Signers: the Chord account (Privy: window.askPrivy) or a browser
// extension (Phantom / Solflare / Backpack; MetaMask / Rabby for deposits), the way trade.js does it. Nothing moves until the
// person's own wallet signs. Hash routes: #wallet · #wallet/deposit · #wallet/deposit/evm · #wallet/withdraw · #wallet/convert ·
// #wallet/activity (panel changes replace the entry; app.js pushes #wallet when the view opens).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FEE_RESERVE = 10_000_000n; // lamports Max keeps for fees (0.01 SOL)
const DUST_USD = 0.01;
const SOLSCAN = "https://solscan.io/tx/";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINUS = "−";

// ── icons (24px stroke set, as app.js) ────────────────────────────────────────────────────────────────────────────────
const I = {
  down: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  up: '<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M5 19.5h14"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  spin: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  flip: '<path d="M8 4v16m0 0-3-3m3 3 3-3M16 20V4m0 0-3 3m3-3 3 3"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10.5h18M16.5 15h1.5M6 6l9-3 1 3"/>',
};
const svg = (n, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] ?? ""}</svg>`;
const ic = (n, sw) => `<i class="wl-ic${n === "spin" ? " wl-spin" : ""}">${svg(n, sw)}</i>`;
/** The Solana mark: three bars on the purple-to-green gradient. */
let solN = 0;
const solMark = (px = 16) => { const id = `wlsg${++solN}`; return `<svg class="wl-sol" width="${px}" height="${px}" viewBox="0 0 100 80" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="80" x2="100" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/></linearGradient></defs><g fill="url(#${id})"><path d="M16 0h84L84 16H0z"/><path d="M0 32h84l16 16H16z"/><path d="M16 64h84L84 80H0z"/></g></svg>`; };
/** A note behind (i): closed by default, the full sentence inside. */
const note = (html, label = "Notes") => `<details class="wl-i"><summary aria-label="${esc(label)}" title="${esc(label)}">${svg("info", 2)}</summary><div class="wl-ip">${html}</div></details>`;

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────────────────
const N = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const SUB = "₀₁₂₃₄₅₆₇₈₉";
const tinyZeros = (s) => s.replace(/^(-?\$?)0\.(0{4,})(\d+)$/, (_, p, z, d) => `${p}0.0${[...String(z.length)].map((c) => SUB[c]).join("")}${d.slice(0, 4)}`);
function usd(x, opts = {}) {
  const n = N(x); if (n == null) return "—";
  const a = Math.abs(n), s = n < 0 ? MINUS : opts.sign && n > 0 ? "+" : "";
  if (a > 0 && a < 0.01) return `${s}<$0.01`;
  if (opts.compact && a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  return `${s}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function price(x) {
  const p = N(x); if (p == null) return "—";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: p >= 100 ? 2 : 4 })}`;
  if (p <= 0) return "$0";
  const lead = Math.max(0, -Math.floor(Math.log10(p)) - 1); // never scientific: $3.149e-7 → $0.0₆3149
  return tinyZeros(`$${p.toFixed(Math.min(20, lead + 4)).replace(/0+$/, "")}`);
}
function amt(x) {
  const n = N(x); if (n == null || n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const lead = Math.max(0, -Math.floor(Math.log10(a)) - 1);
  return tinyZeros(n.toFixed(Math.min(18, lead + 4)).replace(/\.?0+$/, ""));
}
const pct = (x) => { const n = N(x); if (n == null) return "—"; const t = Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 2); return `${Number(t) === 0 ? "" : n > 0 ? "+" : MINUS}${t}%`; };
const tone = (x) => { const n = N(x); return n == null || Math.abs(n) < 0.005 ? "" : n > 0 ? "wl-up" : "wl-down"; };
const short = (s, a = 4, b = 4) => { s = String(s ?? ""); return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
const ago = (ms) => { const s = Math.max(1, Math.floor((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const hueOf = (s) => { let h = 7; for (const ch of String(s ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (sym) => (String(sym ?? "").replace(/^\$/, "").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase();
const ownLogo = (mint) => `/v1/logo/solana/${mint}`;
/** A token picture over its monogram (app.js fades it in on load and falls back to data-alt, then to the monogram). */
function tlogo(t, cls = "") {
  const mint = t.mint === "SOL" ? SOL_MINT : t.mint;
  const third = t.logo && /^(https:\/\/|\/v1\/logo\/)/.test(t.logo) ? t.logo : null;
  const src = mint ? ownLogo(mint) : third; // same-origin first: IPFS pictures asked from a browser mostly get 429
  const alt = mint && third && third !== src ? third : null;
  return `<span class="tlogo ${cls}" style="--mh:${hueOf(mint ?? t.symbol)}"><b>${esc(initials(t.symbol))}</b>${src ? `<img data-tl src="${esc(src)}"${alt ? ` data-alt="${esc(alt)}"` : ""} alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}
// exact decimal strings ↔ raw integers (no floats on the way to a transaction)
function toRaw(text, decimals) {
  const s = String(text ?? "").trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) return null;
  return BigInt((i || "0") + f.padEnd(decimals, "0"));
}
function fromRaw(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals), f = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return f ? `${i}.${f}` : i;
}
const cleanNum = (v) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cancelled = (e) => e?.code === 4001 || /user rejected|rejected the request|denied|exited|cancel/i.test(e?.message ?? "");
const plainErr = (e) => (cancelled(e) ? "You cancelled in the wallet." : String(e?.message ?? e ?? "Something went wrong.").split("\n")[0].slice(0, 200));

async function api(path, init) {
  let r;
  try { r = await fetch(path, init ? { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } } : undefined); } catch { throw new Error("Connection lost. Check your network and try again."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message ?? `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

// ── QR code (byte mode, error correction M, versions 1–10): the Deposit address drawn here, no QR service ──────────────
// After Nayuki's reference generator: data → Reed-Solomon blocks → interleave → zigzag placement → the mask with the lowest
// penalty. Versions 1–10 hold up to 213 bytes at level M: a Solana address (32–44) fits in version 4. Checked against jsQR.
const QR_ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // codewords per block
const QR_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
function qrRawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
  return r;
}
const qrDataCodewords = (v) => Math.floor(qrRawModules(v) / 8) - QR_ECC_M[v] * QR_BLOCKS_M[v];
function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
function rsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
  for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}
function qrAlign(v, size) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, out = [6];
  for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}
/** The module matrix (true = dark) for `text`, or null when it does not fit version 10. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  for (; v <= 10; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= qrDataCodewords(v) * 8) break;
  if (v > 10) return null;
  const cap = qrDataCodewords(v) * 8, bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length)); put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const nb = QR_BLOCKS_M[v], ecl = QR_ECC_M[v], raw = Math.floor(qrRawModules(v) / 8), nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecl), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1)); k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });
  const size = v * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = qrAlign(v, size);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (mask) => {
    const d = mask; // level M = 00
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (v >= 7) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
  }
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < cw.length * 8) { mod[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const apply = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    const line = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1, s = "";
        for (let b = 0; b < size; b++) {
          const c = get(a, b); s += c ? "1" : "0";
          if (b > 0) { if (c === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
        }
        s = `0000${s}0000`;
        for (let k = s.indexOf("1011101"); k !== -1; k = s.indexOf("1011101", k + 1)) if (s.slice(k - 4, k) === "0000" || s.slice(k + 7, k + 11) === "0000") p += 40;
      }
    };
    line((a, b) => mod[a][b]); line((a, b) => mod[b][a]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
    for (const row of mod) for (const c of row) if (c) dark++;
    const total = size * size;
    return p + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); format(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } apply(m); }
  apply(best); format(best);
  return mod;
}
/** The code as one SVG path, dark on white with the four-module quiet zone scanners expect (in both themes). */
function qrSvg(text) {
  const m = qrMatrix(text);
  if (!m) return "";
  const n = m.length, q = 4, w = n + q * 2;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  return `<svg viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges" role="img" aria-label="QR code of the address"><rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="#0b0a12"/></svg>`;
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────
let D = null, root = null;
const S = {
  open: false, panel: null, tab: "holdings", depTab: "solana",
  ext: null, // { name, prov, address } a Solana browser extension connected here
  useExt: false,
  bal: null, balErr: null, balFor: null, balLoading: false, balSeq: 0, showSmall: false, showUnpriced: false,
  act: null, actErr: null, actFor: null, actLoading: false,
  sources: null, // Relay deposit chains from /v1/wallet/relay/chains
  evm: { mode: null, browser: null, bal: {}, balFor: null, chain: "base", amount: "", quote: null, quoteAt: 0, quoteErr: null, quoting: false, seq: 0, timer: null, busy: false },
  wd: { mint: "SOL", to: "", amount: "", built: null, phase: "form", err: null, picking: false, q: "" },
  cv: { from: "SOL", to: null, amount: "", quote: null, quoteAt: 0, quoteErr: null, quoting: false, seq: 0, timer: null, busy: false, picking: null, q: "", search: [] },
  steps: [],
};
const PV = () => window.askPrivy?.state ?? null;
const solAddr = () => (S.useExt && S.ext ? S.ext.address : PV()?.authenticated && PV()?.sol ? PV().sol : S.ext?.address ?? null);
const signerKind = () => (S.useExt && S.ext ? "ext" : PV()?.authenticated && PV()?.sol ? "privy" : S.ext ? "ext" : null);
const evmAddr = () => (S.evm.mode === "browser" ? S.evm.browser : PV()?.authenticated ? PV()?.evm ?? null : null);
const solExtensions = () => [["Phantom", window.phantom?.solana], ["Solflare", window.solflare], ["Backpack", window.backpack]].filter(([, p]) => p);

/** deps: { showView(v), loadPrivy(), signIn(), privyConfigured(), openTrade(prefill) }. Renders into <section id="walletv">. */
export function initWallet(deps) {
  D = deps ?? {};
  root = $("walletv");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";
  root.innerHTML = `<div class="wl-wrap"><header class="wl-head"><div class="wl-ttl"><h1>Wallet</h1><span class="wl-chip">${solMark(13)}Solana</span>${note("<p>A Solana wallet whose keys stay with you: the Chord account's embedded wallet (Privy) or a browser extension. Every transfer is built here, shown to you, and signed by your wallet; this site never holds keys or funds.</p><p>Balances are read from the chain, priced by Jupiter.</p>", "About the wallet")}</div><button type="button" class="wl-btn sm" data-act="refresh" title="Read the balances again">${ic("refresh")}Refresh</button></header><div id="wlBody"></div></div>`;
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", (e) => { if (e.key === "Escape") root.querySelectorAll("details.wl-i[open]").forEach((d) => d.removeAttribute("open")); });
  document.addEventListener("click", (e) => { root.querySelectorAll("details.wl-i[open]").forEach((d) => { if (!d.contains(e.target)) d.removeAttribute("open"); }); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !root.hidden) refresh(); });
  setInterval(() => { if (!root.hidden && document.visibilityState === "visible" && !busy()) loadBalances(); }, 30_000);
}

/** Open the view. `sub` = a #wallet/… hash or a panel name ("deposit", "deposit/evm", "withdraw", "convert", "activity"). */
export function openWallet(sub) {
  if (!root) return;
  D.showView?.("wallet");
  const h = String(sub ?? location.hash ?? "").replace(/^#?wallet\/?/, "");
  if (h === "activity") { S.tab = "activity"; S.panel = null; }
  else if (h.startsWith("deposit")) { S.panel = "deposit"; S.depTab = h === "deposit/evm" ? "evm" : "solana"; }
  else if (h === "withdraw" || h === "convert") S.panel = h;
  else if (h === "") S.panel = null;
  render();
  refresh();
}

/** Called by the page whenever the Chord account changes (signed in, wallet created, signed out). */
let lastKey = "";
export function privyChanged() {
  if (!root) return;
  const s = PV();
  const key = `${s?.ready}|${s?.authenticated}|${s?.sol}|${s?.evm}|${s?.error}|${s?.funding}`;
  if (key === lastKey) return;
  lastKey = key;
  if (!root.hidden) { render(); refresh(); }
}

const busy = () => S.evm.busy || S.cv.busy || ["signing", "sending", "confirming", "building"].includes(S.wd.phase);
function setHash() {
  if (root.hidden) return;
  const h = S.tab === "activity" && !S.panel ? "#wallet/activity" : S.panel === "deposit" ? (S.depTab === "evm" ? "#wallet/deposit/evm" : "#wallet/deposit") : S.panel ? `#wallet/${S.panel}` : "#wallet";
  if (location.hash !== h) try { history.replaceState(history.state, "", location.pathname + location.search + h); } catch {}
}
function refresh() { loadBalances(); if (S.tab === "activity") loadActivity(); if (S.panel === "deposit" && S.depTab === "evm") loadEvm(); }

// ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function loadBalances(fresh = false) {
  const a = solAddr();
  if (!a) return;
  const seq = ++S.balSeq;
  if (S.balFor !== a) { S.bal = null; S.balErr = null; S.act = null; S.balFor = a; renderBody(); }
  S.balLoading = true; paintRefresh();
  try {
    const j = await api(`/v1/wallet/solana/${a}${fresh ? "?fresh=1" : ""}`);
    if (seq !== S.balSeq || a !== solAddr()) return;
    S.bal = j; S.balErr = null;
  } catch (e) { if (seq === S.balSeq) S.balErr = plainErr(e); }
  finally { if (seq === S.balSeq) { S.balLoading = false; paintRefresh(); renderBalances(); } }
}
async function loadActivity() {
  const a = solAddr();
  if (!a) return;
  S.actLoading = true;
  if (S.actFor !== a) { S.act = null; S.actFor = a; }
  try { const j = await api(`/v1/wallet/solana/${a}/activity`); if (a === solAddr()) { S.act = j; S.actErr = null; } }
  catch (e) { S.actErr = plainErr(e); }
  finally { S.actLoading = false; if (S.tab === "activity") renderList(); }
}

// holdings in one shape: SOL first-class (mint "SOL"), every SPL token with a balance
function holdings() {
  const b = S.bal; if (!b) return [];
  const solRow = { mint: "SOL", symbol: "SOL", name: "Solana", decimals: 9, raw: b.sol.lamports, amount: b.sol.amount, priceUsd: b.sol.priceUsd, valueUsd: b.sol.valueUsd, change24h: b.sol.change24h, logo: b.sol.logo, native: true };
  const rows = [solRow, ...b.tokens.map((t) => ({ ...t, native: false }))];
  return rows.sort((x, y) => (x.valueUsd == null && y.valueUsd == null ? x.symbol.localeCompare(y.symbol) : x.valueUsd == null ? 1 : y.valueUsd == null ? -1 : y.valueUsd - x.valueUsd));
}
const holdingOf = (mint) => holdings().find((h) => h.mint === mint) ?? null;

// ── render ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function render() { renderBody(); setHash(); }
function paintRefresh() { const b = root?.querySelector('[data-act="refresh"]'); if (b) { b.disabled = !!S.balLoading; b.querySelector(".wl-ic")?.classList.toggle("wl-spin", !!S.balLoading); } }

function renderBody() {
  const body = $("wlBody"); if (!body) return;
  const s = PV(), a = solAddr();
  const rb = root.querySelector('.wl-head [data-act="refresh"]'); if (rb) rb.hidden = !a;
  if (!a) { body.innerHTML = signedOutHtml(s); return; }
  const kind = signerKind();
  const evm = PV()?.authenticated ? PV()?.evm : null;
  body.innerHTML = `
    <section class="wl-card wl-acct">
      <div class="wl-acct-top">
        <div class="wl-ids">
          <button type="button" class="wl-pill" data-copy="${esc(a)}" title="Copy ${esc(a)}">${solMark(15)}<span class="wl-mono">${esc(short(a, 5, 5))}</span>${ic("copy")}</button>
          ${evm ? `<button type="button" class="wl-evm" data-copy="${esc(evm)}" title="Copy ${esc(evm)}"><span>EVM</span><span class="wl-mono">${esc(short(evm, 6, 4))}</span>${ic("copy")}</button>` : ""}
        </div>
        <div class="wl-src">${kind === "privy" ? "Chord wallet" : esc(S.ext?.name ?? "Browser wallet")}${S.ext && PV()?.authenticated && PV()?.sol ? `<button type="button" class="wl-link" data-act="switch-signer">${kind === "privy" ? `Use ${esc(S.ext.name)}` : "Use Chord wallet"}</button>` : kind === "ext" ? `<button type="button" class="wl-link" data-act="disconnect">Disconnect</button>` : ""}</div>
      </div>
      <div class="wl-total" id="wlTotal"></div>
      <div class="wl-actions" role="group" aria-label="Wallet actions">
        ${[["deposit", "down", "Deposit"], ["withdraw", "up", "Withdraw"], ["convert", "swap", "Convert"]].map(([k, icn, l]) => `<button type="button" class="wl-action${S.panel === k ? " on" : ""}" data-panel="${k}" aria-pressed="${S.panel === k}">${ic(icn, 2)}<span>${l}</span></button>`).join("")}
      </div>
      <div id="wlPanel"></div>
    </section>
    <div id="wlAuto"></div>
    <section class="wl-card wl-listc">
      <div class="wl-tabs" role="tablist">
        <button type="button" role="tab" data-tab="holdings" class="${S.tab === "holdings" ? "on" : ""}" aria-selected="${S.tab === "holdings"}">Holdings<span class="wl-cnt" id="wlCnt"></span></button>
        <button type="button" role="tab" data-tab="activity" class="${S.tab === "activity" ? "on" : ""}" aria-selected="${S.tab === "activity"}">Activity</button>
      </div>
      <div id="wlList"></div>
    </section>
    <p class="wl-foot">${ic("lock")}<span>Keys stay with your wallet. Nothing moves until you sign it.</span></p>`;
  renderBalances();
  renderPanel();
  mountAuto();
}

// Auto-trade for the account (autotrade.js): one card, kept across repaints (the same node is put back in place)
let auto = null;
function mountAuto() {
  const host = $("wlAuto"); if (!host) return;
  if (!D.privyConfigured?.()) { host.remove(); return; }
  if (auto) { host.replaceWith(auto.el); auto.api?.refresh(); return; }
  const el = document.createElement("div"); el.id = "wlAuto"; el.className = "wl-auto"; host.replaceWith(el);
  auto = { el, api: null };
  import(`./autotrade.js${new URL(import.meta.url).search}`).then((m) => {
    auto.api = m.mountAutoTrade(el, { session: D.session, onNewAgent: () => D.openAgents?.("#agents/new"), openAgent: (id) => D.openAgents?.(`#agents/${encodeURIComponent(id)}`) });
  }).catch(() => { el.remove(); auto = null; });
}

function signedOutHtml(s) {
  const exts = solExtensions();
  const extBtns = exts.map(([n]) => `<button type="button" class="wl-btn" data-connect="${esc(n)}">Connect ${esc(n)}</button>`).join("");
  if (s?.authenticated && !s.sol) {
    return `<section class="wl-card wl-empty">${solMark(34)}<h2>Create your Solana wallet</h2><p>Your Chord account has an EVM wallet${s.evm ? ` <span class="wl-mono">${esc(short(s.evm, 6, 4))}</span>` : ""}. Add its Solana wallet to deposit, send and convert here.</p><button type="button" class="wl-cta" data-act="create-sol">Create Solana wallet</button><p class="wl-msg" id="wlMsg"></p></section>`;
  }
  const privy = D.privyConfigured?.();
  return `<section class="wl-card wl-empty">${solMark(34)}<h2>Your Solana wallet</h2><p>${privy ? "Sign in to open a Solana wallet you hold the keys to." : "Connect a Solana wallet to see it here."}</p>
    ${privy ? `<button type="button" class="wl-cta" data-act="signin">${s && !s.ready && !s.error ? "Loading…" : "Sign in"}</button>` : ""}
    ${extBtns ? `<div class="wl-alt">${privy ? "<span>or</span>" : ""}${extBtns}</div>` : privy ? "" : `<p class="wl-sub">No Solana extension in this browser (Phantom, Solflare, Backpack).</p>`}
    <p class="wl-msg${s?.error ? " bad" : ""}" id="wlMsg">${s?.error ? esc(s.error) : ""}</p></section>`;
}

function renderBalances() {
  const t = $("wlTotal"); if (!t) return;
  const b = S.bal;
  if (!b) {
    t.innerHTML = S.balErr ? `<div class="wl-err">${esc(S.balErr)} <button type="button" class="wl-link" data-act="refresh">Try again</button></div>` : `<b class="wl-big"><span class="w-sk" style="width:180px;height:34px"></span></b><span class="wl-chg"><span class="w-sk" style="width:120px"></span></span>`;
  } else {
    const hs = holdings();
    t.innerHTML = `<b class="wl-big w-num">${usd(b.totalUsd)}</b>
      <span class="wl-chg ${tone(b.change24hUsd)}">${b.change24hUsd == null ? "24h change n/a" : `${usd(b.change24hUsd, { sign: true })} <span>${pct(b.change24hPct)}</span> 24h`}</span>
      <span class="wl-meta w-num">${amt(b.sol.amount)} SOL · ${hs.length - 1} token${hs.length === 2 ? "" : "s"}${b.unpriced ? ` · ${b.unpriced} no price` : ""}${b.truncated ? ` · ${b.truncated} not priced` : ""}</span>
      ${S.balErr ? `<span class="wl-stale">Last read ${ago(b.at)}: ${esc(S.balErr)}</span>` : ""}`;
  }
  const c = $("wlCnt"); if (c) c.textContent = b ? String(holdings().length) : "";
  if (S.tab === "holdings") renderList();
  // panels that read balances: painted in full the first time, after that only their available line (a refresh every 30 s
  // must never repaint an input someone is typing in)
  if (S.panel === "withdraw") { if (!$("wlWdAmt") && S.wd.phase === "form" && !S.wd.picking) paintWd(); else paintAvail(); }
  if (S.panel === "convert") { if (!$("wlCvAmt") && !S.cv.picking) paintCv(); else paintAvail(); }
}
function paintAvail() {
  const wd = holdingOf(S.wd.mint), wdEl = root.querySelector("#wlWd .wl-tokb small");
  if (wd && wdEl) wdEl.textContent = `${amt(fromRaw(maxSend(wd), wd.decimals))} available`;
  const cv = holdingOf(S.cv.from), cvEl = root.querySelector("#wlCv .wl-avail");
  if (cv && cvEl) cvEl.textContent = `${amt(fromRaw(maxSend(cv), cv.decimals))} available`;
}

function renderList() {
  const el = $("wlList"); if (!el) return;
  if (S.tab === "activity") { el.innerHTML = activityHtml(); return; }
  const b = S.bal;
  if (!b) { el.innerHTML = S.balErr ? "" : Array.from({ length: 5 }, () => `<div class="wl-row sk"><span class="tlogo"></span><span class="w-sk" style="width:38%"></span><span class="w-sk" style="width:18%;margin-left:auto"></span></div>`).join(""); return; }
  const hs = holdings();
  const main = hs.filter((h) => h.valueUsd != null && h.valueUsd >= DUST_USD);
  const small = hs.filter((h) => h.valueUsd != null && h.valueUsd < DUST_USD);
  const none = hs.filter((h) => h.valueUsd == null);
  if (hs.length === 1 && N(b.sol.lamports) === 0) {
    el.innerHTML = `<div class="wl-none"><b>Nothing here yet</b><span>Send SOL or any SPL token to this address, or bring USDC from another chain.</span><button type="button" class="wl-btn" data-panel="deposit">${ic("down", 2)}Deposit</button></div>`;
    return;
  }
  const head = `<div class="wl-row wl-rh" aria-hidden="true"><span>Token</span><span class="r wl-cp">Price</span><span class="r wl-c24">24h</span><span class="r wl-ca">Balance</span><span class="r">Value</span></div>`;
  const fold = (key, open, label, n, value) => `<button type="button" class="wl-row wl-fold" data-fold="${key}" aria-expanded="${open}"><span class="wl-foldn w-num">+${n}</span><span class="wl-tk"><b>${label}</b><small>${n} token${n === 1 ? "" : "s"}</small></span><span class="r wl-cp"></span><span class="r wl-c24"></span><span class="r wl-ca"></span><span class="r w-num">${value}${ic("chev")}</span></button>`;
  const UNPRICED_OPEN = 5;
  el.innerHTML = head + main.map(rowHtml).join("")
    + (small.length ? fold("small", S.showSmall, "Small balances", small.length, small.reduce((s, h) => s + h.valueUsd, 0) > 0 ? "<$0.01" : "$0.00") + (S.showSmall ? small.map(rowHtml).join("") : "") : "")
    + (none.length ? (none.length <= UNPRICED_OPEN ? none.map(rowHtml).join("") : fold("none", S.showUnpriced, "No price", none.length, "no price") + (S.showUnpriced ? none.map(rowHtml).join("") : "")) : "");
}
function rowHtml(h) {
  return `<button type="button" class="wl-row" data-row="${esc(h.mint)}" title="Convert or send ${esc(h.symbol)}">
    ${tlogo(h)}<span class="wl-tk"><b>${esc(h.symbol)}</b><small>${esc(h.native ? "Gas coin" : h.name ?? short(h.mint))}</small></span>
    <span class="r wl-cp w-num">${price(h.priceUsd)}</span>
    <span class="r wl-c24 w-num ${tone(h.change24h)}">${h.change24h == null ? "" : pct(h.change24h)}</span>
    <span class="r wl-ca w-num">${amt(h.amount)}</span>
    <span class="r wl-cv"><b class="w-num${h.valueUsd == null ? " dim" : ""}">${h.valueUsd == null ? "no price" : usd(h.valueUsd)}</b><small class="w-num"><span class="wl-am">${amt(h.amount)} ${esc(h.symbol)}</span><span class="${tone(h.change24h)}">${h.change24h == null ? "" : pct(h.change24h)}</span></small></span>
  </button>`;
}

function activityHtml() {
  const a = S.act;
  if (!a) return S.actErr ? `<div class="wl-err pad">${esc(S.actErr)} <button type="button" class="wl-link" data-act="activity">Try again</button></div>` : Array.from({ length: 4 }, () => `<div class="wl-row sk"><span class="tlogo"></span><span class="w-sk" style="width:44%"></span><span class="w-sk" style="width:16%;margin-left:auto"></span></div>`).join("");
  const items = a.items ?? [];
  const warn = a.swapsError ? `<p class="wl-sub pad">Swaps are not available right now (${esc(a.swapsError)}).</p>` : "";
  if (!items.length) return warn + `<div class="wl-none"><b>No activity yet</b><span>Swaps on Solana and the transfers you make here show up in this list.</span></div>`;
  return warn + items.map((x) => {
    const sym = x.symbol || short(x.mint ?? "");
    const t = { mint: x.mint, symbol: sym, logo: x.mint ? ownLogo(x.mint) : null };
    let title, sub, val, valTone = "", href;
    if (x.kind === "swap") {
      title = `${x.side === "buy" ? "Bought" : "Sold"} ${esc(sym)}`;
      sub = [x.venue ? esc(venueName(x.venue)) : null, ago(x.at)].filter(Boolean).join(" · ");
      val = x.usd == null ? "" : `${x.side === "buy" ? MINUS : "+"}${usd(x.usd).replace(/^−/, "")}`; valTone = x.side === "sell" ? "wl-up" : "";
      href = SOLSCAN + x.ref;
    } else if (x.kind === "send") {
      title = `Sent ${esc(sym)}`;
      sub = `to <span class="wl-mono">${esc(short(x.counterparty ?? ""))}</span> · ${ago(x.at)}${statusTag(x.status)}`;
      val = x.usd == null ? "" : `${MINUS}${usd(x.usd)}`; href = SOLSCAN + x.ref;
    } else {
      title = `Deposit ${esc(sym)}`;
      sub = `from ${esc(chainName(x.chain))} · Relay · ${ago(x.at)}${statusTag(x.status)}`;
      val = x.usd == null ? "" : `+${usd(x.usd)}`; valTone = "wl-up"; href = `https://relay.link/transaction/${x.ref}`;
    }
    return `<a class="wl-row wl-act" href="${esc(href)}" target="_blank" rel="noopener">${tlogo(t)}<span class="wl-tk"><b>${title}</b><small>${sub}</small></span><span class="r wl-cv"><b class="w-num ${valTone}">${val}</b><small class="w-num">${x.amount != null ? `${x.kind === "swap" ? (x.side === "buy" ? "+" : MINUS) : x.kind === "send" ? MINUS : "+"}${amt(x.amount)} ${esc(sym)}` : ""}</small></span><span class="wl-go">${ic("ext")}</span></a>`;
  }).join("");
}
const statusTag = (s) => (s === "confirmed" || s === "finalized" || s === "success" ? "" : ` · <span class="wl-st ${s === "failed" || s === "failure" || s === "refund" ? "bad" : ""}">${esc(s === "sent" || s === "pending" || s === "processed" ? "pending" : s)}</span>`);
const venueName = (v) => String(v).split("_").map((w) => (/^v\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ").replace(/^Pumpfun$/, "Pump.fun").replace(/^Pumpswap$/, "PumpSwap");
const chainName = (k) => S.sources?.find((s) => s.key === k)?.name ?? ({ base: "Base", arbitrum: "Arbitrum", ethereum: "Ethereum", optimism: "Optimism", polygon: "Polygon", bnb: "BNB Chain" })[k] ?? String(k ?? "");

// ── panels ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderPanel() {
  const el = $("wlPanel"); if (!el) return;
  root.querySelectorAll(".wl-action").forEach((b) => { const on = b.dataset.panel === S.panel; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  if (!S.panel) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="wl-panel">${S.panel === "deposit" ? depositHtml() : S.panel === "withdraw" ? `<div id="wlWd"></div>` : `<div id="wlCv"></div>`}</div>`;
  if (S.panel === "withdraw") paintWd();
  if (S.panel === "convert") paintCv();
  if (S.panel === "deposit" && S.depTab === "evm") { paintEvm(); loadEvm(); }
}

// Deposit ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function depositHtml() {
  const a = solAddr();
  const seg = `<div class="wl-seg" role="tablist"><button type="button" role="tab" data-dep="solana" class="${S.depTab === "solana" ? "on" : ""}">${solMark(12)}On Solana</button><button type="button" role="tab" data-dep="evm" class="${S.depTab === "evm" ? "on" : ""}">Other chains</button></div>`;
  if (S.depTab === "evm") return seg + `<div id="wlEvm"></div>`;
  const fund = PV()?.authenticated && PV()?.funding && typeof window.askPrivy?.fundSol === "function" && signerKind() === "privy";
  return seg + `<div class="wl-recv">
      <div class="wl-qr">${qrSvg(a)}</div>
      <div class="wl-recv-r">
        <div class="wl-lbl wl-ih">Your address${note("<p>Send only on the Solana network. A token sent from another network to this address does not arrive; to bring USDC from Base, Arbitrum, Ethereum, Optimism, Polygon or BNB Chain use Other chains.</p>", "Which network")}</div>
        <code class="wl-addr">${esc(a)}</code>
        <button type="button" class="wl-btn" data-copy="${esc(a)}">${ic("copy")}Copy address</button>
        <p class="wl-line">Send SOL or any SPL token to this address.</p>
        <p class="wl-line dim">${solMark(12)}Keep about 0.01 SOL for network fees.</p>
        ${fund ? `<button type="button" class="wl-btn" data-act="fund">${ic("card")}Buy with card</button>` : ""}
      </div>
    </div>`;
}

async function loadSources() {
  if (S.sources) return S.sources;
  const j = await api("/v1/wallet/relay/chains");
  S.sources = j.sources ?? [];
  return S.sources;
}
async function evmCall(src, method, params) {
  let last = null;
  for (const url of src.rpc) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result;
    } catch (e) { last = e; }
  }
  throw last ?? new Error("no RPC answered");
}
/** USDC + the gas coin on each deposit chain, read in this browser from the chains' public RPCs. */
async function loadEvm() {
  const who = evmAddr();
  try { await loadSources(); } catch (e) { S.evm.quoteErr = plainErr(e); paintEvm(); return; }
  if (!who) { paintEvm(); return; }
  if (S.evm.balFor !== who || !$("wlChains")) { if (S.evm.balFor !== who) { S.evm.bal = {}; S.evm.balFor = who; } paintEvm(); }
  const data = "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0");
  await Promise.all(S.sources.map(async (src) => {
    try {
      const [usdc, gas] = await Promise.all([evmCall(src, "eth_call", [{ to: src.usdc, data }, "latest"]), evmCall(src, "eth_getBalance", [who, "latest"])]);
      if (who !== evmAddr()) return;
      S.evm.bal[src.key] = { usdc: BigInt(usdc === "0x" ? "0x0" : usdc), gas: BigInt(gas), ok: true };
    } catch { if (who === evmAddr()) S.evm.bal[src.key] = { ok: false }; }
    if (S.panel === "deposit" && S.depTab === "evm") paintEvmChains();
  }));
}
function paintEvm() {
  const el = $("wlEvm"); if (!el) return;
  const who = evmAddr();
  const privyOn = PV()?.authenticated && PV()?.evm;
  const modes = `<div class="wl-from"><span class="wl-lbl">Pay from</span>${privyOn ? `<button type="button" class="wl-opt${S.evm.mode !== "browser" ? " on" : ""}" data-evm="privy">Chord wallet <span class="wl-mono">${esc(short(PV().evm, 6, 4))}</span></button>` : ""}<button type="button" class="wl-opt${S.evm.mode === "browser" ? " on" : ""}" data-evm="browser">${S.evm.browser ? `Browser wallet <span class="wl-mono">${esc(short(S.evm.browser, 6, 4))}</span>` : "Browser wallet"}</button></div>`;
  if (!who) {
    el.innerHTML = modes + `<p class="wl-line dim">${privyOn ? "" : D.privyConfigured?.() ? "Sign in to pay from your Chord wallet, or connect MetaMask / Rabby. " : "Connect MetaMask or Rabby. "}USDC on Base, Arbitrum, Ethereum, Optimism, Polygon or BNB Chain arrives as USDC on Solana.</p>`;
    return;
  }
  const e = S.evm;
  const src = S.sources?.find((s) => s.key === e.chain) ?? S.sources?.[0];
  el.innerHTML = modes + `<div class="wl-chains" id="wlChains"></div>
    <label class="wl-field"><span class="wl-lbl wl-ih"><span>Amount</span><span class="wl-avail w-num" id="wlEvmAvail"></span></span>
      <span class="wl-inrow"><input id="wlEvmAmt" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${esc(e.amount)}"><span class="wl-unit">USDC on ${esc(src?.name ?? "")}</span><button type="button" class="wl-btn sm" data-act="evm-max">Max</button></span></label>
    <div class="wl-quote" id="wlEvmQ"></div>
    <button type="button" class="wl-cta" id="wlEvmGo" data-act="evm-go">Deposit</button>
    <ol class="wl-steps" id="wlEvmSteps"></ol>`;
  paintEvmChains(); paintEvmQuote();
}
function paintEvmChains() {
  const el = $("wlChains"); if (!el || !S.sources) return;
  el.innerHTML = S.sources.map((s) => {
    const b = S.evm.bal[s.key];
    const v = !b ? `<span class="w-sk" style="width:42px"></span>` : !b.ok ? `<span class="dim">unavailable</span>` : `${amt(fromRaw(b.usdc, s.decimals))}`;
    return `<button type="button" class="wl-chainb${S.evm.chain === s.key ? " on" : ""}" data-chain="${s.key}"><b>${esc(s.name)}</b><span class="w-num">${v}<small> USDC</small></span></button>`;
  }).join("");
  const src = S.sources.find((s) => s.key === S.evm.chain), b = S.evm.bal[S.evm.chain];
  const av = $("wlEvmAvail"); if (av) av.textContent = b?.ok && src ? `${amt(fromRaw(b.usdc, src.decimals))} USDC available` : "";
  paintEvmGo();
}
function paintEvmQuote() {
  const el = $("wlEvmQ"); if (!el) return;
  const e = S.evm, q = e.quote;
  if (e.quoteErr) { el.innerHTML = `<p class="wl-warn">${esc(e.quoteErr)}</p>`; paintEvmGo(); return; }
  if (!q && !e.quoting) { el.innerHTML = ""; paintEvmGo(); return; }
  if (!q) { el.innerHTML = `<div class="wl-kv"><span>You receive</span><b><span class="w-sk" style="width:90px"></span></b></div>`; paintEvmGo(); return; }
  const fee = q.fees?.totalUsd, gasTx = q.txCount > 0;
  const src = S.sources?.find((s) => s.key === q.chain.key);
  el.innerHTML = `<div class="wl-kv big"><span>You receive</span><b class="w-num">${amt(q.receive)} USDC <small>on Solana</small></b></div>
    <div class="wl-kv"><span>Minimum</span><b class="w-num">${amt(q.minReceive)} USDC</b></div>
    <div class="wl-kv"><span>Bridge fee</span><b class="w-num">${fee == null ? "—" : usd(fee)}</b></div>
    ${q.fees?.gasUsd ? `<div class="wl-kv"><span>Network gas</span><b class="w-num">${usd(q.fees.gasUsd)} in ${esc(src?.native?.symbol ?? "gas")}</b></div>` : ""}
    <div class="wl-kv"><span>Arrives in</span><b class="w-num">${q.seconds == null ? "—" : q.seconds <= 5 ? "a few seconds" : q.seconds < 90 ? `about ${Math.round(q.seconds)} s` : `about ${Math.round(q.seconds / 60)} min`}</b></div>
    <div class="wl-kv"><span>Route</span><b>Relay${q.signatureOnly ? ` <span class="wl-tag">One signature, no gas</span>` : ` <span class="wl-tag dim">${q.txCount} transaction${q.txCount === 1 ? "" : "s"} + signature</span>`}</b></div>
    ${gasTx && S.evm.bal[q.chain.key]?.ok && S.evm.bal[q.chain.key].gas === 0n ? `<p class="wl-warn">This route sends an approval first: the wallet needs a little ${esc(src?.native?.symbol ?? "gas")} on ${esc(q.chain.name)}.</p>` : ""}
    ${Number(q.receive) < Number(q.amountIn) * 0.9 ? `<p class="wl-warn">Fees take more than 10% of this amount. Try a bigger amount.</p>` : ""}`;
  paintEvmGo();
}
function paintEvmGo() {
  const b = $("wlEvmGo"); if (!b) return;
  const e = S.evm, q = e.quote, src = S.sources?.find((s) => s.key === e.chain), bal = e.bal[e.chain];
  const raw = src ? toRaw(e.amount, src.decimals) : null;
  const over = bal?.ok && raw != null && raw > bal.usdc;
  const noGas = q && q.txCount > 0 && bal?.ok && bal.gas === 0n;
  const badRate = q && Number(q.receive) < Number(q.amountIn) * 0.9;
  b.disabled = e.busy || !q || e.quoting || over || noGas || badRate;
  b.textContent = e.busy ? "Working…" : over ? `More than your ${src?.name ?? ""} USDC` : !e.amount ? "Enter an amount" : e.quoting && !q ? "Getting a quote…" : q ? `Deposit ${amt(q.amountIn)} USDC` : "Deposit";
}
function requoteEvm(quiet) {
  const e = S.evm;
  clearTimeout(e.timer);
  const src = S.sources?.find((s) => s.key === e.chain), who = evmAddr(), to = solAddr();
  const raw = src ? toRaw(e.amount, src.decimals) : null;
  if (!src || !who || !to || raw == null || raw <= 0n) { e.quote = null; e.quoteErr = null; e.quoting = false; paintEvmQuote(); return; }
  if (!quiet) { e.quoting = true; e.quote = null; e.quoteErr = null; paintEvmQuote(); }
  e.timer = setTimeout(async () => {
    const seq = ++e.seq;
    try {
      const q = await api(`/v1/wallet/relay/quote?${new URLSearchParams({ from: src.key, user: who, recipient: to, amount: e.amount })}`);
      if (seq !== e.seq) return;
      e.quote = q; e.quoteAt = Date.now(); e.quoteErr = null;
    } catch (err) { if (seq === e.seq) { e.quote = null; e.quoteErr = plainErr(err); } }
    finally { if (seq === e.seq) { e.quoting = false; paintEvmQuote(); } }
  }, quiet ? 0 : 450);
}

/** A progress list: step(text) adds a running line; .done() ticks it; step.fail(msg) turns the running line (or a new one) red. */
function stepper(listId) {
  const ol = $(listId);
  if (ol) ol.innerHTML = "";
  let cur = null;
  const step = (text, state = "now") => {
    const li = document.createElement("li");
    const paint = (t, st) => { li.className = st; li.innerHTML = `${ic(st === "done" ? "check" : st === "bad" ? "x" : "spin", 2)}<span>${t}</span>`; };
    paint(text, state);
    $(listId)?.append(li);
    const h = { done: (t) => { paint(t ?? text, "done"); if (cur === h) cur = null; }, fail: (t) => { paint(esc(t), "bad"); if (cur === h) cur = null; } };
    if (state === "now") cur = h;
    return h;
  };
  step.fail = (msg) => (cur ? cur.fail(msg) : step(esc(msg), "bad"));
  return step;
}

async function evmProvider() { return S.evm.mode === "browser" ? window.ethereum : window.askPrivy.evmProvider(); }
/** Puts the EVM wallet on `src`'s chain. The Chord wallet switches through Privy; a browser wallet is asked (and taught the chain). */
async function ensureEvmChain(src, required) {
  if (S.evm.mode !== "browser") {
    try { await window.askPrivy.switchChain(src.chainId); } catch (e) { if (required) throw new Error(`Your Chord wallet cannot switch to ${src.name} yet. Use a browser wallet for this chain.`); }
    return window.askPrivy.evmProvider();
  }
  const eth = window.ethereum;
  const cur = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (cur === src.hex) return eth;
  try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: src.hex }] }); }
  catch (e) {
    if (e?.code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: src.hex, chainName: src.name, nativeCurrency: src.native, rpcUrls: [src.rpc[0]], blockExplorerUrls: [src.explorer.replace(/\/tx\/$/, "")] }] });
  }
  return eth;
}
const DOMAIN_FIELDS = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];
async function waitEvm(src, hash) {
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const r = await evmCall(src, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) { if (r.status === "0x1") return; throw new Error("The transaction reverted on chain. Nothing was bridged."); }
  }
  throw new Error("No receipt after three minutes. Check the transaction in your wallet.");
}
const hexOf = (v) => (v == null ? undefined : String(v).startsWith("0x") ? String(v) : "0x" + BigInt(v).toString(16));

async function runDeposit() {
  const e = S.evm;
  if (e.busy || !e.quote) return;
  const who = evmAddr(), src = S.sources.find((s) => s.key === e.quote.chain.key);
  e.busy = true; paintEvmGo();
  const step = stepper("wlEvmSteps");
  try {
    let q = e.quote;
    if (Date.now() - e.quoteAt > 25_000) {
      const s = step("Refreshing the quote");
      q = await api(`/v1/wallet/relay/quote?${new URLSearchParams({ from: src.key, user: who, recipient: solAddr(), amount: e.amount })}`);
      e.quote = q; e.quoteAt = Date.now(); paintEvmQuote();
      if (Number(q.receive) < Number(q.amountIn) * 0.9) throw new Error("Fees take more than 10% of this amount now. Try a bigger amount.");
      s.done(`Quote: ${amt(q.receive)} USDC on Solana`);
    }
    for (const st of q.steps ?? []) {
      for (const it of st.items ?? []) {
        if (it.status === "complete") continue;
        if (st.kind === "transaction") {
          let s = step(`Checking ${esc(src.name)}`);
          const eth = await ensureEvmChain(src, true);
          s.done(`On ${esc(src.name)}`);
          s = step(st.id === "approve" ? "Approve USDC in your wallet" : "Confirm the deposit in your wallet");
          const t = it.data;
          const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: who, to: t.to, data: t.data, value: hexOf(t.value ?? "0"), ...(t.gas ? { gas: hexOf(t.gas) } : {}) }] });
          s.done(`${st.id === "approve" ? "Approval" : "Deposit"} sent <a href="${esc(src.explorer + hash)}" target="_blank" rel="noopener">${esc(short(hash, 6, 4))} ↗</a>`);
          s = step("Waiting for the network");
          await waitEvm(src, hash);
          s.done(st.id === "approve" ? "Approved" : "Confirmed");
        } else {
          const sg = it.data.sign, post = it.data.post;
          const eth = await ensureEvmChain(src, S.evm.mode === "browser");
          const s = step("Sign in your wallet");
          const types = { EIP712Domain: DOMAIN_FIELDS.filter(([k]) => sg.domain?.[k] != null).map(([name, type]) => ({ name, type })), ...sg.types };
          const signature = await eth.request({ method: "eth_signTypedData_v4", params: [who, JSON.stringify({ types, domain: sg.domain, primaryType: sg.primaryType, message: sg.value })] });
          await api("/v1/wallet/relay/permit", { method: "POST", body: JSON.stringify({ requestId: post.body.requestId, kind: post.body.kind, api: post.body.api, signature }) });
          s.done("Signed. Relay is moving the USDC");
        }
      }
    }
    const s = step("Arriving on Solana");
    const until = Date.now() + Math.max(120_000, (q.seconds ?? 0) * 3_000);
    let st = "pending";
    while (Date.now() < until) {
      await sleep(2000);
      const r = await api(`/v1/wallet/relay/status/${q.requestId}`).catch(() => null);
      st = r?.status ?? st;
      if (st === "success") { s.done(`${amt(q.receive)} USDC arrived. <a href="https://relay.link/transaction/${esc(q.requestId)}" target="_blank" rel="noopener">View on Relay ↗</a>`); break; }
      if (st === "failure" || st === "refund") throw new Error(st === "refund" ? "Relay refunded the deposit. Nothing moved." : "The deposit failed. Nothing moved.");
    }
    if (st !== "success") s.fail("Still on its way after two minutes. It lands by itself; check Activity.");
    e.amount = ""; e.quote = null;
    loadBalances(true); loadEvm(); if (S.tab === "activity") loadActivity();
  } catch (err) { step.fail(plainErr(err)); }
  finally { e.busy = false; paintEvmGo(); const inp = $("wlEvmAmt"); if (inp && !e.amount) inp.value = ""; }
}

// Withdraw ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const maxSend = (h) => { if (!h) return 0n; const raw = BigInt(h.raw); if (!h.native) return raw; return raw > FEE_RESERVE ? raw - FEE_RESERVE : 0n; };
function pickerHtml(kind, items, selected) {
  const q = (kind === "wd" ? S.wd.q : S.cv.q).trim().toLowerCase();
  const list = items.filter((t) => !q || t.symbol.toLowerCase().includes(q) || (t.name ?? "").toLowerCase().includes(q) || t.mint === q || t.mint.toLowerCase() === q);
  return `<div class="wl-pickl"><div class="wl-pickh"><button type="button" class="wl-link" data-act="pick-close">${ic("back")}Back</button><label class="wl-search">${ic("search")}<input data-pq="${kind}" placeholder="Search a token or paste a mint" autocomplete="off" value="${esc(q)}"></label></div>
    <div class="wl-pitems">${list.length ? list.slice(0, 80).map((t) => `<button type="button" class="wl-row wl-pi${t.mint === selected ? " on" : ""}" data-pick="${esc(t.mint)}">${tlogo(t)}<span class="wl-tk"><b>${esc(t.symbol)}</b><small>${esc(t.name ?? short(t.mint))}</small></span><span class="r wl-cv"><b class="w-num">${t.valueUsd == null ? "" : usd(t.valueUsd)}</b><small class="w-num">${t.amount != null ? `${amt(t.amount)} ${esc(t.symbol)}` : ""}</small></span></button>`).join("") : `<p class="wl-sub pad">No token matches.</p>`}</div></div>`;
}
function wdSources() { return holdings().filter((h) => BigInt(h.raw) > 0n); }
function paintWd() {
  const el = $("wlWd"); if (!el) return;
  const w = S.wd;
  if (!S.bal) { el.innerHTML = `<p class="wl-line dim">Reading the balances…</p>`; return; }
  const srcs = wdSources();
  if (!srcs.length || (srcs.length === 1 && maxSend(srcs[0]) === 0n && BigInt(srcs[0].raw) === 0n)) { el.innerHTML = `<p class="wl-line dim">Nothing to withdraw yet.</p>`; return; }
  if (w.picking) { el.innerHTML = pickerHtml("wd", srcs, w.mint); el.querySelector("input")?.focus(); return; }
  const h = srcs.find((x) => x.mint === w.mint) ?? srcs[0];
  if (h.mint !== w.mint) w.mint = h.mint;
  if (w.phase !== "form" && w.built) { el.innerHTML = wdReviewHtml(w.built.summary); return; }
  el.innerHTML = `<button type="button" class="wl-tokb" data-act="pick-wd">${tlogo(h)}<span class="wl-tk"><b>${esc(h.symbol)}</b><small class="w-num">${amt(fromRaw(maxSend(h), h.decimals))} available</small></span>${ic("chev")}</button>
    <label class="wl-field"><span class="wl-lbl">To address</span><input id="wlWdTo" class="wl-mono" placeholder="Solana address" autocomplete="off" spellcheck="false" value="${esc(w.to)}"></label>
    <label class="wl-field"><span class="wl-lbl wl-ih"><span>Amount</span><span class="wl-avail w-num">${h.valueUsd != null && N(w.amount) ? `≈ ${usd(N(w.amount) * (h.priceUsd ?? 0))}` : ""}</span></span>
      <span class="wl-inrow"><input id="wlWdAmt" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${esc(w.amount)}"><span class="wl-unit">${esc(h.symbol)}</span><button type="button" class="wl-btn sm" data-act="wd-max">Max</button></span></label>
    <p class="wl-warn" id="wlWdErr">${esc(wdError(h) ?? w.err ?? "")}</p>
    <div class="wl-line dim wl-ih">Sends ${esc(h.symbol)} on Solana.${h.native ? " Max keeps 0.01 SOL for fees." : " The network fee is paid in SOL."}${note(`<p>Only send to a Solana address. An exchange deposit address works when the exchange accepts ${esc(h.symbol)} on Solana; on the wrong network it is gone.</p>${h.native ? "" : "<p>When the recipient has never held this token, opening their token account costs a small SOL deposit, shown before you sign.</p>"}`, "Before you send")}</div>
    <button type="button" class="wl-cta" id="wlWdGo" data-act="wd-review">Review</button>`;
  paintWdGo(h);
}
function wdError(h) {
  const w = S.wd;
  if (w.to && !B58.test(w.to)) return "That is not a Solana address.";
  if (w.to && w.to === solAddr()) return "That is this wallet.";
  if (!w.amount) return null;
  const raw = toRaw(w.amount, h.decimals);
  if (raw == null) return `Use at most ${h.decimals} decimals.`;
  if (raw > maxSend(h)) return `More than the ${amt(fromRaw(maxSend(h), h.decimals))} ${h.symbol} you can send.`;
  return null;
}
function paintWdGo(h) {
  const b = $("wlWdGo"); if (!b) return;
  const w = S.wd, raw = toRaw(w.amount, h.decimals);
  const err = wdError(h);
  const e = $("wlWdErr"); if (e) e.textContent = err ?? w.err ?? "";
  b.disabled = w.phase === "building" || !w.to || !B58.test(w.to) || !raw || raw <= 0n || !!err;
  b.textContent = w.phase === "building" ? "Preparing…" : !w.to ? "Enter an address" : !w.amount ? "Enter an amount" : "Review";
}
function wdReviewHtml(s) {
  const w = S.wd;
  const done = w.phase === "done", working = ["signing", "sending", "confirming"].includes(w.phase);
  return `<div class="wl-review">
      <div class="wl-kv big"><span>You send</span><b class="w-num">${esc(amt(s.amount))} ${esc(s.symbol)}${s.valueUsd != null ? ` <small>${usd(s.valueUsd)}</small>` : ""}</b></div>
      <div class="wl-kv col"><span>To</span><code class="wl-addr">${esc(s.to)}</code></div>
      <div class="wl-kv"><span>Network</span><b>${solMark(12)} Solana</b></div>
      <div class="wl-kv"><span>Network fee</span><b class="w-num">${esc(fromRaw(BigInt(s.feeLamports), 9))} SOL</b></div>
      ${s.createsAccount ? `<div class="wl-kv"><span class="wl-ih">New account${note(`<p>The recipient has never held ${esc(s.symbol)}. Opening their token account locks Solana's rent minimum of ${esc(fromRaw(BigInt(s.rentLamports), 9))} SOL in it; your wallet pays it once and it stays with their account.</p>`, "Why a deposit")}</span><b class="w-num">${esc(fromRaw(BigInt(s.rentLamports), 9))} SOL</b></div>` : ""}
      ${(s.warnings ?? []).map((x) => `<p class="wl-warn">${esc(x)}</p>`).join("")}
    </div>
    <p class="wl-line dim">Check the address. A transfer cannot be undone.</p>
    ${done ? "" : `<div class="wl-btnrow"><button type="button" class="wl-btn" data-act="wd-back"${working ? " disabled" : ""}>Back</button><button type="button" class="wl-cta" data-act="wd-send"${working ? " disabled" : ""}>${working ? "Sending…" : `Send ${esc(amt(s.amount))} ${esc(s.symbol)}`}</button></div>`}
    <ol class="wl-steps" id="wlWdSteps"></ol>
    ${done ? `<button type="button" class="wl-link" data-act="wd-new">New transfer</button>` : ""}`;
}
async function wdBuild() {
  const w = S.wd, h = holdingOf(w.mint);
  if (!h || wdError(h)) return;
  w.phase = "building"; w.err = null; paintWdGo(h);
  try {
    const r = await api("/v1/wallet/solana/withdraw/build", { method: "POST", body: JSON.stringify({ from: solAddr(), to: w.to, mint: h.native ? "SOL" : h.mint, amount: w.amount }) });
    w.built = { ...r, at: Date.now() }; w.phase = "review";
  } catch (e) { w.err = plainErr(e); w.phase = "form"; }
  paintWd();
}
async function signSol(b64) {
  if (signerKind() === "privy") return bytesToB64(await window.askPrivy.signSol(b64ToBytes(b64)));
  const web3 = await import("https://esm.sh/@solana/web3.js@1.98.0?bundle");
  const tx = web3.VersionedTransaction.deserialize(b64ToBytes(b64));
  return bytesToB64((await S.ext.prov.signTransaction(tx)).serialize());
}
async function waitSol(path, sig, s, okText) {
  for (let i = 0; i < 45; i++) {
    await sleep(1500);
    const st = await api(`${path}${sig}`).catch(() => null);
    if (st?.error) throw new Error(`It failed on chain: ${st.error}`);
    if (st?.status === "confirmed" || st?.status === "finalized") { s.done(`${okText} <a href="${SOLSCAN}${esc(sig)}" target="_blank" rel="noopener">View on Solscan ↗</a>`); return true; }
  }
  s.fail("Not confirmed after a minute. Check it on Solscan before trying again.");
  return false;
}
async function wdSend() {
  const w = S.wd;
  if (!w.built || busy()) return;
  w.phase = "signing"; paintWd();
  const step = stepper("wlWdSteps");
  try {
    if (Date.now() - w.built.at > 60_000) { // the blockhash ages out: build again, same transfer
      const s = step("Refreshing the transaction");
      const r = await api("/v1/wallet/solana/withdraw/build", { method: "POST", body: JSON.stringify({ from: solAddr(), to: w.built.summary.to, mint: w.built.summary.kind === "sol" ? "SOL" : w.built.summary.mint, amount: w.built.summary.amount }) });
      w.built = { ...r, at: Date.now() };
      s.done("Transaction ready");
    }
    let s = step("Confirm in your wallet");
    const signed = await signSol(w.built.transaction);
    s.done("Signed in your wallet");
    w.phase = "sending";
    s = step("Sending to Solana");
    const sent = await api("/v1/wallet/solana/send", { method: "POST", body: JSON.stringify({ transaction: signed }) });
    s.done(`Sent <a href="${SOLSCAN}${esc(sent.signature)}" target="_blank" rel="noopener">${esc(short(sent.signature, 6, 6))} ↗</a>`);
    w.phase = "confirming";
    s = step("Waiting for confirmation");
    const ok = await waitSol("/v1/wallet/solana/status/", sent.signature, s, `${esc(amt(w.built.summary.amount))} ${esc(w.built.summary.symbol)} sent.`);
    w.phase = ok ? "done" : "review";
    if (ok) { w.amount = ""; loadBalances(true); if (S.tab === "activity") loadActivity(); }
  } catch (e) { step.fail(plainErr(e)); w.phase = "review"; }
  const ol = $("wlWdSteps"); const keep = ol ? ol.innerHTML : "";
  paintWd();
  const ol2 = $("wlWdSteps"); if (ol2) ol2.innerHTML = keep;
}

// Convert (the Trade tab's Jupiter lane, inline) ───────────────────────────────────────────────────────────────────────
const MAJORS = [
  { mint: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9 }, { mint: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6 },
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether USD", decimals: 6 },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", decimals: 6 },
];
const jupMint = (m) => (m === "SOL" ? SOL_MINT : m);
function cvSources() { return holdings().filter((h) => BigInt(h.raw) > 0n && h.mint !== SOL_MINT && (h.valueUsd == null || h.valueUsd >= DUST_USD)); }
function cvTargets() {
  const own = holdings().filter((h) => h.mint !== SOL_MINT).map((h) => ({ ...h, mint: jupMint(h.mint) }));
  const seen = new Set(), out = [];
  for (const t of [...MAJORS.map((m) => own.find((o) => o.mint === m.mint) ?? m), ...own, ...S.cv.search]) if (!seen.has(t.mint)) { seen.add(t.mint); out.push(t); }
  return out.filter((t) => t.mint !== jupMint(S.cv.from));
}
function cvTo() {
  const c = S.cv;
  if (!c.to || c.to.mint === jupMint(c.from)) c.to = c.from === "SOL" ? MAJORS[1] : MAJORS[0];
  return c.to;
}
function paintCv() {
  const el = $("wlCv"); if (!el) return;
  const c = S.cv;
  if (!S.bal) { el.innerHTML = `<p class="wl-line dim">Reading the balances…</p>`; return; }
  const srcs = cvSources();
  if (!srcs.length) { el.innerHTML = `<p class="wl-line dim">Nothing to convert yet. Deposit first.</p>`; return; }
  if (c.picking === "from") { el.innerHTML = pickerHtml("cv", srcs, c.from); el.querySelector("input")?.focus(); return; }
  if (c.picking === "to") { el.innerHTML = pickerHtml("cv", cvTargets(), cvTo().mint); el.querySelector("input")?.focus(); return; }
  const h = srcs.find((x) => x.mint === c.from) ?? srcs[0];
  if (h.mint !== c.from) c.from = h.mint;
  const to = cvTo();
  el.innerHTML = `<div class="wl-cvbox">
      <span class="wl-lbl wl-ih"><span>From</span><span class="wl-avail w-num">${amt(fromRaw(maxSend(h), h.decimals))} available</span></span>
      <div class="wl-inrow"><input id="wlCvAmt" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${esc(c.amount)}"><button type="button" class="wl-btn sm" data-act="cv-max">Max</button><button type="button" class="wl-tokb sm" data-act="pick-from">${tlogo(h)}<b>${esc(h.symbol)}</b>${ic("chev")}</button></div>
    </div>
    <button type="button" class="wl-flip" data-act="cv-flip" aria-label="Switch tokens">${ic("flip")}</button>
    <div class="wl-cvbox">
      <span class="wl-lbl">To</span>
      <div class="wl-inrow"><output id="wlCvOut" class="w-num">0</output><button type="button" class="wl-tokb sm" data-act="pick-to">${tlogo(to)}<b>${esc(to.symbol)}</b>${ic("chev")}</button></div>
    </div>
    <div class="wl-quote" id="wlCvQ"></div>
    <button type="button" class="wl-cta" id="wlCvGo" data-act="cv-go">Convert</button>
    <ol class="wl-steps" id="wlCvSteps"></ol>
    <button type="button" class="wl-link" data-act="cv-trade">${ic("swap")}Open in Trade</button>`;
  paintCvQuote();
}
function paintCvQuote() {
  const el = $("wlCvQ"); if (!el) return;
  const c = S.cv, q = c.quote;
  const out = $("wlCvOut"); if (out) { out.textContent = c.quoting && !q ? "…" : q ? amt(q.amountOut) : "0"; out.classList.toggle("dim", !q); }
  if (c.quoteErr) el.innerHTML = `<p class="wl-warn">${esc(c.quoteErr)}</p>`;
  else if (!q) el.innerHTML = "";
  else {
    const imp = q.priceImpactPct;
    el.innerHTML = `<div class="wl-kv"><span>Rate</span><b class="w-num">1 ${esc(q.tokenIn.symbol)} = ${amt(Number(q.amountOut) / Number(q.amountIn))} ${esc(q.tokenOut.symbol)}</b></div>
      <div class="wl-kv"><span>Minimum</span><b class="w-num">${amt(q.minAmountOut)} ${esc(q.tokenOut.symbol)}</b></div>
      <div class="wl-kv"><span>Price impact</span><b class="w-num ${imp != null && imp > 3 ? "wl-down" : ""}">${imp == null ? "n/a" : `${imp < 0.01 ? "<0.01" : imp.toFixed(2)}%`}</b></div>
      <div class="wl-kv"><span>Route</span><b>${esc(q.route?.length ? q.route.slice(0, 3).join(" · ") : "direct")} <span class="wl-tag dim">Jupiter</span></b></div>`;
  }
  const b = $("wlCvGo"); if (!b) return;
  const h = holdingOf(c.from), raw = h ? toRaw(c.amount, h.decimals) : null, over = h && raw != null && raw > maxSend(h);
  b.disabled = c.busy || !q || c.quoting || over;
  b.textContent = c.busy ? "Working…" : over ? `More than your ${h.symbol}` : !c.amount ? "Enter an amount" : c.quoting && !q ? "Getting a quote…" : q ? `Convert ${amt(q.amountIn)} ${q.tokenIn.symbol}` : "Convert";
}
function requoteCv(quiet) {
  const c = S.cv;
  clearTimeout(c.timer);
  const h = holdingOf(c.from), to = cvTo(), raw = h ? toRaw(c.amount, h.decimals) : null;
  if (!h || !to || raw == null || raw <= 0n) { c.quote = null; c.quoteErr = null; c.quoting = false; paintCvQuote(); return; }
  if (!quiet) { c.quoting = true; c.quote = null; c.quoteErr = null; paintCvQuote(); }
  c.timer = setTimeout(async () => {
    const seq = ++c.seq;
    try {
      const q = await api(`/v1/trade/quote?${new URLSearchParams({ chain: "solana", in: jupMint(h.mint), out: to.mint, amount: c.amount, slippageBps: "50" })}`);
      if (seq !== c.seq) return;
      c.quote = q; c.quoteAt = Date.now(); c.quoteErr = null;
    } catch (e) { if (seq === c.seq) { c.quote = null; c.quoteErr = plainErr(e); } }
    finally { if (seq === c.seq) { c.quoting = false; paintCvQuote(); } }
  }, quiet ? 0 : 400);
}
async function runConvert() {
  const c = S.cv;
  if (c.busy || !c.quote) return;
  c.busy = true; paintCvQuote();
  const step = stepper("wlCvSteps");
  try {
    if (Date.now() - c.quoteAt > 25_000) {
      const h = holdingOf(c.from);
      c.quote = await api(`/v1/trade/quote?${new URLSearchParams({ chain: "solana", in: jupMint(h.mint), out: cvTo().mint, amount: c.amount, slippageBps: "50" })}`);
      c.quoteAt = Date.now(); paintCvQuote();
    }
    let s = step("Preparing the transaction");
    const built = await api("/v1/trade/sol/build", { method: "POST", body: JSON.stringify({ quoteId: c.quote.quoteId, user: solAddr() }) });
    s.done("Transaction prepared");
    s = step("Confirm in your wallet");
    const signed = await signSol(built.transaction);
    s.done("Signed in your wallet");
    s = step("Sending to Solana");
    const sent = await api("/v1/trade/sol/send", { method: "POST", body: JSON.stringify({ transaction: signed }) });
    s.done(`Sent <a href="${SOLSCAN}${esc(sent.signature)}" target="_blank" rel="noopener">${esc(short(sent.signature, 6, 6))} ↗</a>`);
    s = step("Waiting for confirmation");
    const ok = await waitSol("/v1/trade/sol/status?sig=", sent.signature, s, `Converted to ${esc(c.quote.tokenOut.symbol)}.`);
    if (ok) { c.amount = ""; c.quote = null; const i = $("wlCvAmt"); if (i) i.value = ""; loadBalances(true); if (S.tab === "activity") loadActivity(); }
  } catch (e) { step.fail(plainErr(e)); }
  finally { c.busy = false; paintCvQuote(); }
}
let searchTimer = null;
function searchTokens(q) {
  clearTimeout(searchTimer);
  if (q.length < 2) { S.cv.search = []; return; }
  searchTimer = setTimeout(async () => {
    const r = await api(`/v1/trade/tokens?chain=solana&q=${encodeURIComponent(q)}`).catch(() => ({ tokens: [] }));
    S.cv.search = (r.tokens ?? []).map((t) => ({ mint: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, logo: t.logoURI ?? null }));
    if (S.cv.picking === "to") { const inp = root.querySelector('[data-pq="cv"]'); const pos = inp?.selectionStart; paintCv(); const i2 = root.querySelector('[data-pq="cv"]'); if (i2) { i2.value = S.cv.q; i2.setSelectionRange(pos ?? i2.value.length, pos ?? i2.value.length); } }
  }, 300);
}

// ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function openPanel(p) {
  S.panel = S.panel === p ? null : p;
  renderPanel(); setHash();
}
async function onClick(e) {
  const t = e.target.closest("button, a");
  if (!t || !root.contains(t)) return;
  const d = t.dataset;
  if (d.copy) { navigator.clipboard?.writeText(d.copy).then(() => flash(t, "Copied")).catch(() => {}); return; }
  if (d.panel) { openPanel(d.panel); return; }
  if (d.tab) { S.tab = d.tab; root.querySelectorAll(".wl-tabs [data-tab]").forEach((b) => { b.classList.toggle("on", b.dataset.tab === S.tab); b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)); }); renderList(); if (S.tab === "activity") loadActivity(); setHash(); return; }
  if (d.dep) { S.depTab = d.dep; renderPanel(); setHash(); return; }
  if (d.fold) { if (d.fold === "small") S.showSmall = !S.showSmall; else S.showUnpriced = !S.showUnpriced; renderList(); return; }
  if (d.row) {
    const h = holdingOf(d.row); if (!h) return;
    if (S.panel === "withdraw") { S.wd.mint = h.mint; S.wd.amount = ""; S.wd.phase = "form"; S.wd.built = null; paintWd(); }
    else if (h.mint !== SOL_MINT) { S.cv.from = h.mint; S.cv.amount = ""; S.cv.quote = null; S.panel = "convert"; renderPanel(); setHash(); }
    $("wlPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  if (d.connect) { connectExt(d.connect); return; }
  if (d.chain) { if (S.evm.busy) return; S.evm.chain = d.chain; S.evm.quote = null; paintEvm(); requoteEvm(); return; }
  if (d.evm) { pickEvm(d.evm); return; }
  if (d.pick) {
    if (S.panel === "withdraw") { S.wd.mint = d.pick; S.wd.amount = ""; S.wd.picking = false; S.wd.q = ""; paintWd(); return; }
    const c = S.cv;
    if (c.picking === "from") { c.from = d.pick; c.amount = ""; }
    else { const tok = cvTargets().find((x) => x.mint === d.pick); if (tok) c.to = tok; }
    c.picking = null; c.q = ""; c.quote = null; paintCv(); requoteCv(); return;
  }
  switch (d.act) {
    case "refresh": loadBalances(true); if (S.tab === "activity") loadActivity(); if (S.panel === "deposit" && S.depTab === "evm") loadEvm(); break;
    case "activity": loadActivity(); break;
    case "signin": D.signIn?.(); break;
    case "create-sol": {
      t.disabled = true; t.textContent = "Creating your Solana wallet…";
      try { await window.askPrivy.ensureSol(); } catch (err) { const m = $("wlMsg"); if (m) { m.className = "wl-msg bad"; m.textContent = plainErr(err); } t.disabled = false; t.textContent = "Create Solana wallet"; }
      break;
    }
    case "switch-signer": S.useExt = signerKind() === "privy"; resetFlows(); render(); refresh(); break;
    case "disconnect": try { await S.ext?.prov?.disconnect?.(); } catch {} S.ext = null; S.useExt = false; resetFlows(); render(); refresh(); break;
    case "fund": try { await window.askPrivy.fundSol(solAddr()); } catch (err) { flash(t, plainErr(err).slice(0, 40)); } break;
    case "evm-max": { const src = S.sources?.find((s) => s.key === S.evm.chain), b = S.evm.bal[S.evm.chain]; if (src && b?.ok) { S.evm.amount = fromRaw(b.usdc, src.decimals); const i = $("wlEvmAmt"); if (i) i.value = S.evm.amount; requoteEvm(); } break; }
    case "evm-go": runDeposit(); break;
    case "pick-wd": S.wd.picking = true; paintWd(); break;
    case "pick-from": S.cv.picking = "from"; paintCv(); break;
    case "pick-to": S.cv.picking = "to"; S.cv.search = []; paintCv(); break;
    case "pick-close": S.wd.picking = false; S.cv.picking = null; S.wd.q = ""; S.cv.q = ""; S.panel === "withdraw" ? paintWd() : paintCv(); break;
    case "wd-max": { const h = holdingOf(S.wd.mint); if (h) { S.wd.amount = fromRaw(maxSend(h), h.decimals); const i = $("wlWdAmt"); if (i) i.value = S.wd.amount; paintWdGo(h); } break; }
    case "wd-review": wdBuild(); break;
    case "wd-back": S.wd.phase = "form"; S.wd.built = null; paintWd(); break;
    case "wd-send": wdSend(); break;
    case "wd-new": S.wd = { ...S.wd, amount: "", to: "", built: null, phase: "form", err: null }; paintWd(); break;
    case "cv-max": { const h = holdingOf(S.cv.from); if (h) { S.cv.amount = fromRaw(maxSend(h), h.decimals); const i = $("wlCvAmt"); if (i) i.value = S.cv.amount; requoteCv(); } break; }
    case "cv-flip": {
      const to = cvTo(), own = holdingOf(to.mint === SOL_MINT ? "SOL" : to.mint);
      if (!own || BigInt(own.raw) === 0n) { flash(t, "Not held"); break; }
      const h = holdingOf(S.cv.from);
      S.cv.to = h ? { ...h, mint: jupMint(h.mint) } : null; S.cv.from = own.mint; S.cv.amount = ""; S.cv.quote = null; paintCv(); break;
    }
    case "cv-go": runConvert(); break;
    case "cv-trade": {
      const h = holdingOf(S.cv.from), to = cvTo();
      if (!h || !D.openTrade) break;
      const tok = (x) => ({ address: jupMint(x.mint), symbol: x.symbol, name: x.name ?? x.symbol, decimals: x.decimals, logoURI: x.logo && /^https:/.test(x.logo) ? x.logo : null });
      D.openTrade({ chain: "solana", tokenIn: tok(h), tokenOut: tok(to), amount: S.cv.amount || undefined });
      break;
    }
  }
}
function onInput(e) {
  const t = e.target;
  if (t.id === "wlEvmAmt") { t.value = cleanNum(t.value); S.evm.amount = t.value; requoteEvm(); paintEvmGo(); return; }
  if (t.id === "wlWdAmt" || t.id === "wlWdTo") {
    if (t.id === "wlWdAmt") { t.value = cleanNum(t.value); S.wd.amount = t.value; } else S.wd.to = t.value.trim();
    S.wd.err = null;
    const h = holdingOf(S.wd.mint); if (h) paintWdGo(h);
    return;
  }
  if (t.id === "wlCvAmt") { t.value = cleanNum(t.value); S.cv.amount = t.value; requoteCv(); return; }
  if (t.dataset.pq) {
    const q = t.value, pos = t.selectionStart;
    if (t.dataset.pq === "wd") { S.wd.q = q; paintWd(); } else { S.cv.q = q; if (S.cv.picking === "to") searchTokens(q.trim()); paintCv(); }
    const i = root.querySelector(`[data-pq="${t.dataset.pq}"]`); if (i) { i.value = q; i.setSelectionRange(pos, pos); }
  }
}
function flash(btn, text) {
  const old = btn.innerHTML; btn.innerHTML = `${ic("check", 2)}<span>${esc(text)}</span>`; btn.disabled = true;
  setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 1400);
}
function resetFlows() {
  S.bal = null; S.balFor = null; S.act = null; S.actFor = null;
  S.wd = { mint: "SOL", to: "", amount: "", built: null, phase: "form", err: null, picking: false, q: "" };
  Object.assign(S.cv, { from: "SOL", to: null, amount: "", quote: null, quoteErr: null, picking: null, q: "", search: [] });
}
async function connectExt(name) {
  const p = solExtensions().find(([n]) => n === name)?.[1];
  const m = $("wlMsg");
  try {
    if (!p) throw new Error(`${name} is not in this browser.`);
    await p.connect();
    S.ext = { name, prov: p, address: p.publicKey.toString() }; S.useExt = true;
    resetFlows(); render(); refresh();
  } catch (err) { if (m) { m.className = "wl-msg bad"; m.textContent = plainErr(err); } }
}
async function pickEvm(mode) {
  if (mode === "privy") { S.evm.mode = "privy"; S.evm.quote = null; paintEvm(); loadEvm(); return; }
  try {
    if (!window.ethereum) throw new Error("No EVM wallet in this browser. Install MetaMask or Rabby, or use the Chord wallet.");
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
    S.evm.browser = a; S.evm.mode = "browser"; S.evm.quote = null; paintEvm(); loadEvm();
  } catch (err) { const el = $("wlEvmQ") ?? $("wlEvm"); if (el) el.insertAdjacentHTML("beforeend", `<p class="wl-warn">${esc(plainErr(err))}</p>`); }
}
