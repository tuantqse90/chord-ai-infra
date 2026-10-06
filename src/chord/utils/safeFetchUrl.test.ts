import { describe, expect, it } from "bun:test";
import { isPublicHttpsUrl } from "./safeFetchUrl";

// R5-S1 — the SSRF allow/deny table. The threat: a nad.fun token's `image_uri` is typed in by
// whoever launched the coin, and the logo proxy used to fetch it server-side unvalidated.

describe("isPublicHttpsUrl — allows real logo hosts", () => {
  it.each([
    "https://dd.dexscreener.com/ds-data/tokens/monad/0xabc.png",
    "https://token-icons.llamao.fi/icons/tokens/143/0xabc?h=48&w=48",
    "https://assets.parqet.com/logos/symbol/AAPL?format=png",
    "https://ipfs.io/ipfs/QmXyz",
    "https://raw.githubusercontent.com/org/repo/main/logo.svg",
    "https://example.com:443/logo.png", // explicit default port is fine
  ])("allows %s", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(true);
  });
});

describe("isPublicHttpsUrl — refuses the SSRF surface", () => {
  it.each([
    ["container service name", "https://engine/quote"],
    ["container name + port", "https://redis:6379/"],
    ["localhost", "https://localhost/x.png"],
    ["loopback v4", "https://127.0.0.1/x.png"],
    ["loopback range", "https://127.42.7.9/x.png"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["GCP metadata name", "https://metadata.google.internal/computeMetadata/v1/"],
    ["private 10/8", "https://10.0.0.5/x.png"],
    ["private 172.16/12", "https://172.20.1.1/x.png"],
    ["private 192.168/16", "https://192.168.1.1/x.png"],
    ["CGNAT 100.64/10", "https://100.100.100.100/x.png"],
    ["0.0.0.0", "https://0.0.0.0/x.png"],
    ["ipv6 loopback", "https://[::1]/x.png"],
    ["ipv6 link-local", "https://[fe80::1]/x.png"],
    ["ipv6 unique-local", "https://[fd00::1]/x.png"],
    ["ipv4-mapped loopback", "https://[::ffff:127.0.0.1]/x.png"],
    [".internal suffix", "https://vault.internal/x.png"],
    [".local suffix", "https://printer.local/x.png"],
    ["k8s cluster dns", "https://api.default.svc.cluster.local/x.png"],
  ])("refuses %s", (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  it.each([
    ["plain http", "http://example.com/logo.png"],
    ["file", "file:///etc/passwd"],
    ["data URI", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["gopher", "gopher://example.com/x"],
    ["ftp", "ftp://example.com/logo.png"],
    ["javascript", "javascript:alert(1)"],
  ])("refuses non-https scheme: %s", (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  it.each([
    ["credentials in URL", "https://user:pass@example.com/logo.png"],
    ["non-default port (protocol confusion probe)", "https://example.com:6379/"],
    ["non-default port 8080", "https://example.com:8080/logo.png"],
  ])("refuses %s", (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  it.each(["", "not-a-url", "//example.com/logo.png", "https://", "   "])("refuses malformed input %p", (url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });
});
