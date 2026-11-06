// "Make your protocol quantum-safe" (contracts/src/ethereum/admin/PQAdmin.sol), for any browser
// wallet. The page finds a contract's admin keys (an Ownable owner, an OpenZeppelin ProxyAdmin,
// an EIP-1967 admin, an AccessControl admin role), and one button hands every one this wallet
// holds to its PQAdmin, which acts only on a FORS+C signature from the wallet's guard key: the
// same key, from the same 12 words, as the Q-Day vault's. The wallet keeps sending ordinary
// transactions; the guard key, held in this page, signs what they may do as admin.

import { decodeFunctionResult, encodeFunctionData, isAddress, labelhash, parseAbi } from '../../../backend/ethereum/frame.ts';
import { commitmentOf, REGISTRY_ABI, signAction, signRotation, type RegistryKey } from '../../../backend/ethereum/ens/ens.ts';
import { deployment, requireContract } from '../../../deployments/index.ts';
import { isPhrase, newPhrase, normalizePhrase } from '../lib/wallet-keys.ts';
import { copyWords, guardKeyAt, guardPhraseKey, keepPhrase, showWords, SIGNATURES_PER_KEY } from '../vault/guard.ts';

type Hex = `0x${string}`;
type Address = `0x${string}`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (id: string, text: string) => { el(id).textContent = text; };

interface Demo { factory: Address; v1: Address; v2: Address }
const ADMIN = (deployment as { admin?: { factory: Address; demo: Demo; rolesDemo?: Demo } }).admin;
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const CHAIN = deployment.network.chainId;
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'; // EIP-1967
const ZERO_ROLE = `0x${'0'.repeat(64)}` as Hex; // AccessControl's DEFAULT_ADMIN_ROLE
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'; // EIP-1967
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
const ROLE_GRANTED = labelhash('RoleGranted(bytes32,address,address)'); // keccak256 of the event's signature
// The usual role names, by their keccak: found even where the RPC can't read a contract's logs back far enough.
const KNOWN_ROLES = new Map(['MINTER_ROLE', 'PAUSER_ROLE', 'UPGRADER_ROLE', 'BURNER_ROLE', 'OPERATOR_ROLE', 'MANAGER_ROLE', 'GOVERNOR_ROLE',
  'GUARDIAN_ROLE', 'ADMIN_ROLE', 'FEE_ROLE', 'KEEPER_ROLE', 'PROPOSER_ROLE', 'EXECUTOR_ROLE', 'CANCELLER_ROLE'].map((n) => [labelhash(n) as Hex, n]));
const roleName = (role: Hex) => (BigInt(role) === 0n ? 'DEFAULT_ADMIN_ROLE' : KNOWN_ROLES.get(role.toLowerCase() as Hex) ?? `${role.slice(0, 10)}…`);
const CREATED = '0x587ece4cd19692c5be1a4184503d607d45542d2aca0698c0068f52e09ccb541c'; // keccak256("Created(address,address)")
// OwnableUnauthorizedAccount(address), AccessControlUnauthorizedAccount(address,bytes32), AccessManagerUnauthorizedAccount(address,uint64)
const REFUSED = ['118cdaa7', 'e2517d3f', 'f07e038f'];
// Every new guard key: the registry then refuses a 9th signature (FORS+C stays at 2^-160 against forgery).
const MAX_USES = SIGNATURES_PER_KEY;
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
  'function getRoleAdmin(bytes32 role) view returns (bytes32)',
  'function upgradeTo(address newImplementation)',
  'function authority() view returns (address)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
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
// OpenZeppelin's AccessManager, whose role 0 administers every restricted function of the contracts it manages.
const MANAGER = parseAbi([
  'function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)',
  'function grantRole(uint64 roleId, address account, uint32 executionDelay)',
  'function renounceRole(uint64 roleId, address callerConfirmation)',
]);

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
async function until(test: () => Promise<boolean>, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) { if (await test().catch(() => false)) return; await new Promise((r) => setTimeout(r, 2_000)); }
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
  // A key registered with 32 uses still signs at most 8: the budget shown is that.
  const budget = s.maxUses < MAX_USES ? s.maxUses : MAX_USES;
  say('key-left', registered && found !== undefined ? `${budget > s.useCount ? budget - s.useCount : 0n} of ${budget}` : '—');
  el('key-register').hidden = registered;
  const ready = registered && found !== undefined;
  // Saved only if these are the registered key's words, or nothing is registered yet.
  keepPhrase(me!, phrase!, !registered || ready);
  // Once a key is registered, a new phrase could never drive the PQAdmin: only its words can.
  el('key-new').hidden = registered;
  if (registered && !ready) el('key-make').hidden = false;
  el('key-show').hidden = !(ready || !registered);
  el('s-key').classList.toggle('done', ready);
  unlock('s-contract', ready);
  // A few-time key: hand over to the next one before it runs out. The admin names this address, not a key.
  if (ready && s.useCount >= MAX_USES - 1n) await rotate(s.useCount);
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

/** One of a contract's admin powers: who holds it, and how to hand it over. `info` is shown, never handed over. */
interface AdminKey { what: string; at: Address; kind: 'owner' | 'eip1967' | 'role' | 'manager' | 'info'; holder?: Address; twoStep?: boolean; role?: Hex; adminRole?: Hex }
const slotAddress = async (at: Address, slot: string): Promise<Address | undefined> => {
  const v = await rpc<Hex>('eth_getStorageAt', [at, slot, 'latest']);
  return BigInt(v) === 0n ? undefined : (`0x${v.slice(26)}` as Address);
};
const hexOf = (n: bigint) => `0x${n.toString(16)}`;
const managerRead = (to: Address, data: Hex) => call(to, data).then((out) => decodeFunctionResult({ abi: MANAGER, functionName: 'hasRole', data: out }) as readonly [boolean, number], () => undefined);

/**
 * Every RoleGranted log of `contract`: one query where the RPC allows it (MetaMask's does), else
 * windows of 49,000 blocks back to the one that starts before the contract existed.
 */
async function grants(contract: Address): Promise<{ logs: { topics: Hex[] }[]; complete: boolean }> {
  const q = (fromBlock: string, toBlock: string) => rpc<{ topics: Hex[] }[]>('eth_getLogs', [{ address: contract, topics: [ROLE_GRANTED], fromBlock, toBlock }]);
  try { return { logs: await q('0x0', 'latest'), complete: true }; } catch { /* this RPC caps a query's range */ }
  const logs: { topics: Hex[] }[] = [];
  const STEP = 49_000n;
  let to = BigInt(await rpc<Hex>('eth_blockNumber'));
  // ponytail: about a million blocks back at most; a contract older than that, on a capped RPC, is said to be incomplete.
  for (let n = 0; n < 20; n++) {
    const from = to > STEP ? to - STEP : 0n;
    try { logs.push(...await q(hexOf(from), hexOf(to))); } catch { return { logs, complete: false }; }
    if (from === 0n) return { logs, complete: true };
    const code = await rpc<Hex>('eth_getCode', [contract, hexOf(from)]).catch(() => undefined);
    if (code === '0x') return { logs, complete: true };
    to = from - 1n;
  }
  return { logs, complete: false };
}

async function adminKeys(contract: Address): Promise<AdminKey[]> {
  const keys: AdminKey[] = [];
  const ours = [me!, ...(pqAdmin === undefined ? [] : [pqAdmin])];
  const ownerKey = async (what: string, at: Address): Promise<boolean> => {
    const holder = await tryRead<Address>(at, 'owner');
    if (holder !== undefined) keys.push({ what, at, kind: 'owner', holder, twoStep: (await tryRead(at, 'pendingOwner')) !== undefined });
    return holder !== undefined;
  };
  await ownerKey('Owner: every onlyOwner function', contract);
  // Upgrades: an OpenZeppelin ProxyAdmin (or an EIP-1967 admin that is a wallet), a beacon, or the contract itself (UUPS).
  const admin = await slotAddress(contract, ADMIN_SLOT);
  if (admin !== undefined && !(await ownerKey(`Upgrades: its ProxyAdmin ${short(admin)}`, admin))) keys.push({ what: 'Upgrades: its EIP-1967 admin', at: contract, kind: 'eip1967', holder: admin });
  const beacon = await slotAddress(contract, BEACON_SLOT);
  if (beacon !== undefined) await ownerKey(`Upgrades: its beacon ${short(beacon)}`, beacon);
  if (admin === undefined && beacon === undefined && (await slotAddress(contract, IMPL_SLOT)) !== undefined) {
    keys.push({ what: 'Upgrades: UUPS, decided inside the contract, usually by its owner or a role listed here', at: contract, kind: 'info' });
  }
  // AccessControl: every role anyone holds, from its RoleGranted logs, and the usual names for us.
  if ((await tryRead<boolean>(contract, 'hasRole', [ZERO_ROLE, me!])) !== undefined) {
    const { logs, complete } = await grants(contract);
    const pairs = new Map<string, { role: Hex; account: Address }>();
    const add = (role: Hex, account: Address) => pairs.set(`${role.toLowerCase()}:${account.toLowerCase()}`, { role, account });
    for (const l of logs) add(l.topics[1]!, `0x${l.topics[2]!.slice(26)}` as Address);
    for (const role of [ZERO_ROLE, ...KNOWN_ROLES.keys()]) for (const account of ours) add(role, account);
    for (const { role, account } of pairs.values()) {
      if ((await tryRead<boolean>(contract, 'hasRole', [role, account])) !== true) continue;
      keys.push({ what: `Role ${roleName(role)}`, at: contract, kind: 'role', holder: account, role, adminRole: (await tryRead<Hex>(contract, 'getRoleAdmin', [role])) ?? ZERO_ROLE });
    }
    if (!complete) keys.push({ what: 'Roles granted long ago: this RPC would not read back that far, so only the roles above are certain', at: contract, kind: 'info' });
  }
  // OpenZeppelin AccessManager: its admin role decides every restricted function.
  const manager = await tryRead<Address>(contract, 'authority');
  if (manager !== undefined && BigInt(manager) !== 0n) {
    for (const account of ours) {
      if ((await managerRead(manager, encodeFunctionData({ abi: MANAGER, functionName: 'hasRole', args: [0n, account] })))?.[0] === true) {
        keys.push({ what: `Admin role of its AccessManager ${short(manager)}`, at: manager, kind: 'manager', holder: account });
      }
    }
  }
  // A Safe: each owner signs with an ECDSA key of its own.
  const owners = await tryRead<readonly Address[]>(contract, 'getOwners');
  if (owners !== undefined) {
    const threshold = await tryRead<bigint>(contract, 'getThreshold');
    for (const o of owners) keys.push({ what: `Safe owner, ${threshold ?? '?'} of ${owners.length} must sign: this page can't swap a Safe's owners yet`, at: contract, kind: 'info', holder: o });
  }
  return keys;
}

async function showKeys(): Promise<AdminKey[]> {
  const keys = await adminKeys(target!);
  const real = keys.filter((k) => k.kind !== 'info');
  el('c-keys').replaceChildren(...(keys.length === 0 ? [Object.assign(document.createElement('li'), { textContent: 'No admin key found: no owner, no proxy, beacon or EIP-1967 admin, no AccessControl role and no AccessManager admin.' })] : keys.map((k) => {
    const li = document.createElement('li');
    const safe = same(k.holder, pqAdmin);
    li.className = k.kind === 'info' ? 'info' : safe ? 'safe' : same(k.holder, me) ? 'yours' : 'other';
    li.innerHTML = '<b></b><span></span>';
    li.querySelector('b')!.textContent = k.what;
    li.querySelector('span')!.textContent = k.kind === 'info' ? (k.holder === undefined ? '' : short(k.holder))
      : safe ? 'held by your PQAdmin: quantum-safe' : same(k.holder, me) ? 'held by your wallet: one ECDSA key' : `held by ${short(k.holder!)}, not you`;
    return li;
  })));
  const mine = real.filter((k) => same(k.holder, me));
  const handed = real.filter((k) => same(k.holder, pqAdmin));
  const others = real.length - mine.length - handed.length;
  el('s-contract').classList.toggle('done', real.length > 0);
  unlock('s-go', mine.length > 0 || handed.length > 0);
  el('go').hidden = mine.length === 0;
  const done = mine.length === 0 && handed.length > 0;
  el('s-go').classList.toggle('done', done);
  for (const id of ['s-act', 's-attack']) unlock(id, done);
  if (done) {
    say('go-status', others === 0
      ? `Quantum-safe: every admin key of ${short(target!)} is held by your PQAdmin ${short(pqAdmin!)}, which acts only on your FORS+C key.`
      : `Every admin key your wallet held is your PQAdmin's now. ${others} more ${others === 1 ? 'is' : 'are'} held by other addresses and still rest${others === 1 ? 's' : ''} on their own ECDSA keys: they hand theirs over themselves.`);
  }
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
  // What the page said about the last contract is not about this one.
  for (const id of ['go-status', 'act-status', 'attack-status']) say(id, '');
  say('c-status', `Reading ${short(address)}'s admin keys…`);
  await showKeys();
  say('c-status', '');
}

function usePhrase(words: string): void {
  phrase = normalizePhrase(words);
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

el('key-new').addEventListener('click', () => void (async () => {
  if (BigInt((await stateOf()).pkCommitment) !== 0n) {
    say('key-status', 'This address already registered a guard key, and a new one can never replace it. Enter its 12 words with "I have the words".');
    return;
  }
  const words = newPhrase();
  showWords(words, el('words'));
  el('key-words').hidden = false;
  el('key-make').hidden = true;
  say('key-status', 'Write these 12 words down now, or copy them somewhere safe: they are the only way to act as your contract\'s admin.');
  usePhrase(words);
})());
el('key-show').addEventListener('click', () => { showWords(phrase!, el('words')); el('key-words').hidden = false; });
el('key-copy').addEventListener('click', () => void copyWords(phrase!, el('words'), el('key-status')));
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
/** A demo for this wallet from `factory`: `count` admin keys, all the wallet's. */
const makeDemo = (factory: Address | undefined, count: number, what: string) => () => void (async () => {
  if (factory === undefined) { say('c-status', 'That demo is not deployed on this network.'); return; }
  say('c-status', `Making you ${what}…`);
  try {
    const { receipt } = await sendTx(factory, encodeFunctionData({ abi: ABI, functionName: 'create', args: [] }));
    const log = receipt.logs.find((l) => same(l.topics[0], CREATED));
    if (log === undefined) throw new Error('the factory did not say which protocol it made');
    const made = `0x${log.data.slice(26)}` as Address;
    await until(async () => (await adminKeys(made)).filter((k) => same(k.holder, me)).length === count);
    await inspect(made);
  } catch (e) { say('c-status', `No demo protocol: ${(e as Error).message}`); }
})();
el('demo-make').addEventListener('click', makeDemo(ADMIN?.demo.factory, 2, 'a demo protocol: an OpenZeppelin upgradeable proxy whose upgrades and fee are both your wallet\'s'));
el('demo-roles').addEventListener('click', makeDemo(ADMIN?.rolesDemo?.factory, 4, 'a demo with roles: an OpenZeppelin beacon proxy, and three AccessControl roles, all your wallet\'s'));

el('go').addEventListener('click', () => void (async () => {
  try {
    if ((await rpc<Hex>('eth_getCode', [pqAdmin, 'latest'])) === '0x') {
      say('go-status', 'Creating your PQAdmin: it will act only on your FORS+C key…');
      await sendTx(ADMIN!.factory, encodeFunctionData({ abi: ABI, functionName: 'create', args: [me!] }));
      await until(async () => (await rpc<Hex>('eth_getCode', [pqAdmin, 'latest'])) !== '0x');
    }
    const keys = (await adminKeys(target!)).filter((x) => x.kind !== 'info' && same(x.holder, me));
    // A role goes while the wallet still holds the role that administers it: roles that administer
    // others after them, and DEFAULT_ADMIN_ROLE, which usually administers them all, last.
    const roles = keys.filter((k) => k.kind === 'role');
    const administers = (k: AdminKey) => roles.some((r) => r !== k && same(r.adminRole, k.role));
    const isDefault = (k: AdminKey) => BigInt(k.role!) === 0n;
    const ordered = [...keys.filter((k) => k.kind !== 'role'), ...roles.filter((k) => !isDefault(k) && !administers(k)),
      ...roles.filter((k) => !isDefault(k) && administers(k)), ...roles.filter(isDefault)];
    const skipped: string[] = [];
    for (const k of ordered) {
      say('go-status', `Handing over ${k.what.toLowerCase()}…`);
      if (k.kind === 'owner') {
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'transferOwnership', args: [pqAdmin!] }));
        if (k.twoStep) await signed(k.at, encodeFunctionData({ abi: ABI, functionName: 'acceptOwnership', args: [] }));
        await until(async () => same(await read<Address>(k.at, 'owner'), pqAdmin));
      } else if (k.kind === 'eip1967') {
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'changeAdmin', args: [pqAdmin!] }));
      } else if (k.kind === 'role') {
        // Granting needs the role's admin role: without it, renouncing would only lose the role.
        if ((await tryRead<boolean>(k.at, 'hasRole', [k.adminRole!, me!])) !== true) { skipped.push(k.what); continue; }
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'grantRole', args: [k.role!, pqAdmin!] }));
        await until(async () => (await tryRead<boolean>(k.at, 'hasRole', [k.role!, pqAdmin!])) === true);
        await sendTx(k.at, encodeFunctionData({ abi: ABI, functionName: 'renounceRole', args: [k.role!, me!] }));
      } else {
        await sendTx(k.at, encodeFunctionData({ abi: MANAGER, functionName: 'grantRole', args: [0n, pqAdmin!, 0] }));
        await sendTx(k.at, encodeFunctionData({ abi: MANAGER, functionName: 'renounceRole', args: [0n, me!] }));
      }
    }
    if (skipped.length > 0) { say('go-status', `Handed over all but ${skipped.join(', ')}: your wallet doesn't hold the role that administers ${skipped.length === 1 ? 'it' : 'them'}, so it can't grant ${skipped.length === 1 ? 'it' : 'them'} to your PQAdmin.`); return; }
    // Up to three minutes: after many hand-overs in a row, a load-balanced RPC can lag well behind.
    await until(async () => (await adminKeys(target!)).every((k) => k.kind === 'info' || !same(k.holder, me)), 90);
    await showKeys();
  } catch (e) { say('go-status', `Not handed over: ${(e as Error).message}`); }
})());

/** Sends `data` to `to` as your PQAdmin: the guard key signs it in this page, your wallet submits it. */
async function signed(to: Address, data: Hex): Promise<Hex> {
  // A key that has signed 7 times hands over first: its 8th signature is the rotation, and no key signs a 9th.
  const due = await stateOf();
  if (due.useCount >= MAX_USES - 1n) {
    await rotate(due.useCount);
    await until(async () => (await stateOf()).useCount === 0n);
  }
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
  // A beacon proxy upgrades through its beacon; the other demo through its ProxyAdmin.
  const beacon = await slotAddress(target!, BEACON_SLOT);
  const demo = beacon !== undefined ? ADMIN!.rolesDemo! : ADMIN!.demo;
  const to = v === 1n ? demo.v2 : demo.v1;
  const [at, data] = beacon !== undefined
    ? [beacon, encodeFunctionData({ abi: ABI, functionName: 'upgradeTo', args: [to] })]
    : [(await slotAddress(target!, ADMIN_SLOT))!, encodeFunctionData({ abi: ABI, functionName: 'upgradeAndCall', args: [target!, to, '0x'] })];
  await act(`upgrade to version ${v === 1n ? 2 : 1}`, at, data, async () => (await read<bigint>(target!, 'version')) !== v);
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
  const keys = (await adminKeys(target!)).filter((k) => k.kind !== 'info' && same(k.holder, pqAdmin));
  for (const k of keys) {
    // The way each power is taken back by whoever holds it: the cracked key tries every one.
    const data = k.kind === 'role' ? encodeFunctionData({ abi: ABI, functionName: 'grantRole', args: [k.role!, me!] })
      : k.kind === 'manager' ? encodeFunctionData({ abi: MANAGER, functionName: 'grantRole', args: [0n, me!, 0] })
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
