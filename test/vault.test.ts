// AgentVault: the words for a refusal, and the reasons the gate gives.
import { describe, expect, it } from "bun:test";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { agentVaultAbi } from "../src/trust/abi";
import { gateWhy } from "../src/trust/chain";
import { revertName } from "../src/trust/vault";

describe("AgentVault", () => {
  it("names the custom error a reverted draw carries; anything else is not a revert", () => {
    const reverted = (errorName: "NotTrusted" | "OverAllowance", args?: readonly [bigint]) =>
      new BaseError("call failed", { cause: new ContractFunctionRevertedError({ abi: agentVaultAbi, functionName: "draw", data: encodeErrorResult({ abi: agentVaultAbi, errorName, args } as any) }) });
    expect(revertName(reverted("NotTrusted"))).toBe("NotTrusted");
    expect(revertName(reverted("OverAllowance", [0n]))).toBe("OverAllowance");
    expect(revertName(new Error("fetch failed"))).toBeNull();
    expect(revertName(new BaseError("rpc is down"))).toBeNull();
  });
  it("the gate's reasons: a score of 0 from the validator, too few fills, an idle agent; none when trusted", () => {
    const p = { minFills: 3, minValidations: 1, minAvgScore: 90, maxIdleS: 3 * 86400 }, now = 1_800_000_000_000;
    expect(gateWhy({ ok: true, fills: 9, validations: 2, avgScore: 100, lastAt: now }, p, now)).toEqual([]);
    expect(gateWhy({ ok: false, fills: 3, validations: 1, avgScore: 0, lastAt: now - 60_000 }, p, now)).toEqual(["average score 0, the gate asks 90"]);
    expect(gateWhy({ ok: false, fills: 1, validations: 0, avgScore: 0, lastAt: now - 4 * 86400_000 }, p, now)).toEqual(["1 of 3 fills committed", "0 of 1 validations", "no commit in the last 3 days"]);
    expect(gateWhy({ ok: false, fills: 0, validations: 0, avgScore: 0, lastAt: 0 }, p, now)).toEqual(["0 of 3 fills committed", "0 of 1 validations", "no commit in the last 3 days"]);
  });
});
