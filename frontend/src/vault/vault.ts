// The Q-Day vault's page (contracts/src/ethereum/vault/PQVault.sol), for any browser
// wallet: MetaMask, or anything that injects an EIP-1193 provider. The wallet does what
// it already does (connect, send ordinary transactions); this page holds the post-quantum
// guard key, made from 12 words of its own, and signs every withdrawal with it.

import { decodeFunctionResult, encodeFunctionData, formatEther, isAddress, parseAbi, parseEther } from '../../../backend/ethereum/frame.ts';
import { commitmentOf, masterKey, REGISTRY_ABI, signAction, signRotation, type RegistryKey } from '../../../backend/ethereum/ens/ens.ts';
import { deployment, requireContract } from '../../../deployments/index.ts';
import { accountKeys, isPhrase, newPhrase, normalizePhrase, stream } from '../lib/wallet-keys.ts';

type Hex = `0x${string}`;
type Address = `0x${string}`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const say = (id: string, text: string) => { el(id).textContent = text; };

const VAULT = ((deployment as { vault?: { address: Address } }).vault?.address ?? '') as Address;
const REGISTRY = requireContract('pqKeyRegistry') as Address;
const USDC = deployment.tokens.usdc.address as Address;
const CHAIN = deployment.network.chainId;
const ETH: Address = '0x0000000000000000000000000000000000000000';
const BAD_SIGNATURE = '5cd5d233'; // PQKeyRegistry.BadSignature()
const VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount) payable',
  'function withdraw(address owner, address token, uint256 amount, address to, uint256 deadline, bytes signature)',
  'function balanceOf(address owner, address token) view returns (uint256)',
  'function payload(address owner, address token, uint256 amount, address to, uint256 deadline) view returns (bytes)',
]);
const ERC20 = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
const REGISTER = parseAbi(['function register(bytes32 pkCommitment, bytes32 nextCommitment, uint64 maxUses, uint64 rotationDeadline)']);
const MAX_USES = 32n;
const DEADLINE_2100 = 4_102_444_800n;

interface Provider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
const provider = (): Provider | undefined => (window as unknown as { ethereum?: Provider }).ethereum;
let me: Address | undefined;
let phrase: string | undefined;
let generation = 0;

const rpc = <T>(method: string, params: unknown[] = []) => provider()!.request({ method, params }) as Promise<T>;
const call = (to: Address, data: Hex) => rpc<Hex>('eth_call', [{ to, data }, 'latest']);
async function sendTx(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
  const hash = await rpc<Hex>('eth_sendTransaction', [{ from: me, to: tx.to, data: tx.data, ...(tx.value ? { value: `0x${tx.value.toString(16)}` } : {}) }]);
  for (let i = 0; i < 90; i++) {
    const r = await rpc<{ status: Hex } | null>('eth_getTransactionReceipt', [hash]);
    if (r !== null) { if (r.status !== '0x1') throw new Error(`reverted: ${hash}`); return hash; }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(`sent but not yet mined: ${hash}`);
}
const txLink = (hash: Hex) => `${deployment.network.explorer.replace(/\/$/, '')}/tx/${hash}`;

/** Generation g of this phrase's guard key, its own secret: never derived from anything the ECDSA key signs. */
const keyAt = (g: number): RegistryKey => masterKey(stream(accountKeys(phrase!, 0).key, 'opaque/v1/vault/guard')(32), 'opaque/v1/vault/guard', g);
const stateOf = async () => decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'stateOf', data: await call(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'stateOf', args: [me!] })) }) as { pkCommitment: Hex; useCount: bigint; maxUses: bigint };
const balance = async (token: Address) => decodeFunctionResult({ abi: VAULT_ABI, functionName: 'balanceOf', data: await call(VAULT, encodeFunctionData({ abi: VAULT_ABI, functionName: 'balanceOf', args: [me!, token] })) }) as bigint;
const amountOf = (text: string, eth: boolean): bigint | undefined => {
  const v = text.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return undefined;
  if (eth) return parseEther(v);
  const [w, f = ''] = v.split('.');
  return f.length > 6 ? undefined : BigInt(w!) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const storeKey = () => `opaque:vault-phrase:${me!.toLowerCase()}`;
const unlock = (id: string, on: boolean) => { el(id).classList.toggle('locked', !on); };

async function refresh(): Promise<void> {
  if (me === undefined || phrase === undefined) return;
  const s = await stateOf();
  const registered = BigInt(s.pkCommitment) !== 0n;
  // Which of this phrase's keys the registry holds now: they rotate, one generation at a time.
  const found = registered ? Array.from({ length: 16 }, (_, g) => g).find((g) => commitmentOf(keyAt(g)).toLowerCase() === s.pkCommitment.toLowerCase()) : undefined;
  generation = found ?? 0;
  el('key-info').hidden = false;
  say('key-pk', `${commitmentOf(keyAt(generation)).slice(0, 18)}… (FORS+C, generation ${generation})`);
  say('key-reg', !registered ? 'not yet' : found === undefined ? 'a different key: these words are not the ones this address registered' : 'yes, for this address');
  say('key-left', registered && found !== undefined ? `${s.maxUses - s.useCount} of ${s.maxUses}` : '—');
  el('key-register').hidden = registered;
  const ready = registered && found !== undefined;
  el('s-key').classList.toggle('done', ready);
  for (const id of ['s-vault', 's-out', 's-attack']) unlock(id, ready);
  if (!ready) return;
  const [eth, usdc] = await Promise.all([balance(ETH), balance(USDC)]);
  say('bal-eth', formatEther(eth).replace(/(\.\d{6})\d+$/, '$1'));
  say('bal-usdc', (Number(usdc) / 1e6).toFixed(2));
  // A few-time key: hand over to the next one before it runs out.
  if (s.maxUses - s.useCount <= 2n) await rotate(s.useCount);
}

async function rotate(useCount: bigint): Promise<void> {
  say('key-status', 'Handing the vault to your next guard key (it rotates before running out)…');
  const next = commitmentOf(keyAt(generation + 2)) as Hex;
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 365n * 86_400n;
  const sig = signRotation(keyAt(generation), BigInt(CHAIN), me!, useCount, next, MAX_USES, deadline);
  const hash = await sendTx({ to: REGISTRY, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'rotate', args: [me!, next, MAX_USES, deadline, sig] }) });
  say('key-status', `Rotated to the next guard key: ${txLink(hash)}`);
}

function usePhrase(words: string): void {
  phrase = normalizePhrase(words);
  try { localStorage.setItem(storeKey(), phrase); } catch { /* private window: keep it only here */ }
  void refresh().catch((e: Error) => say('key-status', e.message));
}

el('connect').addEventListener('click', () => void (async () => {
  if (provider() === undefined) { say('connect-status', 'No browser wallet found. Install MetaMask, or open this page in a browser that has one.'); return; }
  if (!isAddress(VAULT)) { say('connect-status', 'The vault is not deployed on this network.'); return; }
  try {
    [me] = await rpc<Address[]>('eth_requestAccounts');
    if (BigInt(await rpc<Hex>('eth_chainId')) !== BigInt(CHAIN)) {
      await rpc('wallet_switchEthereumChain', [{ chainId: `0x${CHAIN.toString(16)}` }]);
    }
    say('connect-status', `Connected: ${me}`);
    el('s-connect').classList.add('done');
    unlock('s-key', true);
    let saved: string | null = null;
    try { saved = localStorage.getItem(storeKey()); } catch { /* none */ }
    if (saved !== null && isPhrase(saved)) { el('key-make').hidden = true; usePhrase(saved); }
  } catch (e) { say('connect-status', `Not connected: ${(e as Error).message}`); }
})());

el('key-new').addEventListener('click', () => {
  const words = newPhrase();
  el('words').replaceChildren(...words.split(' ').map((w) => { const li = document.createElement('li'); li.textContent = w; return li; }));
  el('key-words').hidden = false;
  el('key-make').hidden = true;
  say('key-status', 'Write these 12 words down now: they are the only way to open the vault.');
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
    const hash = await sendTx({ to: REGISTRY, data: encodeFunctionData({ abi: REGISTER, functionName: 'register', args: [commitmentOf(keyAt(0)) as Hex, commitmentOf(keyAt(1)) as Hex, MAX_USES, DEADLINE_2100] }) });
    say('key-status', `Registered: from now on only this key opens your vault. ${txLink(hash)}`);
    for (let i = 0; i < 10; i++) { await refresh(); if (!el('key-register').hidden) await new Promise((r) => setTimeout(r, 3_000)); else break; }
  } catch (e) { say('key-status', `Not registered: ${(e as Error).message}`); }
})());

el('dep-go').addEventListener('click', () => void (async () => {
  const eth = el<HTMLSelectElement>('dep-token').value === 'eth';
  const amount = amountOf(el<HTMLInputElement>('dep-amount').value, eth);
  if (amount === undefined || amount === 0n) { say('dep-status', 'Enter an amount.'); return; }
  try {
    if (!eth) {
      say('dep-status', 'Approving the vault for exactly this much tUSDC…');
      await sendTx({ to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [VAULT, amount] }) });
    }
    say('dep-status', 'Depositing: an ordinary transaction from your wallet…');
    const hash = await sendTx({ to: VAULT, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'deposit', args: [eth ? ETH : USDC, amount] }), ...(eth ? { value: amount } : {}) });
    say('dep-status', `In the vault: ${txLink(hash)}`);
    await refresh();
  } catch (e) { say('dep-status', `Not deposited: ${(e as Error).message}`); }
})());

/** A withdrawal of `amount` to `to`, signed by `key` (the guard key, or in the thief's test someone else's). */
async function withdrawal(key: RegistryKey, token: Address, amount: bigint, to: Address): Promise<Hex> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const payload = decodeFunctionResult({ abi: VAULT_ABI, functionName: 'payload', data: await call(VAULT, encodeFunctionData({ abi: VAULT_ABI, functionName: 'payload', args: [me!, token, amount, to, deadline] })) }) as Hex;
  const sig = signAction(key, BigInt(CHAIN), me!, (await stateOf()).useCount, payload);
  return encodeFunctionData({ abi: VAULT_ABI, functionName: 'withdraw', args: [me!, token, amount, to, deadline, sig] });
}

el('out-go').addEventListener('click', () => void (async () => {
  const eth = el<HTMLSelectElement>('out-token').value === 'eth';
  const amount = amountOf(el<HTMLInputElement>('out-amount').value, eth);
  const toText = el<HTMLInputElement>('out-to').value.trim();
  const to = (toText === '' ? me! : toText) as Address;
  if (amount === undefined || amount === 0n) { say('out-status', 'Enter an amount.'); return; }
  if (!isAddress(to)) { say('out-status', 'That is not an address.'); return; }
  try {
    say('out-status', 'Signing with your post-quantum guard key in this page…');
    const data = await withdrawal(keyAt(generation), eth ? ETH : USDC, amount, to);
    say('out-status', 'Signed (FORS+C, about 9 KB). Your wallet submits it…');
    const hash = await sendTx({ to: VAULT, data });
    say('out-status', `Out of the vault, to ${to}: ${txLink(hash)}`);
    await refresh();
  } catch (e) { say('out-status', `Not withdrawn: ${(e as Error).message}`); }
})());

el('attack-go').addEventListener('click', () => void (async () => {
  say('attack-status', 'The thief signs a withdrawal of everything with a FORS+C key of their own, and asks the chain…');
  const all = await balance(ETH);
  const thief = masterKey(crypto.getRandomValues(new Uint8Array(32)), 'thief', 0);
  const data = await withdrawal(thief, ETH, all, me!);
  // Public RPCs mix node software, and some return a revert with no reason: asked again
  // until one says why, which is the part worth showing.
  let last = '';
  for (let i = 0; i < 4; i++) {
    try {
      await call(VAULT, data);
      say('attack-status', 'The chain accepted it: this should never happen. Tell us.');
      return;
    } catch (e) {
      const text = JSON.stringify(e, Object.getOwnPropertyNames(e as object));
      if (text.includes(BAD_SIGNATURE)) { say('attack-status', 'Refused by the chain: BadSignature. The cracked ECDSA key alone cannot open your vault.'); return; }
      last = (e as Error).message;
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  say('attack-status', `Refused by the chain (the node gave no reason: ${last}). The cracked ECDSA key alone cannot open your vault.`);
})());
