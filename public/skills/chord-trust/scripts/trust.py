#!/usr/bin/env python3
"""Chord trust layer on Monad: read an ERC-8004 agent's record and check it yourself.

Standard library only (Python 3.8+). Nothing here signs or spends: every command is a read.

  trust.py status                      the trust layer in numbers
  trust.py agent ID                    one agent: identity, record, validations, TrustGate
  trust.py verify ID [--fills URL]     re-hash the agent's fills, rebuild the chain, compare with Monad (exit 0 = equal)
  trust.py gate ID                     TrustGate.check read from the RPC, with the policy and what is missing
  trust.py search QUERY [--filter record|validated|card] [--limit N]
  trust.py registry                    every ERC-8004 agent on Monad, counted
  trust.py hash FILE|-                 keccak-256 of the exact bytes
  trust.py get PATH                    any GET under the API, e.g. /v1/trust/outside

verify and gate read Monad directly (--rpc URL or MONAD_RPC_URL, default https://rpc.monad.xyz) and compute every hash
here, so they do not rest on the API's own hashes, heads or counts. CHORD_TRUST_BASE overrides https://chordsi.xyz.
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = os.environ.get("CHORD_TRUST_BASE", "https://chordsi.xyz").rstrip("/")
RPC = os.environ.get("MONAD_RPC_URL", "https://rpc.monad.xyz")
CHAIN_ID = 143
IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
TRACK_RECORD = "0xf5650FB475747e2766faDb46aef735F3Ee4e9f09"
TRUST_GATE = "0xcB30174c3Bf5f8170fA6769fe6D704F55968412A"
UA = "chord-trust-skill/1.0"
MAX_BODY = 20 * 1024 * 1024
PAGE = 1000


class Fail(Exception):
    pass


# ── keccak-256 (the Ethereum hash; hashlib's sha3_256 is the later NIST variant and gives other digests) ─────────────
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
       0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
       0x000000000000800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rol(v, n):
    return ((v << n) | (v >> (64 - n))) & _M if n else v


def _permute(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data)
    msg.append(0x01)
    while len(msg) % rate:
        msg.append(0x00)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(msg[off + 8 * i: off + 8 * i + 8], "little")
        a = _permute(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def hex0x(b: bytes) -> str:
    return "0x" + b.hex()


def selector(sig: str) -> str:
    return keccak256(sig.encode())[:4].hex()


# ── HTTP and RPC ─────────────────────────────────────────────────────────────────────────────────────────────────────
def http_json(url, body=None, timeout=20):
    if not url.startswith("https://") and not url.startswith("http://localhost") and not url.startswith("http://127.0.0.1"):
        raise Fail(f"refusing a non-https URL: {url[:80]}")
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"accept": "application/json", "user-agent": UA, **({"content-type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(MAX_BODY + 1)
    except urllib.error.HTTPError as e:
        msg = ""
        try:
            j = json.loads(e.read(4096).decode("utf-8", "replace"))
            msg = j.get("message") or j.get("error") or ""
        except Exception:
            pass
        raise Fail(f"{url.split('?')[0]} answered {e.code}{': ' + str(msg)[:160] if msg else ''}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise Fail(f"{url.split('?')[0]} did not answer: {getattr(e, 'reason', e)}")
    if len(raw) > MAX_BODY:
        raise Fail(f"{url.split('?')[0]} answered more than {MAX_BODY // (1024 * 1024)} MB")
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise Fail(f"{url.split('?')[0]} did not answer JSON")


def api(path):
    return http_json(BASE + path)


def eth_call(rpc, to, data):
    j = http_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]})
    if j.get("error"):
        raise Fail(f"RPC eth_call failed: {str(j['error'].get('message', j['error']))[:160]}")
    out = j.get("result")
    if not isinstance(out, str) or not out.startswith("0x"):
        raise Fail("RPC answered without a result")
    return bytes.fromhex(out[2:])


def chain_id(rpc):
    j = http_json(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []})
    return int(j.get("result", "0x0"), 16)


def word(n: int) -> str:
    return format(n, "064x")


def agent_id(v: str) -> int:
    if not v.isdigit() or len(v) > 12:
        raise Fail("the agent id is a number like 10333 (its ERC-8004 id on Monad)")
    return int(v)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ms else None


def read_chain(rpc, aid):
    """TrackRecord.chains(agentId) -> head, count, lastAt (unix ms)."""
    out = eth_call(rpc, TRACK_RECORD, "0x" + selector("chains(uint256)") + word(aid))
    if len(out) < 96:
        raise Fail("TrackRecord.chains answered fewer than three words")
    return {"head": hex0x(out[0:32]), "count": int.from_bytes(out[32:64], "big"), "lastAt": int.from_bytes(out[64:96], "big") * 1000}


def read_gate(rpc, aid):
    """TrustGate.check(agentId) -> ok, fills, validations, avgScore, lastAt."""
    out = eth_call(rpc, TRUST_GATE, "0x" + selector("check(uint256)") + word(aid))
    if len(out) < 160:
        raise Fail("TrustGate.check answered fewer than five words")
    w = [int.from_bytes(out[i * 32:(i + 1) * 32], "big") for i in range(5)]
    return {"ok": bool(w[0]), "fills": w[1], "validations": w[2], "avgScore": w[3], "lastAt": w[4] * 1000}


def read_policy(rpc):
    out = eth_call(rpc, TRUST_GATE, "0x" + selector("policy()"))
    w = [int.from_bytes(out[i * 32:(i + 1) * 32], "big") for i in range(4)]
    return {"minFills": w[0], "minValidations": w[1], "minAvgScore": w[2], "maxIdleS": w[3]}


def token_uri(rpc, aid):
    out = eth_call(rpc, IDENTITY, "0x" + selector("tokenURI(uint256)") + word(aid))
    if len(out) < 64:
        return ""
    off = int.from_bytes(out[0:32], "big")
    n = int.from_bytes(out[off:off + 32], "big")
    return out[off + 32:off + 32 + n].decode("utf-8", "replace")


def fetch_doc(uri):
    """A JSON document by URI: https, data:, ipfs:// or ar://."""
    if uri.startswith("data:"):
        meta, _, body = uri[5:].partition(",")
        text = base64.b64decode(body).decode("utf-8") if meta.endswith(";base64") else urllib.parse.unquote(body)
        return json.loads(text)
    if uri.startswith("ipfs://"):
        uri = "https://ipfs.io/ipfs/" + uri[7:].replace("ipfs/", "", 1)
    elif uri.startswith("ar://"):
        uri = "https://arweave.net/" + uri[5:]
    return http_json(uri)


def fills_url(rpc, aid):
    """The agent's "track-record" endpoint, found from the chain: tokenURI -> registration file -> service."""
    uri = token_uri(rpc, aid)
    if not uri:
        raise Fail(f"agent #{aid} has no agentURI on the Identity Registry")
    reg = fetch_doc(uri)
    services = reg.get("services") if isinstance(reg, dict) else None
    if not isinstance(services, list):
        services = reg.get("endpoints") if isinstance(reg, dict) and isinstance(reg.get("endpoints"), list) else []
    for s in services:
        if isinstance(s, dict) and str(s.get("name", "")).lower() == "track-record" and s.get("endpoint"):
            ep = str(s["endpoint"])
            return ep if ep.split(":")[0] in ("https", "http", "data", "ipfs", "ar") else urllib.parse.urljoin(uri, ep)
    raise Fail(f'agent #{aid}: its registration file has no "track-record" service')


def fetch_fills(url):
    """The served { seq, hash, doc } entries by seq. Pages with from / to while full pages of 1,000 come back."""
    by_seq, max_seq = {}, 0

    def take(body):
        nonlocal max_seq
        lst = body if isinstance(body, list) else body.get("fills") if isinstance(body, dict) and isinstance(body.get("fills"), list) else []
        base, added = max_seq, 0
        for i, f in enumerate(lst):
            if not isinstance(f, dict) or f.get("doc") is None:
                continue
            seq = f["seq"] if isinstance(f.get("seq"), int) and not isinstance(f.get("seq"), bool) else base + i + 1
            if seq in by_seq:
                continue
            if not isinstance(f["doc"], str):
                raise Fail(f"fill #{seq} is served as an object, not as its exact text: its bytes cannot be re-hashed here (use the JS verifier)")
            by_seq[seq] = {"seq": seq, "hash": f.get("hash"), "doc": f["doc"]}
            max_seq = max(max_seq, seq)
            added += 1
        return added if len(lst) == PAGE else 0

    more = take(fetch_doc(url))
    for _ in range(100):
        if more <= 0:
            break
        p = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(p.query))
        q["from"], q["to"] = str(max_seq + 1), str(max_seq + PAGE)
        more = take(fetch_doc(urllib.parse.urlunsplit(p._replace(query=urllib.parse.urlencode(q)))))
    return by_seq


def out(v):
    print(json.dumps(v, indent=2, ensure_ascii=False))


# ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def cmd_status(_a):
    s = api("/v1/trust/status")
    reg = api("/v1/trust/registry/stats")
    gate = (s.get("open") or {}).get("gate") or {}
    lag = (s.get("commitLag") or {}).get("medianMs")
    out({
        "chain": f"Monad mainnet ({s.get('chainId')})", "contracts": {**s.get("contracts", {}), "trustGate": gate.get("contract")},
        "agentsWithIdentity": s["counts"]["agents"], "fillsCommitted": s["counts"]["committed"], "pending": s["counts"]["pending"],
        "medianSecondsFillToBlock": None if lag is None else round(lag / 1000, 1),
        "validations": s.get("validation"), "trustGate": {"passing": gate.get("passing"), "checked": gate.get("checked")},
        "everyErc8004AgentOnMonad": {k: reg.get(k) for k in ("agents", "owners", "cardsOk", "withRecord", "validated")},
        "lastCommit": {"agentId": (s.get("lastCommit") or {}).get("agentId"), "at": iso((s.get("lastCommit") or {}).get("at")), "tx": (s.get("lastCommit") or {}).get("tx")},
    })


def missing_of(g, p):
    m = []
    if g["fills"] < p["minFills"]:
        m.append(f"{g['fills']} of {p['minFills']} fills committed")
    if g["validations"] < p["minValidations"]:
        m.append(f"{g['validations']} of {p['minValidations']} validations")
    if g["validations"] and g["avgScore"] < p["minAvgScore"]:
        m.append(f"average score {g['avgScore']}, the gate asks {p['minAvgScore']}")
    if p["maxIdleS"] and (not g["lastAt"] or datetime.now(timezone.utc).timestamp() - g["lastAt"] / 1000 > p["maxIdleS"]):
        m.append(f"no commit in the last {round(p['maxIdleS'] / 86400)} days")
    return m


def cmd_gate(a):
    aid = agent_id(a.id)
    g, p = read_gate(a.rpc, aid), read_policy(a.rpc)
    out({"agentId": str(aid), "contract": TRUST_GATE, "ok": g["ok"], "fills": g["fills"], "validations": g["validations"], "avgScore": g["avgScore"],
         "lastCommit": iso(g["lastAt"]), "policy": p, "missing": missing_of(g, p), "readFrom": a.rpc})
    return 0 if g["ok"] else 1


def cmd_agent(a):
    aid = agent_id(a.id)
    r = api(f"/v1/trust/onchain/{aid}")
    g = api(f"/v1/trust/gate/{aid}")
    ident, chain = r.get("identity") or {}, r.get("chain") or {}
    if not ident.get("owner"):
        raise Fail(f"agent {aid} is not registered on Monad's ERC-8004 Identity Registry")
    vals = [{"fills": f"{(v.get('range') or {}).get('fromSeq')}-{(v.get('range') or {}).get('toSeq')}", "score": v.get("response"), "tx": v.get("responseTx"),
             "report": (BASE + v["responseURI"]) if str(v.get("responseURI", "")).startswith("/") else v.get("responseURI")} for v in (r.get("validations") or []) if v.get("response") is not None][:5]
    out({
        "agentId": str(aid), "name": ident.get("name"), "description": ident.get("description"), "owner": ident.get("owner"), "agentCard": ident.get("agentURI"),
        "runByChord": (r.get("ours") or {}).get("web"),
        "trackRecord": {"fills": chain.get("count"), "head": chain.get("head"), "lastCommit": iso(chain.get("lastAt")), "published": r.get("published"), "documents": r.get("fillsUrl")},
        "validation": {"summary": r.get("validationSummary"), "latest": vals},
        "trustGate": {"ok": g.get("ok"), "missing": g.get("missing"), "policy": g.get("policy"), "contract": g.get("contract")},
        "verdict": "No fills on TrackRecord: nothing to check yet." if not chain.get("count") else "TrustGate trusts this agent today." if g.get("ok") else "TrustGate does not trust it yet: " + ", ".join(g.get("missing") or []) + ".",
        "next": f"python3 scripts/trust.py verify {aid}   # re-hash the documents yourself",
    })


def cmd_verify(a):
    aid = agent_id(a.id)
    if chain_id(a.rpc) != CHAIN_ID:
        raise Fail(f"{a.rpc} is not Monad mainnet (chain {CHAIN_ID})")
    onchain = read_chain(a.rpc, aid)
    url = a.fills or fills_url(a.rpc, aid)
    by_seq = fetch_fills(url) if onchain["count"] else {}
    head, hashed, bad, missing = bytes(32), 0, [], []
    for seq in range(1, onchain["count"] + 1):
        f = by_seq.get(seq)
        if not f:
            missing.append(seq)
            continue
        h = keccak256(f["doc"].encode("utf-8"))
        if isinstance(f.get("hash"), str) and f["hash"].lower() != hex0x(h):
            bad.append(seq)
        head = keccak256(head + h)
        hashed += 1
    equal = not missing and hex0x(head) == onchain["head"].lower()
    ok = equal and onchain["count"] > 0
    if onchain["count"] == 0:
        verdict = f"agent #{aid} has no fills on TrackRecord yet"
    elif missing:
        verdict = f"{len(missing)} committed document(s) missing from the endpoint (seq {', '.join(map(str, missing[:5]))}{', ...' if len(missing) > 5 else ''})"
    elif not equal:
        verdict = f"MISMATCH: the documents rebuild {hex0x(head)}, Monad holds {onchain['head']}"
    else:
        verdict = f"VERIFIED: {onchain['count']} document(s) rebuild the head Monad holds for agent #{aid}"
    out({"ok": ok, "agentId": str(aid), "verdict": verdict, "documents": hashed, "committed": onchain["count"], "rebuiltHead": hex0x(head), "monadHead": onchain["head"],
         "lastCommit": iso(onchain["lastAt"]), "missing": missing, "badHashes": bad, "fills": url, "readFrom": a.rpc, "trackRecord": TRACK_RECORD})
    return 0 if ok else 1


def cmd_search(a):
    limit = max(1, min(25, a.limit))
    f = a.filter if a.filter in ("record", "validated", "card") else "all"
    j = api(f"/v1/trust/registry?q={urllib.parse.quote(a.query)}&filter={f}&page=0&size={limit}")
    out({"total": j.get("total"), "agents": [{"agentId": str(r.get("agentId")), "name": r.get("name"), "description": (r.get("description") or "")[:160] or None, "owner": r.get("owner"),
                                              "fillsOnTrackRecord": r.get("commits"), "validations": r.get("validations"), "avgScore": r.get("avgScore"), "agentCard": r.get("uri")} for r in j.get("rows", [])]})


def cmd_registry(_a):
    j = api("/v1/trust/registry/stats")
    out({k: j.get(k) for k in ("agents", "owners", "withUri", "cardsRead", "cardsOk", "trackRecordService", "withRecord", "validated", "topHosts", "topOwners")})


def cmd_hash(a):
    data = sys.stdin.buffer.read() if a.file == "-" else open(a.file, "rb").read()
    out({"keccak256": hex0x(keccak256(data)), "bytes": len(data), "note": "the hash of these exact bytes; a fill document must be committed and served as the same bytes"})


def cmd_get(a):
    if not a.path.startswith("/v1/") and not a.path.startswith("/mcp"):
        raise Fail("the path starts with /v1/ (for example /v1/trust/outside)")
    out(api(a.path))


def main():
    p = argparse.ArgumentParser(prog="trust.py", description="Chord trust layer on Monad: read and check an ERC-8004 agent's record.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    for name, fn in (("agent", cmd_agent), ("gate", cmd_gate), ("verify", cmd_verify)):
        s = sub.add_parser(name)
        s.add_argument("id")
        s.add_argument("--rpc", default=RPC)
        if name == "verify":
            s.add_argument("--fills", default=None, help="the fills endpoint, when not the one the agent's registration file names")
        s.set_defaults(fn=fn)
    s = sub.add_parser("search")
    s.add_argument("query", nargs="?", default="")
    s.add_argument("--filter", default="all")
    s.add_argument("--limit", type=int, default=10)
    s.set_defaults(fn=cmd_search)
    sub.add_parser("registry").set_defaults(fn=cmd_registry)
    s = sub.add_parser("hash")
    s.add_argument("file")
    s.set_defaults(fn=cmd_hash)
    s = sub.add_parser("get")
    s.add_argument("path")
    s.set_defaults(fn=cmd_get)
    a = p.parse_args()
    try:
        sys.exit(a.fn(a) or 0)
    except Fail as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
