// Sign-in with Chord's Privy app (the one getchord.xyz/ask and the Chord mobile app use): the same email is the same
// person and the same embedded EVM wallet there and here. Bundled to public/privy/ and loaded only when someone signs in
// or already has a Privy session in this browser. The page talks to it through `window.askPrivy`; React stays in here.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, useLogin, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useCreateWallet as useCreateSolWallet, useSignTransaction as useSolSignTransaction, useWallets as useSolWallets } from "@privy-io/react-auth/solana";
import { defineChain, type Chain } from "viem";

export type PrivyState = { ready: boolean; authenticated: boolean; email: string | null; evm: string | null; sol: string | null; error: string | null };
type TradeChain = { key: string; name: string; kind: string; chainId?: number; rpc?: string | null; explorer?: string | null; native?: { symbol: string; name: string; decimals: number } | null };
type Actions = {
  login: () => void; logout: () => Promise<void>; evmProvider: () => Promise<any>; switchChain: (id: number) => Promise<void>;
  ensureSol: () => Promise<string>; signSol: (tx: Uint8Array) => Promise<Uint8Array>;
};

let state: PrivyState = { ready: false, authenticated: false, email: null, evm: null, sol: null, error: null };
const listeners = new Set<(s: PrivyState) => void>();
const set = (patch: Partial<PrivyState>) => {
  const next = { ...state, ...patch };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const fn of listeners) fn(state);
};
let actions: Actions | null = null;
const need = () => { if (!actions || !state.ready) throw new Error(state.error ?? "Sign-in is still loading. Try again in a moment."); return actions; };

const api = {
  get state() { return state; },
  subscribe(fn: (s: PrivyState) => void) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
  /** Resolves once the SDK is up; rejects with a readable sentence when it cannot be (domain not allowed, offline). */
  whenReady(ms = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (state.ready) return resolve();
      if (state.error) return reject(new Error(state.error));
      const done = (fn: () => void) => { clearTimeout(timer); listeners.delete(watch); fn(); };
      const watch = (s: PrivyState) => { if (s.ready) done(resolve); else if (s.error) done(() => reject(new Error(s.error!))); };
      const timer = setTimeout(() => done(() => reject(new Error("Sign-in did not load. Check your connection and try again."))), ms);
      listeners.add(watch);
    });
  },
  login: () => need().login(),
  logout: () => need().logout(),
  evmProvider: () => need().evmProvider(),
  switchChain: (id: number) => need().switchChain(id),
  ensureSol: () => need().ensureSol(),
  signSol: (tx: Uint8Array) => need().signSol(tx),
};
export type AskPrivy = typeof api;

const friendly = (e: unknown): string => {
  const m = String((e as Error)?.message ?? e);
  if (/exited|closed|cancel/i.test(m)) return "";
  if (/origin|not allowed|403/i.test(m)) return "Sign-in isn't switched on for this site yet.";
  return m;
};

function Bridge() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { login } = useLogin({ onError: (e) => { const m = friendly(e); if (m) set({ error: m }); } });
  const { wallets } = useWallets();
  const { wallets: solWallets } = useSolWallets();
  const { createWallet: createSol } = useCreateSolWallet();
  const { signTransaction } = useSolSignTransaction();

  const evmWallet: ConnectedWallet | undefined = wallets.find((w) => w.walletClientType === "privy");
  const solAddress = (user?.linkedAccounts ?? []).find((a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy") as { address: string } | undefined;
  const solWallet = solWallets.find((w) => w.address === solAddress?.address);

  const live = useRef({ evmWallet, solWallet, solWallets });
  live.current = { evmWallet, solWallet, solWallets };

  useEffect(() => {
    set({
      ready, authenticated,
      email: authenticated ? (user?.email?.address ?? user?.google?.email ?? null) : null,
      evm: authenticated ? (evmWallet?.address ?? null) : null,
      sol: authenticated ? (solAddress?.address ?? null) : null,
    });
  }, [ready, authenticated, user, evmWallet?.address, solAddress?.address]);

  actions = {
    login: () => { set({ error: null }); if (!authenticated) login(); },
    logout: async () => { await logout(); },
    evmProvider: async () => {
      const w = live.current.evmWallet;
      if (!w) throw new Error("Your Chord wallet is still being set up. Try again in a few seconds.");
      return w.getEthereumProvider();
    },
    switchChain: async (id: number) => {
      const w = live.current.evmWallet;
      if (!w) throw new Error("Your Chord wallet is still being set up.");
      await w.switchChain(id);
    },
    ensureSol: async () => {
      if (solAddress?.address) return solAddress.address;
      const { wallet } = await createSol();
      return wallet.address;
    },
    signSol: async (tx: Uint8Array) => {
      // A wallet created a moment ago shows up in the list on the next render; wait for it briefly.
      for (let i = 0; i < 40 && !live.current.solWallet; i++) {
        const addr = state.sol;
        const w = live.current.solWallets.find((x) => x.address === addr);
        if (w) { live.current.solWallet = w; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      const w = live.current.solWallet;
      if (!w) throw new Error("Your Solana wallet is not ready yet. Try again in a few seconds.");
      const { signedTransaction } = await signTransaction({ transaction: tx, wallet: w, chain: "solana:mainnet" });
      return signedTransaction;
    },
  };
  return null;
}

function toChain(c: TradeChain): Chain | null {
  if (c.kind !== "evm" || !c.chainId || !c.rpc) return null;
  const native = c.native ?? { name: "USDC", symbol: "USDC", decimals: 18 }; // Arc: gas is USDC, 18 decimals natively
  return defineChain({
    id: c.chainId, name: c.name, nativeCurrency: native, rpcUrls: { default: { http: [c.rpc] } },
    ...(c.explorer ? { blockExplorers: { default: { name: "Explorer", url: c.explorer.replace(/\/tx\/?$/, "") } } } : {}),
  });
}

let mounted = false;
export async function mount(opts: { appId: string; clientId?: string | null; dark: boolean }): Promise<AskPrivy> {
  (window as any).askPrivy = api;
  if (mounted) return api;
  mounted = true;
  // The Privy app refuses origins missing from its domain list (403 on every auth call). Its public config carries that
  // list, so a missing domain becomes a sentence here instead of a modal that fails after the email is typed.
  const app = await fetch(`https://auth.privy.io/api/v1/apps/${opts.appId}`, { headers: { "privy-app-id": opts.appId } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const domains: string[] = app?.allowed_domains ?? [];
  if (!app || (domains.length && !domains.includes(location.origin))) { set({ error: "Sign-in isn't switched on for this site yet." }); return api; }
  const r = await fetch("/v1/trade/chains").then((x) => x.json()).catch(() => ({ chains: [] }));
  const chains = ((r.chains ?? []) as TradeChain[]).map(toChain).filter((c): c is Chain => !!c);
  if (!chains.length) { set({ error: "Sign-in could not load its chains." }); return api; }
  const host = document.createElement("div");
  host.id = "privy-host";
  document.body.append(host);
  createRoot(host).render(
    <PrivyProvider
      appId={opts.appId}
      {...(opts.clientId ? { clientId: opts.clientId } : {})}
      config={{
        loginMethods: ["email"],
        appearance: { theme: opts.dark ? "dark" : "light", accentColor: opts.dark ? "#14F195" : "#056c43", walletChainType: "ethereum-and-solana" },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, solana: { createOnLogin: "off" }, showWalletUIs: true },
        supportedChains: chains,
        defaultChain: chains[0],
      }}
    >
      <Bridge />
    </PrivyProvider>,
  );
  return api;
}
