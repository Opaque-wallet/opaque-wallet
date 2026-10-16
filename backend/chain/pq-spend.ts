// The other half of chain/ecdsa-exposure.ts: what authorises an Opaque spend.
//
// The transaction envelope is still ECDSA — our egress key pays the gas — and
// that is the point worth being precise about. The courier cannot move a note,
// pick a recipient, or touch an account. Authority lives in the calldata: a
// hash-based FORS+C signature, and a ring proof over eight candidate notes.
//
//   node chain/pq-spend.ts <spend tx hash>

import { createPublicClient, decodeFunctionData, parseAbi, parseEventLogs } from 'viem';
import { ARC, POOL_ABI, rpcTransport } from './pool.ts';

const hash = process.argv[2] as `0x${string}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) { console.error('usage: node chain/pq-spend.ts <tx hash>'); process.exit(1); }
const c = createPublicClient({ chain: ARC, transport: rpcTransport() });
const [t, r] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash })]);

const { args } = decodeFunctionData({ abi: POOL_ABI, data: t.input });
const [ring, proof, recipient] = args as unknown as [readonly `0x${string}`[], `0x${string}`, `0x${string}`];
const events = parseEventLogs({
  abi: parseAbi([
    'event Spent(bytes32 indexed nullifier, address indexed recipient, uint256 amount)',
    'event RingUsed(bytes32[] ring)',
  ]),
  logs: r.logs,
});
const spent = events.find((e) => e.eventName === 'Spent');

const p = (k: string, v: string) => console.log(`  ${k.padEnd(22)}${v}`);
console.log(`\n  OPAQUE SPEND  ${hash}\n`);
p('submitted by', `${t.from}  ← pays gas, and nothing else`);
p('calldata', `${(t.input.length - 2) / 2} bytes`);
p('  ring', `${ring.length} commitments — one is the note, nobody can say which`);
p('  proof', `${(proof.length - 2) / 2} bytes of hash-based signature and attestation`);
p('paid to', recipient);
p('nullifier', `${spent?.args.nullifier ?? '—'}`);
console.log('\n  THE RING. One of these was spent:\n');
ring.forEach((cm, i) => console.log(`   ${String(i + 1).padStart(2)}  ${cm}`));
console.log(`
  Nowhere in this transaction is the payer named. The sender above is our egress
  key: break it and you get a wallet that pays gas. It cannot spend a note, it
  cannot choose a recipient, and it cannot act for any account.

  What can is a FORS+C signature — hash-based, with no known quantum attack —
  and the secret behind one of the ${ring.length} commitments above. Compare with
  chain/ecdsa-exposure.ts, where 65 bytes hand over the account itself.
`);
process.exit(0);
