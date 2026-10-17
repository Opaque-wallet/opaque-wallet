// The header's network picker, shared by the Arc wallet (app.html) and the
// XRPL wallet (xrpl.html). Each network is its own build, mainnet at the site
// root and testnet under testnet/ (`npm run build`), with storage names of its
// own, so switching network is a page load and never a change of keys.

import { deployment, networks } from '../../../deployments/index.ts';

/** An Arc network id, or 'xrpl': the XRPL wallet page (testnet/xrpl.html). */
export type WalletPage = (typeof networks)[number]['id'] | 'xrpl';

/** The directory of the build at `sitePath`, relative to this page; '' for this build. */
const dirOf = (sitePath: string): string =>
  sitePath === deployment.network.sitePath ? '' : `${'../'.repeat(deployment.network.sitePath.split('/').filter(Boolean).length)}${sitePath}`;

// Listed, not offered yet. The XRPL page still works when opened directly
// (testnet/xrpl.html, and every xrpl:e2e script); the picker just doesn't lead there.
const COMING = [{ id: 'xrpl', name: 'XRPL Testnet' }, { id: 'xrpl-mainnet', name: 'XRPL Mainnet' }];

export function networkPicker(select: HTMLSelectElement, current: WalletPage): void {
  const arc = networks.map((n) => ({ id: n.id as string, name: n.displayName, href: `${dirOf(n.sitePath)}app.html` }));
  select.replaceChildren(
    ...arc.map((p) => new Option(p.name, p.id, false, p.id === current)),
    ...COMING.map((p) => {
      const here = p.id === current;
      const option = new Option(here ? p.name : `${p.name} (coming soon)`, p.id, false, here);
      option.disabled = !here;
      return option;
    }),
  );
  select.addEventListener('change', () => {
    const page = arc.find((p) => p.id === select.value);
    if (page !== undefined && page.id !== current) location.href = page.href;
  });
}
