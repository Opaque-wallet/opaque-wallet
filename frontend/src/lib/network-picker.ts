// The header's network button and its sheet, shared by every network's wallet
// page: Arc's (app.html) and XRPL's (xrpl.html). Each network is its own build,
// mainnet at the site root and testnet under testnet/ (`npm run build:site`),
// with storage names of its own, so switching network is a page load and never
// a change of keys. A new chain is an entry here and a page in
// extension/build.mjs, never a second wallet.

import { deployment, networks } from '../../../deployments/index.ts';

/** An Arc network id, or 'xrpl': the XRPL wallet page (testnet/xrpl.html). */
export type WalletPage = (typeof networks)[number]['id'] | 'xrpl';

/** The directory of the build at `sitePath`, relative to this page; '' for this build. */
const dirOf = (sitePath: string): string =>
  sitePath === deployment.network.sitePath ? '' : `${'../'.repeat(deployment.network.sitePath.split('/').filter(Boolean).length)}${sitePath}`;

interface Network { readonly id: string; readonly chain: string; readonly name: string; readonly note: string; readonly href?: string; readonly flag?: string }
const NETWORKS: readonly Network[] = [
  ...networks.map((n) => ({
    id: n.id as string, chain: 'Arc', name: n.displayName, href: `${dirOf(n.sitePath)}app.html`,
    note: n.id === 'mainnet' ? 'Private USDC, real funds' : 'Private test USDC, no value',
    ...(n.id === 'mainnet' ? { flag: 'Not audited' } : {}),
  })),
  // The XRPL wallet is built with testnet, so it sits beside testnet's app.html.
  { id: 'xrpl', chain: 'XRP Ledger', name: 'XRPL Testnet', note: 'Private XRP, RLUSD and USDC', href: `${dirOf(networks.find((n) => n.id === 'testnet')!.sitePath)}xrpl.html` },
  { id: 'xrpl-mainnet', chain: 'XRP Ledger', name: 'XRPL Mainnet', note: 'After the audit' },
];
type SidePanel = { setOptions(options: { path: string }): Promise<void> };
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

export function networkPicker(button: HTMLButtonElement, current: WalletPage): void {
  // In the extension, the side panel reopens on the network used last.
  (globalThis as { chrome?: { sidePanel?: SidePanel } }).chrome?.sidePanel?.setOptions({ path: location.pathname.slice(1) }).catch(() => undefined);

  const here = NETWORKS.find((n) => n.id === current)!;
  button.innerHTML = '<i class="net-dot" aria-hidden="true"></i><span></span>';
  button.querySelector('span')!.textContent = here.name;
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
      row.innerHTML = `<i class="tok tok-${chain === 'Arc' ? 'arc' : 'xrp'}">${chain[0]}</i><span><b></b><small></small></span>`;
      row.querySelector('b')!.textContent = n.name;
      row.querySelector('small')!.textContent = n.note;
      if (n.flag !== undefined) row.append(Object.assign(document.createElement('em'), { className: 'net-flag', textContent: n.flag }));
      if (n.href === undefined) row.append(Object.assign(document.createElement('em'), { className: 'net-flag soon', textContent: 'Soon' }));
      if (n.id === current) row.insertAdjacentHTML('beforeend', `<em class="net-check">${CHECK}</em>`);
      if (n.id === current) row.addEventListener('click', () => sheet.close());
      sheet.append(row);
    }
  }
  sheet.append(Object.assign(document.createElement('p'), { className: 'fine-print', textContent: 'Each network keeps its own keys and notes. Switching opens that network\'s wallet and never moves funds.' }));
  document.body.append(sheet);
  button.addEventListener('click', () => sheet.showModal());
  // A click on the backdrop closes it, as a sheet does.
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
}
