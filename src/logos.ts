// GET /v1/logo/solana/:mint — a token's real picture for the Agents page. Chord's logo route answers a generic SVG for most
// memes, Jupiter's token list has their icon: ask Jupiter first (mints requested within 60 ms share one search call, up to 100),
// then read the picture HERE and serve the bytes from this origin; when nothing answers, redirect to Chord's picture.
// Why not a redirect to the icon: most meme icons are IPFS links, and the public gateways (ipfs.io, dweb.link, w3s.link,
// nftstorage.link) answer 429 to browsers most of the time while a launchpad's own *.mypinata.cloud gateway answers 403 to
// anyone else — the page showed monograms. An IPFS picture is read through gateways that answer (filebase, Pinata's public
// one, then ipfs.io). Icon URLs are cached 24 h (misses 1 h), pictures 24 h in memory (bounded), failures 1 h.
import { Hono } from "hono";
import { http } from "./bots/market";
import { isPubkey } from "./solana/tokens";

const JUP = () => ((process.env.JUPITER_API_URL ?? "").trim().replace(/\/$/, "") || "https://lite-api.jup.ag/swap/v1").replace(/\/swap\/v1$/, "/tokens/v2");
const chordLogo = (mint: string) => `https://api.getchord.xyz/v1/logo/solana/${encodeURIComponent(mint)}`;
const HIT_MS = 24 * 3600_000, MISS_MS = 3600_000, BATCH_WAIT_MS = 60, BATCH_MAX = 100, CACHE_MAX = 20_000;
const IMG_MAX = 3_000_000, PIC_BYTES_MAX = 96_000_000, TRY_MS = 5_000;
const ICON_RE = /^(https|ipfs):\/\//;

const cache = new Map<string, { url: string | null; at: number }>();
let queue = new Map<string, ((u: string | null) => void)[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
  timer = null;
  const batch = queue;
  queue = new Map();
  const mints = [...batch.keys()];
  for (let i = 0; i < mints.length; i += BATCH_MAX) {
    const part = mints.slice(i, i + BATCH_MAX);
    const found = new Map<string, string>();
    try {
      const r = await http(`${JUP()}/search?query=${part.join(",")}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6_000) });
      if (r.ok) for (const t of (await r.json()) as any[]) if (t && typeof t.id === "string" && typeof t.icon === "string" && ICON_RE.test(t.icon)) found.set(t.id, t.icon);
    } catch { /* every mint of the batch falls back to Chord's picture this time */ }
    const now = Date.now();
    for (const m of part) {
      const url = found.get(m) ?? null;
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(m, { url, at: now });
      for (const done of batch.get(m) ?? []) done(url);
    }
  }
}

/** The token's icon URL from Jupiter, or null (cached). */
export function iconOf(mint: string): Promise<string | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < (hit.url ? HIT_MS : MISS_MS)) return Promise.resolve(hit.url);
  return new Promise((resolve) => {
    const waiting = queue.get(mint);
    if (waiting) waiting.push(resolve); else queue.set(mint, [resolve]);
    if (!timer) timer = setTimeout(() => void flush(), BATCH_WAIT_MS);
  });
}

// ── reading the picture ───────────────────────────────────────────────────────────────────────────────────────────────
const GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const viaGateways = (cidPath: string) => (CID.test(cidPath.split("/")[0]) ? GATEWAYS.map((g) => g + cidPath) : []);

/** Where to read an icon from: an IPFS link (ipfs://, any …/ipfs/<cid> gateway, <cid>.ipfs.<host>) through the gateways
 *  that answer, any other https URL as it is; anything else nowhere. */
export function sourcesOf(url: string): string[] {
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/.exec(url);
  if (ipfs) return viaGateways(ipfs[1]);
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  if (u.protocol !== "https:") return [];
  const path = /^\/ipfs\/(.+)$/.exec(u.pathname);
  if (path) { const g = viaGateways(path[1]); if (g.length) return g; }
  const sub = /^([a-z0-9]+)\.ipfs\./.exec(u.hostname);
  if (sub) { const g = viaGateways(sub[1] + (u.pathname === "/" ? "" : u.pathname)); if (g.length) return g; }
  return [url];
}

/** The picture type from its first bytes, for gateways that answer application/octet-stream. */
function sniff(b: Uint8Array): string | null {
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0x89 && s(1, 3) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (s(0, 4) === "GIF8") return "image/gif";
  if (s(0, 4) === "RIFF" && s(8, 4) === "WEBP") return "image/webp";
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 256)))) return "image/svg+xml";
  return null;
}

type Bytes = Uint8Array<ArrayBuffer>;
type Pic = { body: Bytes; type: string; at: number } | { body: null; at: number };
const pics = new Map<string, Pic>();
const reading = new Map<string, Promise<Pic>>();
let picBytes = 0;

async function readPic(url: string): Promise<{ body: Bytes; type: string } | null> {
  for (const src of sourcesOf(url)) {
    try {
      const r = await http(src, { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(TRY_MS) });
      if (!r.ok || Number(r.headers.get("content-length") ?? 0) > IMG_MAX) continue;
      const body = new Uint8Array(await r.arrayBuffer());
      if (!body.byteLength || body.byteLength > IMG_MAX) continue;
      const said = (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const type = said.startsWith("image/") ? said : sniff(body);
      if (type) return { body, type };
    } catch { /* the next gateway */ }
  }
  return null;
}

function keep(mint: string, pic: Pic): Pic {
  const old = pics.get(mint);
  if (old?.body) picBytes -= old.body.byteLength;
  pics.delete(mint);
  pics.set(mint, pic);
  if (pic.body) picBytes += pic.body.byteLength;
  while (picBytes > PIC_BYTES_MAX && pics.size > 1) {
    const [k, v] = pics.entries().next().value!;
    pics.delete(k);
    if (v.body) picBytes -= v.body.byteLength;
  }
  return pic;
}

/** The token's picture (bytes and type), or { body: null } when neither Jupiter nor any gateway has it (cached). */
export function picOf(mint: string): Promise<Pic> {
  const hit = pics.get(mint);
  if (hit && Date.now() - hit.at < (hit.body ? HIT_MS : MISS_MS)) { pics.delete(mint); pics.set(mint, hit); return Promise.resolve(hit); }
  let p = reading.get(mint);
  if (!p) {
    p = (async () => {
      const icon = await iconOf(mint);
      const got = icon ? await readPic(icon) : null;
      return keep(mint, got ? { ...got, at: Date.now() } : { body: null, at: Date.now() });
    })().finally(() => reading.delete(mint));
    reading.set(mint, p);
  }
  return p;
}

export const logos = new Hono();
logos.get("/solana/:mint", async (c) => {
  const mint = c.req.param("mint");
  if (!isPubkey(mint)) return c.json({ error: "bad_mint" }, 400);
  const pic = await picOf(mint);
  if (pic.body) {
    return new Response(pic.body, { headers: {
      "Content-Type": pic.type, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff",
      // a picture opened on its own (an SVG above all) runs nothing on this origin
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    } });
  }
  c.header("Cache-Control", "public, max-age=3600");
  return c.redirect(chordLogo(mint), 302);
});
export function _resetLogos(): void { cache.clear(); pics.clear(); reading.clear(); picBytes = 0; queue = new Map(); if (timer) clearTimeout(timer); timer = null; }
