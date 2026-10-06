import { afterEach, describe, expect, it } from "bun:test";
import { setBotsFetch } from "../src/bots/market";
import { addr } from "../src/bots/_testkit";
import { logos, _resetLogos } from "../src/logos";

afterEach(() => { _resetLogos(); setBotsFetch(null); });

describe("/v1/logo/solana/:mint", () => {
  it("one Jupiter search for mints asked together; icon → 302 to it, unknown → Chord's picture; cached", async () => {
    const A = addr(201), B = addr(202);
    const calls: string[] = [];
    setBotsFetch(async (u) => { calls.push(String(u)); return Response.json([{ id: A, icon: "https://img.example/a.png" }, { id: "x", icon: "http://plain.example/x.png" }]); });
    const [ra, rb] = await Promise.all([logos.request(`/solana/${A}`), logos.request(`/solana/${B}`)]);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(`query=${A},${B}`);
    expect(ra.status).toBe(302);
    expect(ra.headers.get("location")).toBe("https://img.example/a.png");
    expect(rb.headers.get("location")).toBe(`https://api.getchord.xyz/v1/logo/solana/${B}`);
    await logos.request(`/solana/${A}`);
    expect(calls.length).toBe(1);
    expect((await logos.request("/solana/not-a-mint")).status).toBe(400);
  });
});
