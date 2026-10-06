// Who is signed in: a Privy access token (ES256 JWT) checked against the app's JWKS, Chord's verifier (api
// services/appAuth.ts) with its rules: algorithm pinned to ES256, iss privy.io, aud = PRIVY_APP_ID, not expired, sub a
// Privy DID; keys cached 10 minutes, an unknown kid refetched at most once a minute, last-good keys served on a blip.
import { config } from "./config";

export class AuthError extends Error {
  constructor(readonly status: 401 | 503, readonly code: string, message: string) { super(message); }
}
type Jwk = { kty: string; crv: string; x: string; y: string; kid: string };
let jwks: { at: number; keys: Jwk[] } | null = null;

async function fetchJwks(appId: string): Promise<Jwk[]> {
  const r = await fetch(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  const keys = (((await r.json()) as any).keys ?? []).filter((k: any) => k?.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" && typeof k.kid === "string");
  if (!keys.length) throw new Error("jwks: no P-256 keys");
  jwks = { at: Date.now(), keys };
  return keys;
}
async function keysFor(appId: string, refresh = false): Promise<Jwk[]> {
  if (jwks && !refresh && Date.now() - jwks.at < 600_000) return jwks.keys;
  try { return await fetchJwks(appId); } catch {
    if (jwks) return jwks.keys;
    throw new AuthError(503, "AUTH_UNAVAILABLE", "sign-in check is unavailable right now");
  }
}
const b64uJson = (s: string): any => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return null; } };

export async function verifyPrivyToken(token: string): Promise<{ did: string }> {
  const appId = config.privyAppId();
  if (!appId) throw new AuthError(503, "AUTH_DISABLED", "sign-in is not set up on this server");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "AUTH_FAILED", "malformed token");
  const [h, p, s] = parts;
  const header = b64uJson(h), claims = b64uJson(p);
  if (!header || !claims) throw new AuthError(401, "AUTH_FAILED", "malformed token");
  if (header.alg !== "ES256" || typeof header.kid !== "string") throw new AuthError(401, "AUTH_FAILED", "unsupported token algorithm");
  let jwk = (await keysFor(appId)).find((k) => k.kid === header.kid);
  if (!jwk && jwks && Date.now() - jwks.at > 60_000) jwk = (await keysFor(appId, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError(401, "AUTH_FAILED", "unknown signing key");
  let ok = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
  } catch { ok = false; }
  if (!ok) throw new AuthError(401, "AUTH_FAILED", "invalid token signature");
  const now = Math.floor(Date.now() / 1000);
  const audOk = claims.aud === appId || (Array.isArray(claims.aud) && claims.aud.includes(appId));
  if (claims.iss !== "privy.io" || !audOk) throw new AuthError(401, "AUTH_FAILED", "token is not for this app");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new AuthError(401, "AUTH_FAILED", "token expired");
  if (typeof claims.sub !== "string" || !claims.sub.startsWith("did:privy:")) throw new AuthError(401, "AUTH_FAILED", "token subject is not a Privy user");
  return { did: claims.sub };
}
export const _resetJwks = () => { jwks = null; };
