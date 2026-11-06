// Opaque as an Ethereum wallet any dapp can connect to: an EIP-1193 provider,
// announced with EIP-6963 so a dapp lists "Opaque" beside MetaMask, whose account is
// a post-quantum ERC-4337 account (FORS+C). Every transaction a dapp asks for opens
// Opaque's own window (eth-connect.html), is shown there with the site that asked,
// and on approval goes out as a UserOperation the account's FORS+C key signs.
//
// The page this runs in never holds a key. Like the XRPL adapter (opaque-adapter.ts):
// postMessage to the wallet's window, origins checked on both ends, and the wallet
// names the site from event.origin, which the browser sets and no page can forge.

const SEPOLIA = '0xaa36a7';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
export const OPAQUE_ICON = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%23070608%22/%3E%3Cg fill=%22%23ff7a18%22%3E%3Ccircle cx=%2216%22 cy=%225.6%22 r=%222.6%22/%3E%3Ccircle cx=%2223.4%22 cy=%228.6%22 r=%222.6%22/%3E%3Ccircle cx=%2226.4%22 cy=%2216%22 r=%222.6%22/%3E%3Ccircle cx=%2223.4%22 cy=%2223.4%22 r=%222.6%22/%3E%3Ccircle cx=%2216%22 cy=%2226.4%22 r=%222.6%22/%3E%3Ccircle cx=%228.6%22 cy=%2223.4%22 r=%222.6%22/%3E%3Ccircle cx=%225.6%22 cy=%2216%22 r=%222.6%22/%3E%3Ccircle cx=%228.6%22 cy=%228.6%22 r=%222.6%22/%3E%3C/g%3E%3C/svg%3E';

/** What only Opaque's window may answer: everything else is a read any RPC answers. */
const WALLET_METHODS = new Set(['eth_requestAccounts', 'eth_sendTransaction']);
const UNSUPPORTED = new Set(['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_signTransaction']);

export class ProviderRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

export class OpaqueEthProvider {
  readonly isOpaque = true;
  readonly #url: () => string;
  #popup: Window | null = null;
  #ready: Promise<void> | undefined;
  #next = 0;
  #saved: string[] | undefined;
  readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

  /** A function where the URL is known only later: the extension's bridge sets it beside this script. */
  constructor(options: { walletUrl?: string | (() => string) } = {}) {
    const url = options.walletUrl ?? 'https://www.opaque.credit/sepolia/eth-connect';
    this.#url = typeof url === 'string' ? () => url : url;
  }

  get #origin(): string { return new URL(this.#url()).origin; }
  #key(): string { return `opaque:eth-accounts:${this.#origin}`; }
  // A site connects once: its account comes back without a window, as a wallet's trusted sites do.
  get #accounts(): string[] {
    this.#saved ??= (() => { try { return JSON.parse(localStorage.getItem(this.#key()) ?? '[]') as string[]; } catch { return []; } })();
    return this.#saved;
  }
  set #accounts(list: string[]) {
    this.#saved = list;
    try { if (list.length === 0) localStorage.removeItem(this.#key()); else localStorage.setItem(this.#key(), JSON.stringify(list)); } catch { /* the next visit asks again */ }
  }

  async request({ method, params = [] }: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> {
    const list = Array.isArray(params) ? params : [params];
    switch (method) {
      case 'eth_chainId': return SEPOLIA;
      case 'net_version': return '11155111';
      case 'eth_accounts': return [...this.#accounts];
      case 'wallet_switchEthereumChain': {
        const id = String((list[0] as { chainId?: string } | undefined)?.chainId ?? '').toLowerCase();
        if (id === SEPOLIA) return null;
        throw new ProviderRpcError(4902, 'Opaque is on Sepolia: its post-quantum accounts are not on that chain yet');
      }
      case 'wallet_requestPermissions':
        await this.request({ method: 'eth_requestAccounts' });
        return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_revokePermissions':
        this.#accounts = [];
        this.#emit('accountsChanged', []);
        return null;
    }
    if (UNSUPPORTED.has(method)) throw new ProviderRpcError(4200, `Opaque signs transactions with a post-quantum key; it does not make ${method} signatures yet`);
    if (WALLET_METHODS.has(method)) {
      if (method === 'eth_requestAccounts' && this.#accounts.length > 0) return [...this.#accounts];
      if (method === 'eth_sendTransaction' && this.#accounts.length === 0) throw new ProviderRpcError(4100, 'connect Opaque first (eth_requestAccounts)');
      const result = await this.#ask(method, list);
      if (method === 'eth_requestAccounts') {
        this.#accounts = result as string[];
        this.#emit('connect', { chainId: SEPOLIA });
        this.#emit('accountsChanged', this.#accounts);
      }
      return result;
    }
    // A read: any public RPC answers it, and it names nothing of the wallet's.
    const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: list }) });
    const body = await response.json() as { result?: unknown; error?: { code: number; message: string } };
    if (body.error !== undefined) throw new ProviderRpcError(body.error.code, body.error.message);
    return body.result;
  }

  on(event: string, callback: (data: unknown) => void): this {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(callback);
    this.#listeners.set(event, set);
    return this;
  }
  removeListener(event: string, callback: (data: unknown) => void): this { this.#listeners.get(event)?.delete(callback); return this; }
  #emit(event: string, data: unknown): void { for (const cb of this.#listeners.get(event) ?? []) cb(data); }

  /** Opaque's window, opened once and reused while it stays open. */
  #open(): Promise<void> {
    if (this.#popup !== null && !this.#popup.closed && this.#ready !== undefined) return this.#ready;
    const popup = window.open(this.#url(), 'opaque-eth-wallet', 'popup,width=440,height=720');
    if (popup === null) return Promise.reject(new ProviderRpcError(4001, 'the browser blocked the Opaque window; allow popups for this site'));
    this.#popup = popup;
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { removeEventListener('message', onReady); reject(new ProviderRpcError(4001, 'the Opaque window did not open')); }, 120_000);
      const onReady = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== this.#origin || (event.data as { type?: string })?.type !== 'opaque:ready') return;
        clearTimeout(timer);
        removeEventListener('message', onReady);
        resolve();
      };
      addEventListener('message', onReady);
    });
    return this.#ready;
  }

  async #ask(method: string, params: unknown[]): Promise<unknown> {
    await this.#open();
    const popup = this.#popup!;
    const id = `${Date.now()}-${this.#next++}`;
    return new Promise((resolve, reject) => {
      const done = () => { clearInterval(closed); removeEventListener('message', onMessage); };
      // A closed window is a refusal (EIP-1193's 4001), not a request left hanging.
      const closed = setInterval(() => { if (popup.closed) { done(); reject(new ProviderRpcError(4001, 'the Opaque window was closed')); } }, 500);
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; id?: string; result?: unknown; error?: string; code?: number };
        if (event.source !== popup || event.origin !== this.#origin || data?.type !== 'opaque:response' || data.id !== id) return;
        done();
        if (data.error !== undefined) reject(new ProviderRpcError(data.code ?? 4001, data.error));
        else resolve(data.result);
      };
      addEventListener('message', onMessage);
      popup.postMessage({ type: 'opaque:request', id, method, params }, this.#origin);
    });
  }
}

/** EIP-6963: tell the page Opaque is here, now and whenever it asks again. */
export function announceOpaque(provider: OpaqueEthProvider): void {
  const detail = Object.freeze({ info: Object.freeze({ uuid: crypto.randomUUID(), name: 'Opaque', icon: OPAQUE_ICON, rdns: 'credit.opaque' }), provider });
  const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  addEventListener('eip6963:requestProvider', announce);
  announce();
}
