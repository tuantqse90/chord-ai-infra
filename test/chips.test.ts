import { describe, expect, it } from "bun:test";
import { ChipBag, chipsNamedIn } from "../src/chips";

const chip = (symbol: string, extra = {}) => ({ id: symbol, symbol, label: symbol, price: 1, change24hPct: 0, hl: null, href: null, ...extra });
describe("chips", () => {
  it("names in order of mention; short symbols only as $TICKER", () => {
    const m = new Map([["ORCA", chip("ORCA")], ["AF", chip("AF")], ["HIGGS", chip("HIGGS")]]);
    expect(chipsNamedIn("HIGGS leads, then $orca. AF is a word.", m).map((c) => c.symbol)).toEqual(["HIGGS", "ORCA"]);
  });
  it("vouched assets first, then named board rows; logos and links absolute", () => {
    const b = new ChipBag();
    b.add([chip("BTC", { hl: "BTC", href: "/ask/perp/BTC" })], [chip("ORCA", { chain: 8453, address: "0xabc" }), chip("SOL")]);
    const out = b.pick("ORCA and SOL moved");
    expect(out.map((c) => c.symbol)).toEqual(["BTC", "ORCA", "SOL"]);
    expect(out[0].logo).toBe("https://api.getchord.xyz/v1/logo/hl/BTC?v=2");
    expect(out[0].href).toBe("https://getchord.xyz/ask/perp/BTC");
    expect(out[1].logo).toBe("https://api.getchord.xyz/v1/logo/8453/0xabc");
  });
});
