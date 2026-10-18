// Assembles extension-xrpl/dist/, the directory you load as an unpacked
// extension, and its zip:
//
//   cd frontend && npm run ext:xrpl    (builds the wallet into frontend/dist-ext, then runs this)
//
// The side panel and the approval window are the hosted pages themselves
// (xrpl.html, xrpl-connect.html), built for testnet and copied here with only
// the assets they reference. The extension keeps its own notes and keys, as a
// wallet extension does; the hosted wallet's stay on its own origin.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', 'frontend');
const BUILT = join(FRONTEND, 'dist-ext');
const DIST = join(HERE, 'dist');
const SITE = 'https://opaque-xrpl.vercel.app/';
const fail = (why) => { console.error(why); process.exit(1); };

if (!existsSync(join(BUILT, 'xrpl.html'))) fail('frontend/dist-ext/xrpl.html is missing: run `npm run ext:xrpl` in frontend/');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'assets'), { recursive: true });

const available = readdirSync(join(BUILT, 'assets'));
const copied = new Set();
for (const page of ['xrpl.html', 'xrpl-connect.html']) {
  let html = readFileSync(join(BUILT, page), 'utf8').replace('<html lang="en">', '<html lang="en" class="extension">');

  // Manifest V3 refuses inline scripts and handlers, and the page would open blank.
  const scannable = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const [re, why] of [[/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i, 'an inline <script>'], [/\son[a-z]+\s*=\s*["']/i, 'an inline event handler'], [/javascript:/i, 'a javascript: URL']]) {
    if (re.test(scannable)) fail(`${page} has ${why}, which the extension's CSP refuses`);
  }

  // What the page references, and what those files reference in turn.
  const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  for (let i = 0; i < refs.length; i++) {
    if (!/\.(js|css)$/.test(refs[i])) continue;
    const body = readFileSync(join(BUILT, refs[i]), 'utf8');
    for (const name of available) if (body.includes(name) && !refs.includes(`assets/${name}`)) refs.push(`assets/${name}`);
  }
  for (const ref of refs) { copyFileSync(join(BUILT, ref), join(DIST, ref)); copied.add(ref); }

  // The wallet finds Opaque's servers through the stack URL built into it.
  const code = refs.filter((r) => r.endsWith('.js')).map((r) => readFileSync(join(BUILT, r), 'utf8')).join('\n');
  if (!/https:\/\/[^"'`\s]+\/xrpl-stack\.json/.test(code)) fail(`${page} names no stack URL: build it with VITE_XRPL_STACK_URL (npm run ext:xrpl does)`);

  html = html
    // Vite's crossorigin turns same-origin loads on chrome-extension:// into CORS requests, which fail.
    .replace(/\s+crossorigin(?=[\s>])/g, '')
    // A home-screen app manifest means nothing inside an extension.
    .replace(/\s*<link rel="(?:manifest|apple-touch-icon)"[^>]*>/g, '')
    // There is no site inside the extension: links to it open the hosted one in a tab.
    .replaceAll('href="/"', `href="${SITE}" target="_blank" rel="noopener"`);
  writeFileSync(join(DIST, page), html);
}

// A wallet that tells a font server each time it opens would leak who reaches for private payments.
const leaks = [...copied].filter((ref) => /\.(css|js)$/.test(ref) && /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(join(DIST, ref), 'utf8')));
if (leaks.length > 0) fail(`remote fonts in ${leaks.join(', ')}`);

for (const file of ['manifest.json', 'background.js', 'bridge.js']) copyFileSync(join(HERE, file), join(DIST, file));
mkdirSync(join(DIST, 'icons'));
for (const size of [16, 32, 48, 128]) copyFileSync(join(HERE, '..', 'extension', 'icons', `${size}.png`), join(DIST, 'icons', `${size}.png`));
execFileSync(join(FRONTEND, 'node_modules', '.bin', 'rolldown'), [join(HERE, 'inject.ts'), '-o', join(DIST, 'inject.js'), '-f', 'iife', '-p', 'browser'], { stdio: 'inherit' });

// The zip for Developer-mode installs, offered on the hosted wallet. Unzipped it
// is always the folder `opaque-xrpl-extension`, and an unpacked extension's id
// (and so its wallet) follows its folder.
const { version } = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const zip = join(FRONTEND, 'public', 'opaque-xrpl-extension.zip');
const staging = join(HERE, 'opaque-xrpl-extension');
rmSync(staging, { recursive: true, force: true });
rmSync(zip, { force: true });
execFileSync('cp', ['-R', DIST, staging]);
try {
  execFileSync('zip', ['-qr', '-X', zip, 'opaque-xrpl-extension'], { cwd: HERE });
} catch {
  console.warn('no zip command: extension-xrpl/dist is built, but not zipped');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`extension-xrpl/dist ${version}: ${copied.size} assets${existsSync(zip) ? `, frontend/public/opaque-xrpl-extension.zip` : ''}`);
