// The Agents mascot: a deadpan terminal head as inline SVG (no requests, no dependencies).
// One silhouette: rounded-square bezel, dark screen, two lit eyes, flat mouth, one antenna.
//   type → antenna tip + lit colour (copy dot green · alert bell amber · lp droplet cyan · custom blocks violet)
//   copy trader / LP copy → the face glances sideways, eyes half-lidded
//   id   → bezel tint (8 cool graphites) · eye cut or glance side · mouth cut, so two agents of one type differ
// Drawn on a 32 grid, snapped to whole pixels at the asked size. The screen is dark and lit in both themes; bezel and
// tip follow the page's color-scheme via light-dark() (the fill attribute = the dark value, for older engines).
const LIT = { neutral: ["#E9E6F5", "currentColor"], copy: ["#3DDC97", "#0A8A56"], lp: ["#5BC8F5", "#0A73AD"], alert: ["#FFB547", "#A86400"], custom: ["#B98CFF", "#7C2FE6"] };
const HUES = [252, 236, 220, 204, 188, 268, 284, 300];
const EYES = [[3, 4], [3.5, 3.5], [2.5, 4.5], [3, 3]];
const MOUTHS = [[7, 0], [5, 0], [6, 1], [4, -1]];
const LABEL = { neutral: "Agent", copy: "Copy trader agent", alert: "Alert agent", lp: "LP agent", lpcopy: "LP copy agent", custom: "Custom agent" };

/** FNV-1a over the id: the same agent always gets the same face. */
function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const tone = (dark, light) => (light === "currentColor" ? `fill="currentColor"` : `fill="${dark}" style="fill:light-dark(${light},${dark})"`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The mascot as an inline <svg> string.
 * @param {"neutral"|"copy"|"alert"|"lp"|"lpcopy"|"custom"} variant
 * @param {{ size?: number, seed?: string|null, label?: string, decorative?: boolean, className?: string }} opts
 *   seed = an agent id (null = the plain, untinted mascot); decorative = aria-hidden (when the name sits next to it).
 */
export function mascotSvg(variant = "neutral", opts = {}) {
  const S = Math.max(12, Math.round(opts.size ?? 32)), k = S / 32, c = S / 2;
  const R = (n) => Math.round(n * k);
  const v = LABEL[variant] ? variant : "neutral", side = v === "copy" || v === "lpcopy", kind = v === "lpcopy" ? "lp" : v;
  const h = opts.seed == null || opts.seed === "" ? null : hash(opts.seed);
  const hue = h == null ? 252 : HUES[h & 7], sat = h == null ? 8 : 18;
  const [lit, tipLight] = LIT[kind], face = `fill="${lit}"`, tip = tone(lit, tipLight);
  // bezel + antenna stem (one tone), screen inset with concentric corners
  const bezel = tone(`hsl(${hue} ${sat}% 26%)`, `hsl(${hue} ${sat + 6}% 25%)`);
  const hx = R(3), hy = R(9), hw = S - 2 * hx, hh = S - R(1) - hy, hr = R(6.5), b = Math.max(1, Math.round(S / 20)), st = 2 * Math.max(1, Math.round(k * 0.9));
  let o = `<rect x="${c - st / 2}" y="${R(4)}" width="${st}" height="${hy - R(4) + 1}" ${bezel}/><rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="${hr}" ${bezel}/>`;
  o += `<rect x="${hx + b}" y="${hy + b}" width="${hw - 2 * b}" height="${hh - 2 * b}" rx="${Math.max(1, hr - b)}" ${tone(`hsl(${hue} ${sat}% 10%)`, `hsl(${hue} ${sat}% 8%)`)}/>`;
  // face
  const [ew0, eh0] = side ? [4.5, 2.5] : EYES[h == null ? 0 : (h >>> 3) & 3];
  const ew = Math.max(2, R(ew0)), eh = Math.max(2, R(eh0)), ey = R(19) - eh, fx = side ? R(3.5) * (h != null && (h >>> 3) & 1 ? -1 : 1) : 0, er = Math.max(0.5, Math.min(ew, eh) / 4);
  const xl = Math.round(c - R(4.5) - ew / 2);
  for (const x of [xl, S - xl - ew]) o += `<rect x="${x + fx}" y="${ey}" width="${ew}" height="${eh}" rx="${er}" ${face}/>`;
  const [mw0, mo0] = MOUTHS[h == null ? 0 : (h >>> 5) & 3], mw = R(mw0), mh = Math.max(1, R(1.5));
  o += `<rect x="${Math.round(c - mw / 2) + R(mo0) + fx}" y="${R(23.5)}" width="${mw}" height="${mh}" rx="${mh / 2}" ${face}/>`;
  // antenna tip = what the agent does
  if (kind === "alert") {
    o += `<path d="M${c - R(3)} ${R(5)}C${c - R(3)} ${R(1.6)} ${c - R(1.8)} ${R(0.5)} ${c} ${R(0.5)}S${c + R(3)} ${R(1.6)} ${c + R(3)} ${R(5)}H${c + R(4)}V${R(6.5)}H${c - R(4)}Z" ${tip}/>`;
  } else if (kind === "lp") {
    const r = R(3), y = R(0.25) + 1.9 * r, f = (n) => +n.toFixed(2); // droplet: point up, round bottom
    o += `<path d="M${c} ${f(y - r * 1.9)}L${f(c + r * 0.87)} ${f(y - r * 0.5)}A${r} ${r} 0 1 1 ${f(c - r * 0.87)} ${f(y - r * 0.5)}Z" ${tip}/>`;
  } else if (kind === "custom") {
    if (S < 28) o += `<rect x="${c - R(3)}" y="${R(0.5)}" width="${R(6)}" height="${R(6)}" rx="${R(1)}" ${tip}/>`;
    else { const q = R(2.75), w = R(6.5), y = R(0.5), x = Math.round(c - w / 2); o += `<rect x="${x}" y="${y}" width="${q}" height="${q}" rx="${R(0.5)}" ${tip}/><rect x="${x}" y="${y + q + R(0.75)}" width="${w}" height="${q}" rx="${R(0.5)}" ${tip}/>`; }
  } else {
    o += `<circle cx="${c}" cy="${R(3.5)}" r="${R(3)}" ${tip}/>`;
  }
  const a11y = opts.decorative ? `aria-hidden="true"` : `role="img" aria-label="${esc(opts.label ?? LABEL[v])}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="agm${opts.className ? ` ${esc(opts.className)}` : ""}" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" ${a11y} focusable="false" style="flex:none">${o}</svg>`;
}

/** The variant of an agent from the API (`{ id, type, params }`, src/bots/types.ts): an LP agent with params.mode "copy" is an LP copy agent. */
export function agentVariant(bot) {
  const t = bot?.type;
  return t === "lp" ? (bot?.params?.mode === "copy" ? "lpcopy" : "lp") : t === "copy" || t === "alert" || t === "custom" ? t : "neutral";
}

/** An agent's avatar: its type's mascot with the agent's own touch from its id. `opts` as mascotSvg (label, decorative, className). */
export function agentAvatar(bot, size = 32, opts = {}) {
  return mascotSvg(agentVariant(bot), { ...opts, size, seed: bot?.id ?? null });
}
