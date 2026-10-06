import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "devkeys-")); process.env.DB_PATH = join(dir, "t.db"); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("api keys", async () => {
  const k = await import("../src/devkeys");
  it("create shows the key once, stores only a hash, caps at 5, revoke kills it", () => {
    k._resetKeys();
    const a = k.createKey("did:privy:a", "bot")!;
    expect(a.key).toMatch(/^ak_live_[0-9a-f]{48}$/);
    expect(k.resolveKey(a.key)).toEqual({ id: a.id, owner: "did:privy:a" });
    expect(k.listKeys("did:privy:a")[0]).not.toHaveProperty("key");
    for (let i = 0; i < 4; i++) k.createKey("did:privy:a", `k${i}`);
    expect(k.createKey("did:privy:a", "six")).toBeNull();
    expect(k.listKeys("did:privy:b")).toEqual([]);
    expect(k.revokeKey("did:privy:b", a.id)).toBe(false); // someone else's key
    expect(k.revokeKey("did:privy:a", a.id)).toBe(true);
    expect(k.resolveKey(a.key)).toBeNull();
  });
  it("usage counts per day and the per-minute budget holds", () => {
    k._resetKeys();
    const a = k.createKey("did:privy:c", "x")!;
    for (let i = 0; i < k.KEY_RPM; i++) expect(k.useKey(a.id)).toBe(true);
    expect(k.useKey(a.id)).toBe(false);
    const s = k.usageSeries("did:privy:c", 30);
    expect(s.length).toBe(30);
    expect(s[29].n).toBe(k.KEY_RPM);
  });
});

describe("privy token", async () => {
  const { verifyPrivyToken, AuthError } = await import("../src/privyAuth");
  it("refuses junk before any network, and with no app id says sign-in is off", async () => {
    const was = process.env.PRIVY_APP_ID;
    delete process.env.PRIVY_APP_ID;
    await expect(verifyPrivyToken("a.b.c")).rejects.toBeInstanceOf(AuthError);
    process.env.PRIVY_APP_ID = "app";
    await expect(verifyPrivyToken("nope")).rejects.toThrow("malformed");
    await expect(verifyPrivyToken(`${Buffer.from('{"alg":"HS256","kid":"k"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.x`)).rejects.toThrow("unsupported");
    if (was) process.env.PRIVY_APP_ID = was; else delete process.env.PRIVY_APP_ID;
  });
});
