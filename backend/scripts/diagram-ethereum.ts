// diagrams/ethereum.{excalidraw,svg,png}: the Ethereum architecture, laid out here and drawn
// by Excalidraw itself (esm.sh, in Chromium), so the SVG carries Excalifont like the others.
// Edit diagrams/ethereum.excalidraw on excalidraw.com, or change this and run it again:
//   node --use-system-ca scripts/diagram-ethereum.ts      (in backend/)

import { readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const O = { strokeColor: '#e8590c', backgroundColor: '#fff4e6', fillStyle: 'solid', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const G = { strokeColor: '#495057', backgroundColor: '#f1f3f5', fillStyle: 'solid', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const C = { strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const W = { strokeColor: '#2f9e44', backgroundColor: '#b2f2bb', fillStyle: 'solid', strokeWidth: 2, roughness: 1, roundness: { type: 3 } };
const box = (x: number, y: number, w: number, h: number, text: string, s = O, size = 18) => ({ type: 'rectangle', x, y, width: w, height: h, ...s, label: { text, fontSize: size, fontFamily: 5, strokeColor: '#1e1e1e' } });
const frame = (x: number, y: number, w: number, h: number, s = C) => ({ type: 'rectangle', x, y, width: w, height: h, ...s });
const text = (x: number, y: number, t: string, size = 18, color = '#1e1e1e') => ({ type: 'text', x, y, text: t, fontSize: size, fontFamily: 5, strokeColor: color });
const arrow = (pts: [number, number][], label?: string, size = 15) => ({
  type: 'arrow', x: pts[0]![0], y: pts[0]![1], points: pts.map(([a, b]) => [a - pts[0]![0], b - pts[0]![1]]), strokeColor: '#1e1e1e', strokeWidth: 2, roughness: 1, endArrowhead: 'arrow',
  ...(label ? { label: { text: label, fontSize: size, fontFamily: 5 } } : {}),
});

const els = [
  text(40, 20, 'Opaque on Ethereum: every signature FORS+C, private by default', 36),
  text(40, 72, 'Live on Sepolia and the EIP-8141 devnet  ·  ETHGlobal Mumbai  ·  opaque.credit', 20, '#495057'),

  // You
  box(40, 130, 360, 300, 'Opaque wallet\n\nweb · extension · phone\nFORS+C keys from one\nrecovery phrase, sealed\nin the browser; they\nrotate themselves', W, 20),
  box(40, 480, 360, 110, 'Any dapp\n(EIP-6963: Opaque listed\nbeside MetaMask)'),
  box(40, 640, 360, 110, 'MetaMask users\nkeep MetaMask, guard it\nwith the Q-Day vault'),
  arrow([[220, 478], [220, 434]]),

  // Path A
  frame(460, 130, 600, 310),
  text(478, 140, 'Path A · EIP-8141 devnet · one frame transaction (type 0x06)', 17),
  box(480, 175, 560, 48, 'VERIFY · FORS+C via LeanFors · 76,430 gas (cap 100k)'),
  box(480, 233, 560, 48, 'SENDER · Uniswap v4 swap through the PQ hook'),
  box(480, 291, 560, 48, 'SENDER · deposit into a privacy pool'),
  box(480, 349, 560, 48, 'SENDER · rotate to the next key'),
  text(482, 408, 'no bundler, no paymaster: the account pays for itself', 16, '#495057'),
  arrow([[402, 250], [458, 250]]),

  // Path B
  frame(460, 480, 600, 220),
  text(478, 490, 'Path B · Sepolia · one ERC-4337 UserOperation', 17),
  box(480, 525, 560, 60, 'signature = FORS+C, checked by\nPQAccount + PQKeyRegistry'),
  text(482, 600, 'one executeBatch: send · swap · claim a name ·\ndeposit · a dapp\'s call approved in Opaque', 16, '#495057'),
  text(482, 655, 'keys hand over to the next before they run out', 16, '#495057'),
  arrow([[402, 380], [430, 380], [430, 590], [458, 590]], 'Sepolia'),

  // Infrastructure
  box(1110, 180, 250, 90, 'Alt mempool\n(the gateway)', G),
  box(1110, 320, 250, 90, 'ethrex miner\n(EIP-8141)', G),
  box(1110, 540, 250, 120, 'Bundler (Pimlico)\ncarries it,\nauthorizes nothing', G),
  box(1110, 905, 250, 80, 'Public RPC\nand bundler', G),
  arrow([[1062, 225], [1108, 225]]),
  arrow([[1235, 272], [1235, 318]]),
  arrow([[1362, 365], [1408, 365]]),
  arrow([[1062, 600], [1108, 600]]),
  arrow([[1362, 600], [1408, 600]]),

  // Devnet
  frame(1410, 130, 940, 310),
  text(1428, 140, 'EIP-8141 devnet · chain 1337  (Ethereum Foundation track)', 17),
  box(1430, 175, 440, 105, 'FramePQAccount + factory\naccounts made with no signature'),
  box(1890, 175, 440, 105, 'PQKeyRegistry\nfew-time FORS+C keys'),
  box(1430, 300, 440, 105, 'Uniswap v4 + PQPoolHook\nonly PQ accounts trade'),
  box(1890, 300, 440, 105, '7 pqUSDC privacy pools\nthe attester is a FORS+C account'),

  // Sepolia
  frame(1410, 480, 940, 470),
  text(1428, 490, 'Sepolia  (ENS + Uniswap tracks)', 17),
  box(1430, 525, 440, 105, 'PQAccount (ERC-4337)\n+ PQKeyRegistry'),
  box(1890, 525, 440, 105, 'Uniswap v4 (Uniswap\'s own)\nPQAccountPoolHook · PQGuardHook'),
  box(1430, 645, 440, 125, 'ENSv2: Root → ETHRegistry (ENS\'s)\n→ PQNameController: opaque.eth\n→ OpaqueNames: you.opaque.eth'),
  box(1890, 645, 440, 125, 'Stealth, post-quantum\nERC-6538: your ML-KEM-768 key\nERC-5564: the announcements'),
  box(1430, 785, 440, 110, 'Exitable pools · tUSDC and WETH\nleave without us:\nannounce, wait, reveal'),
  box(1890, 785, 440, 110, 'Q-Day vault\nin: any wallet · out: FORS+C only'),
  text(1430, 910, 'every name, pool, hook and the vault answer to the same FORS+C key format', 16, '#495057'),

  // Privacy layer
  frame(460, 760, 600, 250),
  text(478, 770, 'Opaque privacy layer', 17),
  box(480, 805, 170, 95, 'Ring proof\none of 8,\nbuilt here', O, 16),
  box(670, 805, 180, 95, 'Three relays\nnone sees you\nand the payment', O, 16),
  box(870, 805, 170, 95, 'Attester\nchecks the proof,\nnot which note', O, 16),
  box(480, 915, 560, 75, 'EF anon-rpc (Nox mixnet): reads and UserOperations,\nnobody sees who asks', O, 16),
  arrow([[652, 852], [668, 852]]),
  arrow([[852, 852], [868, 852]]),
  arrow([[760, 702], [760, 758]], 'a private payment'),
  arrow([[1042, 852], [1428, 840]], 'attested: the pool pays\nthe payee or a one-time account'),
  arrow([[1042, 950], [1108, 948]]),
  arrow([[1362, 945], [1408, 935]]),

  // MetaMask → vault
  arrow([[220, 752], [220, 1050], [2110, 1050], [2110, 897]]),
  text(1180, 1018, 'MetaMask deposits; only FORS+C withdraws', 16, '#495057'),

  // Core
  box(40, 1100, 2310, 110, 'PQ AUTH CORE · PQKeyRegistry + ForsVerifier / LeanFors\none FORS+C key format for accounts, names, LP guards and the vault · few-time keys, the next one committed ahead · hash-based: nothing for Shor\'s algorithm to attack', O, 22),
];

const html = `<!doctype html><html><body><script type="module">
  import * as X from 'https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle-deps';
  window.make = async (skeleton) => {
    const elements = X.convertToExcalidrawElements(skeleton, { regenerateIds: true });
    const appState = { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false };
    const svg = await X.exportToSvg({ elements, appState, files: null, exportPadding: 30 });
    const json = X.serializeAsJSON(elements, { ...appState, name: 'opaque-ethereum-architecture' }, {}, 'local');
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
const out = await page.evaluate((s) => (window as unknown as { make: (s: unknown) => Promise<{ svg: string; json: string; png: string }> }).make(s), els);
const dir = new URL('../../diagrams/', import.meta.url).pathname;
writeFileSync(join(dir, 'ethereum.svg'), out.svg);
writeFileSync(join(dir, 'ethereum.excalidraw'), out.json);
writeFileSync(join(dir, 'ethereum.png'), Buffer.from(out.png, 'base64'));
console.log('svg', out.svg.length, 'embedded fonts:', (out.svg.match(/data:font/g) ?? []).length);
await browser.close();
