// Read-only smoke test of a hosted network, the way the wallet page boots it.
// Spends nothing and signs nothing on chain.
//
//   OPAQUE_NETWORK=mainnet node scripts/smoke-network.ts
//   STACK_URL=… overrides where stack.json comes from (default: the network's mesh exit host).
//
// Checks: stack.json is served with CORS; its relay directory chains to the
// trust root COMPILED INTO the build (deployments/arc-<network>.json); then,
// over real 3-hop mesh paths, every pool answers capabilities() as configured,
// the registry/token/EntryPoint reads pass the exit's allowlist, the exit reaches
// the bundler, the Graph snapshots answer, and the credential authority issues.

import { decodeFunctionResult, encodeFunctionData } from 'viem';

import { createMeshBootstrap } from '../mesh/bootstrap.ts';
import { chainTo } from '../mesh/directory.ts';
import { bundlerCall, readOne, readState, STATE_ABI, type WalletRpcSend } from '../chain/wallet-rpc.ts';
import { MarkovPathPolicy } from '../../graph/src/path-policy.ts';
import { deployment, entryPoint, meshTrustRoot, NETWORK, requireAttester, requireContract, requireService } from '../../deployments/index.ts';

const stackUrl = process.env['STACK_URL'] ?? `${new URL(requireService('meshExitUrl')).origin}/stack.json`;
const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

let failed = 0;
async function check(name: string, run: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    console.log(`  ok    ${name}  (${await run()}, ${Date.now() - t0} ms)`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}  ${(error as Error).message}`);
  }
}
const expect = (cond: boolean, why: string) => { if (!cond) throw new Error(why); };

console.log(`\n  ${deployment.network.displayName} (chain ${deployment.network.chainId}) via ${stackUrl}\n`);

const response = await fetch(stackUrl, { headers: { origin: 'https://www.opaque.credit' } });
expect(response.ok, `stack.json ${response.status}`);
const cfg = JSON.parse(await response.text(), reviver);

await check('stack.json allows the site origin (CORS)', async () => {
  const allow = response.headers.get('access-control-allow-origin');
  expect(allow === '*' || allow === 'https://www.opaque.credit', `allow-origin ${allow}`);
  return `allow-origin ${allow}`;
});
await check('stack reports LIVE wallet, LIVE graph, ATTESTED CRE', async () => {
  const c = cfg.capabilities;
  expect(c.pqWallet === 'LIVE' && c.graph === 'LIVE' && c.confidentialExecution === 'ATTESTED', JSON.stringify(c));
  return JSON.stringify(c);
});

// What the page does first: the directory must chain to the compiled-in root.
const { signed, root } = chainTo(cfg.directoryChain ?? [cfg.signedDirectory], meshTrustRoot() as never);
await check(`relay directory chains to the ${NETWORK} trust root compiled into the build`, async () =>
  `${signed.directory.entries.length} relays, generation ${root.minVersion}`);

const bootstrap = createMeshBootstrap({ root, signed, pathPolicy: new MarkovPathPolicy(), client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 } });
const query = async <T>(request: Parameters<typeof bootstrap.transport.query>[0]) =>
  (await bootstrap.transport.query(request, await bootstrap.pathFor())) as unknown as { value: T };
const walletRpc: WalletRpcSend = async (operation, encodedRequest) =>
  (await query<`0x${string}`>({ kind: 'WALLET_RPC', operation, encodedRequest } as never)).value;

const rings = deployment.pools.filter((p) => p.proofMode === 'RING_8');
await check(`deployment lists the RING_8 pools`, async () => {
  expect(rings.length > 0, 'no RING_8 pools in the deployment');
  return `${rings.length} pools`;
});

// One STATE read over the mesh for every pool: chain, exit allowlist and config must agree.
await check('every pool answers capabilities() over the mesh as configured', async () => {
  const calls = rings.map((p) => ({ to: p.address, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'capabilities', args: [] }) }));
  const { results, blockNumber } = await readState(walletRpc, calls as never);
  rings.forEach((p, i) => {
    const c = decodeFunctionResult({ abi: STATE_ABI, functionName: 'capabilities', data: results[i]! }) as { proofMode: number; ringSize: number; denomination: bigint };
    expect(c.proofMode === 0 && c.ringSize === 8 && c.denomination === BigInt(p.denomination), `${p.address}: ${JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
  });
  return `block ${blockNumber}`;
});
await check('registry, USDC and EntryPoint reads pass the exit allowlist', async () => {
  const attester = requireAttester();
  const state = (await readOne(walletRpc, requireContract('pqKeyRegistry'), 'stateOf', [attester])).value as { useCount: bigint; maxUses: bigint };
  expect(state.maxUses > 0n, 'attester has no registered key');
  await readOne(walletRpc, deployment.tokens.usdc.address, 'balanceOf', [attester]);
  await readOne(walletRpc, entryPoint(), 'getNonce', [attester, 0n]);
  return `attester key ${state.useCount}/${state.maxUses} used`;
});
await check('the exit reaches the ERC-4337 bundler', async () => {
  const price = await bundlerCall(walletRpc, 'pimlico_getUserOperationGasPrice', []) as { standard?: { maxFeePerGas?: string } };
  expect(price?.standard?.maxFeePerGas !== undefined, JSON.stringify(price));
  return `maxFeePerGas ${BigInt(price.standard!.maxFeePerGas!)} wei`;
});
await check('Graph relay snapshot over the mesh', async () => {
  const s = (await query<{ nodes: unknown[] }>({ kind: 'RELAY_SNAPSHOT' } as never)).value;
  expect(Array.isArray(s?.nodes), 'no nodes in the snapshot');
  return `${s.nodes.length} relays observed`;
});
const scope = { chainId: BigInt(deployment.network.chainId), pool: rings[0]!.address, denomination: rings[0]!.denomination };
await check(`Graph ring snapshot for the ${rings[0]!.denomination / 1e6} USDC pool`, async () => {
  const s = (await query<{ candidates: unknown[]; indexedThroughBlock: bigint }>({ kind: 'RING_SNAPSHOT', scope } as never)).value;
  expect(Array.isArray(s?.candidates), 'no candidates array');
  return `${s.candidates.length} deposits, indexed through block ${s.indexedThroughBlock}`;
});
await check('privacy conditions for that pool', async () => {
  const s = (await query<Record<string, unknown>>({ kind: 'PRIVACY_CONDITIONS', scope } as never)).value;
  return Object.keys(s ?? {}).slice(0, 4).join(', ') || 'empty';
});
await check('credential authority issues a recipient credential', async () => {
  const r = await fetch(cfg.credentialUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipient: deployment.accounts.attester }) });
  expect(r.ok, `HTTP ${r.status}`);
  return `${(await r.text()).length} bytes`;
});

console.log(failed === 0 ? '\n  all checks passed\n' : `\n  ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
