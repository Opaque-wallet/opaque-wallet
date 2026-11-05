// Draws the store's two promo tiles from the wordmark (frontend/public/logo.png)
// and the ring of eight, as JPEGs: the store takes JPEG or a PNG without alpha.
//
//   node extension/store/make-promo.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const logo = `data:image/png;base64,${readFileSync(join(HERE, '..', '..', 'frontend', 'public', 'logo.png')).toString('base64')}`;

// The ring of eight, one dot per ring member, around a dashed circle.
const ring = (size, label) => {
  const c = size / 2, r = size * 0.4, dot = size * 0.075;
  const dots = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI - Math.PI / 2;
    return `<circle cx="${(c + r * Math.cos(a)).toFixed(1)}" cy="${(c + r * Math.sin(a)).toFixed(1)}" r="${dot}" fill="#ff7a18"/>`;
  }).join('');
  const text = label === undefined ? '' : `<text x="${c}" y="${c + 6}" text-anchor="middle" fill="#a39a94" font-size="${size * 0.065}" letter-spacing="2">${label}</text>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#ff7a18" stroke-opacity=".35" stroke-dasharray="6 14"/>${dots}${text}</svg>`;
};

const page = (w, h, body) => `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500&display=swap">
<style>
  html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
  body { display: flex; align-items: center; background: radial-gradient(circle at 18% 50%, #2a1406 0%, #0b090c 55%, #070608 100%); color: #f4efe9; font-family: Poppins, system-ui, sans-serif; }
  img { display: block; height: auto; }
  h1 { margin: 0; font-weight: 400; }
  p { margin: 0; color: #a39a94; }
</style></head><body>${body}</body></html>`;

const tiles = {
  'promo-440x280.jpg': [440, 280, `
    <div style="display:grid; grid-template-columns:auto 1fr; align-items:center; gap:28px; padding:0 34px 26px; width:100%">
      ${ring(118)}
      <img src="${logo}" style="width:220px">
      <h1 style="grid-column:1 / -1; font-size:17px; color:#e9e2dc">Private payments, post-quantum</h1>
    </div>`],
  'marquee-1400x560.jpg': [1400, 560, `
    <div style="display:flex; align-items:center; gap:96px; padding:0 120px">
      ${ring(300, 'one signed')}
      <div style="display:grid; gap:26px">
        <img src="${logo}" style="width:500px">
        <h1 style="margin-top:34px; font-size:38px">Private payments, post-quantum</h1>
        <p style="max-width:640px; font-size:21px; line-height:1.6">A ring of eight hides which note paid. Three relays hide who sent it. On Arc and the XRP Ledger.</p>
      </div>
    </div>`],
};

const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
for (const [file, [w, h, body]] of Object.entries(tiles)) {
  const tab = await browser.newPage({ viewport: { width: w, height: h } });
  await tab.setContent(page(w, h, body), { waitUntil: 'networkidle' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: join(HERE, file), type: 'jpeg', quality: 95 });
  console.log(`wrote extension/store/${file}`);
}
await browser.close();
