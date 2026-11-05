// Makes a network's mesh master and pins its root in deployments/<name>.json.
//
//   cd backend && node scripts/new-mesh-master.ts eth-sepolia
//
// The master goes to .stack/<name>/mesh-master (0600) and is never printed. It
// is the only copy off the host, so keep it: without it the weekly directories
// can't be re-derived. Then, as docs/xrpl.md does for XRPL:
//   tr -d '\n' < .stack/<name>/mesh-master | railway variable set MESH_MASTER --stdin …

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { meshRootAt } from '../mesh/local-mesh.ts';

const name = process.argv[2] ?? '';
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('usage: node scripts/new-mesh-master.ts <deployments file name, e.g. eth-sepolia>');
const HERE = dirname(fileURLToPath(import.meta.url));
const config = join(HERE, '..', '..', 'deployments', `${name}.json`);
const secret = join(HERE, '..', '.stack', name, 'mesh-master');

const d = JSON.parse(readFileSync(config, 'utf8')) as { mesh: { genesis: number; trustRoot: { signerCommitment: string; minVersion: number } } };
const master = randomBytes(32);
mkdirSync(dirname(secret), { recursive: true, mode: 0o700 });
// 'wx' refuses an existing file: a second master would orphan the first one's directories.
writeFileSync(secret, `0x${master.toString('hex')}`, { mode: 0o600, flag: 'wx' });
d.mesh.genesis = Math.floor(Date.now() / 1000);
d.mesh.trustRoot = { signerCommitment: meshRootAt(master).signerCommitment, minVersion: 0 };
writeFileSync(config, `${JSON.stringify(d, null, 2)}\n`);
console.log(`pinned ${d.mesh.trustRoot.signerCommitment} (genesis ${d.mesh.genesis}) in deployments/${name}.json`);
