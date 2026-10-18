// Assembles extension/dist/ — the directory you load as an unpacked extension.
// One extension for every chain: each network's wallet page, as the site serves it.
//
//   cd frontend && npm run ext        (builds the site, then runs this)
//   node extension/build.mjs          (assumes frontend/dist is already built)
//
// It copies the Vite build of each wallet page and only the assets that page
// actually references, then makes the edits Chrome requires. There is no second
// UI codebase: the side panel shows the pages served at opaque.credit, which is
// the whole reason they are written to Manifest V3's rules in the first place.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = join(HERE, '..', 'frontend', 'dist');
const DIST = join(HERE, 'dist');

if (!existsSync(join(BUILT, 'app.html')) || !existsSync(join(BUILT, 'testnet', 'xrpl.html'))) {
  console.error('frontend/dist is missing a wallet page.\nRun:  cd frontend && npm run ext');
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'assets'), { recursive: true });
mkdirSync(join(DIST, 'icons'), { recursive: true });

// Every network's wallet, in the hosted site's layout (Arc mainnet at the root,
// Arc and XRPL testnet in testnet/), so the header's network picker works here
// too. A new chain adds its page here. Their storage names differ
// (storage-name.ts, and XRPL's are opaque:xrpl…), so one extension holds every
// wallet and none shares a key. xrpl-connect.html is the window dapps open.
const PAGES = ['app.html', 'testnet/app.html', 'testnet/xrpl.html', 'testnet/xrpl-connect.html'];
let fileCount = 0;
for (const page of PAGES) {
  const SRC = join(BUILT, dirname(page));
  const OUT = join(DIST, dirname(page));
  mkdirSync(join(OUT, 'assets'), { recursive: true });
  let html = readFileSync(join(BUILT, page), 'utf8');
  html = html.replace('<html lang="en">', '<html lang="en" class="extension">');

  // ── the CSP guard ─────────────────────────────────────────────────────────
  //
  // Manifest V3 refuses inline <script> and inline handlers outright, and the
  // failure mode is a popup that opens completely blank with the reason buried
  // in a console nobody has open. Catching it here costs one regex.
  //
  // Comments are stripped first: app.html carries a comment that NAMES the two
  // forbidden constructs in order to warn the next person off them, and scanning
  // the raw file flags that warning as the violation it is warning about.
  const scannable = html.replace(/<!--[\s\S]*?-->/g, '');
  const violations = [
    [/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i, 'inline <script> block'],
    [/\son[a-z]+\s*=\s*["']/i, 'inline event handler (onclick=, oninput=, …)'],
    [/javascript:/i, 'javascript: URL'],
  ].filter(([re]) => re.test(scannable));

  if (violations.length) {
    console.error(`The built ${page} breaks the Manifest V3 CSP:`);
    for (const [, why] of violations) console.error(`  - ${why}`);
    console.error('\nThe page would load blank. Move the code into its src/*.ts.');
    process.exit(1);
  }

  // ── copy only what the page references ────────────────────────────────────
  //
  // The build holds every page's assets and the wallet needs few of them. The
  // HTML names the entry script and stylesheet; those name the rest (the proof
  // worker, viem's lazy chunks, the fonts), so references are followed file to
  // file until nothing new turns up. No allow-list to maintain, and nothing the
  // page loads is left behind.

  const available = readdirSync(join(SRC, 'assets'));
  const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  for (let i = 0; i < refs.length; i++) {
    if (!/\.(js|css)$/.test(refs[i])) continue;
    const body = readFileSync(join(SRC, refs[i]), 'utf8');
    for (const name of available) if (body.includes(name) && !refs.includes(`assets/${name}`)) refs.push(`assets/${name}`);
  }
  for (const ref of refs) copyFileSync(join(SRC, ref), join(OUT, ref));

  // The wallet finds its backend through a stack URL built into it. A build
  // without one looks next to the page, which inside the extension is a file
  // that does not exist, and the wallet would open to "Could not start".
  const code = refs.filter((r) => r.endsWith('.js')).map((r) => readFileSync(join(SRC, r), 'utf8')).join('\n');
  if (!/https:\/\/[^"'`\s]+\/(stack\.json|v1\/mesh|xrpl-stack\.json)/.test(code)) {
    console.error(`${page} does not name its backend: build it for production (npm run ext does).`);
    process.exit(1);
  }

  // ── three required edits ──────────────────────────────────────────────────

  // 1. Vite emits crossorigin on its script and stylesheet tags. On a
  //    chrome-extension:// origin that turns same-origin loads into CORS
  //    requests, and Chrome fails them.
  html = html.replace(/\s+crossorigin(?=[\s>])/g, '');

  // 2. The hosted page links back to the landing page. Inside the extension
  //    there is no landing page, so the link would dead-end on a blank tab.
  // Both the wordmark and the sidebar return to the hosted product. The wallet
  // now puts classes and nested markup on those anchors, so rewriting the href
  // is more durable than matching one exact old anchor shape.
  for (const home of ['href="index.html"', 'href="/"']) {
    html = html.replaceAll(home, 'href="https://www.opaque.credit" target="_blank" rel="noopener"');
  }
  // A home-screen app manifest means nothing inside an extension.
  html = html.replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]*>/g, '');

  writeFileSync(join(DIST, page), html);

  // 3. styles.css @imports Cormorant Garamond and Lora from Google Fonts. On the
  //    hosted page that is a normal choice. In a wallet it is not: the popup
  //    would tell fonts.googleapis.com every single time it opens, producing a
  //    request-per-use log of when someone reaches for private payments — leaked
  //    to a third party by the one product that exists to prevent exactly that.
  //
  //    The tokens already declare `system-ui, sans-serif` fallbacks, so removing
  //    the import changes the typeface and nothing else.
  //    Two traps here, both hit on the way in. Vite rewrites the source's
  //    `@import url('…')` into `@import "…"`, so a pattern requiring url() finds
  //    nothing; and the URL itself contains a semicolon inside `wght@400;600`,
  //    so matching up to the first `;` truncates mid-URL and leaves the tail
  //    behind as garbage. Matching to the closing quote avoids both.
  const REMOTE_FONT = /@import\s+(?:url\(\s*)?(["'])https:\/\/fonts\.googleapis\.com.*?\1\s*\)?\s*;/g;

  for (const ref of refs.filter((r) => r.endsWith('.css'))) {
    const file = join(OUT, ref);
    writeFileSync(file, readFileSync(file, 'utf8').replace(REMOTE_FONT, ''));
  }

  // Assert the invariant, not the edit. Counting replacements only proves a
  // regex fired; this proves the shipped bytes contain no remote font reference
  // at all, however it got there.
  const leaks = refs
    .map((ref) => [ref, readFileSync(join(OUT, ref), 'utf8')])
    .filter(([, body]) => /fonts\.(googleapis|gstatic)\.com/.test(body))
    .map(([ref]) => ref);

  if (leaks.length) {
    console.error('The extension would phone home for fonts on every open:');
    for (const ref of leaks) console.error(`  - ${ref}`);
    process.exit(1);
  }
  fileCount += refs.length + 1;
}

for (const file of ['manifest.json', 'background.js', 'bridge.js']) copyFileSync(join(HERE, file), join(DIST, file));
// What lets XRPL dapps built for GemWallet or Crossmark reach Opaque (inject.ts).
execFileSync(join(HERE, '..', 'frontend', 'node_modules', '.bin', 'rolldown'), [join(HERE, 'inject.ts'), '-o', join(DIST, 'inject.js'), '-f', 'iife', '-p', 'browser'], { stdio: 'inherit' });
for (const size of [16, 32, 48, 128]) {
  copyFileSync(join(HERE, 'icons', `${size}.png`), join(DIST, 'icons', `${size}.png`));
}

// The file the Chrome Web Store takes: dist/'s contents, manifest at the root.
const { version } = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const zip = join(HERE, `opaque-extension-${version}.zip`);
rmSync(zip, { force: true });
try {
  execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: DIST });
} catch {
  console.warn('no zip command: extension/dist is built, but not zipped for the store');
}
// And the copy the landing page offers for Developer-mode installs, under a
// stable name: unzipped, it is always the folder `opaque-extension`, and an
// unpacked extension's id — its wallet — follows its folder.
if (existsSync(zip)) copyFileSync(zip, join(HERE, '..', 'frontend', 'public', 'opaque-extension.zip'));

console.log(`built ${DIST}  (${fileCount + 8} files, ${PAGES.length} pages)${existsSync(zip) ? `, and ${basename(zip)} for the Chrome Web Store` : ''}`);
console.log('load it: chrome://extensions → Developer mode → Load unpacked → extension/dist');
