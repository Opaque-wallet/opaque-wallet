#!/usr/bin/env node
// The SDK and the MCP server as packages a company installs without this
// repository: each bundled into one folder of plain JavaScript (the wallet
// code it reaches into frontend/ and backend/ included), then packed.
//
//   node packages/scripts/build-dist.ts      → packages/{sdk,mcp}/dist, and .tgz beside them
//
// ponytail: no .d.ts yet; the API page documents every shape. Add declarations
// when a customer builds in TypeScript against it.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from '../../frontend/node_modules/rolldown/dist/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LICENSE = join(ROOT, 'LICENSE');

async function bundle(name: 'sdk' | 'mcp', input: Record<string, string>, pkg: Record<string, unknown>): Promise<string> {
  const out = join(ROOT, 'packages', name, 'dist');
  rmSync(out, { recursive: true, force: true });
  // One build per entry, each inlining what it needs. cli.ts keeps its own #! line:
  // a banner beside it left rolldown 1.2.7 writing the banner alone.
  for (const [name, path] of Object.entries(input)) {
    await build({
      input: { [name]: join(ROOT, path) },
      platform: 'node',
      external: [/^node:/],
      output: { dir: join(out, 'lib'), format: 'esm', entryFileNames: '[name].js', chunkFileNames: `${name}-[name]-[hash].js` },
    } as never);
  }
  cpSync(LICENSE, join(out, 'LICENSE'));
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({ license: 'SEE LICENSE IN LICENSE', type: 'module', engines: { node: '>=22.18' }, ...pkg }, null, 2)}\n`);
  writeFileSync(join(out, 'README.md'), readFileSync(join(ROOT, 'packages', name, 'README.md')));
  const tgz = execFileSync('npm', ['pack', '--pack-destination', join(ROOT, 'packages', name)], { cwd: out, encoding: 'utf8' }).trim().split('\n').pop()!;
  return join('packages', name, tgz);
}

const sdk = JSON.parse(readFileSync(join(ROOT, 'packages/sdk/package.json'), 'utf8')) as { version: string; description: string };
const mcp = JSON.parse(readFileSync(join(ROOT, 'packages/mcp/package.json'), 'utf8')) as { version: string; description: string };
mkdirSync(join(ROOT, 'packages'), { recursive: true });
console.log(await bundle('sdk', { index: 'packages/sdk/src/index.ts', 'prover-worker': 'packages/sdk/src/prover-worker.ts' },
  { name: '@opaque/sdk', version: sdk.version, description: sdk.description, exports: { '.': './lib/index.js' } }));
console.log(await bundle('mcp', { cli: 'packages/mcp/src/cli.ts', server: 'packages/mcp/src/server.ts', 'prover-worker': 'packages/sdk/src/prover-worker.ts' },
  { name: '@opaque/mcp', version: mcp.version, description: mcp.description, bin: { 'opaque-mcp': './lib/cli.js' }, exports: { '.': './lib/server.js' } }));
