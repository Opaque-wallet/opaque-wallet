// SWAP_QUOTE at the exit: LI.FI is asked for this network's swap tokens only,
// for the account itself, and its answer is trimmed to what the wallet needs.
// LI.FI is stood in for, so this runs offline.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWalletRpcAnswerer, swapQuote } from '../wallet-rpc.ts';
import { deployment } from '../../../deployments/index.ts';

const ACCOUNT = '0x7224f894d0c9fbf65b883c7814419048d83b2e11';
const [USDC, EURC] = deployment.swap.tokens;

function exit(answer: (url: URL) => { status: number; body: unknown }) {
  const asked: URL[] = [];
  const send = createWalletRpcAnswerer({
    publicClient: {} as never, bundlerUrl: 'https://bundler.invalid', entryPoint: '0x0000000071727de22e5e9d8baf0edac6f37da032' as never,
    accountImplementation: '0x0000000000000000000000000000000000000001' as never,
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
  await assert.rejects(swapQuote(send, { from: USDC!.address as never, to: EURC!.address as never, amount: 5n, account: ACCOUNT as never }), /No available quotes/);
});
