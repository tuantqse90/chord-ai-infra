// SSRF guard for URLs that came from a THIRD PARTY rather than from us.
//
// The concrete exposure: a token's `logoURI` is whatever the token's creator typed into nad.fun
// (`token_info.image_uri`, services/tokenRegistry.ts) or whatever DexScreener echoes back. That
// string reaches `fetch()` server-side in the logo proxy, i.e. an anonymous user who launches a
// memecoin picks a URL our backend will request from INSIDE the private network — engine:3002,
// redis:6379, the cloud metadata endpoint at 169.254.169.254, or a port scan of the host.
//
// So: only plain https on a public host. Everything a browser would happily fetch but a server has
// no business fetching is refused here.

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local — cloud instance metadata lives here
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

const BLOCKED_HOST_SUFFIX = [".internal", ".local", ".localdomain", ".cluster.local"];
const BLOCKED_HOST_EXACT = ["localhost", "metadata.google.internal", "instance-data"];

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST_EXACT.includes(h)) return true;
  if (BLOCKED_HOST_SUFFIX.some((s) => h.endsWith(s))) return true;
  if (PRIVATE_V4.some((re) => re.test(h))) return true;
  // IPv6 loopback / link-local / unique-local, incl. IPv4-mapped forms.
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (h.startsWith("::ffff:")) return isPrivateHost(h.slice(7));
  // A bare hostname with no dot is an internal service name on a container network (engine, redis).
  if (!h.includes(".") && !/^\d+$/.test(h)) return true;
  return false;
}

/**
 * True when `url` is safe for the server to fetch on behalf of a request.
 * https only, default port only, no credentials, no private/loopback/link-local host.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false; // no http/file/ftp/data/gopher…
  if (u.username || u.password) return false; // https://user:pass@internal/
  if (u.port && u.port !== "443") return false; // https://host:6379 → protocol-confusion probes
  if (!u.hostname) return false;
  return !isPrivateHost(u.hostname);
}
