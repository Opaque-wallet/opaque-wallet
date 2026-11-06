// diagrams/{uniswap,ens,ethereum-foundation}.{excalidraw,svg,png}: one diagram per ETHGlobal Mumbai
// partner, drawn by Excalidraw itself (esm.sh, in Chromium) like diagrams/ethereum.*.
// Edit the .excalidraw files on excalidraw.com, or change this and run it again:
//   node --use-system-ca scripts/diagram-partners.ts      (in backend/)

import { readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const O = { strokeColor: '#e8590c', backgroundColor: '#fff4e6', fillStyle: 'solid', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const G = { strokeColor: '#495057', backgroundColor: '#f1f3f5', fillStyle: 'solid', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const K = { strokeColor: '#1e1e1e', backgroundColor: '#ffd8a8', fillStyle: 'solid', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const C = { strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const box = (x: number, y: number, w: number, h: number, text: string, s = O, size = 18) => ({ type: 'rectangle', x, y, width: w, height: h, ...s, label: { text, fontSize: size, fontFamily: 5, strokeColor: '#1e1e1e' } });
const frame = (x: number, y: number, w: number, h: number, s = C) => ({ type: 'rectangle', x, y, width: w, height: h, ...s });
const text = (x: number, y: number, t: string, size = 18, color = '#1e1e1e') => ({ type: 'text', x, y, text: t, fontSize: size, fontFamily: 5, strokeColor: color });
const arrow = (pts: [number, number][], label?: string, size = 15) => ({
  type: 'arrow', x: pts[0]![0], y: pts[0]![1], points: pts.map(([a, b]) => [a - pts[0]![0], b - pts[0]![1]]), strokeColor: '#1e1e1e', strokeWidth: 2, roughness: 1, endArrowhead: 'arrow',
  ...(label ? { label: { text: label, fontSize: size, fontFamily: 5 } } : {}),
});
const GREY = '#495057';

const uniswap = [
  text(40, 20, 'Uniswap v4: pool authority moved to a hash-based key', 36),
  text(40, 72, 'Three hooks · Uniswap\'s own v4 on Sepolia, and the EIP-8141 devnet · a hook\'s callbacks are the low 14 bits of its address', 20, GREY),

  // Callers
  box(40, 140, 320, 90, 'ECDSA wallet\n(or a cracked key)', G),
  box(40, 260, 320, 160, 'Post-quantum account\nPQAccount on Sepolia,\nFramePQAccount on devnet\nsigns with FORS+C', O),
  box(40, 640, 320, 130, 'Any LP, MetaMask too\n+ a guard key in\nPQKeyRegistry', O),

  // Uniswap's periphery and core
  box(460, 170, 280, 120, 'Universal Router\nswaps (V4_SWAP)', G),
  box(460, 480, 280, 120, 'PositionManager\nmint · decrease\nliquidity', G, 17),
  box(860, 140, 230, 680, 'v4 PoolManager\n\ncalls only the\ncallbacks whose\nbit is set in the\nhook\'s address', G, 17),
  arrow([[362, 185], [458, 205]], 'swap'),
  arrow([[362, 290], [458, 262]], 'swap'),
  arrow([[362, 400], [458, 510]], 'add · remove'),
  arrow([[362, 690], [458, 575]], 'add · remove'),
  arrow([[742, 230], [858, 230]]), text(778, 203, 'swap', 15),
  arrow([[742, 540], [858, 540]]), text(746, 513, 'modifyLiquidity', 14),
  arrow([[1092, 300], [1198, 300]]), text(1106, 273, 'PQ pools', 15),
  arrow([[1092, 770], [1198, 770]]), text(1110, 743, 'guarded', 15),
  text(40, 830, 'orange: Opaque\'s hooks and accounts\ngrey: Uniswap\'s own contracts, unchanged\ndark orange: what is refused', 16, GREY),

  // The post-quantum pools
  frame(1200, 130, 960, 480),
  text(1218, 140, 'PQAccountPoolHook (Sepolia) · PQPoolHook (devnet) · FLAGS 0xAA0', 18),
  box(1220, 180, 225, 80, 'beforeAddLiquidity\nbit 11', O, 15),
  box(1455, 180, 225, 80, 'beforeRemoveLiquidity\nbit 9', O, 15),
  box(1690, 180, 225, 80, 'beforeSwap · bit 7\n→ (selector, 0, 0)', O, 15),
  box(1925, 180, 225, 80, 'beforeDonate\nbit 5', O, 15),
  box(1220, 310, 460, 100, 'who = actor(sender)\nrouter or PositionManager → msgSender()\nany other contract counts as itself', O, 16),
  box(1700, 310, 450, 100, 'isPostQuantum(who)?\nSepolia: who.codehash == PQAccount clone\ndevnet: registered from the factory', O, 16),
  arrow([[1450, 262], [1450, 308]], 'every callback'),
  arrow([[1682, 360], [1698, 360]]),
  box(1220, 460, 460, 90, 'no → revert NotPostQuantum(who)\nthe whole swap or liquidity change reverts', K, 16),
  box(1700, 460, 450, 90, 'yes → it runs as in a hookless pool\nthe pool\'s own 0.30% fee, amounts untouched', O, 16),
  arrow([[1925, 412], [1925, 458]], 'yes'),
  arrow([[1760, 412], [1600, 458]], 'no'),
  text(1222, 568, 'no afterSwap (bit 6 = 0): the gate runs before the pool moves, and nothing needs doing after a swap', 16, GREY),

  // The guard
  frame(1200, 650, 960, 360),
  text(1218, 660, 'PQGuardHook (Sepolia) · FLAGS 0xB01 · a FORS+C second factor for any LP', 18),
  box(1220, 700, 290, 150, 'beforeAddLiquidity · bit 11\nthe first funding binds\nthe position to its\nfunder\'s FORS+C key', O, 15),
  box(1535, 700, 290, 150, 'beforeRemoveLiquidity · bit 9\nhookData: a FORS+C signature\nPQKeyRegistry.consume\nrecipient → transient storage', O, 15),
  box(1850, 700, 290, 150, 'afterRemoveLiquidity · bit 8\n+ ReturnDelta · bit 0\npays what was released\nto the signed recipient only', O, 15),
  arrow([[1512, 775], [1533, 775]]),
  arrow([[1827, 775], [1848, 775]]),
  box(1220, 890, 605, 90, 'another key\'s signature, or the real one\nreplayed to another recipient: BadSignature', K, 16),
  arrow([[1680, 852], [1600, 888]], 'refused'),
  text(1852, 900, 'swaps stay open:\nthe guard has no\nswap callbacks', 16, GREY),

  // The flags
  box(40, 1050, 2120, 90, 'The flags are the address. PoolManager reads its low 14 bits: 0x…4aa0 & 0x3fff = 0x0aa0 · 0x…4b01 & 0x3fff = 0x0b01.\nSalts mined for the CREATE2 deployer 0x4e59…956c; each constructor reverts WrongHookAddress() if its bits differ.', O, 17),
];

const ens = [
  text(40, 20, 'ENSv2: opaque.eth held by a post-quantum key', 36),
  text(40, 72, 'Live on Sepolia · ENS\'s own RootRegistry, ETHRegistry and UniversalResolverV2, unchanged · ours in orange', 20, GREY),

  // Who controls opaque.eth
  text(40, 112, 'who controls opaque.eth', 16, GREY),
  box(40, 140, 400, 140, 'opaque.eth\'s FORS+C key\n32 uses, the next key\ncommitted ahead', O),
  box(540, 140, 460, 140, 'PQNameController.execute(\ntarget, data, deadline, sig)\nanyone may submit:\npaying authorizes nothing', O, 17),
  box(540, 330, 460, 90, 'PQKeyRegistry.consume\nonce per signature · else BadSignature', O, 16),
  box(1100, 140, 460, 140, 'ETHRegistry (ENS)\nopaque.eth is an ERC-1155 token\nheld by the controller: every\nrole moves with it (_update)', G, 16),
  box(1660, 140, 500, 140, 'PermissionedResolver\nopaque.eth\'s records: addr 60,\nENSIP-11 0x80000539 (devnet), pq-key\nonly the controller writes them', G, 16),
  arrow([[442, 210], [538, 210]], 'signs'),
  arrow([[770, 282], [770, 328]], 'checks'),
  arrow([[1002, 210], [1098, 210]], 'calls', 14),
  arrow([[1562, 210], [1658, 210]], 'resolver', 14),

  // Who can hold name.opaque.eth
  text(40, 440, 'who can hold name.opaque.eth', 16, GREY),
  box(40, 470, 400, 230, 'Opaque PQ account\n(ERC-4337, FORS+C)\n\none UserOperation,\none signature: both calls', O),
  box(540, 470, 460, 110, 'ERC-6538 registry (standard)\nML-KEM-768 meta-address,\n1,184 bytes, Opaque\'s scheme id', G, 16),
  box(1100, 470, 460, 220, 'OpaqueNames\nopaque.eth\'s subregistry + resolver\nclaim(label) only if:\ncodehash == PQAccount clone\n3–32 characters · one name per wallet\nelse NotAnOpaqueAccount · BadLabel\n· Taken · HasAName', O, 16),
  box(1660, 470, 500, 220, 'So a name resolves to an\naccount only a hash-based key\ncan move. An ECDSA write to\nthe resolver, and the old\nowner\'s setResolver, both revert.', G, 16),
  arrow([[442, 525], [538, 525]], 'registerKeys'),
  arrow([[442, 640], [1098, 640]], 'claim(label)'),
  arrow([[1330, 282], [1330, 468]], 'setSubregistry (signed)', 14),

  // How a payer finds the account
  text(40, 780, 'how a payer finds the account', 16, GREY),
  box(40, 810, 400, 150, 'A payer\'s wallet\nresolve("alice.opaque.eth")', G),
  box(540, 810, 460, 150, 'EF anon-rpc (Nox mixnet)\nthe RPC never sees who asks', G, 17),
  box(1100, 810, 460, 150, 'UniversalResolverV2 (ENS)\nRoot → ETHRegistry → OpaqueNames\n→ addr(node, 60): the holder', G, 16),
  box(1660, 810, 500, 150, 'then pay a one-time account:\nencapsulate to the payee\'s\nML-KEM-768 meta-address', O, 17),
  arrow([[442, 885], [538, 885]], 'lookup'),
  arrow([[1002, 885], [1098, 885]], 'eth_call'),
  arrow([[1562, 885], [1658, 885]], 'then'),
  arrow([[1330, 808], [1330, 692]], 'getResolver · resolve', 14),
];

const ef = [
  text(40, 20, 'Ethereum Foundation: CROPS on Sepolia and the EIP-8141 devnet', 36),
  text(40, 72, 'S: a transaction signed by FORS+C alone · C: an exit that needs nobody · P: stealth hidden from quantum computers, reads nobody can trace', 20, GREY),

  // S
  frame(40, 120, 1040, 510),
  text(58, 130, 'S · EIP-8141 devnet: one frame transaction (type 0x06)', 18),
  box(60, 175, 320, 125, 'FramePQAccountFactory\nsends and pays the creating\ntx; approves only create(key)', O, 16),
  box(60, 370, 320, 110, 'FramePQAccount\nCREATE2, salt = key: known\nbefore it exists', O, 17),
  arrow([[220, 302], [220, 368]], 'no signature at all'),
  text(62, 500, 'VERIFY used 76,430 gas,\nunder MAX_VERIFY_GAS 100,000\n(the audited ForsVerifier\nalone: 167k)', 15, GREY),
  box(470, 175, 590, 175, 'VERIFY frame (a STATICCALL)\n1. SIGDATACOPY: the FORS+C signature\n2. digest = keccak(DOMAIN, sigHash)\n3. LeanFors recovers the key: 53.6k gas\n4. approve(EXECUTION_AND_PAYMENT)', O, 17),
  arrow([[382, 400], [468, 300]], 'signs, sends'),
  box(470, 420, 590, 100, 'SENDER frames, the account as msg.sender\nswap · deposit · send · rotate(next)', O, 17),
  arrow([[765, 352], [765, 418]], 'approved'),
  text(472, 540, 'the account pays its own gas: no bundler, no paymaster\nthe protocol nonce counts the key\'s 8 uses', 15, GREY),

  // C
  frame(1120, 120, 1040, 510),
  text(1138, 130, 'C · Sepolia: a note leaves its pool with every Opaque server down', 18),
  box(1140, 175, 300, 110, 'Wallet\nevery Opaque host blocked', O, 16),
  box(1140, 370, 300, 110, 'EF anon-rpc (Nox)\n+ a public bundler', G, 17),
  arrow([[1290, 287], [1290, 368]], 'reads, UserOps'),
  box(1560, 175, 580, 105, '1 · announceExit(nullifier, claim)\nclaim = keccak(S, paymentContext)\nthe private path closes: NoteIsExiting', O, 16),
  box(1560, 350, 580, 125, '2 · spend(ring, EXIT_TAG ‖ S, recipient)\nAES-128 on chain recomputes the\ncommitment and nullifier from S:\nin the ring? announced? old enough?', O, 16),
  box(1560, 530, 580, 70, 'the pool pays the recipient', K, 17),
  arrow([[1442, 400], [1558, 230]], 'UserOp 1'),
  arrow([[1442, 445], [1558, 425]], 'UserOp 2'),
  arrow([[1720, 282], [1720, 348]]),
  text(1735, 300, 'wait exitDelay: 300 s on Sepolia', 15, GREY),
  arrow([[1850, 477], [1850, 528]]),

  // P
  frame(40, 670, 2120, 420),
  text(58, 680, 'P · Sepolia: who was paid is hidden, against quantum computers too', 18),
  box(60, 725, 330, 125, 'Payee\nan ML-KEM-768 key pair\nfrom the recovery phrase', O, 16),
  box(495, 725, 330, 125, 'ERC-6538 registry\nregisterKeys(SCHEME_ID,\n1,184-byte meta-address)', G, 16),
  box(930, 725, 330, 125, 'Payer\nencapsulates: a 1,088-byte\nciphertext + shared secret ss', G, 16),
  box(1365, 725, 330, 125, 'ss draws both FORS+C keys\nof a fresh PQAccount:\nthe pool pays its address', O, 16),
  box(1800, 725, 340, 125, 'ERC-5564 Announcer\nciphertext + view tag,\nposted by Opaque\'s exit', G, 16),
  arrow([[392, 787], [493, 787]], 'publish'),
  arrow([[827, 787], [928, 787]], 'read'),
  arrow([[1262, 787], [1363, 787]], 'derive'),
  arrow([[1697, 787], [1798, 787]], 'announce'),
  arrow([[1960, 852], [1960, 900], [230, 900], [230, 852]]),
  text(480, 910, 'the payee scans: the view tag skips 255 in 256, it decapsulates its own, and the wallet sweeps the payment into notes', 16, GREY),
  box(60, 965, 2080, 100, 'EF anon-rpc (the Nox mixnet) in the wallet: a sandboxed, null-origin iframe runs only the worker whose keccak matches the on-chain\nspecifier (0x3513…7A9A). Every ENS lookup goes through it always; the account\'s reads and UserOperations, with one switch.', O, 16),
];

const html = `<!doctype html><html><body><script type="module">
  import * as X from 'https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle-deps';
  window.make = async ([skeleton, name]) => {
    const elements = X.convertToExcalidrawElements(skeleton, { regenerateIds: true });
    const appState = { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false };
    const svg = await X.exportToSvg({ elements, appState, files: null, exportPadding: 30 });
    const json = X.serializeAsJSON(elements, { ...appState, name }, {}, 'local');
    const png = await X.exportToBlob({ elements, appState, files: null, exportPadding: 30, mimeType: 'image/png', getDimensions: (w, h) => ({ width: w * 2, height: h * 2, scale: 2 }) });
    const bytes = new Uint8Array(await png.arrayBuffer());
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    return { svg: svg.outerHTML, json, png: btoa(bin) };
  };
  window.ready = true;
</script></body></html>`;

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage();
page.on('pageerror', (e: Error) => console.log('pageerror', e.message));
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 200)); });
await page.goto('https://example.com');
await page.setContent(html);
await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, undefined, { timeout: 120_000 });
const dir = new URL('../../diagrams/', import.meta.url).pathname;
for (const [name, els] of [['uniswap', uniswap], ['ens', ens], ['ethereum-foundation', ef]] as const) {
  const out = await page.evaluate((a) => (window as unknown as { make: (a: unknown) => Promise<{ svg: string; json: string; png: string }> }).make(a), [els, `opaque-${name}`]);
  writeFileSync(join(dir, `${name}.svg`), out.svg);
  writeFileSync(join(dir, `${name}.excalidraw`), out.json);
  writeFileSync(join(dir, `${name}.png`), Buffer.from(out.png, 'base64'));
  console.log(name, 'svg', out.svg.length, 'embedded fonts:', (out.svg.match(/data:font/g) ?? []).length);
}
await browser.close();
