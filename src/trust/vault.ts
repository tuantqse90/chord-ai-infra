// AgentVault on Monad (contracts/src/examples/AgentVault.sol): a pool of MON that pays an ERC-8004 agent's owner a capped
// amount per epoch, and only while TrustGate trusts the agent. It is the example of what the trust layer is for: a contract
// that moves money on an agent's record with nobody in between. Here:
//   · vaultStatus   the pool, its rule and the payouts this app's agents drew (table vault_draws, written when a draw lands);
//   · vaultCheck    for ANY agent id: the gate's answer, and AgentVault.draw simulated as a call from the agent's owner, so the
//                   page shows the exact revert a contract would get (NotTrusted, OverAllowance) without sending anything;
//   · payouts       once an epoch, up to VAULT_AUTO_DRAWS (default 1, 0 = off) of this app's trusted agents draw their allowance
//                   to the operator, the wallet that pays the gas of their commits. An agent the gate stops trusting is skipped
//                   by the contract itself, not by this code: the draw is tried only after the gate read, and a revert is logged.
import { BaseError, ContractFunctionRevertedError, formatEther } from "viem";
import { getBot } from "../bots";
import { logger } from "../chord/utils/logger";
import { EXPLORER } from "../monad/chain";
import { operatorAccount, publicClient } from "../monad/client";
import { agentVaultAbi } from "./abi";
import { gateCheck, gatePolicy, gateWhy, identityOwner, trustConfig, vaultDraw } from "./chain";
import { trustDb } from "./registry";

const TICK_MS = 10 * 60_000;
function db() {
  const d = trustDb();
  d.run("CREATE TABLE IF NOT EXISTS vault_draws (tx TEXT PRIMARY KEY, agent_id TEXT NOT NULL, to_addr TEXT NOT NULL, amount TEXT NOT NULL, epoch INTEGER NOT NULL, block INTEGER NOT NULL, at INTEGER NOT NULL)");
  return d;
}
type DrawRow = { tx: string; agent_id: string; to_addr: string; amount: string; epoch: number; block: number; at: number };

let rule: { allowance: bigint; epochLength: number } | null = null;
/** the vault's two immutables, read once */
async function vaultRule() {
  if (rule) return rule;
  const vault = trustConfig.agentVault()!, pc = publicClient();
  const [allowance, epochLength] = await Promise.all([
    pc.readContract({ address: vault, abi: agentVaultAbi, functionName: "allowancePerEpoch" }) as Promise<bigint>,
    pc.readContract({ address: vault, abi: agentVaultAbi, functionName: "epochLength" }) as Promise<bigint>,
  ]);
  rule = { allowance, epochLength: Number(epochLength) };
  return rule;
}
const mon = (wei: bigint | string) => Number(formatEther(BigInt(wei)));
const nameOf = (agentId: string): string | null => {
  const r = trustDb().query("SELECT bot_id FROM trust_agents WHERE agent_id = ?").get(agentId) as { bot_id: string } | null;
  return r ? getBot(null, r.bot_id)?.bot.name ?? null : null;
};

/** The pool, its rule, and the payouts recorded here (newest first). */
export async function vaultStatus(now = Date.now()) {
  const vault = trustConfig.agentVault()!;
  const [r, balance] = await Promise.all([vaultRule(), publicClient().getBalance({ address: vault })]);
  const epoch = Math.floor(now / 1000 / r.epochLength);
  const rows = db().query("SELECT * FROM vault_draws ORDER BY at DESC LIMIT 12").all() as DrawRow[];
  const total = db().query("SELECT COUNT(*) AS n, COUNT(DISTINCT agent_id) AS agents FROM vault_draws").get() as { n: number; agents: number };
  const paid = (db().query("SELECT amount FROM vault_draws").all() as { amount: string }[]).reduce((s, x) => s + BigInt(x.amount), 0n);
  return {
    contract: vault, gate: trustConfig.trustGate(), balanceMon: mon(balance), allowanceMon: mon(r.allowance), epochLengthS: r.epochLength, epoch, epochEndsAt: (epoch + 1) * r.epochLength * 1000,
    paidMon: mon(paid), payouts: total.n, agentsPaid: total.agents,
    recent: rows.map((x) => ({ agentId: x.agent_id, name: nameOf(x.agent_id), to: x.to_addr, amountMon: mon(x.amount), at: x.at, tx: x.tx, txUrl: `${EXPLORER}/tx/${x.tx}` })),
  };
}

/** The custom error a reverted call carries, by name (null when the node answered something else). */
export function revertName(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName ?? r.reason ?? null : null;
}
const REVERT_WORDS: Record<string, string> = {
  NotTrusted: "TrustGate does not trust this agent today",
  OverAllowance: "this epoch's allowance is already drawn",
  NotAuthorized: "the caller neither owns the identity nor is approved for it",
  TransferFailed: "the pool cannot pay: it is empty, or the receiver refused the transfer",
};

/** Any ERC-8004 agent: what the gate answers, and what AgentVault.draw would do if the agent's owner called it now. */
export async function vaultCheck(agentId: string) {
  const vault = trustConfig.agentVault()!, pc = publicClient();
  const owner = await identityOwner(agentId);
  if (!owner) return { agentId, registered: false as const, message: `agent ${agentId} is not in Monad's ERC-8004 Identity Registry` };
  const [g, p, r] = await Promise.all([gateCheck(agentId), gatePolicy(), vaultRule()]);
  const last = trustDb().query("SELECT request_hash FROM trust_validations WHERE agent_id = ? AND response IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(agentId) as { request_hash: string } | null;
  const report = last ? `${trustConfig.publicBase()}/v1/trust/validation/responses/${last.request_hash}.json` : null;
  const base = { agentId, registered: true as const, owner, gate: { ...g, missing: gateWhy(g, p) }, report, call: `AgentVault.draw(${agentId}, ${owner}, ${formatEther(r.allowance)} MON)`, vault };
  try {
    await pc.simulateContract({ address: vault, abi: agentVaultAbi, functionName: "draw", args: [BigInt(agentId), owner as `0x${string}`, r.allowance], account: owner as `0x${string}` });
    return { ...base, draw: { ok: true as const, amountMon: mon(r.allowance), to: owner } };
  } catch (e) {
    const name = revertName(e);
    if (!name) throw e;
    return { ...base, draw: { ok: false as const, revert: name, reason: REVERT_WORDS[name] ?? "the call reverts" } };
  }
}

// ── payouts: this app's trusted agents draw their allowance ───────────────────────────────────────────────────────────
// One a day by default: a draw is ~204,000 gas (0.02 MON at Monad's 102 gwei, measured 12 Oct 2026), more than the 0.01 MON this
// example vault pays, so the payouts are there to show the rule working, not to earn.
const autoDraws = () => { const n = Number(process.env.VAULT_AUTO_DRAWS ?? 1); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
let busy = false, lastError: string | null = null, lastTickAt = 0;
/** One draw at most: the next of this app's agents (most fills first) that the gate trusts and that has not drawn this epoch. */
export async function payoutTick(now = Date.now()): Promise<DrawRow | null> {
  const limit = autoDraws(), operator = operatorAccount(), vault = trustConfig.agentVault();
  if (!limit || !operator || !vault || busy) return null;
  busy = true; lastTickAt = now;
  try {
    const pc = publicClient(), r = await vaultRule();
    const epoch = Math.floor(now / 1000 / r.epochLength);
    const done = (db().query("SELECT agent_id FROM vault_draws WHERE epoch = ?").all(epoch) as { agent_id: string }[]).map((x) => x.agent_id);
    if (done.length >= limit) return null;
    const [pool, gas] = await Promise.all([pc.getBalance({ address: vault }), pc.getBalance({ address: operator.address })]);
    if (pool < r.allowance || gas < trustConfig.minOperatorWei()) return null;
    const ids = (trustDb().query("SELECT agent_id FROM trust_agents WHERE agent_id IS NOT NULL ORDER BY count DESC LIMIT 24").all() as { agent_id: string }[]).map((x) => x.agent_id).filter((id) => !done.includes(id));
    for (const id of ids) {
      const [g, left] = await Promise.all([gateCheck(id), pc.readContract({ address: vault, abi: agentVaultAbi, functionName: "remaining", args: [BigInt(id)] }) as Promise<bigint>]);
      if (!g.ok || left < r.allowance) continue;
      const s = await vaultDraw(id, operator.address, r.allowance);
      const row: DrawRow = { tx: s.tx, agent_id: id, to_addr: operator.address, amount: r.allowance.toString(), epoch, block: s.block, at: s.timestamp };
      db().run("INSERT OR IGNORE INTO vault_draws (tx, agent_id, to_addr, amount, epoch, block, at) VALUES (?, ?, ?, ?, ?, ?, ?)", [row.tx, row.agent_id, row.to_addr, row.amount, row.epoch, row.block, row.at]);
      logger.info({ agentId: id, tx: s.tx, mon: mon(r.allowance) }, "vault: a trusted agent drew its allowance");
      lastError = null;
      return row;
    }
    return null;
  } catch (e) {
    lastError = `${revertName(e) ?? String((e as Error)?.message ?? e)}`.slice(0, 160);
    logger.warn({ err: lastError }, "vault: draw failed");
    return null;
  } finally { busy = false; }
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startVaultPayouts(): void {
  if (timer || !autoDraws()) return;
  timer = setInterval(() => { payoutTick().catch(() => { /* logged */ }); }, TICK_MS);
  timer.unref?.();
  setTimeout(() => { payoutTick().catch(() => { /* logged */ }); }, 45_000).unref?.();
}
export const vaultPayoutStatus = () => ({ perEpoch: autoDraws(), running: !!timer, lastTickAt: lastTickAt || null, lastError });
export function _resetVault(): void { if (timer) clearInterval(timer); timer = null; rule = null; busy = false; lastError = null; lastTickAt = 0; }
