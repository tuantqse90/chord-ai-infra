import { afterEach, describe, expect, it } from "bun:test";
import { setBotsFetch } from "../src/bots/market";
import { logos, sourcesOf, _resetLogos } from "../src/logos";

afterEach(() => { _resetLogos(); setBotsFetch(null); });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CIDV1 = "bafkreifxafre4guukylf4vtdwlxnvecng6iyn4vkslh4n2ivtcwn72qcxi";
const CIDV0 = "QmNYURozXKYkSuLk2CKbq7JLb6KXnuQRR1jCNgqXiE2m5o";
/** Real Solana mints (USDC, BONK, JUP, POPCAT): this route serves the Solana pictures Ask shows. */
const MINTS = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"];

describe("/v1/logo/solana/:mint", () => {
  it("one Jupiter search for mints asked together; the picture is served from here; unknown → Chord's picture; cached", async () => {
    const [A, B] = MINTS;
    const calls: string[] = [];
    setBotsFetch(async (u) => {
      calls.push(String(u));
      if (String(u).includes("/search?")) return Response.json([{ id: A, icon: "https://img.example/a.png" }, { id: "x", icon: "http://plain.example/x.png" }]);
      if (String(u) === "https://img.example/a.png") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      return new Response("no", { status: 404 });
    });
    const [ra, rb] = await Promise.all([logos.request(`/solana/${A}`), logos.request(`/solana/${B}`)]);
    expect(calls.filter((u) => u.includes("/search?")).length).toBe(1);
    expect(calls[0]).toContain(`query=${A},${B}`);
    expect(ra.status).toBe(200);
    expect(ra.headers.get("content-type")).toBe("image/png");
    expect(ra.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await ra.arrayBuffer())).toEqual(PNG);
    expect(rb.status).toBe(302);
    expect(rb.headers.get("location")).toBe(`https://api.getchord.xyz/v1/logo/solana/${B}`);
    const n = calls.length;
    expect((await logos.request(`/solana/${A}`)).status).toBe(200);
    expect(calls.length).toBe(n);
    expect((await logos.request("/solana/not-a-mint")).status).toBe(400);
  });

  it("an IPFS icon is read through the gateways that answer; octet-stream is sniffed; a non-picture falls back to Chord", async () => {
    const [, , A, B] = MINTS;
    const tried: string[] = [];
    setBotsFetch(async (u) => {
      const s = String(u);
      if (s.includes("/search?")) return Response.json([{ id: A, icon: `https://ipfs.io/ipfs/${CIDV1}` }, { id: B, icon: "https://cdn.example/b" }]);
      tried.push(s);
      if (s.startsWith("https://ipfs.filebase.io/")) return new Response("busy", { status: 429 });
      if (s.startsWith("https://gateway.pinata.cloud/")) return new Response(PNG, { headers: { "Content-Type": "application/octet-stream" } });
      if (s === "https://cdn.example/b") return new Response("<html>", { headers: { "Content-Type": "text/html" } });
      return new Response("no", { status: 404 });
    });
    const ra = await logos.request(`/solana/${A}`);
    expect(ra.status).toBe(200);
    expect(ra.headers.get("content-type")).toBe("image/png");
    expect(tried.slice(0, 2)).toEqual([`https://ipfs.filebase.io/ipfs/${CIDV1}`, `https://gateway.pinata.cloud/ipfs/${CIDV1}`]);
    const rb = await logos.request(`/solana/${B}`);
    expect(rb.status).toBe(302);
  });

  it("sourcesOf: every IPFS shape goes through the gateways, https as is, anything else nowhere", () => {
    expect(sourcesOf(`https://sapphire-working-koi-276.mypinata.cloud/ipfs/${CIDV1}`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${CIDV1}`);
    expect(sourcesOf(`ipfs://${CIDV0}/logo.png`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${CIDV0}/logo.png`);
    expect(sourcesOf(`https://${CIDV1}.ipfs.dweb.link/`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${CIDV1}`);
    expect(sourcesOf("https://arweave.net/abc")).toEqual(["https://arweave.net/abc"]);
    expect(sourcesOf("https://example.com/ipfs/not-a-cid")).toEqual(["https://example.com/ipfs/not-a-cid"]);
    expect(sourcesOf("http://plain.example/x.png")).toEqual([]);
    expect(sourcesOf("javascript:alert(1)")).toEqual([]);
  });
});
