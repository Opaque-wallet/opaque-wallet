// What an ordinary transaction gives away: the sender's secp256k1 public key,
// recovered from the signature every transaction carries. Nothing privileged is
// used here — only what the chain already publishes to everyone.
//
// This is the exposure Opaque exists to remove. ECDSA authority is recoverable
// from any past signature, and Shor's algorithm turns that public key into the
// private key. A FORS+C signature publishes its public key too, and no quantum
// algorithm is known that recovers the secret from it. That is what the extra
// nine kilobytes buys.
//
//   node chain/ecdsa-exposure.ts <tx hash>
import { createPublicClient, keccak256, recoverPublicKey, serializeTransaction } from 'viem';
import { ARC, rpcTransport } from './pool.ts';

const hash = process.argv[2] as `0x${string}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) { console.error('usage: node chain/ecdsa-exposure.ts <tx hash>'); process.exit(1); }
const c = createPublicClient({ chain: ARC, transport: rpcTransport() });
const t = await c.getTransaction({ hash });

const unsigned = serializeTransaction({
  type: t.type, chainId: t.chainId ?? ARC.id, nonce: t.nonce, gas: t.gas,
  to: t.to ?? undefined, value: t.value, data: t.input,
  ...(t.type === 'legacy' ? { gasPrice: t.gasPrice! } : { maxFeePerGas: t.maxFeePerGas!, maxPriorityFeePerGas: t.maxPriorityFeePerGas! }),
} as never);
// EIP-155 packs the chain id into v (chainId*2 + 35 or 36), which is not the
// 0/1 recovery bit the recovery wants. Unpack it rather than trusting yParity,
// which legacy transactions do not carry.
const v = t.v ?? 0n;
const yParity = t.yParity ?? Number(v >= 35n ? (v - 35n) % 2n : v >= 27n ? v - 27n : v);
const pub = await recoverPublicKey({ hash: keccak256(unsigned), signature: { r: t.r!, s: t.s!, yParity } as never });
const recovered = `0x${keccak256(`0x${pub.slice(4)}`).slice(-40)}`;

const p = (k: string, v: string) => console.log(`  ${k.padEnd(22)}${v}`);
console.log(`\n  ORDINARY TRANSACTION  ${hash}\n`);
p('signed by', t.from);
p('signature', 'r + s + v  =  32 + 32 + 1  =  65 bytes');
p('r', t.r!);
p('s', t.s!);
console.log('\n  PUBLIC KEY, recovered from that signature by anyone:\n');
console.log(`  ${pub}\n`);
p('checks out as', `${recovered}  ${recovered.toLowerCase() === t.from.toLowerCase() ? '= the sender' : 'MISMATCH'}`);
console.log(`
  This is the whole exposure. Shor's algorithm turns a secp256k1 public key into
  its private key. The key above is already public, in a transaction already
  written, and nothing this wallet does later can take it back.

  An opaque spend publishes a 9,251-byte FORS+C signature instead. Its public key
  is published too — and no quantum algorithm is known that recovers the secret
  from it. That is what the extra 9 kilobytes buys.
`);
process.exit(0);
