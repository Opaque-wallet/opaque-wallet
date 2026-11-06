// Anonymous fetch for the wallet: EF's anon-rpc (ethereum.github.io/anon-rpc).
//
// The harness reads an anonymizing network's worker bundle hash from its on-chain
// specifier, runs only bytes with that keccak256, in a Web Worker inside a sandboxed
// null-origin iframe, and hands back a `fetch` that leaves through the network. So
// an RPC provider or bundler answering through it sees the network's exit, never
// this browser, and the worker never sees the page, its storage or its keys.
//
// Opaque uses it where nothing of ours should be in the path: ENS lookups; the
// wallet's reads and UserOperations when Opaque's own servers are switched off
// (lib/without-opaque.ts); and, with the Privacy view's switch on, the wallet's reads
// and UserOperations all the time (lib/runtime.ts). Networks from anon-rpc's adopters.json5.

import { AnonRpcWorker } from '@anon-rpc/browser-harness';

import { scoped } from './storage-name.ts';

export interface AnonNetwork {
  readonly id: 'nox' | 'tor' | 'nym';
  readonly label: string;
  /** The IWorkerSpecifier contract, and the chain it lives on (where its bundle hash is read). */
  readonly specifier: `0x${string}`;
  readonly specifierRpc: string;
  readonly config?: unknown;
}

const MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

export const ANON_NETWORKS: readonly AnonNetwork[] = [
  // Sphinx packets through entry, mix and exit nodes; TLS to the RPC runs inside the worker,
  // so the exit relays bytes it cannot read. Its specifier is on Sepolia.
  { id: 'nox', label: 'Nox mixnet', specifier: '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A', specifierRpc: SEPOLIA_RPC },
  // A Tor client compiled to WebAssembly; the gateway is anon-rpc's demonstration one.
  { id: 'tor', label: 'Tor', specifier: '0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e', specifierRpc: MAINNET_RPC,
    config: { gateways: ['152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ'] } },
  // The Nym mixnet; an ~18 MB bundle and a few seconds to bootstrap.
  { id: 'nym', label: 'Nym mixnet', specifier: '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0', specifierRpc: MAINNET_RPC },
];

/** A one-request EIP-1193 provider: the harness's bootstrap, used once to read the specifier. */
const bootstrap = (url: string) => ({
  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }) });
    const body = await res.json() as { result?: unknown; error?: { message: string } };
    if (body.error !== undefined) throw new Error(body.error.message);
    return body.result;
  },
});

const workers = new Map<string, AnonRpcWorker>();

/** The network's anonymous fetch, its worker started on first use and kept. */
export function anonFetch(network: AnonNetwork = ANON_NETWORKS[0]!): typeof fetch {
  let worker = workers.get(network.id);
  if (worker === undefined) {
    worker = new AnonRpcWorker({
      address: network.specifier,
      ...(network.config === undefined ? {} : { config: network.config as never }),
      preExisting: { rpcProvider: bootstrap(network.specifierRpc) as never },
    });
    workers.set(network.id, worker);
  }
  return worker.fetch as unknown as typeof fetch;
}

/** One JSON-RPC call through the network: what an RPC provider or bundler answers without learning who asked. */
export async function anonRpc<T>(url: string, method: string, params: readonly unknown[], network?: AnonNetwork): Promise<T> {
  const res = await anonFetch(network)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json() as { result?: T; error?: { message: string; data?: unknown } };
  if (body.error !== undefined) throw Object.assign(new Error(body.error.message), { data: body.error.data });
  return body.result as T;
}

const READS_KEY = scoped('opaque:anon-reads');
/** The Privacy view's switch: the account's reads and UserOperations through anon-rpc, not Opaque's relays. */
export const anonReadsOn = (): boolean => { try { return localStorage.getItem(READS_KEY) === 'on'; } catch { return false; } };
export const setAnonReads = (on: boolean): void => { try { localStorage.setItem(READS_KEY, on ? 'on' : 'off'); } catch { /* a private window: off */ } };
