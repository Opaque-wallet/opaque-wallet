// The header's network button and its sheet, shared by every network's wallet
// page: Arc's and Sepolia's (app.html), XRPL's (xrpl.html) and the devnet's
// (devnet.html). Each network is its own build, mainnet at the site root,
// testnet under testnet/ and Sepolia under sepolia/ (`npm run build:site`),
// with storage names of its own, so switching network is a page load and never
// a change of keys. A new chain is an entry here and a page in
// extension/build.mjs, never a second wallet.

import { deployment, networks, type NetworkId } from '../../../deployments/index.ts';
import sepolia from '../../../deployments/eth-sepolia.json' with { type: 'json' };

/** An EVM network id, or 'xrpl': the XRPL wallet page (testnet/xrpl.html). */
export type WalletPage = NetworkId | 'xrpl' | 'devnet';

/** The directory of the build at `sitePath`, relative to this page; '' for this build. */
const dirOf = (sitePath: string): string =>
  sitePath === deployment.network.sitePath ? '' : `${'../'.repeat(deployment.network.sitePath.split('/').filter(Boolean).length)}${sitePath}`;

interface Network { readonly id: string; readonly chain: string; readonly name: string; readonly note: string; readonly href?: string; readonly flag?: string }
const NETWORKS: Network[] = [
  // The Arc wallet's code, built for Sepolia (VITE_NETWORK=sepolia) into its own directory.
  { id: 'sepolia', chain: 'Ethereum', name: 'Sepolia', note: 'Private test USDC, no value', href: `${dirOf(sepolia.network.sitePath)}app.html` },
  ...networks.map((n) => ({
    id: n.id as string, chain: 'Arc', name: n.displayName, href: `${dirOf(n.sitePath)}app.html`,
    note: n.id === 'mainnet' ? 'Private USDC, real funds' : 'Private test USDC, no value',
    ...(n.id === 'mainnet' ? { flag: 'Not audited' } : {}),
  })),
  // The XRPL wallet is built with testnet, so it sits beside testnet's app.html.
  { id: 'xrpl', chain: 'XRP Ledger', name: 'XRPL Testnet', note: 'Private XRP, RLUSD and USDC', href: `${dirOf(networks.find((n) => n.id === 'testnet')!.sitePath)}xrpl.html` },
  { id: 'xrpl-mainnet', chain: 'XRP Ledger', name: 'XRPL Mainnet', note: 'After the audit' },
];
// The EIP-8141 devnet's page is built with testnet too (devnet.html). Listed first: it is the newest.
NETWORKS.unshift({ id: 'devnet', chain: 'Ethereum', name: 'Ethereum Devnet (Fully post-quantum)', note: 'EIP-8141, hash-based signatures only', href: `${dirOf(networks.find((n) => n.id === 'testnet')!.sitePath)}devnet.html` });
type SidePanel = { setOptions(options: { path: string }): Promise<void> };
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

export function networkPicker(button: HTMLButtonElement, current: WalletPage): void {
  // In the extension, the side panel reopens on the network used last.
  (globalThis as { chrome?: { sidePanel?: SidePanel } }).chrome?.sidePanel?.setOptions({ path: location.pathname.slice(1) }).catch(() => undefined);

  const here = NETWORKS.find((n) => n.id === current)!;
  button.innerHTML = '<i class="net-dot" aria-hidden="true"></i><span></span>';
  // The header has room for the name only, not its bracketed note.
  button.querySelector('span')!.textContent = here.name.split(' (')[0]!;
  button.setAttribute('aria-haspopup', 'dialog');

  const sheet = document.createElement('dialog');
  sheet.className = 'networks';
  sheet.id = 'network-dialog';
  sheet.innerHTML = '<form method="dialog" class="dialog-head"><h2>Select network</h2><button value="close" aria-label="Close">×</button></form>';
  for (const chain of [...new Set(NETWORKS.map((n) => n.chain))]) {
    sheet.append(Object.assign(document.createElement('p'), { className: 'net-group', textContent: chain }));
    for (const n of NETWORKS.filter((x) => x.chain === chain)) {
      const row = document.createElement(n.href === undefined || n.id === current ? 'button' : 'a');
      row.className = `net-row${n.href === undefined ? ' soon' : ''}`;
      row.dataset['network'] = n.id;
      if (row instanceof HTMLAnchorElement) row.href = n.href!;
      else { row.type = 'button'; row.disabled = n.href === undefined; }
      if (n.id === current) row.setAttribute('aria-current', 'true');
      row.innerHTML = `<i class="tok tok-${{ Arc: 'arc', Ethereum: 'eth' }[chain] ?? 'xrp'}">${chain[0]}</i><span><b></b><small></small></span>`;
      // A bracketed note after the name stays on one line, in a lighter weight.
      const [title, tag] = n.name.split(' (');
      row.querySelector('b')!.textContent = `${title}${tag === undefined ? '' : ' '}`;
      if (tag !== undefined) row.querySelector('b')!.append(Object.assign(document.createElement('span'), { className: 'net-tag', textContent: `(${tag}` }));
      row.querySelector('small')!.textContent = n.note;
      if (n.flag !== undefined) row.append(Object.assign(document.createElement('em'), { className: 'net-flag', textContent: n.flag }));
      if (n.href === undefined) row.append(Object.assign(document.createElement('em'), { className: 'net-flag soon', textContent: 'Soon' }));
      if (n.id === current) row.insertAdjacentHTML('beforeend', `<em class="net-check">${CHECK}</em>`);
      if (n.id === current) row.addEventListener('click', () => sheet.close());
      sheet.append(row);
    }
  }
  // Post-quantum protection for what people already have, with no wallet to switch to: pages of the
  // Sepolia build, so on the site, not in the extension, which bundles only the wallets.
  sheet.append(Object.assign(document.createElement('p'), { className: 'net-group', textContent: 'Keep what you have · Sepolia' }));
  const inExtension = location.protocol === 'chrome-extension:';
  for (const [page, name, note] of [
    ['vault', 'Q-Day vault', 'Keep MetaMask: only a FORS+C key takes funds out'],
    ['quantum-safe', 'Quantum-safe admin', 'Any protocol\'s admin keys, moved to a FORS+C key'],
  ] as const) {
    const row = document.createElement('a');
    row.className = 'net-row';
    row.dataset['tool'] = page;
    row.href = inExtension ? `https://www.opaque.credit/${sepolia.network.sitePath}${page}` : `${dirOf(sepolia.network.sitePath)}${page}.html`;
    if (inExtension) { row.target = '_blank'; row.rel = 'noopener'; }
    row.innerHTML = '<i class="tok tok-eth">E</i><span><b></b><small></small></span>';
    row.querySelector('b')!.textContent = name;
    row.querySelector('small')!.textContent = note;
    sheet.append(row);
  }
  sheet.append(Object.assign(document.createElement('p'), { className: 'fine-print', textContent: 'Each network keeps its own keys and notes. Switching opens that network\'s wallet and never moves funds.' }));
  document.body.append(sheet);
  button.addEventListener('click', () => sheet.showModal());
  // A click on the backdrop closes it, as a sheet does.
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
}
