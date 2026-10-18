// The browser tests' way into the XRPL wallet page (frontend/xrpl.html). A
// fresh browser opens on onboarding, so a test makes its wallet as a person
// would: reveal the phrase, tick that it is written down, type three words back.
// Outside backend's typecheck, like the scripts that use it.

const READY = () => document.getElementById('account-short')?.textContent === 'Notes in this browser';

/** Creates a wallet from onboarding's first screen; returns its recovery phrase. */
export async function createWallet(page: any, timeout = 90_000): Promise<string> {
  await page.waitForSelector('#ob-create', { state: 'visible', timeout });
  await page.click('#ob-create');
  await page.click('#ob-reveal');
  const words: string[] = await page.$$eval('#ob-words li', (items: Element[]) => items.map((li) => li.textContent!.trim()));
  await page.check('#ob-saved');
  await page.click('#ob-next');
  for (const input of await page.$$('#ob-quiz input')) await input.fill(words[Number(await input.getAttribute('data-pos'))]!);
  await page.click('#ob-finish');
  await page.waitForFunction(READY, null, { timeout });
  return words.join(' ');
}

/** Imports a phrase from onboarding's first screen, and waits for its notes to be looked for. */
export async function importWallet(page: any, phrase: string, timeout = 240_000): Promise<string> {
  await page.waitForSelector('#ob-import', { state: 'visible', timeout: 90_000 });
  await page.click('#ob-import');
  await page.fill('#ob-phrase', phrase);
  await page.click('#ob-restore-go');
  await page.waitForFunction(() => /^Found \d+ note/.test(document.getElementById('home-status')?.textContent ?? ''), null, { timeout });
  return String(await page.textContent('#home-status'));
}

/** Waits for the wallet; on a fresh browser, creates one first and returns its phrase. */
export async function openWallet(page: any, timeout = 90_000): Promise<string | undefined> {
  const which = await page.waitForFunction(() => (document.getElementById('account-short')?.textContent === 'Notes in this browser' ? 'wallet'
    : document.getElementById('onboard')?.hidden === false ? 'onboard' : null), null, { timeout });
  return (await which.jsonValue()) === 'wallet' ? undefined : createWallet(page, timeout);
}
