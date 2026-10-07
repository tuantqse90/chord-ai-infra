// Privy's server API, for auto-trade only (src/autoTrade.ts): find the person's embedded Solana wallet, check that our session
// signer sits on it with our policy, and sign one Solana transaction through the wallet's RPC with our authorization key. This
// file never sends anything to the chain and never holds a key of the person's: Privy signs inside its enclave, only for a
// wallet whose owner added our key quorum, and only what the quorum's policy allows.
//
// Docs used (read 07/10/2026):
//   https://docs.privy.io/api-reference/wallets/solana/sign-transaction
//       POST /v1/wallets/{wallet_id}/rpc { method: "signTransaction", params: { transaction: <base64>, encoding: "base64" } }
//       → { method, data: { signed_transaction: <base64>, encoding: "base64" } }; Basic auth app_id:app_secret + privy-app-id
//   https://docs.privy.io/controls/authorization-keys/using-owners/sign/direct-implementation
//       privy-authorization-signature = base64(ECDSA P-256 / SHA-256 over RFC 8785 JSON of
//       { version: 1, method, url, body, headers: { "privy-app-id" (+ privy-idempotency-key / privy-request-expiry when sent) } }),
//       key = PKCS8 DER after the "wallet-auth:" prefix
//   https://docs.privy.io/api-reference/users/get        GET /v1/users/{user_id} → linked_accounts[] (wallet: id, address, chain_type, wallet_client_type)
//   https://docs.privy.io/api-reference/wallets/get      GET /v1/wallets/{wallet_id} → additional_signers[] { signer_id, override_policy_ids }
//   https://docs.privy.io/wallets/using-wallets/signers/add-signers   client useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })
//   https://docs.privy.io/controls/policies/example-policies/solana  policy rules on solana_program_instruction.programId
// The installed @privy-io/react-auth 3.45.0 (js-sdk-core) signs its own wallet requests the same way (the `canonicalize` package,
// RFC 8785); its addSigners appends { signer_id, override_policy_ids } to the wallet's additional_signers (TEE wallets only) and
// removeSigners sets additional_signers to [] (every signer).
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { config } from "./config";

export class PrivyApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "PrivyApiError"; }
}

const KEY_PREFIX = "wallet-auth:";
let keyCache: { raw: string; key: KeyObject | null; err: string | null } | null = null;
/** Our authorization key, parsed once per value. Null + a reason when it is not a P-256 PKCS8 key. */
function authKey(): { key: KeyObject | null; err: string | null } {
  const raw = config.privyAuthorizationKey();
  if (keyCache?.raw === raw) return keyCache;
  let key: KeyObject | null = null, err: string | null = null;
  try {
    const der = Buffer.from(raw.startsWith(KEY_PREFIX) ? raw.slice(KEY_PREFIX.length) : raw, "base64");
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") { key = null; err = "PRIVY_AUTHORIZATION_PRIVATE_KEY is not a P-256 key"; }
  } catch { err = "PRIVY_AUTHORIZATION_PRIVATE_KEY is not readable (expected wallet-auth:<base64 PKCS8 DER>)"; }
  keyCache = { raw, key, err };
  return keyCache;
}

export type PrivyServerConfig =
  | { ok: true; appId: string; quorumId: string; policyId: string }
  | { ok: false; missing: string[]; problem: string | null };
/** Whether the server can sign through Privy: every setting present and the key readable. Names only, never values. */
export function privyServerConfig(): PrivyServerConfig {
  const need: [string, string][] = [
    ["PRIVY_APP_ID", config.privyAppId()], ["PRIVY_APP_SECRET", config.privyAppSecret()], ["PRIVY_AUTHORIZATION_PRIVATE_KEY", config.privyAuthorizationKey()],
    ["PRIVY_SIGNER_QUORUM_ID", config.privySignerQuorumId()], ["PRIVY_SIGNER_POLICY_ID", config.privySignerPolicyId()],
  ];
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, missing, problem: null };
  const k = authKey();
  if (!k.key) return { ok: false, missing: [], problem: k.err };
  return { ok: true, appId: config.privyAppId(), quorumId: config.privySignerQuorumId(), policyId: config.privySignerPolicyId() };
}

/** RFC 8785 (JSON Canonicalization Scheme) for the JSON values a request carries: keys sorted by UTF-16 code units at every
 *  level, no whitespace, ECMAScript number and string serialization (what JSON.stringify does for those). */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("canonicalize: not a finite number"); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x === undefined || typeof x === "function" ? null : x)).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalize: cannot encode a ${typeof v}`);
}

/** The privy-authorization-signature of one request (direct implementation, version 1). */
export function authorizationSignature(req: { method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body: unknown; headers: Record<string, string> }, key?: KeyObject): string {
  const k = key ?? authKey().key;
  if (!k) throw new PrivyApiError(503, "the authorization key is not set");
  const privyHeaders = Object.fromEntries(Object.entries(req.headers).filter(([h]) => h.toLowerCase().startsWith("privy-")).map(([h, v]) => [h.toLowerCase(), v]));
  const payload = { version: 1, method: req.method, url: req.url.replace(/\/$/, ""), body: req.body, headers: privyHeaders };
  return sign("sha256", Buffer.from(canonicalize(payload), "utf8"), k).toString("base64");
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (i, init) => fetch(i, init);
export function setPrivyFetch(f: Fetch | null): void { fetchImpl = f ?? ((i, init) => fetch(i, init)); }

async function privy<T>(method: "GET" | "POST", path: string, body?: unknown, signed = false): Promise<T> {
  const appId = config.privyAppId(), secret = config.privyAppSecret();
  if (!appId || !secret) throw new PrivyApiError(503, "Privy's server API is not set up on this server");
  const url = `${config.privyApiUrl()}${path}`;
  const headers: Record<string, string> = { "privy-app-id": appId };
  if (signed && method === "POST") headers["privy-authorization-signature"] = authorizationSignature({ method, url, body, headers: { "privy-app-id": appId } });
  let r: Response;
  try {
    r = await fetchImpl(url, {
      method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      headers: { ...headers, Authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString("base64")}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
  } catch (e) {
    throw new PrivyApiError(502, `Privy did not answer: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = String(j.error ?? j.message ?? msg).slice(0, 200); } catch { /* keep text */ }
    throw new PrivyApiError(r.status, `Privy answered ${r.status}: ${msg}`);
  }
  try { return JSON.parse(text) as T; } catch { throw new PrivyApiError(502, "Privy answered something that is not JSON"); }
}

/** id null = the wallet exists but has no server-side id (not a TEE wallet): Privy cannot add signers to it. */
export type PrivySolWallet = { id: string | null; address: string };
const DID_RE = /^did:privy:[A-Za-z0-9]{6,64}$/;
/** The person's embedded (Privy) Solana wallet, from their user record: the one at `address` when given, else the first. */
export async function embeddedSolanaWallet(did: string, address?: string | null): Promise<PrivySolWallet | null> {
  if (!DID_RE.test(did)) throw new PrivyApiError(400, "not a Privy user id");
  const u = await privy<{ linked_accounts?: any[] }>("GET", `/v1/users/${did}`);
  const wallets = (u.linked_accounts ?? []).filter((a) => a?.type === "wallet" && a.chain_type === "solana" && (a.wallet_client_type === "privy" || a.connector_type === "embedded")
    && typeof a.address === "string")
    .sort((a, b) => (Number(a.wallet_index) || 0) - (Number(b.wallet_index) || 0));
  const w = address ? wallets.find((a) => a.address === address) : wallets[0];
  return w ? { id: typeof w.id === "string" && w.id ? w.id : null, address: w.address } : null;
}

export type SignerCheck = { ok: true } | { ok: false; fix: "add" | "replace"; message: string };
/** Whether our key quorum is an additional signer of the wallet, under our policy. */
export async function signerOnWallet(walletId: string, address: string, quorumId: string, policyId: string): Promise<SignerCheck> {
  const w = await privy<{ id: string; address: string; chain_type: string; additional_signers?: { signer_id: string; override_policy_ids?: string[] }[] }>("GET", `/v1/wallets/${encodeURIComponent(walletId)}`);
  if (w.address !== address || w.chain_type !== "solana") throw new PrivyApiError(409, "Privy's wallet record does not match this Solana wallet");
  const ours = (w.additional_signers ?? []).filter((s) => s?.signer_id === quorumId);
  if (!ours.length) return { ok: false, fix: "add", message: "Approve auto-trade in your wallet first (the session signer is not on it yet)." };
  if (!ours.some((s) => (s.override_policy_ids ?? []).includes(policyId))) {
    return { ok: false, fix: "replace", message: "The session signer on your wallet is not under this app's trading policy: it has to be added again." };
  }
  return { ok: true };
}

/** Sign one Solana transaction (base64) with the person's wallet through Privy, as our key quorum. Returns the signed base64. */
export async function signSolanaTransaction(walletId: string, txB64: string): Promise<string> {
  const body = { method: "signTransaction", params: { transaction: txB64, encoding: "base64" } };
  const r = await privy<{ method?: string; data?: { signed_transaction?: string; encoding?: string } }>("POST", `/v1/wallets/${encodeURIComponent(walletId)}/rpc`, body, true);
  const signed = r?.data?.signed_transaction;
  if (typeof signed !== "string" || !signed || (r.data?.encoding && r.data.encoding !== "base64")) throw new PrivyApiError(502, "Privy's answer carries no signed transaction");
  return signed;
}

export function _resetPrivyWallets(): void { keyCache = null; setPrivyFetch(null); }
