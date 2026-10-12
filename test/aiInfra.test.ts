import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { useTempDb } from "../src/bots/_testkit";

let tmp: ReturnType<typeof useTempDb>;
const { _closeTrustDb, trustDb } = await import("../src/trust/registry");
const { checkUrl, privateAddress, UnsafeUrlError } = await import("../src/trust/safeFetch");
const { readCard, searchRegistry, registryStats, registryMap, _resetRegistry } = await import("../src/trust/registryIndex");
const { handle, TOOLS } = await import("../src/mcp");
beforeAll(() => { _closeTrustDb(); _resetRegistry(); tmp = useTempDb("aiinfra"); });
afterAll(() => { _closeTrustDb(); tmp.restore(); });

describe("safeFetch: URLs from the chain never reach our own network", () => {
  it("private, loopback, link-local, CGNAT and v4-mapped addresses are private; public ones are not", () => {
    for (const ip of ["10.66.0.2", "127.0.0.1", "172.20.1.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect({ ip, p: privateAddress(ip) }).toEqual({ ip, p: true });
    for (const ip of ["104.21.3.4", "8.8.8.8", "2606:4700::1"]) expect({ ip, p: privateAddress(ip) }).toEqual({ ip, p: false });
  });
  it("refuses docker service names, internal suffixes, other ports, credentials, private literals and hosts resolving inside", async () => {
    const pub = async () => ["104.21.3.4"], inside = async () => ["10.66.0.2"];
    for (const u of ["http://api:3001/x", "http://redis/x", "https://box.internal/x", "https://a.example.com:8545/", "https://u:p@a.example.com/", "http://127.0.0.1/", "http://[::1]/", "ftp://a.example.com/"])
      await expect(checkUrl(u, pub)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(checkUrl("https://rebind.example.com/card.json", inside)).rejects.toThrow("private address");
    expect((await checkUrl("https://chordsi.xyz/v1/trust/docs/0xab", pub)).host).toBe("chordsi.xyz");
  });
});

describe("every ERC-8004 agent on Monad", () => {
  it("reads data: cards; ranks agents with a record first; filters and searches by id, name and owner", async () => {
    const card = { name: "Data agent", services: [{ name: "track-record", endpoint: "https://x.example/f" }] };
    const got = await readCard(`data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`);
    expect("card" in got && got.card.name).toBe("Data agent");
    const d = trustDb();
    d.run(`CREATE TABLE IF NOT EXISTS trust_chain (agent_id TEXT NOT NULL, seq INTEGER NOT NULL, fill_hash TEXT NOT NULL, head TEXT NOT NULL, block INTEGER NOT NULL, tx TEXT NOT NULL, PRIMARY KEY (agent_id, seq))`);
    registryStats(); // creates registry_agents
    const ins = d.prepare("INSERT INTO registry_agents (agent_id, owner, uri, scheme, name, description, services, card, card_at, updated) VALUES (?, ?, ?, 'https', ?, ?, ?, ?, 1, 1)");
    ins.run(1, "0xaaa1", "https://a.example/1", "Alpha trader", "momentum on MON", "[]", "ok");
    ins.run(2, "0xbbb2", "https://b.example/2", "Beta LP", "liquidity", JSON.stringify([{ name: "track-record" }]), "ok");
    ins.run(3, "0xaaa1", null, null, null, "[]", null);
    d.run("INSERT INTO trust_chain VALUES ('2', 1, '0x1', '0x1', 10, '0xt')");
    d.run("INSERT INTO trust_validations (request_hash, bot_id, agent_id, validator, from_seq, to_seq, head, request, created_at, response) VALUES ('0xv', 'ext:2', '2', '0xv', 1, 1, '', '', 1, 96)");
    const all = searchRegistry();
    expect(all.total).toBe(3);
    expect(all.rows[0]).toMatchObject({ agentId: 2, commits: 1, validations: 1, avgScore: 96, trackRecordService: true });
    expect(searchRegistry({ filter: "record" }).rows.map((r) => r.agentId)).toEqual([2]);
    expect(searchRegistry({ q: "alpha" }).rows.map((r) => r.agentId)).toEqual([1]);
    expect(searchRegistry({ q: "3" }).rows.map((r) => r.agentId)).toEqual([3]);
    expect(searchRegistry({ q: "0xaaa" }).total).toBe(2);
    expect(registryStats()).toMatchObject({ agents: 3, cardsOk: 2, trackRecordService: 1, withRecord: 1, validated: 1, owners: 2 });
  });
  it("the map: one point per agent, grouped by card host; a host stands alone at 25 agents or with one record-keeper", () => {
    const d = trustDb();
    const ins = d.prepare("INSERT INTO registry_agents (agent_id, owner, uri, scheme, name, services, card, card_at, updated) VALUES (?, '0xccc3', ?, ?, ?, '[]', 'ok', 1, 1)");
    for (let i = 100; i < 130; i++) ins.run(i, `https://big.example/agent/${i}`, "https", `Mint ${i}`);
    ins.run(200, "data:application/json;base64,e30=", "data", "Inline");
    ins.run(201, "https://a.example/201", "https", "Alpha two");
    _resetRegistry();
    const m = registryMap();
    expect(m).toMatchObject({ total: 35, withRecord: 1, validated: 1, names: { "2": "Beta LP" } });
    // a.example has 2 agents and no record, so it folds; b.example has 1 agent that keeps a record, so it stands alone
    expect(m.groups).toEqual([{ host: "big.example", agents: 30, record: 0 }, { host: "b.example", agents: 1, record: 1 }, { host: "other hosts", agents: 2, record: 0 },
      { host: "inline", agents: 1, record: 0 }, { host: "no card", agents: 1, record: 0 }]);
    expect(m.agents.length).toBe(35);
    expect(m.agents.slice(0, 30).every((a, i) => a[0] === 100 + i && a[1] === 0)).toBe(true);
    expect(m.agents.slice(30)).toEqual([[2, 1, 1, 1, 96], [1, 2, 0, 0, -1], [201, 2, 0, 0, -1], [200, 3, 0, 0, -1], [3, 4, 0, 0, -1]]);
    expect(m.groups.reduce((n, g) => n + g.agents, 0)).toBe(m.total);
    expect(registryMap()).toBe(m); // cached for a minute
  });
});

describe("MCP server", () => {
  it("initialize negotiates the version; tools/list; notifications get no answer; unknown method and tool are errors", async () => {
    const init: any = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "chord-trust" } });
    expect(((await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any).result.protocolVersion).toBe("2025-06-18");
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list: any = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(list.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(list.result.tools.every((t: any) => t.inputSchema?.type === "object" && t.annotations?.readOnlyHint)).toBe(true);
    expect(((await handle({ jsonrpc: "2.0", id: 4, method: "nope" })) as any).error.code).toBe(-32601);
    expect(((await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })) as any).error.code).toBe(-32602);
    expect(((await handle({ id: 6, method: "ping" } as any)) as any).error.code).toBe(-32600);
  });
  it("a tool's bad argument is a tool error (isError), not a protocol error; trust_status answers from the record", async () => {
    const bad: any = await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "gate_check", arguments: { agentId: "abc" } } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain("agentId must be a number");
    const st: any = await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "trust_status", arguments: {} } });
    expect(st.result.isError).toBe(false);
    expect(st.result.structuredContent).toMatchObject({ chain: "Monad mainnet (143)", everyErc8004AgentOnMonad: { agents: 35 } }); // the 3 of the search test and the 32 of the map test
    const s2: any = await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_agents", arguments: { query: "beta" } } });
    expect(s2.result.structuredContent.agents[0]).toMatchObject({ agentId: "2", fillsOnTrackRecord: 1, avgScore: 96 });
  });
});
