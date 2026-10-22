// @opaque/sdk: Opaque's private, post-quantum payments from Node.
//
//   import { createWallet, openWallet } from '@opaque/sdk';
//   const wallet = await createWallet({ dir: './.opaque', password, network: 'testnet' });
//   const arc = await wallet.arc();
//   await arc.deposit(10);                       // USDC at arc.address → private notes
//   await arc.send('0xRecipient…', 5);           // through a ring of 8, across the mesh
//
// Everything that can spend stays in this process: the account key, the
// notes' secrets, the proofs. Opaque's services see what the wallet page lets
// them see, no more (frontend/public/docs.html, "What stays private").
//
// One wallet, one network, per process: the wallet code reads the network
// once, at import, and one process holds a wallet's file at a time.

import { randomBytes } from 'node:crypto';

import type { AccountKeys } from '../../../frontend/src/lib/xrpl-keys.ts';
import type { ArcClient } from './arc.ts';
import { FileStore, installStorage } from './store.ts';
import type { XrplClient } from './xrpl.ts';

export type { ArcBalance, ArcClient, ArcPayment, Deployer, KeyStatus, SendOptions } from './arc.ts';
export type { SwapToken } from '../../../deployments/index.ts';
export type { XrplClient, XrplSendOptions } from './xrpl.ts';

export type Network = 'testnet' | 'mainnet';
export interface OpenOptions {
  /** The folder the wallet's encrypted file lives in. Keep it, and back up its account key. */
  readonly dir: string;
  readonly password: string;
}
export interface CreateOptions extends OpenOptions {
  readonly network?: Network;
  /**
   * The account to hold. Default: a new one. Or an account key (opq1…), or a
   * recovery phrase and the account's number in it (0 is Account 1). Give an
   * app or agent an account of its own: two hosts signing for one account can
   * use the same few-time key twice.
   */
  readonly accountKey?: string;
  readonly phrase?: string;
  readonly account?: number;
}

export interface OpaqueWallet {
  readonly network: Network;
  /** Public: names the account, and nothing else. */
  readonly accountId: string;
  /** The account's key (opq1…): whoever holds it can spend the account. Its backup. */
  accountKey(): string;
  arc(): Promise<ArcClient>;
  xrpl(): Promise<XrplClient>;
  /** Your app's own records, sealed in the wallet file beside the account's. */
  readonly data: { get(name: string): string | null; set(name: string, value: string): void };
  /** Lets the wallet file go, for another process to open. */
  close(): void;
}

const ACCOUNT = 'opaque:sdk:account:v1';
const NETWORK = 'opaque:sdk:network:v1';

function useNetwork(network: string): asserts network is Network {
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`unknown network "${network}": testnet or mainnet`);
  const set = process.env['OPAQUE_NETWORK'];
  if (set !== undefined && set !== network) throw new Error(`this process runs Opaque on ${set}: one network per process`);
  process.env['OPAQUE_NETWORK'] = network;
}

// The wallet code is imported only once the network is set: it reads it at import.
const keys = () => import('../../../frontend/src/lib/xrpl-keys.ts');

function wrap(store: FileStore, account: AccountKeys, network: Network, text: string): OpaqueWallet {
  installStorage(store);
  let arc: Promise<ArcClient> | undefined;
  let xrpl: Promise<XrplClient> | undefined;
  return {
    network,
    accountId: account.id,
    accountKey: () => text,
    arc: () => (arc ??= import('./arc.ts').then((m) => m.openArc(store, account)).catch((e) => { arc = undefined; throw e; })),
    xrpl: () => (xrpl ??= import('./xrpl.ts').then((m) => m.openXrpl(account)).catch((e) => { xrpl = undefined; throw e; })),
    data: { get: (name) => store.getItem(`opaque:app:${name}`), set: (name, value) => store.setItem(`opaque:app:${name}`, value) },
    close: () => store.close(),
  };
}

/** Makes a wallet in `dir`, sealed with `password`. */
export async function createWallet(options: CreateOptions): Promise<OpaqueWallet> {
  const network = options.network ?? 'testnet';
  useNetwork(network);
  const { accountFromKeyText, accountKeys, accountKeyText } = await keys();
  const account: AccountKeys = options.accountKey !== undefined ? accountFromKeyText(options.accountKey, 0)
    : options.phrase !== undefined ? accountKeys(options.phrase, options.account ?? 0)
      : accountFromKeyText(accountKeyText({ index: 0, key: randomBytes(32), id: '' }), 0);
  const text = accountKeyText(account);
  const store = FileStore.create(options.dir, options.password);
  store.setItem(NETWORK, network);
  store.setItem(ACCOUNT, text);
  return wrap(store, account, network, text);
}

/** Opens the wallet in `dir`. */
export async function openWallet(options: OpenOptions): Promise<OpaqueWallet> {
  const store = FileStore.open(options.dir, options.password);
  try {
    const network = store.getItem(NETWORK) ?? 'testnet';
    useNetwork(network);
    const text = store.getItem(ACCOUNT);
    if (text === null) throw new Error(`the wallet in ${options.dir} holds no account`);
    return wrap(store, (await keys()).accountFromKeyText(text, 0), network, text);
  } catch (error) {
    store.close();
    throw error;
  }
}

export const walletExists = (dir: string): boolean => FileStore.exists(dir);

/**
 * A deployer's key, read from the wallet without opening it: for a person at a
 * terminal while an agent's server holds the wallet. Never written anywhere.
 */
export async function deployerKeyOf(options: OpenOptions, index: number): Promise<{ readonly address: `0x${string}`; readonly key: `0x${string}` }> {
  const items = FileStore.peek(options.dir, options.password);
  const network = items.get(NETWORK) ?? 'testnet';
  useNetwork(network);
  const account = (await keys()).accountFromKeyText(items.get(ACCOUNT)!, 0);
  const { addressOfKey, deployerKey } = await import('../../../frontend/src/lib/arc-keys.ts');
  const key = deployerKey(account, index);
  return { address: addressOfKey(key), key };
}
