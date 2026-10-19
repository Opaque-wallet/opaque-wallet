import { ProtocolFailure, type Bytes32, type PqWallet, type PqWalletState, type Hex, type TxHash } from '@opaque/protocol-types';
import { asAddress, asChainId, asUnixSeconds, assertHex, toHex } from '@opaque/protocol-types/codecs.js';
import { pqDigest } from './digest.ts';
import { assertForsParams, forsSchemeId, keyGen, pkCommitment, type ForsParams } from './fors.ts';
import { assertUsable, disablePayload, rotationPayload, uint64, validateKeyState, validateRegistryPolicy, type RegistryPolicy } from './registry.ts';
import { initializeSigner, restoreSigner, signerSummary, unsafeState, validateSignerRecord, type RestorableSignerStore, type SignerStore, type SignedOutput } from './signer-state.ts';
import { signDigest } from './sign.ts';
import { authorityConfigId, validateAuthorityConfig, validatePreparedOperation, type AuthorityConfig, type ChainObservation, type PreparedUserOperation } from './authority.ts';
import type { WalletChainAdapter } from './chain-adapter.ts';
import { validateWalletRecord, type WalletRecord, type WalletStateStore } from './wallet-state.ts';

export interface WalletOptions {
  readonly walletId: string;
  readonly signerStore: SignerStore;
  readonly walletStore: WalletStateStore;
  readonly chain: WalletChainAdapter;
  readonly authority: AuthorityConfig;
  readonly params: ForsParams;
  readonly maxUses: bigint;
  readonly lifecycleReserve: bigint;
  readonly initialKeyEpoch: bigint;
  readonly initialRotationDeadline: bigint;
  readonly registryPolicy: RegistryPolicy;
  /** Supplied from the approved epoch and deadline rules, never inferred from chain useCount. */
  readonly nextKeyEpoch: (epoch: bigint) => bigint;
  readonly nextRotationDeadline: (now: bigint) => bigint;
  /**
   * Each key's seed, by epoch, drawn from a recovery phrase: the phrase then
   * makes every key this wallet will ever hold, and adoptWallet finds them on
   * chain again. Random keys when absent.
   */
  readonly seedFor?: (keyEpoch: bigint) => Uint8Array;
}

export function createPqWallet(options: WalletOptions): PqWallet { return new Wallet(options); }

/** How many rotations adoptWallet looks through for the key the chain holds. */
const ADOPT_EPOCHS = 256;
/**
 * Signatures assumed made beyond what the chain counted: ones another device
 * signed that never landed. A key adopted from the chain cannot know them, and
 * a few-time key must count every signature it ever made.
 */
const ADOPT_MARGIN = 2n;

/**
 * Brings a phrase's wallet into an empty store from the chain alone: the key
 * the chain holds now, the next one, and a signing log as long as the chain's
 * use count. Returns false when there is nothing to adopt, either because the
 * store already holds the wallet or because it was never registered, in which
 * case create() makes the same keys and the same address.
 *
 * One device at a time: two devices signing with one key each count only
 * their own signatures, and a few-time key is weakened by every one.
 */
export async function adoptWallet(options: WalletOptions & { readonly signerStore: RestorableSignerStore }): Promise<boolean> {
  const o = options;
  if (o.seedFor === undefined) throw new ProtocolFailure('INVALID_INPUT', 'only a wallet drawn from a phrase can be adopted');
  if (await o.walletStore.readWallet(o.walletId)) return false;
  const made = new Map<bigint, Bytes32>();
  const commitmentAt = (epoch: bigint): Bytes32 => {
    let id = made.get(epoch);
    if (id === undefined) {
      const seed = o.seedFor!(epoch);
      try { id = pkCommitment(keyGen(seed, o.params).publicKey); } finally { seed.fill(0); }
      made.set(epoch, id);
    }
    return id;
  };
  const first = o.initialKeyEpoch;
  const account = asAddress(await o.chain.deriveAccount(commitmentAt(first), commitmentAt(o.nextKeyEpoch(first))));
  const observation = await o.chain.observe(account);
  const chain = observation.state;
  if (!chain) return false;
  let epoch = first;
  for (let i = 0; i < ADOPT_EPOCHS && commitmentAt(epoch) !== chain.pkCommitment; i++) epoch = o.nextKeyEpoch(epoch);
  const nextEpoch = o.nextKeyEpoch(epoch);
  if (commitmentAt(epoch) !== chain.pkCommitment || commitmentAt(nextEpoch) !== chain.nextCommitment) throw unsafeState();

  const signed = chain.useCount + ADOPT_MARGIN < chain.maxUses ? chain.useCount + ADOPT_MARGIN : chain.useCount;
  const restore = async (keyEpoch: bigint, uses: bigint) => {
    const seed = o.seedFor!(keyEpoch);
    try {
      return await restoreSigner(o.signerStore, { id: commitmentAt(keyEpoch), keyEpoch, params: o.params, seed: toHex(seed), maxUses: o.maxUses,
        lifecycleReserve: o.lifecycleReserve,
        // Stand-ins for signatures this store never saw: unique, and never a digest anyone signs.
        reservations: Array.from({ length: Number(uses) }, (_, i) => ({ index: BigInt(i + 1),
          digest: pqDigest({ chainId: o.authority.chainId, walletAddress: account, schemeId: 'adopted', useCount: BigInt(i), payload: toHex(new TextEncoder().encode(`adopted/${keyEpoch}`)) }) })) });
    } finally { seed.fill(0); }
  };
  const active = await restore(epoch, signed);
  const next = await restore(nextEpoch, 0n);
  const record: WalletRecord = { version: 1, revision: 0n, accountAddress: account, authorityId: authorityConfigId(o.authority), active, next,
    rotationDeadline: chain.rotationDeadline, lastChainUseCount: chain.useCount, lastObservedBlock: observation.blockNumber, registered: true };
  return o.walletStore.compareAndSwapWallet(o.walletId, undefined, record);
}

class Wallet implements PqWallet {
  #options: WalletOptions;
  constructor(options: WalletOptions) {
    validateAuthorityConfig(options.authority); assertForsParams(options.params); validateRegistryPolicy(options.registryPolicy);
    uint64(options.maxUses); uint64(options.lifecycleReserve); uint64(options.initialRotationDeadline);
    if (!options.walletId || typeof options.initialKeyEpoch !== 'bigint' || options.initialKeyEpoch < 0n ||
        options.lifecycleReserve < 1n || options.maxUses <= options.lifecycleReserve) {
      throw new ProtocolFailure('INVALID_INPUT', 'Explicit wallet lifecycle configuration required');
    }
    this.#options = { ...options, params: Object.freeze({ ...options.params }),
      authority: Object.freeze({ ...options.authority, paymaster: Object.freeze({ ...options.authority.paymaster }) }),
      registryPolicy: Object.freeze({ ...options.registryPolicy }) };
  }

  async create(): Promise<PqWalletState> {
    const o = this.#options;
    if (await o.walletStore.readWallet(o.walletId)) return this.getState();
    const active = await this.#newKey(o.initialKeyEpoch);
    const next = await this.#newKey(this.#nextEpoch(o.initialKeyEpoch));
    const accountAddress = asAddress(await this.#dependency(() => o.chain.deriveAccount(active, next)));
    const record: WalletRecord = { version: 1, revision: 0n, accountAddress, authorityId: authorityConfigId(o.authority), active, next,
      rotationDeadline: o.initialRotationDeadline, lastChainUseCount: 0n, lastObservedBlock: 0n, registered: false };
    // Concurrent losers leave unused encrypted keys, never reused signing state.
    await o.walletStore.compareAndSwapWallet(o.walletId, undefined, record);
    return this.getState();
  }

  async register(): Promise<TxHash> {
    const { record, observation } = await this.#reconcile();
    if (observation.state) throw new ProtocolFailure('INVALID_INPUT', 'Wallet is already registered');
    return this.#dependency(() => this.#options.chain.register(record.accountAddress, record.active, record.next,
      this.#options.maxUses, record.rotationDeadline));
  }

  async getState(): Promise<PqWalletState> {
    const { record, observation } = await this.#reconcile();
    const local = await signerSummary(this.#options.signerStore, record.active);
    const chain = observation.state;
    return Object.freeze({ accountAddress: record.accountAddress, pkCommitment: record.active,
      keyEpoch: local.keyEpoch, chainUseCount: chain?.useCount ?? 0n,
      localSigningReservations: local.localSigningReservations, maxUses: local.maxUses,
      rotationDeadline: asUnixSeconds(chain?.rotationDeadline ?? record.rotationDeadline),
      active: !!chain && chain.useCount < chain.maxUses && local.localSigningReservations < local.maxUses &&
        (chain.disableAfter === 0n || observation.now < chain.disableAfter) });
  }

  async signUserOperation(encodedUserOperation: Hex): Promise<SignedOutput> {
    assertHex(encodedUserOperation, 'encodedUserOperation');
    const { record, observation } = await this.#reconcile();
    // Unregistered, the wallet signs one kind of operation: its first, whose
    // initCode deploys this account for exactly these keys and registers them
    // (checked below, once the adapter has said what the initCode does). Its
    // signature binds use count 0, the count the key starts at on chain.
    if (observation.state) this.#assertAction(observation, false);
    if (record.pendingRotation) throw unsafeState();
    const schemeId = forsSchemeId(this.#options.params);
    const adapterResult = await this.#dependency(() => this.#options.chain.prepareUserOperation(encodedUserOperation, observation, schemeId));
    let prepared: PreparedUserOperation;
    try { prepared = Object.freeze(structuredClone(adapterResult)); }
    catch { throw new ProtocolFailure('PROOF_REJECTED', 'Malformed prepared operation'); }
    validatePreparedOperation(this.#options.authority, observation, encodedUserOperation, schemeId, prepared);
    const d = prepared.deployment;
    if (d && (d.pkCommitment !== record.active || d.nextCommitment !== record.next ||
        d.maxUses !== this.#options.maxUses || d.rotationDeadline !== record.rotationDeadline)) {
      throw new ProtocolFailure('PROOF_REJECTED', 'A first operation must deploy this wallet, with its own keys');
    }
    if (!await this.#dependency(() => this.#options.chain.verifyUserOperationBinding(prepared))) {
      throw new ProtocolFailure('PROOF_REJECTED', 'Full operation payload binding rejected');
    }
    return signDigest(this.#options.signerStore, record.active, prepared.digest, 'ordinary');
  }

  async rotate(): Promise<TxHash> {
    let context = await this.#reconcile();
    this.#assertAction(context.observation, true);
    if (!context.record.pendingRotation) {
      const nextSummary = await signerSummary(this.#options.signerStore, context.record.next);
      const next = await this.#newKey(this.#nextEpoch(nextSummary.keyEpoch));
      const deadline = uint64(this.#options.nextRotationDeadline(context.observation.now));
      if (deadline <= context.observation.now) throw new ProtocolFailure('INVALID_INPUT', 'Next rotation deadline must be in the future');
      const updated = { ...context.record, revision: context.record.revision + 1n, pendingRotation: { next, deadline } };
      await this.#options.walletStore.compareAndSwapWallet(this.#options.walletId, context.record.revision, updated);
      context = await this.#reconcile();
    }
    const { record, observation } = context;
    this.#assertAction(observation, true);
    const pending = record.pendingRotation;
    if (!pending) throw unsafeState();
    const digest = pqDigest({ chainId: this.#options.authority.chainId, walletAddress: record.accountAddress,
      schemeId: forsSchemeId(this.#options.params), useCount: observation.state!.useCount,
      payload: rotationPayload(pending.next, this.#options.maxUses, pending.deadline) });
    const signed = await signDigest(this.#options.signerStore, record.active, digest, 'lifecycle');
    return this.#dependency(() => this.#options.chain.rotate(record.accountAddress, pending.next, this.#options.maxUses, pending.deadline, signed));
  }

  async disable(): Promise<TxHash> {
    const { record, observation } = await this.#reconcile();
    this.#assertAction(observation, true);
    if (record.pendingRotation) throw unsafeState();
    const digest = pqDigest({ chainId: this.#options.authority.chainId, walletAddress: record.accountAddress,
      schemeId: forsSchemeId(this.#options.params), useCount: observation.state!.useCount, payload: disablePayload() });
    const signed = await signDigest(this.#options.signerStore, record.active, digest, 'lifecycle');
    return this.#dependency(() => this.#options.chain.disable(record.accountAddress, signed));
  }

  async #newKey(keyEpoch: bigint) {
    const seed = this.#options.seedFor?.(keyEpoch);
    try {
      return await initializeSigner(this.#options.signerStore, { keyEpoch, maxUses: this.#options.maxUses,
        lifecycleReserve: this.#options.lifecycleReserve, params: this.#options.params, ...(seed ? { seed } : {}) });
    } finally { seed?.fill(0); }
  }
  #nextEpoch(epoch: bigint): bigint {
    const next = this.#options.nextKeyEpoch(epoch);
    if (typeof next !== 'bigint' || next <= epoch) throw unsafeState();
    return next;
  }
  #assertAction(observation: ChainObservation, lifecycle: boolean): void {
    if (!observation.state) throw new ProtocolFailure('INVALID_INPUT', 'Register the wallet before signing');
    assertUsable(observation.state, observation.now);
    const p = this.#options.registryPolicy;
    if (p.deadline === 'reject-actions' && observation.now >= observation.state.rotationDeadline &&
        !(lifecycle && p.allowLateRotation)) throw new ProtocolFailure('EXPIRED', 'Rotation deadline reached');
  }

  async #reconcile(): Promise<{ record: WalletRecord; observation: ChainObservation }> {
    const o = this.#options;
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await o.walletStore.readWallet(o.walletId);
      if (!record) throw unsafeState();
      validateWalletRecord(record);
      if (record.authorityId !== authorityConfigId(o.authority)) throw unsafeState();
      const observed = await this.#dependency(() => o.chain.observe(record.accountAddress));
      let observation: ChainObservation;
      try {
        if (!observed || typeof observed !== 'object') throw unsafeState();
        const snapshot = structuredClone(observed);
        observation = Object.freeze({ ...snapshot, state: snapshot.state && Object.freeze(snapshot.state) });
      } catch { throw unsafeState(); }
      if (asAddress(observation.accountAddress) !== record.accountAddress || asChainId(observation.chainId) !== o.authority.chainId ||
          typeof observation.keyEpoch !== 'bigint' || observation.keyEpoch < 0n ||
          typeof observation.blockNumber !== 'bigint' || observation.blockNumber < record.lastObservedBlock) throw unsafeState();
      uint64(observation.now);
      const chain = observation.state;
      let updated = { ...record, lastObservedBlock: observation.blockNumber };
      if (chain) {
        validateKeyState(chain);
        if (record.pendingRotation && chain.pkCommitment === record.next) {
          if (chain.nextCommitment !== record.pendingRotation.next) throw unsafeState();
          const { pendingRotation, ...rest } = record;
          updated = { ...rest, active: record.next, next: pendingRotation.next,
            rotationDeadline: chain.rotationDeadline, lastChainUseCount: 0n, lastObservedBlock: observation.blockNumber };
        }
        const local = await o.signerStore.read(updated.active); validateSignerRecord(local, updated.active);
        if (forsSchemeId(local.publicKey.params) !== forsSchemeId(o.params)) throw unsafeState();
        if (chain.pkCommitment !== updated.active || chain.nextCommitment !== updated.next || chain.useCount < updated.lastChainUseCount ||
            chain.useCount > BigInt(local.reservations.length) || chain.maxUses !== local.maxUses ||
            observation.keyEpoch !== local.keyEpoch) throw unsafeState();
        updated = { ...updated, registered: true, lastChainUseCount: chain.useCount, rotationDeadline: chain.rotationDeadline };
      } else if (record.registered) throw unsafeState();
      const local = await signerSummary(o.signerStore, updated.active);
      if (!chain && observation.keyEpoch !== local.keyEpoch) throw unsafeState();
      // Avoid a write on repeated reads at the same authoritative block/state.
      if (updated.active === record.active && updated.registered === record.registered &&
          updated.lastObservedBlock === record.lastObservedBlock && updated.lastChainUseCount === record.lastChainUseCount &&
          updated.rotationDeadline === record.rotationDeadline) return { record, observation };
      updated = { ...updated, revision: record.revision + 1n };
      if (await o.walletStore.compareAndSwapWallet(o.walletId, record.revision, updated)) return { record: updated, observation };
    }
    throw unsafeState();
  }

  async #dependency<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      throw new ProtocolFailure(error instanceof ProtocolFailure ? error.code : 'SETTLEMENT_REVERTED',
        'Wallet dependency rejected or could not complete the request', error instanceof ProtocolFailure && error.retryable);
    }
  }
}
