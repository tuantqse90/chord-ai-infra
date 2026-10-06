// Cardano tools on NOWNodes' Blockfrost-compatible API: /addresses/{a}, /addresses/{a}/transactions, /txs/{h}, /txs/{h}/utxos.
import { config } from "../config";
import { verifyCardanoPayment } from "../payments";
import { bf } from "../rpc/cardano";
import { cardanoscan, short, ToolInputError, type Tool } from "../types";

type Amount = { unit: string; quantity: string };
export const isAdaAddress = (s: string) => /^addr1[0-9a-z]{50,120}$/.test(s);
export const isAdaTxHash = (s: string) => /^[0-9a-f]{64}$/.test(s);

/** Lovelace → ADA; native assets → policy, readable name (hex-decoded when printable) and raw quantity. */
export function readAmounts(list: Amount[] = []) {
  let ada = 0;
  const assets: { unit: string; policy: string; name: string; quantity: string }[] = [];
  for (const a of list) {
    if (a.unit === "lovelace") ada += Number(BigInt(a.quantity)) / 1e6;
    else {
      const policy = a.unit.slice(0, 56), hex = a.unit.slice(56);
      const txt = Buffer.from(hex, "hex").toString("utf8");
      assets.push({ unit: a.unit, policy, name: /^[\x20-\x7e]+$/.test(txt) ? txt : hex, quantity: a.quantity });
    }
  }
  return { ada, assets };
}

function needAddr(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!isAdaAddress(s)) throw new ToolInputError("address must be a Cardano mainnet address (addr1…)");
  return s;
}
function needHash(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (!isAdaTxHash(s)) throw new ToolInputError("hash must be a 64-character Cardano transaction hash");
  return s;
}

const adaAddress: Tool = {
  name: "ada_address",
  via: "cardano",
  label: "Reading the Cardano address",
  description: "A Cardano address: ADA balance, native assets, stake address, and its latest transactions.",
  parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
  async run(a) {
    const address = needAddr(a.address);
    const [info, txs] = await Promise.all([
      bf<{ amount: Amount[]; stake_address: string | null; type: string; script: boolean }>(`/addresses/${address}`),
      bf<{ tx_hash: string; block_height: number; block_time: number }[]>(`/addresses/${address}/transactions?count=10&order=desc`),
    ]);
    if (!info) return { data: { address, found: false, note: "No on-chain history for this address." }, sources: [], summary: "no history" };
    const { ada, assets } = readAmounts(info.amount);
    const recent = (txs ?? []).map((t) => ({ hash: t.tx_hash, block: t.block_height, time: new Date(t.block_time * 1000).toISOString() }));
    return {
      data: { address, ada, assets: assets.slice(0, 30), assetCount: assets.length, stakeAddress: info.stake_address, script: info.script, recent },
      sources: [{ kind: "ada-address", id: address, label: `Address ${short(address)}`, url: cardanoscan.address(address) },
        ...recent.slice(0, 4).map((t) => ({ kind: "ada-tx" as const, id: t.hash, label: `Tx ${short(t.hash)}`, url: cardanoscan.tx(t.hash) }))],
      summary: `${ada.toLocaleString("en-US")} ADA, ${assets.length} asset${assets.length === 1 ? "" : "s"}`,
    };
  },
};

const adaTx: Tool = {
  name: "ada_tx",
  via: "cardano",
  label: "Reading the Cardano transaction",
  description: "One Cardano transaction: block, time, fee, validity, and its inputs and outputs (addresses, ADA, native assets).",
  parameters: { type: "object", properties: { hash: { type: "string" } }, required: ["hash"] },
  async run(a) {
    const hash = needHash(a.hash);
    const [tx, utxos] = await Promise.all([
      bf<{ block: string; block_height: number; block_time: number; fees: string; valid_contract: boolean; size: number }>(`/txs/${hash}`),
      bf<{ inputs: { address: string; amount: Amount[] }[]; outputs: { address: string; amount: Amount[] }[] }>(`/txs/${hash}/utxos`),
    ]);
    if (!tx) return { data: { hash, found: false }, sources: [], summary: "not found" };
    const side = (xs: { address: string; amount: Amount[] }[] = []) => xs.map((x) => ({ address: x.address, ...readAmounts(x.amount) }));
    return {
      data: { hash, block: tx.block_height, time: new Date(tx.block_time * 1000).toISOString(), feeAda: Number(tx.fees) / 1e6, valid: tx.valid_contract,
        inputs: side(utxos?.inputs).slice(0, 20), outputs: side(utxos?.outputs).slice(0, 20) },
      sources: [{ kind: "ada-tx", id: hash, label: `Tx ${short(hash)}`, url: cardanoscan.tx(hash) }],
      summary: `block ${tx.block_height}, fee ${(Number(tx.fees) / 1e6).toFixed(3)} ADA`,
    };
  },
};

const adaVerifyPayment: Tool = {
  name: "ada_verify_payment",
  via: "cardano",
  label: "Verifying the Cardano payment",
  description: "Check whether a Cardano transaction paid an address at least an amount of ADA (default: this app's treasury, one ask). Read-only.",
  parameters: { type: "object", properties: { hash: { type: "string" }, recipient: { type: "string" }, amount: { type: "number", description: "Minimum ADA" } }, required: ["hash"] },
  async run(a) {
    const hash = needHash(a.hash);
    const recipient = a.recipient ? needAddr(a.recipient) : config.treasuryAda();
    if (!recipient) throw new ToolInputError("no recipient given and no treasury configured");
    const min = Number(a.amount) > 0 ? Number(a.amount) : config.priceAda();
    const [tx, utxos] = await Promise.all([bf<any>(`/txs/${hash}`), bf<any>(`/txs/${hash}/utxos`)]);
    const v = verifyCardanoPayment(tx, utxos, { recipient, minAda: min });
    return {
      data: { hash, recipient, minimumAda: min, ...v },
      sources: [{ kind: "ada-tx", id: hash, label: `Tx ${short(hash)}`, url: cardanoscan.tx(hash) }],
      summary: v.ok ? `paid ${v.paid} ADA` : `not valid: ${v.reason}`,
    };
  },
};

export const cardanoTools: Tool[] = [adaAddress, adaTx, adaVerifyPayment];
