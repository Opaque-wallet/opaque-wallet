// SWAP_QUOTE at the exit: LI.FI is asked for this network's swap tokens only,
// for the account itself, and its answer is trimmed to what the wallet needs.
// LI.FI is stood in for, so this runs offline.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWalletRpcAnswerer, swapQuote } from '../wallet-rpc.ts';
import { deployment } from '../../../deployments/index.ts';

const ACCOUNT = '0x7224f894d0c9fbf65b883c7814419048d83b2e11';
const [USDC, EURC] = deployment.swap.tokens;

function exit(answer: (url: URL) => { status: number; body: unknown }, quotesPerMinute?: number) {
  const asked: URL[] = [];
  const send = createWalletRpcAnswerer({
    publicClient: {} as never, bundlerUrl: 'https://bundler.invalid', entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032' as never,
    accountImplementation: '0x0000000000000000000000000000000000000001' as never,
    ...(quotesPerMinute === undefined ? {} : { quotesPerMinute }),
    fetch: (async (input: string) => {
      const url = new URL(input);
      asked.push(url);
      const { status, body } = answer(url);
      return new Response(JSON.stringify(body), { status });
    }) as never,
  });
  return { send, asked };
}

const LIFI = {
  tool: 'fly', toolDetails: { name: 'Fly' },
  estimate: { toAmount: '2764288', toAmountMin: '2736645', approvalAddress: deployment.swap.router, feeCosts: [{ amountUSD: '0.0050' }] },
  transactionRequest: { to: deployment.swap.router, data: `0xabcdef${ACCOUNT.slice(2)}`, value: '0x0', gasLimit: '0x1' },
};

test('a quote is LI.FI\'s, asked for the account itself on this chain, and trimmed', async () => {
  const { send, asked } = exit(() => ({ status: 200, body: LIFI }));
  const quote = await swapQuote(send, { from: USDC!.address as never, to: EURC!.address as never, amount: 2_000_000n, account: ACCOUNT as never });
  assert.deepEqual(quote, { tool: 'Fly', toAmount: '2764288', toAmountMin: '2736645', approvalAddress: deployment.swap.router, to: deployment.swap.router,
    data: `0xabcdef${ACCOUNT.slice(2)}`, value: '0x0', feeUsd: 0.005 });
  const p = asked[0]!.searchParams;
  assert.equal(asked[0]!.origin, 'https://li.quest');
  assert.equal(p.get('fromChain'), String(deployment.network.chainId));
  assert.equal(p.get('toChain'), String(deployment.network.chainId));
  assert.equal(p.get('fromAddress'), ACCOUNT);
  assert.equal(p.get('toAddress'), ACCOUNT, 'what the swap buys goes to the account, nowhere else');
  assert.equal(p.get('fromAmount'), '2000000');
});

test('only this network\'s swap tokens, a whole amount, and an account', async () => {
  const { send, asked } = exit(() => ({ status: 200, body: LIFI }));
  const other = '0x1111111111111111111111111111111111111111';
  for (const request of [
    { from: other, to: EURC!.address, amount: 1n, account: ACCOUNT },
    { from: USDC!.address, to: USDC!.address, amount: 1n, account: ACCOUNT },
    { from: USDC!.address, to: EURC!.address, amount: 0n, account: ACCOUNT },
    { from: USDC!.address, to: EURC!.address, amount: 1n, account: 'nobody' },
  ]) await assert.rejects(swapQuote(send, request as never), { code: 'INVALID_INPUT' });
  assert.equal(asked.length, 0, 'LI.FI is never asked for a refused request');
});

test('no route is an error the wallet can show', async () => {
  const { send } = exit(() => ({ status: 404, body: { message: 'No available quotes for the requested transfer' } }));
  // F-26 (overlord): LI.FI's own words stay with LI.FI; the wallet hears that there is no route.
  await assert.rejects(swapQuote(send, { from: USDC!.address as never, to: EURC!.address as never, amount: 5n, account: ACCOUNT as never }), /LI\.FI found no route for that swap \(404\)/);
});

// F-2 (overlord): a swap quote's call is decoded, not searched. OMEGA's PoC: LI.FI calldata
// paying an attacker, with the account's address hidden in _referrer, which the old
// "does the calldata contain the account?" check let through.
test('a swap call paying anyone but the account, or less, or another token, is refused (F-2)', async () => {
  const { encodeFunctionData, parseAbi } = await import('viem');
  const { checkSwapCall } = await import('../pq-wallet-chain.ts');
  const ABI = parseAbi([
    'struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }',
    'function swapTokensMultipleV3ERC20ToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData[] _swapData)',
  ]);
  const account = '0x1111111111111111111111111111111111111111' as const;
  const attacker = '0x2222222222222222222222222222222222222222' as const;
  const usdc = '0x3600000000000000000000000000000000000000' as const;
  const eurc = '0x89b50855aa3be2f677cd6303cec089b5f319d72a' as const;
  const step = (from: `0x${string}`, to: `0x${string}`, amount: bigint) => ({ callTo: usdc, approveTo: usdc, sendingAssetId: from, receivingAssetId: to, fromAmount: amount, callData: '0x' as const, requiresDeposit: false });
  const call = (receiver: `0x${string}`, referrer: string, min: bigint, steps: ReturnType<typeof step>[]) => encodeFunctionData({ abi: ABI, functionName: 'swapTokensMultipleV3ERC20ToERC20', args: [`0x${'ab'.repeat(32)}`, 'opaque', referrer, receiver, min, steps] });
  const expect = { account, from: usdc, to: eurc, amount: 1_000_000n, minOut: 1_301_746n } as unknown as Parameters<typeof checkSwapCall>[1];
  const honest = [step(usdc, usdc, 1_000_000n), step(usdc, eurc, 997_500n)];

  assert.doesNotThrow(() => checkSwapCall(call(account, '', 1_301_746n, honest), expect));
  // The PoC: receiver is the attacker; the account's hex sits in _referrer.
  assert.throws(() => checkSwapCall(call(attacker, account, 1_301_746n, honest), expect), /pays someone other than this account/);
  assert.throws(() => checkSwapCall(call(account, '', 1n, honest), expect), /different least/, 'a floor of 1 behind a displayed one');
  assert.throws(() => checkSwapCall(call(account, '', 1_301_746n, [step(usdc, usdc, 2_000_000n), step(usdc, eurc, 1_995_000n)]), expect), /different token or amount/);
  assert.throws(() => checkSwapCall(call(account, '', 1_301_746n, [step(usdc, usdc, 1_000_000n), step(usdc, attacker, 997_500n)]), expect), /different token/);
  assert.throws(() => checkSwapCall(`0xa9059cbb${'00'.repeat(64)}`, expect), /not a LI.FI token swap/, 'a bare transfer()');
});

// F-17 (overlord): quotes are rate limited, so a flood can't burn the LI.FI quota every swap shares.
test('swap quotes past the limit are refused here, without a call to LI.FI (F-17)', async () => {
  const { send, asked } = exit(() => ({ status: 200, body: LIFI }), 2);
  const ask = () => swapQuote(send, { from: USDC!.address as never, to: EURC!.address as never, amount: 5n, account: ACCOUNT as never });
  // OMEGA's PoC: many SWAP_QUOTE queries in a row.
  await ask();
  await ask();
  await assert.rejects(ask(), /busy/);
  assert.equal(asked.length, 2, 'the third never reached LI.FI');
});
