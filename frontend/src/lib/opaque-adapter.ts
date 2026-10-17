// The Opaque adapter for xrpl-connect (XRPL Commons), for any XRPL dapp.
//
//   import { WalletManager } from 'xrpl-connect';
//   import { OpaqueAdapter } from '<this file>';
//   const manager = new WalletManager({ adapters: [new OpaqueAdapter()], network: 'testnet' });
//   const account = await manager.connect('opaque');
//
// It implements xrpl-connect's WalletAdapter structurally and imports nothing,
// so it can be offered upstream as is. Like GHOSTSIG, Opaque is a web wallet in
// a popup: the dapp never holds a key and never learns who you are. Each site
// gets an account of its own, funded by an Opaque pool, so the address it sees
// leads nowhere.
//
// Protocol: postMessage between this page and the wallet popup, with the
// origin checked on both ends. The wallet takes the requesting site from
// event.origin, which the browser sets and no page can forge.

export interface OpaqueAdapterOptions {
  /** The wallet's connect page. */
  readonly walletUrl?: string;
  /** How long a request may wait for the user, in ms. */
  readonly timeoutMs?: number;
}

type Method = 'connect' | 'sign' | 'signAndSubmit' | 'signMessage';
interface NetworkInfo { id: string; name: string; wss: string }
interface AccountInfo { address: string; publicKey?: string; network: NetworkInfo }

const ICON = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%23070608%22/%3E%3Cpath d=%22M16 7l9 9-9 9-9-9z%22 fill=%22none%22 stroke=%22%23ff7a18%22 stroke-width=%222%22/%3E%3C/svg%3E';

export class OpaqueAdapter {
  readonly id = 'opaque';
  readonly name = 'Opaque';
  readonly icon = ICON;
  readonly url: string;
  readonly capabilities = { sign: true, signAndSubmit: true, signMessage: true };

  readonly #walletUrl: string;
  readonly #origin: string;
  readonly #timeoutMs: number;
  #popup: Window | null = null;
  #ready: Promise<void> | undefined;
  #account: AccountInfo | null = null;
  #next = 0;
  readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

  constructor(options: OpaqueAdapterOptions = {}) {
    // ponytail: the hosted testnet wallet until an XRPL mainnet one exists; the popup refuses a site that asks for another network.
    this.#walletUrl = options.walletUrl ?? 'https://opaque-xrpl.vercel.app/testnet/xrpl-connect.html';
    this.#origin = new URL(this.#walletUrl).origin;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.url = this.#origin;
  }

  async isAvailable(): Promise<boolean> { return typeof window !== 'undefined' && typeof window.open === 'function'; }

  /** A stored account reconnects without a popup. */
  serializeReconnectOptions(): Record<string, unknown> | undefined {
    return this.#account === null ? undefined : { account: this.#account };
  }

  async connect(options?: { network?: { id?: string }; account?: AccountInfo }): Promise<AccountInfo> {
    if (options?.account?.address !== undefined) {
      this.#account = options.account;
    } else {
      this.#account = await this.#request<AccountInfo>('connect', { network: options?.network?.id ?? null });
    }
    this.#emit('connect', this.#account);
    return this.#account;
  }

  async disconnect(): Promise<void> {
    this.#account = null;
    this.#popup?.close();
    this.#popup = null;
    this.#emit('disconnect', null);
  }

  async getAccount(): Promise<AccountInfo | null> { return this.#account; }

  async getNetwork(): Promise<NetworkInfo> {
    if (this.#account === null) throw new Error('Opaque is not connected');
    return this.#account.network;
  }

  sign(transaction: Record<string, unknown>) { return this.#request<{ hash: string; tx_blob: string; signerAddress: string }>('sign', { transaction }); }
  signAndSubmit(transaction: Record<string, unknown>) { return this.#request<{ hash: string; tx_json: Record<string, unknown> }>('signAndSubmit', { transaction }); }
  signMessage(message: string | Uint8Array) {
    const text = typeof message === 'string' ? { message } : { hex: Array.from(message, (b) => b.toString(16).padStart(2, '0')).join('') };
    return this.#request<{ message: string; signature: string; publicKey: string }>('signMessage', text);
  }

  on(event: string, callback: (data: unknown) => void): void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(callback);
    this.#listeners.set(event, set);
  }
  off(event: string, callback: (data: unknown) => void): void { this.#listeners.get(event)?.delete(callback); }
  #emit(event: string, data: unknown): void { for (const cb of this.#listeners.get(event) ?? []) cb(data); }

  /** Opens the popup once, and reuses it while it stays open. */
  #open(): Promise<void> {
    if (this.#popup !== null && !this.#popup.closed && this.#ready !== undefined) return this.#ready;
    const popup = window.open(this.#walletUrl, 'opaque-wallet', 'popup,width=440,height=700');
    if (popup === null) return Promise.reject(new Error('the browser blocked the Opaque popup; allow popups for this site'));
    this.#popup = popup;
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', onReady); reject(new Error('the Opaque wallet did not open')); }, 60_000);
      const onReady = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== this.#origin || (event.data as { type?: string })?.type !== 'opaque:ready') return;
        clearTimeout(timer);
        window.removeEventListener('message', onReady);
        resolve();
      };
      window.addEventListener('message', onReady);
    });
    return this.#ready;
  }

  async #request<T>(method: Method, params: Record<string, unknown>): Promise<T> {
    await this.#open();
    const popup = this.#popup!;
    const id = `${Date.now()}-${this.#next++}`;
    return new Promise<T>((resolve, reject) => {
      const done = () => { clearTimeout(timer); clearInterval(closed); window.removeEventListener('message', onMessage); };
      const timer = setTimeout(() => { done(); reject(new Error(`Opaque: ${method} timed out`)); }, this.#timeoutMs);
      // A closed popup is a refusal, not a request left hanging.
      const closed = setInterval(() => { if (popup.closed) { done(); reject(new Error('the Opaque window was closed')); } }, 500);
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; id?: string; result?: T; error?: string };
        if (event.source !== popup || event.origin !== this.#origin || data?.type !== 'opaque:response' || data.id !== id) return;
        done();
        if (data.error !== undefined) reject(new Error(data.error));
        else resolve(data.result as T);
      };
      window.addEventListener('message', onMessage);
      popup.postMessage({ type: 'opaque:request', id, method, params }, this.#origin);
    });
  }
}
