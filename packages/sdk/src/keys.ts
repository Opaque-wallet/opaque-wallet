// An Arc account's post-quantum keys, kept in the wallet file. The page keeps
// them in IndexedDB under a key that can't leave the browser; a file can't
// hold such a key, so each signer is saved as a backup carries it (its seed),
// inside the file the password seals, and opened into memory on start.
//
// Every change is on disk before transact() returns: a FORS key is few-time,
// and the reservation of a signing index must outlive a crash that follows it.

import type { Bytes32 } from '@opaque/protocol-types';

import { exportSigner, MemorySignerStore, restoreSigner, type ExportedSigner, type RestorableSignerStore, type SignerRecord } from '../../pq-wallet/src/signer-state.ts';
import { validateWalletRecord, validateWalletTransition, type WalletRecord, type WalletStateStore } from '../../pq-wallet/src/wallet-state.ts';

interface Kv { getItem(name: string): string | null; setItem(name: string, value: string): void }
interface Saved { readonly signers: readonly ExportedSigner[]; readonly wallets: readonly (readonly [string, WalletRecord])[] }

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export class FileKeyStore implements RestorableSignerStore, WalletStateStore {
  readonly #kv: Kv;
  readonly #name: string;
  readonly #signers = new MemorySignerStore();
  readonly #ids = new Set<Bytes32>();
  readonly #wallets = new Map<string, WalletRecord>();
  readonly #ready: Promise<void>;
  /** Every change, one at a time: each on disk before the next begins, so an older snapshot never lands after a newer one. */
  #queue: Promise<unknown>;

  constructor(kv: Kv, name: string) {
    this.#kv = kv;
    this.#name = `opaque:sdk:keys:${name}`;
    this.#ready = this.#load();
    this.#queue = this.#ready;
  }

  #serial<T>(change: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(change);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #load(): Promise<void> {
    const saved = JSON.parse(this.#kv.getItem(this.#name) ?? 'null', reviver) as Saved | null;
    if (saved === null) return;
    for (const s of saved.signers) { await restoreSigner(this.#signers, s); this.#ids.add(s.id); }
    for (const [id, record] of saved.wallets) { validateWalletRecord(record); this.#wallets.set(id, record); }
  }

  async #save(): Promise<void> {
    const signers = await Promise.all([...this.#ids].map((id) => exportSigner(this.#signers, id)));
    this.#kv.setItem(this.#name, JSON.stringify({ signers, wallets: [...this.#wallets] } satisfies Saved, replacer));
  }

  async read(id: Bytes32): Promise<SignerRecord | undefined> { await this.#ready; return this.#signers.read(id); }

  transact<T>(id: Bytes32, update: (current: SignerRecord | undefined) => { record: SignerRecord; result: T }): Promise<T> {
    return this.#serial(async () => {
      const result = await this.#signers.transact(id, update);
      this.#ids.add(id);
      await this.#save();
      return result;
    });
  }

  restore(id: Bytes32, record: SignerRecord): Promise<void> {
    return this.#serial(async () => {
      await this.#signers.restore(id, record);
      this.#ids.add(id);
      await this.#save();
    });
  }

  async readWallet(id: string): Promise<WalletRecord | undefined> {
    await this.#ready;
    const record = this.#wallets.get(id);
    return record && structuredClone(record);
  }

  compareAndSwapWallet(id: string, revision: bigint | undefined, record: WalletRecord): Promise<boolean> {
    return this.#serial(async () => {
      const before = this.#wallets.get(id);
      if (before?.revision !== revision) return false;
      validateWalletTransition(before, record);
      this.#wallets.set(id, structuredClone(record));
      await this.#save();
      return true;
    });
  }

  async close(): Promise<void> { /* nothing held open: the wallet file is written on every change */ }
}
