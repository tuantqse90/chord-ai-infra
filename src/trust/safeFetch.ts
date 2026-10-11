// Fetching a URL someone else wrote on-chain (an agentURI, a validation requestURI, an agent card) from inside the server is a
// request into our own network unless it is checked: a URI may name http://api:3001, 127.0.0.1 or a WireGuard peer. safeFetch
// allows http(s) on the default ports to public hosts only: the host must have a dot, every address it resolves to must be
// public, and each redirect (at most 3) is checked the same way.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

/** true for loopback, private, link-local, CGNAT, multicast and reserved addresses (v4 and v6, v4-mapped v6 included) */
export function privateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("ff");
}

/** Reject a URL the server must not fetch; resolve its host and reject private addresses. */
export async function checkUrl(raw: string, resolve: (h: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError("not a URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError("only http(s) URLs");
  if (u.username || u.password) throw new UnsafeUrlError("no credentials in URLs");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("only the default ports");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) { if (privateAddress(host)) throw new UnsafeUrlError("a private address"); return u; }
  if (!host.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/i.test(host) || host === "localhost") throw new UnsafeUrlError("not a public host name");
  const addrs = await resolve(host).catch(() => [] as string[]);
  if (!addrs.length) throw new UnsafeUrlError("the host does not resolve");
  if (addrs.some(privateAddress)) throw new UnsafeUrlError("the host resolves to a private address");
  return u;
}

/** fetch() for URLs from the chain: checked before every hop, redirects followed by hand (at most 3) */
export async function safeFetch(raw: string, init: RequestInit = {}, resolve?: (h: string) => Promise<string[]>): Promise<Response> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await checkUrl(url, resolve);
    const r = await fetch(u, { ...init, redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location")!, u).toString(); continue; }
    return r;
  }
  throw new UnsafeUrlError("too many redirects");
}
