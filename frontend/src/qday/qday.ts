// The Q-Day simulator (frontend/q-day.html), live on Sepolia. A quantum computer's one result is a
// private key from a public key (Shor's algorithm). We can't run that, so the page plays its result:
// the attacker is handed the victim's ECDSA private key and tries everything it could take. What
// Opaque guards answers only to a FORS+C key, whose secret no quantum algorithm recovers from its
// public key (inverting keccak), so the attacker's only FORS+C key is one of its own, and the
// chain refuses it. Then the owner, with the guard key, moves everything from a brand-new wallet.

import { decodeFunctionResult, encodeFunctionData, formatEther, parseAbi, parseEther } from '../../../backend/ethereum/frame.ts';
import { clients, FEES, generatePrivateKey, mlKemPay, privateKeyToAccount, publicKeyOf, scheme1Find, scheme1Keys, scheme1Pay } from '../../../backend/ethereum/qday.ts';
import { commitmentOf, masterKey, REGISTRY_ABI, signAction, signExecute, type RegistryKey } from '../../../backend/ethereum/ens/ens.ts';
import { deployment, requireContract } from '../../../deployments/index.ts';

type Hex = `0x${string}`;
type Address = `0x${string}`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (id: string, text: string) => { el(id).textContent = text; };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const D = deployment as unknown as {
  vault: { address: Address };
  admin: { factory: Address; demo: { factory: Address; v1: Address; v2: Address } };
  ens: { controller: Address; resolver: Address };
  services: { meshExitUrl: string };
};
const CHAIN = BigInt(deployment.network.chainId);
const RPCS = [deployment.network.rpcUrl, 'https://sepolia.gateway.tenderly.co'];
const EXPLORER = deployment.network.explorer.replace(/\/$/, '');
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const USDC = deployment.tokens.usdc.address as Address;
const ETH: Address = '0x0000000000000000000000000000000000000000';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'; // EIP-1967
const CREATED = '0x587ece4cd19692c5be1a4184503d607d45542d2aca0698c0068f52e09ccb541c'; // keccak256("Created(address,address)")
const IN_VAULT_ETH = parseEther('0.01');
const IN_VAULT_USDC = 50_000_000n;
const ABI = parseAbi([
  'function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)',
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address owner, address token, uint256 amount, address to, uint256 deadline, bytes signature)',
  'function balanceOf(address owner, address token) view returns (uint256)',
  'function payload(address owner, address token, uint256 amount, address to, uint256 deadline) view returns (bytes)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function create() returns (address)',
  'function create(address guardian) returns (address)',
  'function adminOf(address guardian) view returns (address)',
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function setFee(uint256 fee)',
  'function fee() view returns (uint256)',
  'function upgradeAndCall(address proxy, address implementation, bytes data) payable',
  'function execute(address target, bytes data, uint256 deadline, bytes signature) returns (bytes)',
]);
const PQADMIN_PAYLOAD = parseAbi(['function payload(address target, bytes data, uint256 deadline) view returns (bytes)']);

/** Everything the simulation made, kept in this browser so a reload carries on. Throwaway testnet keys. */
interface Run {
  victim: Hex; rescue: Hex; attacker: Address; guard: Hex;
  plain?: Address; safe?: Address; safeAdmin?: Address; pqAdmin?: Address;
  stealth?: { spendPub: Hex; viewPub: Hex; view: Hex; ephemeral: Hex; stealth: Address; mlKem: { keyBytes: number; ciphertextBytes: number } };
  ready?: boolean; attacked?: boolean;
}
const KEY = 'opaque-qday-run';
const load = (): Run | undefined => { try { const r = localStorage.getItem(KEY); return r === null ? undefined : (JSON.parse(r) as Run); } catch { return undefined; } };
const store = (r: Run) => { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* this visit only */ } };
let run: Run = load() ?? fresh();
function fresh(): Run {
  return { victim: generatePrivateKey(), rescue: generatePrivateKey(), attacker: privateKeyToAccount(generatePrivateKey()).address, guard: generatePrivateKey() };
}
const victim = () => privateKeyToAccount(run.victim).address;
const guardKey = (): RegistryKey => masterKey(Uint8Array.from(run.guard.slice(2).match(/../g)!.map((b) => parseInt(b, 16))), 'opaque/v1/qday/guard', 0);
const { pub } = clients(RPCS);
const as = (key: Hex) => clients(RPCS, key).wallet!;

const read = async <T>(address: Address, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi: ABI, functionName, args } as never) as Promise<T>;
const txLink = (hash: Hex) => `${EXPLORER}/tx/${hash}`;

/** Sends and waits; `force` skips the gas estimate, so a transaction the chain will refuse still lands, refused, on chain. */
async function send(key: Hex, to: Address, data: Hex, value = 0n, force?: bigint): Promise<{ hash: Hex; ok: boolean; logs: readonly { topics: readonly Hex[]; data: Hex }[] }> {
  const wallet = as(key);
  let hash: Hex | undefined;
  // A load-balanced node a block behind sees too little ETH, or the call reverting: asked again.
  for (let i = 0; hash === undefined; i++) {
    try { hash = await wallet.sendTransaction({ to, data, value, ...FEES, ...(force === undefined ? {} : { gas: force }) } as never); }
    catch (e) { if (i >= 5 || !/insufficient funds|exceeds allowance/i.test((e as Error).message)) throw e; await sleep(4_000); }
  }
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  return { hash, ok: r.status === 'success', logs: r.logs as never };
}
/**
 * A setup step that may already have happened: skipped if `done` says so, and if sending fails,
 * looked at again before failing. A fallback RPC can broadcast a transaction and still report an
 * error, and sending it a second time would then revert.
 */
async function ensure(done: () => Promise<boolean>, act: () => Promise<unknown>): Promise<void> {
  if (await done().catch(() => false)) return;
  try { await act(); } catch (e) {
    for (let i = 0; i < 10; i++) { await sleep(4_000); if (await done().catch(() => false)) return; }
    throw e;
  }
}

/** Why the chain refuses a call, from a simulation of it. */
async function reason(from: Address, to: Address, data: Hex): Promise<string> {
  try { await pub.call({ account: from, to, data, gas: 3_000_000n }); return 'refused'; } catch (e) {
    // viem keeps the revert data deep in its error's causes: walk down to it.
    const found = (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => typeof (x as { data?: unknown } | null)?.data === 'string') as { data?: string } | undefined;
    const text = `${found?.data ?? ''} ${String((e as Error).message)}`;
    for (const [sel, name] of [['5cd5d233', 'BadSignature'], ['118cdaa7', 'OwnableUnauthorizedAccount']] as const) if (text.includes(sel) || text.includes(name)) return name;
    return 'refused';
  }
}

// ── the board ───────────────────────────────────────────────────────────────
function chip(id: string, state: 'ready' | 'taken' | 'safe' | 'wait', text: string): void {
  const c = el(id);
  c.className = `chip chip-${state}`;
  c.textContent = text;
}
async function paintBalances(): Promise<void> {
  const [eth, usdc, vEth, vUsdc] = await Promise.all([
    pub.getBalance({ address: victim() }), read<bigint>(USDC, 'balanceOf', [victim()]),
    read<bigint>(D.vault.address, 'balanceOf', [victim(), ETH]), read<bigint>(D.vault.address, 'balanceOf', [victim(), USDC]),
  ]);
  say('w-bal', `${Number(formatEther(eth)).toFixed(4)} ETH · ${(Number(usdc) / 1e6).toFixed(0)} tUSDC`);
  say('v-bal', `${Number(formatEther(vEth)).toFixed(4)} ETH · ${(Number(vUsdc) / 1e6).toFixed(0)} tUSDC`);
  if (run.plain) say('p-owner', `owner: ${short(await read<Address>(run.plain, 'owner'))}`);
  if (run.safe) say('s-owner', `owner: ${short(await read<Address>(run.safe, 'owner'))} (PQAdmin)`);
}
function step(id: string, state: 'wait' | 'done' | 'now', text?: string): void {
  const li = el(id);
  li.dataset['state'] = state;
  if (text !== undefined) li.querySelector('small')!.textContent = text;
}

// ── 1. the victim, before Q-Day ─────────────────────────────────────────────
async function setUp(): Promise<void> {
  el<HTMLButtonElement>('setup').disabled = true;
  try {
    const me = victim();
    step('st-fund', 'now');
    if ((await pub.getBalance({ address: me })) < parseEther('0.015')) {
      const res = await fetch(`${new URL(D.services.meshExitUrl).origin}/v1/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: me }) });
      if (!res.ok) throw new Error(`the faucet said no: ${((await res.json().catch(() => ({}))) as { message?: string }).message ?? res.status}`);
      for (let i = 0; i < 60 && ((await pub.getBalance({ address: me })) < parseEther('0.015') || (await read<bigint>(USDC, 'balanceOf', [me])) < 100_000_000n); i++) await sleep(3_000);
    }
    step('st-fund', 'done', `${short(me)}: a MetaMask-style ECDSA wallet, funded by Opaque's faucet`);

    step('st-guard', 'now');
    const registered = async () => BigInt(((await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'stateOf', args: [me] })) as { pkCommitment: Hex }).pkCommitment) !== 0n;
    await ensure(registered, () => send(run.victim, REGISTRY, encodeFunctionData({ abi: ABI, functionName: 'register', args: [commitmentOf(guardKey()), commitmentOf(masterKey(Uint8Array.from(run.guard.slice(2).match(/../g)!.map((b) => parseInt(b, 16))), 'opaque/v1/qday/guard', 1)), 8n, 4_102_444_800n] })));
    step('st-guard', 'done', 'its FORS+C guard key, registered in PQKeyRegistry');

    step('st-vault', 'now');
    await ensure(async () => (await read<bigint>(D.vault.address, 'balanceOf', [me, ETH])) >= IN_VAULT_ETH,
      () => send(run.victim, D.vault.address, encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [ETH, IN_VAULT_ETH] }), IN_VAULT_ETH));
    const usdcIn = async () => (await read<bigint>(D.vault.address, 'balanceOf', [me, USDC])) >= IN_VAULT_USDC;
    await ensure(async () => (await usdcIn()) || (await pub.readContract({ address: USDC, abi: parseAbi(['function allowance(address,address) view returns (uint256)']), functionName: 'allowance', args: [me, D.vault.address] })) >= IN_VAULT_USDC,
      () => send(run.victim, USDC, encodeFunctionData({ abi: ABI, functionName: 'approve', args: [D.vault.address, IN_VAULT_USDC] })));
    await ensure(usdcIn, () => send(run.victim, D.vault.address, encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [USDC, IN_VAULT_USDC] })));
    step('st-vault', 'done', '0.01 ETH and 50 tUSDC in the Q-Day vault; the rest stays in the wallet');

    step('st-protocols', 'now');
    const made = async () => {
      const r = await send(run.victim, D.admin.demo.factory, encodeFunctionData({ abi: ABI, functionName: 'create', args: [] }));
      return `0x${r.logs.find((l) => l.topics[0] === CREATED)!.data.slice(26)}` as Address;
    };
    run.plain ??= await made(); store(run);
    run.safe ??= await made(); store(run);
    run.pqAdmin = await read<Address>(D.admin.factory, 'adminOf', [me]);
    const pqAdmin = run.pqAdmin;
    await ensure(async () => ((await pub.getCode({ address: pqAdmin })) ?? '0x') !== '0x', () => send(run.victim, D.admin.factory, encodeFunctionData({ abi: ABI, functionName: 'create', args: [me] })));
    const slot = await pub.getStorageAt({ address: run.safe, slot: ADMIN_SLOT });
    run.safeAdmin = `0x${slot!.slice(26)}` as Address;
    for (const at of [run.safe, run.safeAdmin]) {
      await ensure(async () => (await read<Address>(at, 'owner')).toLowerCase() === pqAdmin.toLowerCase(),
        () => send(run.victim, at, encodeFunctionData({ abi: ABI, functionName: 'transferOwnership', args: [pqAdmin] })));
    }
    store(run);
    step('st-protocols', 'done', 'two OpenZeppelin upgradeable protocols: one owned by the wallet, one handed to its PQAdmin');

    step('st-rescue', 'now');
    const rescue = privateKeyToAccount(run.rescue).address;
    await ensure(async () => (await pub.getBalance({ address: rescue })) >= parseEther('0.002'), () => send(run.victim, rescue, '0x', parseEther('0.003')));
    step('st-rescue', 'done', `${short(rescue)}: the owner's new wallet, with a little gas`);

    step('st-stealth', 'now');
    if (run.stealth === undefined) {
      const k = scheme1Keys();
      const paid = scheme1Pay(k.spendPub, k.viewPub);
      run.stealth = { spendPub: k.spendPub, viewPub: k.viewPub, view: k.view, ephemeral: paid.ephemeral, stealth: paid.stealth, mlKem: mlKemPay() };
    }
    step('st-stealth', 'done', 'a stealth payment each way: secp256k1 (ERC-5564) and ML-KEM-768 (Opaque)');
    run.ready = true; store(run);
    await paintBoard();
  } catch (e) {
    say('setup-status', `Setup stopped: ${(e as Error).message}. Press it again to carry on from here.`);
  } finally { el<HTMLButtonElement>('setup').disabled = false; }
}

async function paintBoard(): Promise<void> {
  el('board').hidden = !run.ready;
  el<HTMLButtonElement>('qday').disabled = !run.ready || run.attacked === true;
  say('pk', publicKeyOf(run.victim));
  if (run.stealth) {
    say('st1', `paid ${short(run.stealth.stealth)} · announced R = ${short(run.stealth.ephemeral)}`);
    say('st2', `a ${run.stealth.mlKem.ciphertextBytes}-byte ML-KEM-768 ciphertext to a ${run.stealth.mlKem.keyBytes}-byte key`);
  }
  await paintBalances().catch(() => undefined);
}

// ── 2. Q-Day ───────────────────────────────────────────────────────────────
function log(id: string, verdict: 'taken' | 'safe', what: string, detail: string, hash?: Hex): void {
  const li = document.createElement('li');
  li.className = `hit hit-${verdict}`;
  li.innerHTML = '<span class="chip"></span><span><b></b><small></small></span>';
  li.querySelector('.chip')!.className = `chip chip-${verdict}`;
  li.querySelector('.chip')!.textContent = verdict === 'taken' ? 'TAKEN' : 'REFUSED';
  li.querySelector('b')!.textContent = what;
  li.querySelector('small')!.textContent = detail;
  if (hash !== undefined) li.querySelector('small')!.append(' · ', Object.assign(document.createElement('a'), { href: txLink(hash), target: '_blank', rel: 'noopener', textContent: 'on Etherscan ↗' }));
  el('hits').append(li);
  li.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  void id;
}

async function reveal(): Promise<void> {
  const out = el('sk');
  const key = run.victim;
  if (reduce) { out.textContent = key; return; }
  const hex = '0123456789abcdef';
  for (let i = 2; i <= key.length; i++) {
    out.textContent = key.slice(0, i) + Array.from({ length: key.length - i }, () => hex[Math.floor(Math.random() * 16)]).join('');
    await sleep(28);
  }
}

async function qday(): Promise<void> {
  el<HTMLButtonElement>('qday').disabled = true;
  el('crack').hidden = false;
  say('qday-status', 'Running Shor\'s algorithm on the public key the wallet published with its first transaction…');
  await reveal();
  say('qday-status', 'Private key recovered. The attacker now signs anything the wallet can.');
  const me = victim();
  const attacker = run.attacker;
  const key = run.victim; // the attacker holds it now
  try {
    // The plain protocol: its owner is the wallet's ECDSA key, so it simply changes hands.
    const seize = await send(key, run.plain!, encodeFunctionData({ abi: ABI, functionName: 'transferOwnership', args: [attacker] }));
    chip('p-chip', 'taken', 'TAKEN'); log('h1', 'taken', 'The plain protocol changes hands', `transferOwnership(attacker): its owner is now ${short(attacker)}`, seize.hash);

    // The protocol behind PQAdmin: the same key is no admin of it any more.
    const take = encodeFunctionData({ abi: ABI, functionName: 'transferOwnership', args: [attacker] });
    const t1 = await send(key, run.safe!, take, 0n, 120_000n);
    const up = encodeFunctionData({ abi: ABI, functionName: 'upgradeAndCall', args: [run.safe!, D.admin.demo.v2, '0x'] });
    const t2 = await send(key, run.safeAdmin!, up, 0n, 200_000n);
    chip('s-chip', 'safe', 'SAFE');
    log('h2', 'safe', 'The protocol behind PQAdmin', `taking ownership: ${t1.ok ? 'went through?!' : await reason(me, run.safe!, take)}; upgrading it: ${t2.ok ? 'went through?!' : await reason(me, run.safeAdmin!, up)}`, t1.hash);

    // The Q-Day vault: a withdrawal needs the guard key's FORS+C signature; the attacker's own is all it has.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const payload = decodeFunctionResult({ abi: ABI, functionName: 'payload', data: (await pub.call({ to: D.vault.address, data: encodeFunctionData({ abi: ABI, functionName: 'payload', args: [me, ETH, IN_VAULT_ETH, attacker, deadline] }) })).data! }) as Hex;
    const useCount = ((await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'stateOf', args: [me] })) as { useCount: bigint }).useCount;
    const forged = signAction(masterKey(crypto.getRandomValues(new Uint8Array(32)), 'thief', 0), CHAIN, me, useCount, payload);
    const steal = encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [me, ETH, IN_VAULT_ETH, attacker, deadline, forged] });
    const t3 = await send(key, D.vault.address, steal, 0n, 900_000n);
    chip('v-chip', 'safe', 'SAFE');
    log('h3', 'safe', 'The Q-Day vault', `a withdrawal of everything to the attacker, with a FORS+C signature of its own: ${t3.ok ? 'went through?!' : await reason(me, D.vault.address, steal)}`, t3.hash);

    // opaque.eth: its controller obeys only its FORS+C key.
    const data = encodeFunctionData({ abi: parseAbi(['function setText(bytes name, string key, string value)']), functionName: 'setText', args: ['0x', 'url', 'attacker'] });
    const ensCall = encodeFunctionData({ abi: ABI, functionName: 'execute', args: [D.ens.resolver, data, deadline, signExecute(masterKey(crypto.getRandomValues(new Uint8Array(32)), 'thief', 0), CHAIN, D.ens.controller, 0n, D.ens.resolver, data, deadline)] });
    chip('n-chip', 'safe', 'SAFE');
    log('h4', 'safe', 'opaque.eth', `rewriting its records through PQNameController: ${await reason(me, D.ens.controller, ensCall)}`);

    // Stealth payments: the secp256k1 viewing key falls to Shor's algorithm too; ML-KEM has no curve key.
    const s = run.stealth!;
    const linked = scheme1Find(s.view, s.spendPub, s.ephemeral).toLowerCase() === s.stealth.toLowerCase();
    chip('st1-chip', linked ? 'taken' : 'safe', linked ? 'LINKED' : 'SAFE');
    log('h5', 'taken', 'A secp256k1 stealth payment (ERC-5564)', `the cracked viewing key recomputes the shared secret from R: ${short(s.stealth)} is the victim's`);
    chip('st2-chip', 'safe', 'SAFE');
    log('h6', 'safe', 'An ML-KEM-768 stealth payment (Opaque)', 'a lattice key, not a curve point: Shor\'s algorithm has nothing to solve, and the payment stays unlinkable');

    // Last, the wallet itself.
    const usdc = await read<bigint>(USDC, 'balanceOf', [me]);
    if (usdc > 0n) await send(key, USDC, encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [attacker, usdc] }));
    // A load-balanced RPC can read the balance a block late, before the last transaction's gas: a
    // little headroom so the sweep never asks for more than is there.
    const left = await pub.getBalance({ address: me });
    const reserve = parseEther('0.0002');
    const swept = left > reserve ? left - reserve : 0n;
    const sweep = swept > 0n ? await send(key, attacker, '0x', swept) : undefined;
    chip('w-chip', 'taken', 'EMPTIED');
    log('h7', 'taken', 'The wallet itself', `${Number(formatEther(swept)).toFixed(4)} ETH and ${(Number(usdc) / 1e6).toFixed(0)} tUSDC sent to the attacker`, sweep?.hash);

    run.attacked = true; store(run);
    await paintBalances().catch(() => undefined);
    el('score').hidden = false;
    say('qday-status', 'Q-Day is over. Everything the ECDSA key guarded is gone; nothing Opaque guards moved.');
    el('rescue-card').hidden = false;
  } catch (e) {
    say('qday-status', `Stopped: ${(e as Error).message}`);
    el<HTMLButtonElement>('qday').disabled = false;
  }
}

// ── 3. the owner, after Q-Day ──────────────────────────────────────────────
async function rescueAll(): Promise<void> {
  el<HTMLButtonElement>('rescue').disabled = true;
  const me = victim();
  const to = privateKeyToAccount(run.rescue).address;
  try {
    const g = guardKey();
    // What the guard key signs: the contract's own payload() for this exact call, read from the chain.
    const signed = async (abi: typeof ABI | typeof PQADMIN_PAYLOAD, payloadCall: Hex, at: Address) => {
      const payload = decodeFunctionResult({ abi, functionName: 'payload', data: (await pub.call({ to: at, data: payloadCall })).data! } as never) as Hex;
      const useCount = ((await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'stateOf', args: [me] })) as { useCount: bigint }).useCount;
      return signAction(g, CHAIN, me, useCount, payload);
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    say('rescue-status', 'Signing with the guard key in this page, and sending from the owner\'s new wallet…');
    const lines: string[] = [];
    for (const [token, amount, what] of [[ETH, IN_VAULT_ETH, '0.01 ETH'], [USDC, IN_VAULT_USDC, '50 tUSDC']] as const) {
      const sig = await signed(ABI, encodeFunctionData({ abi: ABI, functionName: 'payload', args: [me, token, amount, to, deadline] }), D.vault.address);
      const r = await send(run.rescue, D.vault.address, encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [me, token, amount, to, deadline, sig] }));
      lines.push(`${what} out of the vault to the new wallet: ${txLink(r.hash)}`);
    }
    const fee = encodeFunctionData({ abi: ABI, functionName: 'setFee', args: [1n] });
    const sig = await signed(PQADMIN_PAYLOAD, encodeFunctionData({ abi: PQADMIN_PAYLOAD, functionName: 'payload', args: [run.safe!, fee, deadline] }), run.pqAdmin!);
    const r = await send(run.rescue, run.pqAdmin!, encodeFunctionData({ abi: ABI, functionName: 'execute', args: [run.safe!, fee, deadline, sig] }));
    lines.push(`the protocol behind PQAdmin, still the owner's: fee set to 1, ${txLink(r.hash)}`);
    el('rescue-list').replaceChildren(...lines.map((l) => Object.assign(document.createElement('li'), { textContent: l })));
    say('rescue-status', 'Done. The cracked key took the wallet; the guard key still has everything Opaque protected.');
    await paintBalances().catch(() => undefined);
  } catch (e) {
    say('rescue-status', `Stopped: ${(e as Error).message}`);
    el<HTMLButtonElement>('rescue').disabled = false;
  }
}

el('setup').addEventListener('click', () => void setUp());
el('qday').addEventListener('click', () => void qday());
el('rescue').addEventListener('click', () => void rescueAll());
el('again').addEventListener('click', () => { run = fresh(); store(run); location.reload(); });
void paintBoard();
