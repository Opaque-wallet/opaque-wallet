// The browser tests' way into the wallet pages (frontend/xrpl.html, app.html). A
// fresh browser opens on onboarding, so a test makes its wallet as a person
// would: reveal the phrase, tick that it is written down, type three words back.
// Outside backend's typecheck, like the scripts that use it.

import { TERMS_VERSION } from '../../frontend/src/lib/wallet-ui.ts';

const READY = () => document.getElementById('account-short')?.textContent === 'Notes in this browser';

/** Accepts the Terms of Use and Privacy Policy when the page asks, as a person would; a browser that has accepted them is not asked. */
export async function acceptTerms(page: any, timeout = 90_000): Promise<void> {
  const asked = await page.waitForFunction((version: string) => ((document.getElementById('terms-dialog') as HTMLDialogElement | null)?.open ? 'asked'
    : localStorage.getItem('opaque:terms-accepted') === version ? 'accepted' : null), TERMS_VERSION, { timeout });
  if ((await asked.jsonValue()) !== 'asked') return;
  await page.check('#terms-agree');
  await page.click('#terms-continue');
}

/** The Arc page (frontend/app.html) is ready once its runtime is. */
export const ARC_READY = () => (globalThis as { opaque?: unknown }).opaque !== undefined;

/** The password the browser tests give every wallet they make. */
export const PASSWORD = 'opaque test password';

/**
 * Right after a wallet is made or brought in: its password, then, where a
 * browser can make passkeys, the passkey backup ("Not now" unless `back`).
 */
export async function passkeyOffer(page: any, timeout = 90_000, back = false): Promise<void> {
  // The page reloads into the wallet at the end; a reload mid-wait is tried again.
  for (let tries = 0; ; ) {
    try {
      const step = await page.waitForFunction(() => (document.getElementById('ob-password')?.hidden === false ? 'password'
        : document.getElementById('ob-passkey')?.hidden === false ? 'offered'
        : document.getElementById('onboard')?.hidden === false ? null : 'opened'), null, { timeout });
      const at = await step.jsonValue();
      if (at === 'password') {
        await page.fill('#ob-pass', PASSWORD);
        await page.fill('#ob-pass2', PASSWORD);
        await page.click('#ob-pass-go');
        await page.waitForFunction(() => document.getElementById('ob-password')?.hidden !== false, null, { timeout });
        continue;
      }
      if (at === 'offered') await page.click(back ? '#ob-passkey-go' : '#ob-passkey-skip');
      return;
    } catch (error) {
      if (++tries > 3 || !/context was destroyed|navigat/i.test(String(error))) throw error;
    }
  }
}

/**
 * A wallet page opened in a tab of its own (a dapp's popup, a second tab) opens locked: the password, as a person would.
 * A wallet from before passwords (a test profile kept on disk) is made to set one instead.
 */
export async function unlockIfAsked(page: any, timeout = 90_000): Promise<void> {
  const at = await page.waitForFunction(() => (document.documentElement.dataset['lock'] === 'open' ? 'open'
    : document.getElementById('lock-password') !== null ? 'locked'
    : document.getElementById('lock-new') !== null ? 'new' : null), null, { timeout });
  const said = await at.jsonValue();
  if (said === 'open') return;
  if (said === 'new') {
    await page.fill('#lock-new', PASSWORD);
    await page.fill('#lock-new2', PASSWORD);
    await page.click('#lock-new-go');
  } else {
    await page.fill('#lock-password', PASSWORD);
    await page.click('#lock-go');
  }
  await page.waitForFunction(() => document.documentElement.dataset['lock'] === 'open', null, { timeout });
}

/** Creates a wallet from onboarding's first screen (and its passkey backup, if `backup`); returns its recovery phrase. */
export async function createWallet(page: any, timeout = 90_000, ready: () => boolean = READY, backup = false): Promise<string> {
  await acceptTerms(page);
  await page.waitForSelector('#ob-create', { state: 'visible', timeout });
  await page.click('#ob-create');
  await page.click('#ob-reveal');
  const words: string[] = await page.$$eval('#ob-words li', (items: Element[]) => items.map((li) => li.textContent!.trim()));
  await page.check('#ob-saved');
  await page.click('#ob-next');
  for (const input of await page.$$('#ob-quiz input')) await input.fill(words[Number(await input.getAttribute('data-pos'))]!);
  await page.click('#ob-finish');
  await passkeyOffer(page, timeout, backup);
  await page.waitForFunction(ready, null, { timeout });
  return words.join(' ');
}

/** Imports a phrase from onboarding's first screen, and waits for its notes to be looked for. */
export async function importWallet(page: any, phrase: string, timeout = 240_000): Promise<string> {
  await acceptTerms(page);
  await page.waitForSelector('#ob-import', { state: 'visible', timeout: 90_000 });
  await page.click('#ob-import');
  await page.fill('#ob-phrase', phrase);
  await page.click('#ob-restore-go');
  await passkeyOffer(page);
  await page.waitForFunction(() => /^Found \d+ note/.test(document.getElementById('home-status')?.textContent ?? ''), null, { timeout });
  return String(await page.textContent('#home-status'));
}

/** Waits for the wallet (unlocking it if it opens locked); on a fresh browser, creates one first and returns its phrase. */
export async function openWallet(page: any, timeout = 90_000): Promise<string | undefined> {
  await acceptTerms(page);
  const which = await page.waitForFunction(() => (document.getElementById('account-short')?.textContent === 'Notes in this browser' ? 'wallet'
    : document.getElementById('lock-password') !== null || document.getElementById('lock-new') !== null ? 'locked'
    : document.getElementById('onboard')?.hidden === false ? 'onboard' : null), null, { timeout });
  const at = await which.jsonValue();
  if (at === 'locked') { await unlockIfAsked(page, timeout); return undefined; }
  return at === 'wallet' ? undefined : createWallet(page, timeout);
}
