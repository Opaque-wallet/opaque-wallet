// The site's demo autopilot (frontend/src/demo/autopilot.ts) in a real browser against the live
// stacks: a build made with VITE_DEMO=1, opened at /sepolia/app?demo, Play pressed as the person
// recording would, and the run followed across the Sepolia wallet, the devnet and the Q-Day page
// to its end. Every caption and wait it logs is printed with its time; the test fails where the
// autopilot stops, with its words.
//
//   (cd ../frontend && VITE_DEMO=1 npm run build:site && npx vite preview --outDir dist --port 5174)
//   node --use-system-ca scripts/e2e-demo.ts                       SITE=http://localhost:5174 by default
//   SITE=https://www.opaque.credit node --use-system-ca scripts/e2e-demo.ts   after npm run demo:on

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';

const SITE = process.env['SITE'] ?? 'http://localhost:5174';
const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
const build = readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().pop()!;
const browser = await chromium.launch({ executablePath: process.env['CHROMIUM'] ?? join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(`${page.url()}: ${e.message}`));

try {
  const ended = new Promise<string>((resolve, reject) => page.on('console', (m: any) => {
    const line: string = m.text();
    if (!line.startsWith('[opaque demo')) return;
    console.log(line);
    if (line.endsWith('the demo is done')) resolve(line);
    else if (/\] (stopped at|stopped$)/.test(line)) reject(new Error(line));
  }));
  await page.goto(`${SITE}/sepolia/app?demo`);
  await page.click('#demo-start button', { timeout: 60_000 });
  await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('the demo ran for an hour')), 3_600_000))]);
  console.log(`ok  the demo played to its end: ${await page.textContent('#demo-caption')}`);
  if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('ok  no page errors');
} finally {
  await browser.close();
}
