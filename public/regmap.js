// The ERC-8004 registry on Monad as a picture (Trust tab): every agent is one dot of the same size, grouped by the host that
// serves its agent card (that is who mints), lit when the agent keeps a record on TrackRecord and solid when a validator has
// scored it. One canvas, no library. Data: GET /v1/trust/registry/map. Every server string goes through esc or textContent.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => Number(n).toLocaleString("en-US");
const GAP = 3;          // empty columns between two hosts
const LABEL_H = 24;     // the strip of host names above the dots
const FOLDS = new Set(["other hosts", "inline", "ipfs / ar", "no card"]);
const PASS = 90;        // TrustGate asks an average score of 90: a validated agent under it is drawn as failed

let DATA = null, AT = 0, played = false;
async function fetchMap(api) { if (DATA && Date.now() - AT < 60_000) return DATA; DATA = await api("/v1/trust/registry/map"); AT = Date.now(); return DATA; }

/** The biggest cell at which every host fits side by side. A host is a full-height band; a small one is a block at the top. */
export function layout(groups, W, H) {
  for (let s = 22; s >= 2; s -= 0.25) {
    const rows = Math.floor((H - LABEL_H) / s);
    if (rows < 4) continue;
    let x = 0;
    const bands = groups.map((g) => { const cols = Math.max(Math.ceil(g.agents / rows), Math.min(Math.ceil(Math.sqrt(g.agents)), 8)); const b = { x, cols }; x += cols + GAP; return b; });
    const cols = x - GAP;
    if (cols * s <= W || s === 2) return { s, rows, bands, cols, x0: Math.max(0, (W - cols * s) / 2) };
  }
  return null;
}

export function createRegistryMap({ api, onPick }) {
  const el = document.createElement("div");
  el.className = "rm";
  el.innerHTML = `<div class="rm-h"><div class="rm-st"></div>
      <div class="rm-lg"><span><i></i>No record</span><span><i class="rec"></i>Keeps a record</span><span><i class="val"></i>Validated</span><span class="rm-failed" hidden><i class="bad"></i>Failed validation</span></div>
      <button type="button" class="b-btn sm" data-rmfs aria-pressed="false">Full screen</button></div>
    <div class="rm-c"><canvas role="img" aria-label="Every ERC-8004 agent on Monad, one dot each, grouped by the host of its agent card"></canvas><div class="rm-tip" hidden></div></div>`;
  const cv = el.querySelector("canvas"), box = el.querySelector(".rm-c"), tip = el.querySelector(".rm-tip"), stats = el.querySelector(".rm-st"), fsBtn = el.querySelector("[data-rmfs]");
  const ctx = cv.getContext("2d");
  let d = null, L = null, pos = null, hover = -1, raf = 0, t0 = 0, W = 0, H = 0;

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  /** where each agent sits, in CSS pixels: agents arrive ordered by group, so a running count per group places them */
  function place() {
    W = box.clientWidth; H = box.clientHeight;
    if (!d || W < 40 || H < 60) { L = null; return; }
    L = layout(d.groups, W, H);
    if (!L) return;
    pos = new Float32Array(d.agents.length * 2);
    const seen = d.groups.map(() => 0);
    d.agents.forEach((a, i) => { const b = L.bands[a[1]], k = seen[a[1]]++; pos[i * 2] = L.x0 + (b.x + (k % b.cols) + 0.5) * L.s; pos[i * 2 + 1] = LABEL_H + (Math.floor(k / b.cols) + 0.5) * L.s; });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /** p in 0..1: the dim field sweeps in by position, then the agents with a record come up */
  function draw(p = 1) {
    if (!L) return;
    ctx.clearRect(0, 0, W, H);
    const s = L.s, n = d.agents.length, shown = Math.ceil(n * Math.min(1, p / 0.7)), lit = Math.max(0, Math.min(1, (p - 0.7) / 0.3));
    const fg = css("--fg"), mu = css("--muted-fg"), pu = css("--purple"), bad = css("--bad");
    // host names, where the band is wide enough to carry one
    ctx.font = `500 12px Geist, ui-sans-serif, system-ui, sans-serif`; ctx.textBaseline = "middle";
    d.groups.forEach((g, i) => {
      const b = L.bands[i], x = L.x0 + b.x * s, w = b.cols * s, count = num(g.agents);
      const full = `${g.host}  ${count}`;
      ctx.globalAlpha = 1;
      if (ctx.measureText(full).width <= w) { ctx.fillStyle = fg; ctx.fillText(g.host, x, LABEL_H / 2 - 2); ctx.fillStyle = mu; ctx.fillText(count, x + ctx.measureText(`${g.host}  `).width, LABEL_H / 2 - 2); }
      else if (ctx.measureText(g.host).width <= w) { ctx.fillStyle = fg; ctx.fillText(g.host, x, LABEL_H / 2 - 2); }
      else if (ctx.measureText(count).width <= w) { ctx.fillStyle = mu; ctx.fillText(count, x, LABEL_H / 2 - 2); }
    });
    // the field: agents with no record
    const r = Math.max(0.7, s * 0.3);
    ctx.fillStyle = mu; ctx.globalAlpha = 0.34; ctx.beginPath();
    for (let i = 0; i < shown; i++) { if (d.agents[i][2] > 0) continue; const x = pos[i * 2], y = pos[i * 2 + 1]; if (s < 4) ctx.rect(x - r, y - r, r * 2, r * 2); else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); } }
    ctx.fill();
    // the ones that keep a record: a ring, and solid once a validator has scored them
    if (lit > 0) {
      const R = Math.min(Math.max(1.6, s * 0.44), Math.max(0.9, s * 0.5 - 0.15)) * (0.4 + 0.6 * lit); // never wider than its cell
      ctx.globalAlpha = lit; ctx.fillStyle = pu; ctx.strokeStyle = pu; ctx.lineWidth = Math.min(Math.max(1, s * 0.14), R * 0.8);
      for (let i = 0; i < n; i++) {
        const a = d.agents[i]; if (!(a[2] > 0)) continue;
        const failed = a[3] > 0 && a[4] < PASS;
        ctx.fillStyle = ctx.strokeStyle = failed ? bad : pu;
        ctx.beginPath(); ctx.arc(pos[i * 2], pos[i * 2 + 1], a[3] > 0 ? R : R - ctx.lineWidth / 2, 0, 6.2832); a[3] > 0 ? ctx.fill() : ctx.stroke();
      }
    }
    if (hover >= 0 && p >= 1) { ctx.globalAlpha = 1; ctx.strokeStyle = fg; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(pos[hover * 2], pos[hover * 2 + 1], Math.max(3, s * 0.62), 0, 6.2832); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  function play() {
    cancelAnimationFrame(raf);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { draw(1); return; }
    t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 1600); draw(p); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  }
  function head() {
    if (!d) return;
    const top = d.groups[0], share = top && !FOLDS.has(top.host) && d.total ? Math.round((top.agents / d.total) * 100) : null;
    el.querySelector(".rm-failed").hidden = !d.agents.some((a) => a[3] > 0 && a[4] < PASS);
    stats.innerHTML = `<span><b>${num(d.total)}</b>agents registered</span>${share != null ? `<span><b>${share}%</b>from one host</span>` : ""}<span class="lit"><b>${num(d.withRecord)}</b>keep a record</span><span class="lit"><b>${num(d.validated)}</b>validated</span>`;
  }
  /** the agent under the pointer: the cell first, then its neighbours when the pointer is between two dots */
  function at(mx, my) {
    if (!L || my < LABEL_H) return -1;
    let best = -1, bd = (L.s * 0.75) ** 2;
    const col = (mx - L.x0) / L.s, gi = L.bands.findIndex((b) => col >= b.x - 0.5 && col < b.x + b.cols + 0.5);
    if (gi < 0) return -1;
    let start = 0; for (let g = 0; g < gi; g++) start += d.groups[g].agents;
    const b = L.bands[gi], row = Math.floor((my - LABEL_H) / L.s), c = Math.floor(col - b.x);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = row + dr, cc = c + dc; if (rr < 0 || cc < 0 || cc >= b.cols) continue;
      const k = rr * b.cols + cc; if (k >= d.groups[gi].agents) continue;
      const i = start + k, dx = pos[i * 2] - mx, dy = pos[i * 2 + 1] - my, q = dx * dx + dy * dy;
      if (q < bd) { bd = q; best = i; }
    }
    return best;
  }
  function showTip(i, mx, my) {
    if (i < 0) { tip.hidden = true; return; }
    const a = d.agents[i], name = d.names[a[0]];
    tip.innerHTML = `<b>#${a[0]}${name ? ` ${esc(name)}` : ""}</b><span>${esc(d.groups[a[1]].host)}</span>${a[2] > 0 ? `<span class="lit">${num(a[2])} fill${a[2] === 1 ? "" : "s"} on Monad${a[3] > 0 ? `, scored ${a[4]}/100` : ", not validated yet"}</span>` : `<span>No record</span>`}`;
    tip.querySelector(".lit")?.classList.toggle("bad", a[3] > 0 && a[4] < PASS);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.max(4, Math.min(W - tw - 4, mx + 14))}px`;
    tip.style.top = `${my + th + 18 > H ? Math.max(4, my - th - 10) : my + 14}px`;
  }
  cv.addEventListener("pointermove", (e) => {
    if (!d) return;
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, i = at(mx, my);
    if (i !== hover) { hover = i; cv.style.cursor = i >= 0 ? "pointer" : ""; draw(1); }
    showTip(i, mx, my);
  });
  cv.addEventListener("pointerleave", () => { if (hover >= 0) { hover = -1; draw(1); } tip.hidden = true; });
  cv.addEventListener("click", () => { if (hover < 0 || !d) return; const id = d.agents[hover][0]; setFs(false); onPick?.(id); });

  function setFs(on) {
    if (el.classList.contains("fs") === on) return;
    el.classList.toggle("fs", on); document.documentElement.classList.toggle("rm-lock", on);
    fsBtn.textContent = on ? "Close" : "Full screen"; fsBtn.setAttribute("aria-pressed", String(on));
    hover = -1; tip.hidden = true; place(); on ? play() : draw(1);
  }
  fsBtn.addEventListener("click", () => setFs(!el.classList.contains("fs")));
  const onKey = (e) => { if (e.key === "Escape" && el.classList.contains("fs")) setFs(false); };
  document.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(() => { if (!el.isConnected) return; const w = box.clientWidth, h = box.clientHeight; if (w === W && h === H) return; place(); cancelAnimationFrame(raf); draw(1); });
  ro.observe(box);
  const mo = new MutationObserver(() => { if (el.isConnected) draw(1); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  async function refresh() {
    let j;
    try { j = await fetchMap(api); } catch (e) { if (!d) { box.classList.add("err"); tip.hidden = true; stats.textContent = e.message; } return; }
    const first = !d;
    d = j; head(); place();
    if (first && !played) { played = true; play(); } else draw(1);
  }
  function destroy() { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); document.removeEventListener("keydown", onKey); document.documentElement.classList.remove("rm-lock"); }
  return { el, refresh, destroy, replay: () => { place(); play(); } };
}
