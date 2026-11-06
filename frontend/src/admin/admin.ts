// "Make your protocol quantum-safe" (contracts/src/ethereum/admin/PQAdmin.sol), for any browser
// wallet. The page finds a contract's admin keys (an Ownable owner, an OpenZeppelin ProxyAdmin,
// an EIP-1967 admin, an AccessControl admin role), and one button hands every one this wallet
// holds to its PQAdmin, which acts only on a FORS+C signature from the wallet's guard key: the
// same key, from the same 12 words, as the Q-Day vault's. The wallet keeps sending ordinary
// transactions; the guard key, held in this page, signs what they may do as admin.

import { decodeFunctionResult, encodeFunctionData, isAddress, parseAbi } from '../../../backend/ethereum/frame.ts';
import { commitmentOf, REGISTRY_ABI, signAction, signRotation, type RegistryKey } from '../../../backend/ethereum/ens/ens.ts';
import { deployment, requireContract } from '../../../deployments/index.ts';
import { isPhrase, newPhrase, normalizePhrase } from '../lib/wallet-keys.ts';
import { guardKeyAt, guardPhraseKey } from '../vault/guard.ts';

type Hex = `0x${string}`;
type Address = `0x${string}`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (id: string, text: string) => { el(id).textContent = text; };

const ADMIN = (deployment as { admin?: { factory: Address; demo: { factory: Address; v1: Address; v2: Address } } }).admin;
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const CHAIN = deployment.network.chainId;
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'; // EIP-1967
const ZERO_ROLE = `0x${'0'.repeat(64)}` as Hex; // AccessControl's DEFAULT_ADMIN_ROLE
const CREATED = '0x587ece4cd19692c5be1a4184503d607d45542d2aca0698c0068f52e09ccb541c'; // keccak256("Created(address,address)")
const REFUSED = ['118cdaa7', 'e2517d3f']; // OwnableUnauthorizedAccount(address), AccessControlUnauthorizedAccount(address,bytes32)
const MAX_USES = 32n;
const DEADLINE_2100 = 4_102_444_800n;
const ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  'function changeAdmin(address newAdmin)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
  'function renounceRole(bytes32 role, address account)',
  'function setFee(uint256 fee)',
  'function fee() view returns (uint256)',
  'function version() view returns (uint256)',
  'function upgradeAndCall(address proxy, address implementation, bytes data) payable',
  'function create() returns (address)',
  'function create(address guardian) returns (address)',
  'function adminOf(address guardian) view returns (address)',
  'function payload(address target, bytes data, uint256 deadline) view returns (bytes)',
  'function execute(address target, bytes data, uint256 deadline, bytes signature) returns (bytes)',
]);
const REGISTER = parseAbi(['function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)']);

interface Provider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
const provider = (): Provider | undefined => (window as unknown as { ethereum?: Provider }).ethereum;
let me: Address | undefined;
let phrase: string | undefined;
let generation = 0;
let target: Address | undefined;
let pqAdmin: Address | undefined;

const rpc = <T>(method: string, params: unknown[] = []) => provider()!.request({ method, params }) as Promise<T>;
const call = (to: Address, data: Hex, from?: Address) => rpc<Hex>('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
const read = async <T>(to: Address, functionName: string, args: readonly unknown[] = []): Promise<T> =>
  decodeFunctionResult({ abi: ABI, functionName, data: await call(to, encodeFunctionData({ abi: ABI, functionName, args } as never)) } as never) as T;
const tryRead = <T>(to: Address, functionName: string, args: readonly unknown[] = []) => read<T>(to, functionName, args).catch(() => undefined);
const same = (a?: string, b?: string) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const txLink = (hash: Hex) => `${deployment.network.explorer.replace(/\/$/, '')}/tx/${hash}`;
interface Receipt { status: Hex; logs: { topics: Hex[]; data: Hex }[] }
async function sendTx(to: Address, data: Hex): Promise<{ hash: Hex; receipt: Receipt }> {
  const hash = await rpc<Hex>('eth_sendTransaction', [{ from: me, to, data }]);
  for (let i = 0; i < 90; i++) {
    const r = await rpc<Receipt | null>('eth_getTransactionReceipt', [hash]);
    if (r !== null) { if (r.status !== '0x1') throw new Error(`reverted: ${hash}`); return { hash, receipt: r }; }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(`sent but not yet mined: ${hash}`);
}
/** Waits for a read to come true: a load-balanced RPC's node can lag the one that took the transaction. */
async function until(test: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 30; i++) { if (await test().catch(() => false)) return; await new Promise((r) => setTimeout(r, 2_000)); }
}

const keyAt = (g: number): RegistryKey => guardKeyAt(phrase!, g);
const stateOf = async () => decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'stateOf', data: await call(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'stateOf', args: [me!] })) }) as { pkCommitment: Hex; useCount: bigint; maxUses: bigint };
const unlock = (id: string, on: boolean) => { el(id).classList.toggle('locked', !on); };

async function refreshKey(): Promise<boolean> {
  const s = await stateOf();
  const registered = BigInt(s.pkCommitment) !== 0n;
  const found = registered ? Array.from({ length: 16 }, (_, g) => g).find((g) => same(commitmentOf(keyAt(g)), s.pkCommitment)) : undefined;
  generation = found ?? 0;
  el('key-info').hidden = false;
  say('key-pk', `${commitmentOf(keyAt(generation)).slice(0, 18)}… (FORS+C, generation ${generation})`);
  say('key-reg', !registered ? 'not yet' : found === undefined ? 'a different key: these words are not the ones this address registered' : 'yes, for this address');
  say('key-left', registered && found !== undefined ? `${s.maxUses - s.useCount} of ${s.maxUses}` : '—');
  el('key-register').hidden = registered;
  const ready = registered && found !== undefined;
  el('s-key').classList.toggle('done', ready);
  unlock('s-contract', ready);
  // A few-time key: hand over to the next one before it runs out. The admin names this address, not a key.
  if (ready && s.maxUses - s.useCount <= 2n) await rotate(s.useCount);
  return ready;
}

async function rotate(useCount: bigint): Promise<void> {
  say('key-status', 'Handing over to your next guard key (it rotates before running out)…');
  const next = commitmentOf(keyAt(generation + 2)) as Hex;
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
  const sig = signRotation(keyAt(generation), BigInt(CHAIN), me!, useCount, next, MAX_USES, deadline);
  const { hash } = await sendTx(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'rotate', args: [me!, next, MAX_USES, deadline, sig] }));
  generation += 1;
  say('key-status', `Rotated to your next guard key; your PQAdmin didn't change: ${txLink(hash)}`);
}

/** One of a contract's admin powers: who holds it, and how to hand it over. */
interface AdminKey { what: string; at: Address; kind: 'owner' | 'eip1967' | 'role'; holder: Address; twoStep: boolean }
async function adminKeys(contract: Address): Promise<AdminKey[]> {
  const keys: AdminKey[] = [];
  const owner = await tryRead<Address>(contract, 'owner');
  if (owner !== undefined) keys.push({ what: 'Owner: every onlyOwner function', at: contract, kind: 'owner', holder: owner, twoStep: (await tryRead(contract, 'pendingOwner')) !== undefined });
  const slot = await rpc<Hex>('eth_getStorageAt', [contract, ADMIN_SLOT, 'latest']);
  if (BigInt(slot) !== 0n) {
    const admin = `0x${slot.slice(26)}` as Address;
    const adminOwner = await tryRead<Address>(admin, 'owner');
    keys.push(adminOwner !== undefined
      ? { what: `Upgrades: its ProxyAdmin ${short(admin)}`, at: admin, kind: 'owner', holder: adminOwner, twoStep: (await tryRead(admin, 'pendingOwner')) !== undefined }
      : { what: 'Upgrades: its EIP-1967 admin', at: contract, kind: 'eip1967', holder: admin, twoStep: false });
  }
  if ((await tryRead<boolean>(contract, 'hasRole', [ZERO_ROLE, me!])) === true) keys.push({ what: 'Admin role (AccessControl)', at: contract, kind: 'role', holder: me!, twoStep: false });
  if (pqAdmin !== undefined && (await tryRead<boolean>(contract, 'hasRole', [ZERO_ROLE, pqAdmin])) === true) keys.push({ what: 'Admin role (AccessControl)', at: contract, kind: 'role', holder: pqAdmin, twoStep: false });
  return keys;
}

async function showKeys(): Promise<AdminKey[]> {
  const keys = await adminKeys(target!);
  el('c-keys').replaceChildren(...(keys.length === 0 ? [Object.assign(document.createElement('li'), { textContent: 'No admin key found: no owner(), no EIP-1967 admin, and no AccessControl admin role for you.' })] : keys.map((k) => {
    const li = document.createElement('li');
    const safe = same(k.holder, pqAdmin);
    li.className = safe ? 'safe' : same(k.holder, me) ? 'yours' : 'other';
    li.innerHTML = '<b></b><span></span>';
    li.querySelector('b')!.textContent = k.what;
    li.querySelector('span')!.textContent = safe ? 'held by your PQAdmin: quantum-safe' : same(k.holder, me) ? 'held by your wallet: one ECDSA key' : `held by ${short(k.holder)}, not you`;
    return li;
  })));
  const mine = keys.filter((k) => same(k.holder, me));
  const allSafe = keys.length > 0 && keys.every((k) => same(k.holder, pqAdmin));
  el('s-contract').classList.toggle('done', keys.length > 0);
  unlock('s-go', mine.length > 0 || allSafe);
  el('go').hidden = mine.length === 0;
  el('s-go').classList.toggle('done', allSafe);
  for (const id of ['s-act', 's-attack']) unlock(id, allSafe);
  if (allSafe) say('go-status', `Quantum-safe: every admin key of ${short(target!)} is held by your PQAdmin ${short(pqAdmin!)}, which acts only on your FORS+C key.`);
  const demo = ADMIN !== undefined && (await tryRead<bigint>(target!, 'version')) !== undefined && (await tryRead<bigint>(target!, 'fee')) !== undefined;
  el('act-demo').hidden = !demo;
  if (demo) say('act-state', `Fee ${await read<bigint>(target!, 'fee')} · version ${await read<bigint>(target!, 'version')}`);
  return keys;
}

async function inspect(address: string): Promise<void> {
  if (!isAddress(address)) { say('c-status', 'That is not an address.'); return; }
  let code: Hex = '0x';
  // A load-balanced RPC's node can lag the one that just deployed it: asked a few times.
  for (let i = 0; i < 5 && code === '0x'; i++) {
    code = await rpc<Hex>('eth_getCode', [address, 'latest']);
    if (code === '0x') await new Promise((r) => setTimeout(r, 2_000));
  }
  if (code === '0x') { say('c-status', 'There is no contract at that address on Sepolia.'); return; }
  target = address as Address;
  el<HTMLInputElement>('c-address').value = address;
  say('c-status', `Reading ${short(address)}'s admin keys…`);
  await showKeys();
  say('c-status', '');
}

function usePhrase(words: string): void {
  phrase = normalizePhrase(words);
  try { localStorage.setItem(guardPhraseKey(me!), phrase); } catch { /* private window: keep it only here */ }
  void refreshKey().catch((e: Error) => say('key-status', e.message));
}

el('connect').addEventListener('click', () => void (async () => {
  if (provider() === undefined) { say('connect-status', 'No browser wallet found. Install MetaMask, or open this page in a browser that has one.'); return; }
  if (ADMIN === undefined) { say('connect-status', 'The quantum-safe admin is not deployed on this network.'); return; }
  try {
    [me] = await rpc<Address[]>('eth_requestAccounts');
    if (BigInt(await rpc<Hex>('eth_chainId')) !== BigInt(CHAIN)) await rpc('wallet_switchEthereumChain', [{ chainId: `0x${CHAIN.toString(16)}` }]);
    pqAdmin = await read<Address>(ADMIN.factory, 'adminOf', [me]);
    say('connect-status', `Connected: ${me}. Your PQAdmin's address, known before it exists: ${pqAdmin}`);
    el('s-connect').classList.add('done');
    unlock('s-key', true);
    let saved: string | null = null;
    try { saved = localStorage.getItem(guardPhraseKey(me!)); } catch { /* none */ }
    if (saved !== null && isPhrase(saved)) { el('key-make').hidden = true; usePhrase(saved); }
  } catch (e) { say('connect-status', `Not connected: ${(e as Error).message}`); }
})());

el('key-new').addEventListener('click', () => {
  const words = newPhrase();
  el('words').replaceChildren(...words.split(' ').map((w) => { const li = document.createElement('li'); li.textContent = w; return li; }));
  el('key-words').hidden = false;
  el('key-make').hidden = true;
  say('key-status', 'Write these 12 words down now: they are the only way to act as your contract\'s admin.');
  usePhrase(words);
});
el('key-have').addEventListener('click', () => { el('key-enter').hidden = false; });
el('key-use').addEventListener('click', () => {
  const words = el<HTMLInputElement>('key-phrase').value;
  if (!isPhrase(words)) { say('key-status', 'Those are not 12 valid words.'); return; }
  el('key-make').hidden = true; el('key-enter').hidden = true;
  usePhrase(words);
});
el('key-register').addEventListener('click', () => void (async () => {
  say('key-status', 'Registering your guard key: one transaction from your wallet…');
  try {
    const { hash } = await sendTx(REGISTRY, encodeFunctionData({ abi: REGISTER, functionName: 'register', args: [commitmentOf(keyAt(0)) as Hex, commitmentOf(keyAt(1)) as Hex, MAX_USES, DEADLINE_2100] }));
    say('key-status', `Registered: from now on only this key can act as your PQAdmin. ${txLink(hash)}`);
    await until(async () => refreshKey());
  } catch (e) { say('key-status', `Not registered: ${(e as Error).message}`); }
})());

el('c-inspect').addEventListener('click', () => void inspect(el<HTMLInputElement>('c-address').value.trim()).catch((e: Error) => say('c-status', e.message)));
el('demo-make').addEventListener('click', () => void (async () => {
  say('c-status', 'Making you a demo protocol: an OpenZeppelin upgradeable proxy whose upgrades and fee are both your wallet\'s…');
  try {
    const { receipt } = await sendTx(ADMIN!.demo.factory, encodeFunctionData({ abi: ABI, functionName: 'create', args: [] }));
    const log = receipt.logs.find((l) => same(l.topics[0], CREATED));
    if (log === undefined) throw new Error('the factory did not say which protocol it made');
    const made = `0x${log.data.slice(26)}` as Address;
    await until(async () => (await adminKeys(made)).length === 2);
    await inspect(made);
  } catch (e) { say('c-status', `No demo protocol: ${(e as Error).message}`); }
})());

el('go').addEventListener('click', () => void (async () => {
  try {
    if ((await rpc<Hex>('eth_getCode', [pqAdmin, 'latest'])) === '0x') {
      say('go-status', 'Creating your PQAdmin: it will act only on your FORS+C key…');
      await sendTx(ADMIN!.factory, encodeFunctionData({ abi: ABI, functionName: 'create', args: [me!] }));
      await until(async () => (await rpc<Hex>('eth_getCode', [pqAdmin, 'latest'])) !== '0x');
    }
    for (const k of (await adminKeys(target!)).filter((x) => same(x.holder, me))) {
      say('go-status', `Handing over ${k.what.toLowerCase()}…`);
      if (k.kind === 'owner') {
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'transferOwnership', args: [pqAdmin!] }));
        if (k.twoStep) await signed(k.at, encodeFunctionData({ abi: ABI, functionName: 'acceptOwnership', args: [] }));
        await until(async () => same(await read<Address>(k.at, 'owner'), pqAdmin));
      } else if (k.kind === 'eip1967') {
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'changeAdmin', args: [pqAdmin!] }));
      } else {
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'grantRole', args: [ZERO_ROLE, pqAdmin!] }));
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'renounceRole', args: [ZERO_ROLE, me!] }));
      }
    }
    await until(async () => (await adminKeys(target!)).every((k) => same(k.holder, pqAdmin)));
    await showKeys();
  } catch (e) { say('go-status', `Not handed over: ${(e as Error).message}`); }
})());

/** Sends `data` to `to` as your PQAdmin: the guard key signs it in this page, your wallet submits it. */
async function signed(to: Address, data: Hex): Promise<Hex> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const payload = await read<Hex>(pqAdmin!, 'payload', [to, data, deadline]);
  const sig = signAction(keyAt(generation), BigInt(CHAIN), me!, (await stateOf()).useCount, payload);
  const { hash } = await sendTx(pqAdmin!, encodeFunctionData({ abi: ABI, functionName: 'execute', args: [to, data, deadline, sig] }));
  await refreshKey();
  return hash;
}
async function act(what: string, to: Address, data: Hex, done: () => Promise<boolean>): Promise<void> {
  try {
    say('act-status', `Signing "${what}" with your FORS+C guard key in this page (about 9 KB). Your wallet submits it…`);
    const hash = await signed(to, data);
    await until(done);
    await showKeys();
    say('act-status', `Done, as your PQAdmin: ${what}. ${txLink(hash)}`);
  } catch (e) { say('act-status', `Not done: ${(e as Error).message}`); }
}

el('fee-go').addEventListener('click', () => {
  const fee = el<HTMLInputElement>('fee').value.trim();
  if (!/^\d+$/.test(fee)) { say('act-status', 'Enter a whole number.'); return; }
  void act(`set the fee to ${fee}`, target!, encodeFunctionData({ abi: ABI, functionName: 'setFee', args: [BigInt(fee)] }), async () => (await read<bigint>(target!, 'fee')) === BigInt(fee));
});
el('upgrade-go').addEventListener('click', () => void (async () => {
  const v = await read<bigint>(target!, 'version');
  const slot = await rpc<Hex>('eth_getStorageAt', [target, ADMIN_SLOT, 'latest']);
  const data = encodeFunctionData({ abi: ABI, functionName: 'upgradeAndCall', args: [target!, v === 1n ? ADMIN!.demo.v2 : ADMIN!.demo.v1, '0x'] });
  await act(`upgrade to version ${v === 1n ? 2 : 1}`, `0x${slot.slice(26)}` as Address, data, async () => (await read<bigint>(target!, 'version')) !== v);
})());
el('fn-go').addEventListener('click', () => void (async () => {
  const fn = el<HTMLInputElement>('fn').value.trim().replace(/^function\s+/, '');
  let args: unknown[];
  try { args = JSON.parse(el<HTMLInputElement>('args').value.trim() || '[]') as unknown[]; } catch { say('act-status', 'Arguments are a JSON list, like [42] or ["0x…"].'); return; }
  try {
    const abi = parseAbi([`function ${fn}`] as readonly string[]);
    const inputs = (abi[0] as unknown as { inputs: { type: string }[] }).inputs;
    const typed = args.map((a, i) => (/^u?int/.test(inputs[i]?.type ?? '') ? BigInt(String(a)) : a));
    await act(fn, target!, encodeFunctionData({ abi, args: typed } as never), async () => true);
  } catch (e) { say('act-status', `Not a call this page can make: ${(e as Error).message}`); }
})());

el('attack-go').addEventListener('click', () => void (async () => {
  say('attack-status', 'Q-Day: someone has cracked your wallet\'s ECDSA key. They try to take your contract back with it alone…');
  const keys = await adminKeys(target!);
  for (const k of keys) {
    const data = k.kind === 'role'
      ? encodeFunctionData({ abi: ABI, functionName: 'grantRole', args: [ZERO_ROLE, me!] })
      : encodeFunctionData({ abi: ABI, functionName: k.kind === 'owner' ? 'transferOwnership' : 'changeAdmin', args: [me!] });
    let refused = false;
    for (let i = 0; i < 4 && !refused; i++) {
      try { await call(k.at, data, me); break; } catch (e) {
        refused = REFUSED.some((s) => JSON.stringify(e, Object.getOwnPropertyNames(e as object)).includes(s)) || i === 3;
        if (!refused) await new Promise((r) => setTimeout(r, 1_500));
      }
    }
    if (!refused) { say('attack-status', `The chain would let your ECDSA key take ${k.what.toLowerCase()} back: this should never happen. Tell us.`); return; }
  }
  say('attack-status', `Refused by the chain, every time (${keys.length} admin key${keys.length === 1 ? '' : 's'}): your wallet's ECDSA key alone is no admin of this contract any more.`);
})());
