// The video's demo, played by the site itself in the real wallet (src/demo/boot.ts loads it).
// It types into the pages' own fields and presses their own buttons, with a cursor and a
// caption on screen, and every transaction is real: the Sepolia wallet (made from 12 words,
// funded, the deposit, a private payment, a Uniswap v4 swap, a name claimed and paid at a
// one-time address the wallet finds), the EIP-8141 devnet, the way out with every Opaque
// server down, and the Q-Day simulator last.
//
// Start: /sepolia/app?demo (or ?demo=<label> for <label>.opaque.eth), then Play. Its place is
// kept in this tab, so a reload or a new page carries on from the step it was on; a step that
// fails says why, and a reload tries it again. Esc or Stop ends it. While the chain works, a
// "Waiting · cut" tag marks what to cut in the edit. npm run demo:off deploys the site without it.

import { deployment } from '../../../deployments/index.ts';
import { ETHEREUM_COIN, resolveName } from '../ethereum/ens/ens-name.ts';

const KEY = 'opaque-demo';
const PASSWORD = 'opaque demo password';
type Phase = 'aims' | 'wallet' | 'funds' | 'payment' | 'swap' | 'name' | 'named' | 'paid' | 'devnet' | 'leave' | 'withdraw' | 'protocol' | 'qday' | 'done';
interface State { phase: Phase; label: string; started: number; exitHost?: string; faucet?: boolean; block?: string; note?: string }
const PAGE_OF: Record<Phase, string> = {
  aims: '/sepolia/app', wallet: '/sepolia/app', funds: '/sepolia/app', payment: '/sepolia/app', swap: '/sepolia/app', name: '/sepolia/app', named: '/sepolia/app', paid: '/sepolia/app',
  devnet: '/testnet/devnet', leave: '/sepolia/app', withdraw: '/sepolia/app', protocol: '/sepolia/quantum-safe', qday: '/sepolia/q-day', done: '/sepolia/q-day',
};
const here = (path: string) => location.pathname.replace(/\.html$/, '').endsWith(path);

let state: State | null = null;
try { state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { /* no run */ }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* this tab only */ } };

// ── on screen: a cursor that glides to what it presses, a caption, and the cut tag ─────────
// Manual popovers, raised again before each action, so they sit above an open <dialog>.
const css = `#demo-cursor,#demo-caption,#demo-wait{margin:0;padding:0;border:0;background:none;overflow:visible;inset:auto;color:inherit}
#demo-cursor{position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;transition:transform .65s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
#demo-cursor i{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;border:3px solid #ff6a00;opacity:0}
#demo-cursor.down i{animation:demo-ring .55s ease-out}
@keyframes demo-ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
#demo-caption{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;align-items:center;gap:14px;max-width:min(820px,calc(100vw - 32px));padding:10px 12px 10px 20px;border-radius:999px;background:#0b0b0b;color:#fff;border:1px solid #ff6a00;font:600 15px/1.4 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4)}
#demo-caption b{color:#ff6a00;margin-right:8px}
#demo-caption button{flex:none;padding:6px 14px;border-radius:999px;border:1px solid #ff6a00;background:#ff6a00;color:#0b0b0b;font:700 13px system-ui,sans-serif;cursor:pointer}
#demo-caption button.ghost{background:none;color:#ff6a00}
#demo-wait{position:fixed;top:14px;right:14px;padding:6px 12px;border-radius:6px;background:#ff6a00;color:#0b0b0b;font:700 12px/1.3 system-ui,sans-serif;letter-spacing:.04em;pointer-events:none}`;
const make = (id: string, tag = 'div') => {
  let e = document.getElementById(id);
  if (e === null) {
    e = Object.assign(document.createElement(tag), { id });
    e.setAttribute('popover', 'manual');
    document.body.append(e);
  }
  return e as HTMLElement & { showPopover(): void; hidePopover(): void };
};
function overlay(): void {
  if (document.getElementById('demo-style') === null) document.head.append(Object.assign(document.createElement('style'), { id: 'demo-style', textContent: css }));
  const cursor = make('demo-cursor');
  if (cursor.childElementCount === 0) cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2l17 10.5-7.6 1.4L9 21z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg><i></i>';
  make('demo-caption'); make('demo-wait');
  raise();
}
function raise(): void {
  for (const id of ['demo-cursor', 'demo-caption', 'demo-wait']) {
    const e = document.getElementById(id) as (HTMLElement & { showPopover(): void; hidePopover(): void }) | null;
    if (e === null || (id === 'demo-wait' && e.textContent === '')) continue;
    try { e.hidePopover(); e.showPopover(); } catch { /* not shown */ }
  }
}
let at = { x: innerWidth / 2, y: innerHeight - 120 };
function moveTo(x: number, y: number): void {
  const c = document.getElementById('demo-cursor')!;
  raise();
  c.style.transition = 'none'; c.style.transform = `translate(${at.x}px,${at.y}px)`; void c.offsetWidth;
  c.style.transition = ''; c.style.transform = `translate(${x}px,${y}px)`;
  at = { x, y };
}
function ring(): void { const c = document.getElementById('demo-cursor')!; c.classList.remove('down'); void c.offsetWidth; c.classList.add('down'); }
function caption(step: string, text: string, buttons: [string, () => void, boolean?][] = [['Stop', stop, true]]): void {
  const c = make('demo-caption');
  c.replaceChildren(Object.assign(document.createElement('span'), {}));
  c.firstElementChild!.append(Object.assign(document.createElement('b'), { textContent: step }), text);
  for (const [label, act, ghost] of buttons) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: ghost ? 'ghost' : '' });
    b.addEventListener('click', act);
    c.append(b);
  }
  raise();
}
function waiting(what = ''): void {
  const w = make('demo-wait');
  w.textContent = what === '' ? '' : `Waiting · cut: ${what}`;
  if (what === '') { try { w.hidePopover(); } catch { /* hidden */ } } else raise();
  if (what !== '') log(`  … ${what} (cut)`); else log('  … done');
}
const log = (line: string) => {
  const s = Math.floor((Date.now() - (state?.started ?? Date.now())) / 1000);
  console.info(`[opaque demo ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}] ${line}`);
};
async function say(step: string, text: string): Promise<void> { log(`${step}: ${text}`); caption(step, text); }

// ── acting as a person does ───────────────────────────────────────────────────────────────
const STOP = new Error('stopped');
let stopped = false;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)).then(() => { if (stopped) throw STOP; });
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const shown = (sel: string) => q(sel)?.checkVisibility() === true;
const text = (id: string) => (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
const ready = () => (globalThis as { opaque?: unknown }).opaque !== undefined;
async function until(what: string, test: () => boolean | Promise<boolean>, ms = 600_000, every = 500): Promise<void> {
  for (const end = Date.now() + ms; ; await sleep(every)) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`waited too long for ${what}`);
  }
}
/** Waits, without failing the run if `what` never comes. */
const maybe = (p: Promise<void>) => p.catch((e) => { if (e === STOP) throw e; });

async function point(sel: string): Promise<HTMLElement> {
  await until(`${sel} to show`, () => shown(sel), 180_000);
  const e = q(sel)!;
  e.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(450);
  const b = e.getBoundingClientRect();
  moveTo(b.left + (b.width > 240 ? 36 : b.width / 2), b.top + b.height / 2);
  await sleep(750);
  ring();
  return e;
}
async function press(sel: string): Promise<void> {
  const e = await point(sel) as HTMLButtonElement;
  await until(`${sel} to be ready`, () => !e.disabled, 120_000);
  e.click();
  await sleep(350);
}
async function tick(sel: string): Promise<void> {
  const e = await point(sel) as HTMLInputElement;
  if (!e.checked) e.click();
  await sleep(350);
}
async function type(sel: string, value: string): Promise<void> {
  const e = await point(sel) as HTMLInputElement;
  e.focus();
  const set = (v: string) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  set('');
  for (const ch of value) { set(e.value + ch); await sleep(55); }
  e.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(350);
}
const clear = (id: string) => { const e = document.getElementById(id); if (e !== null) e.textContent = ''; };
/** Waits for status line `id` to match `done`; fails with its words when it matches `failed`. */
async function status(id: string, done: RegExp, failed: RegExp, wait = '', ms = 600_000): Promise<string> {
  if (wait !== '') waiting(wait);
  await until(`#${id}`, () => done.test(text(id)) || failed.test(text(id)), ms);
  if (wait !== '') waiting();
  if (!done.test(text(id))) throw new Error(text(id));
  return text(id);
}
const next = (phase: Phase) => { state!.phase = phase; save(); };
/** Reloads into `phase`: the run goes on from there when the page is back. */
const reloadInto = async (phase: Phase): Promise<never> => { next(phase); location.reload(); return new Promise<never>(() => undefined); };
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const name = () => `${state!.label}.opaque.eth`;
const account = () => text('receive-address').toLowerCase();

/** A private payment from Send. "Not sent" from a mesh that says to try again: pressed again, as a person would (nothing was spent). */
async function pay(to: string, amount: string, wait: string): Promise<void> {
  await press('#tab-send');
  for (let attempt = 1; ; attempt++) {
    await type('#recipient', to);
    if (to.endsWith('.eth')) await sleep(1_500);
    await type('#send-amount', amount);
    clear('send-status');
    await press('#arm');
    try { await status('send-status', /^Sent/, /^(?!Sent|Looking up|\S+ → )\S/, wait); return; } catch (error) {
      waiting();
      if (error === STOP || attempt >= 3 || !/Not sent: (MESH_UNAVAILABLE|.*try again)|has no ENS records|could not look .* up just now/.test((error as Error).message)) throw error;
      log(`${(error as Error).message}: Send again`);
      await sleep(15_000);
    }
  }
}

// ── the steps ─────────────────────────────────────────────────────────────────────────────
const STEPS: Record<Exclude<Phase, 'done'>, () => Promise<void>> = {
  // From the front page (site/tour.js): the wallet held still while the aims are said.
  async aims() {
    await until('the wallet page', () => shown('#terms-continue') || shown('#ob-create') || ready(), 120_000);
    await say('The demo', 'A wallet · a private payment · Uniswap v4 · an ENS name · the EIP-8141 devnet · leaving without Opaque · Q-Day');
    await sleep(12_000);
    next('wallet');
  },

  async wallet() {
    await say('A wallet', '12 words; its FORS+C keys are drawn from them');
    await until('the wallet or its onboarding', () => shown('#terms-continue') || shown('#ob-create') || ready(), 120_000);
    if (shown('#terms-continue')) {
      await tick('#terms-agree');
      await press('#terms-continue');
      await until('onboarding', () => shown('#ob-create') || ready(), 60_000);
    }
    // A browser with a wallet already goes on with that one.
    if (!shown('#ob-create')) return next('funds');
    await press('#ob-create');
    await press('#ob-reveal');
    const words = [...document.querySelectorAll('#ob-words li')].map((li) => li.textContent!.trim());
    await sleep(3_000);
    await tick('#ob-saved');
    await press('#ob-next');
    for (const pos of [...document.querySelectorAll<HTMLInputElement>('#ob-quiz input')].map((i) => i.dataset['pos']!)) await type(`#ob-quiz input[data-pos="${pos}"]`, words[Number(pos)]!);
    await press('#ob-finish');
    await until('the password step', () => shown('#ob-pass') || shown('#ob-passkey-skip') || ready(), 60_000);
    if (shown('#ob-pass')) {
      await type('#ob-pass', PASSWORD);
      await type('#ob-pass2', PASSWORD);
      await press('#ob-pass-go');
    }
    // The page reloads into the wallet from here: the run goes on with the funds.
    next('funds');
    await until('the passkey offer', () => shown('#ob-passkey-skip') || ready(), 60_000);
    if (shown('#ob-passkey-skip')) await press('#ob-passkey-skip');
    await until('the wallet', ready, 180_000);
  },

  async funds() {
    if (!ready()) caption('Opaque', 'Unlock the wallet, and the demo goes on');
    await until('the wallet', ready, 600_000);
    await until('the account\'s address', () => /^0x[0-9a-f]{40}$/.test(account()), 120_000);
    if (shown('#test-faucet')) {
      await say('Funds', 'Test dollars and gas from Opaque\'s faucet');
      clear('deposit-status');
      await press('#test-faucet');
      await status('deposit-status', /^On its way/, /^The faucet said no/, '', 180_000);
      state!.faucet = true; save();
    }
    await say('Deposit', 'One ERC-4337 operation the account\'s FORS+C key signs: deployed, and the tUSDC made private');
    waiting('the deposit');
    await until('the deposit', () => Number(text('balance')) >= (state!.faucet ? 100 : 10), 900_000, 2_000);
    waiting();
    await sleep(3_000);
    next('payment');
  },

  async payment() {
    await until('the wallet', ready, 180_000);
    await say('Private payment', '5 tUSDC, proved in the browser, through three relays');
    await pay(`0x${hex(20)}`, '5', 'the proof and the relays');
    await sleep(2_500);
    await press('#tab-activity');
    await sleep(5_000);
    next('swap');
  },

  async swap() {
    await until('the wallet', ready, 180_000);
    await say('Uniswap v4', 'The post-quantum pool: its hook lets in only accounts that sign with FORS+C');
    await press('#tab-swap');
    await type('#v4-amount', '0.001');
    await until('the quote', () => text('v4-quote').startsWith('≈'), 120_000);
    await sleep(2_000);
    clear('v4-status');
    await press('#v4-go');
    await status('v4-status', /^Swapped/, /^Not swapped/, 'the swap');
    await sleep(3_000);
    next('name');
  },

  async name() {
    await until('the wallet', ready, 180_000);
    await say('A name', `${name()} on ENSv2, claimed with one FORS+C signature`);
    await press('#tab-names');
    await until('Names', () => shown('#sub-claim') || shown('#sub-release'), 120_000);
    if (shown('#sub-claim')) {
      for (let n = 1; ; n++) {
        await type('#sub-label', state!.label);
        clear('sub-status');
        await press('#sub-claim');
        const said = await status('sub-status', /is yours|is taken/, /^(Not done|Use 3 to|Opaque is still)/, 'the claim');
        if (!/is taken/.test(said)) break;
        if (n >= 5) throw new Error(said);
        // Taken, by an earlier take's wallet: the next label, as a person would try one.
        state!.label = `${state!.label.replace(/-\d+$/, '')}-${n + 1}`; save();
        await say('A name', `${name()} on ENSv2, claimed with one FORS+C signature`);
      }
      await sleep(3_000);
    }
    // The name this wallet holds is the one shown and paid, whatever the run asked for.
    const held = text('sub-name').replace(/\.opaque\.eth$/, '');
    if (held !== '' && held !== state!.label) { state!.label = held; save(); }
    waiting('ENS to resolve the name');
    await until(`${name()} to resolve`, async () => (await resolveName(name(), ETHEREUM_COIN).catch(() => undefined))?.address.toLowerCase() === account(), 600_000, 5_000);
    waiting();
    await reloadInto('named');
  },

  async named() {
    await until('the wallet', ready, 180_000);
    await maybe(until('the header to read the name', () => text('account-name') === name(), 120_000));
    await say('A name', `The wallet is called ${name()} now`);
    await sleep(3_500);
    next('paid');
  },

  async paid() {
    await until('the wallet', ready, 180_000);
    await say('Paid by name', `2 tUSDC to ${name()}: the pool pays a one-time address only this wallet can find`);
    await pay(name(), '2', 'the payment');
    await press('#tab-home');
    await say('Found', 'Its ML-KEM-768 key finds the payment; it is swept into the wallet\'s notes');
    await status('stealth-status', /is now in your notes/, /(?!)/, 'the wallet finding it', 900_000);
    await sleep(4_000);
    next('devnet');
  },

  async devnet() {
    await until('the devnet account', () => text('account-short').startsWith('0x'), 180_000);
    await say('EIP-8141', 'A devnet where the account itself is FORS+C only: the same 12 words, a key of its own');
    await sleep(3_000);
    if (shown('#promo-fund-go')) {
      clear('home-status');
      await press('#promo-fund-go');
      await status('home-status', /^Funded/, /^Didn't go through/, 'the devnet faucet', 300_000);
    }
    if (shown('#promo-create-go')) {
      await say('EIP-8141', 'Its factory creates the account: nothing to sign');
      clear('home-status');
      await press('#promo-create-go');
      await status('home-status', /^Created/, /^Didn't go through/, 'the account', 300_000);
    }
    await say('EIP-8141', 'A send: the signature request first, then FORS+C signs; frame 0 verifies it on chain');
    await press('#tab-send');
    await press('#send-asset');
    await press('#asset-eth');
    await type('#recipient', '0x000000000000000000000000000000000000dEaD');
    await type('#send-amount', '0.00001');
    clear('send-status');
    await press('#send-button');
    await until('the signature request', () => q<HTMLDialogElement>('#sign-dialog')?.open === true, 60_000);
    await sleep(3_500);
    await press('#sign-confirm');
    await status('send-status', /^Sent\./, /^Didn't go through/, 'the frame transaction', 300_000);
    await sleep(3_000);
    await say('EIP-8141', 'Uniswap v4 on the devnet, signed with FORS+C alone');
    await press('#tab-swap');
    await type('#swap-amount', '0.0001');
    await until('the quote', () => Number(text('swap-out')) > 0, 60_000);
    await sleep(1_500);
    clear('swap-status');
    await press('#swap-go');
    await until('the signature request', () => q<HTMLDialogElement>('#sign-dialog')?.open === true, 60_000);
    await sleep(2_500);
    await press('#sign-confirm');
    await status('swap-status', /^Swapped on Uniswap v4/, /^Didn't go through/, 'the swap', 300_000);
    await sleep(4_000);
    next('leave');
  },

  async leave() {
    // Opaque's servers refused from the page's first request: boot.ts, on the next load.
    if (state!.block === undefined) { state!.block = state!.exitHost!; await reloadInto('leave'); }
    await say('Without Opaque', 'Every Opaque server down: the wallet offers the way out');
    await until('the way out', () => shown('#exit-card'), 180_000);
    await sleep(3_000);
    await say('Without Opaque', 'The notes, read from the chain through anon-rpc, EF\'s mixnet');
    await press('#exit-find');
    waiting('anon-rpc');
    await until('the notes', () => document.querySelectorAll('#exit-notes .exit-row').length > 0 || /^(No notes|Could not)/.test(text('exit-status')), 300_000);
    waiting();
    const note = q('#exit-notes .exit-row button')?.dataset['note'];
    if (note === undefined) throw new Error(`no notes to take out: ${text('exit-status')}`);
    state!.note = note; save();
    await sleep(2_000);
    clear('exit-status');
    await press(`#exit-notes button[data-note="${note}"]`);
    await status('exit-status', /^Exit announced/, /^Not done/, 'the announcement', 300_000);
    await say('Without Opaque', 'Announced on chain; the pool waits five minutes, then pays');
    await sleep(4_000);
    next('withdraw');
  },

  async withdraw() {
    const payable = `#exit-notes button.primary[data-note="${state!.note}"]`;
    // While the delay runs, the note's row counts down and its Withdraw button appears by itself;
    // only after a reload, when the list is empty, are the notes found again.
    if (document.querySelectorAll('#exit-notes .exit-row').length === 0) {
      await until('the way out', () => shown('#exit-card'), 180_000);
      await press('#exit-find');
    }
    await say('Without Opaque', 'The delay is over: withdrawn through a public bundler, with no Opaque server');
    waiting('the pool\'s five-minute delay');
    await until('the delay', () => shown(payable), 900_000, 2_000);
    waiting();
    clear('exit-status');
    await press(payable);
    await status('exit-status', /^Withdrawn/, /^Not done/, 'the withdrawal', 300_000);
    await sleep(4_000);
    delete state!.block;
    next('protocol');
  },

  // Any protocol, from MetaMask: the page asks MetaMask for every transaction, and the person
  // recording approves each one there; those waits are marked to cut.
  async protocol() {
    const metamask = 'your approval in MetaMask, then the chain';
    await say('Any protocol', 'From MetaMask: deploy a protocol, find its admin keys, hand them to a FORS+C key');
    clear('connect-status');
    await press('#connect');
    await status('connect-status', /^Connected/, /^(Not connected|No browser wallet|The quantum-safe admin is not)/, metamask, 300_000);
    await sleep(2_000);
    // A MetaMask account registers one guard key, once: a new one here, or the words this browser kept.
    await until('the guard key', () => shown('#key-new') || !q('#s-contract')!.classList.contains('locked') || /different key/.test(text('key-reg')), 120_000);
    if (/different key/.test(text('key-reg'))) throw new Error('this MetaMask account registered a guard key whose 12 words this browser does not have: switch MetaMask to a fresh account, or enter its words, then reload');
    if (shown('#key-new')) {
      await say('Any protocol', 'A guard key from 12 words, registered from MetaMask');
      await press('#key-new');
      await until('the 12 words', () => document.querySelectorAll('#words li').length === 12, 60_000);
      await sleep(3_000);
      clear('key-status');
      await press('#key-register');
      await status('key-status', /^Registered/, /^Not registered/, metamask, 600_000);
      await until('the contract step', () => !q('#s-contract')!.classList.contains('locked'), 120_000);
    }
    await say('Any protocol', 'A protocol deployed from MetaMask: its owner and proxy admin are one ECDSA key');
    clear('c-status');
    await press('#demo-make');
    waiting(metamask);
    await until('the protocol and its admin keys', () => document.querySelectorAll('#c-keys li.yours').length >= 2 || /^(No demo|There is no contract)/.test(text('c-status')), 600_000, 1_000);
    waiting();
    if (document.querySelectorAll('#c-keys li.yours').length < 2) throw new Error(text('c-status'));
    await sleep(4_000);
    await say('Any protocol', 'One button: every admin key handed to PQAdmin, which acts only on a FORS+C signature');
    clear('go-status');
    await press('#go');
    await status('go-status', /^Quantum-safe/, /^(Not handed|Handed over all but)/, metamask, 900_000);
    await sleep(3_000);
    await say('Any protocol', 'The cracked ECDSA key tries to take it back: refused');
    clear('attack-status');
    await press('#attack-go');
    await status('attack-status', /^Refused/, /^The chain would/, '', 120_000);
    await sleep(3_000);
    await say('Any protocol', 'A fee change, signed by the guard key alone');
    await type('#fee', '42');
    clear('act-status');
    await press('#fee-go');
    await status('act-status', /^Done/, /^(Not done|Enter a whole)/, metamask, 600_000);
    await sleep(4_000);
    next('qday');
  },

  async qday() {
    const setUp = () => document.getElementById('st-stealth')?.dataset['state'] === 'done';
    // A run of the simulator from before: a new victim first.
    if (!q('#score')!.hidden) { await press('#again'); return new Promise<never>(() => undefined); }
    await say('Q-Day', 'A wallet with money, a protocol, a vault and stealth payments');
    if (!setUp()) {
      if (!q<HTMLButtonElement>('#setup')!.disabled) await press('#setup');
      waiting('the victim\'s setup');
      await until('the victim', () => setUp() || /^Setup stopped/.test(text('setup-status')), 900_000, 2_000);
      waiting();
      if (!setUp()) throw new Error(text('setup-status'));
    }
    await sleep(3_000);
    await say('Q-Day', 'Shor\'s algorithm, played: the private key from the public key');
    await press('#qday');
    await until('the attacks', () => !q('#score')!.hidden || /^Stopped/.test(text('qday-status')), 900_000);
    if (q('#score')!.hidden) throw new Error(text('qday-status'));
    await say('Q-Day', 'What ECDSA guarded is taken; what FORS+C guards, the chain refuses');
    q('#score')!.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(6_000);
    await say('Q-Day', 'The owner moves it all with the FORS+C key alone');
    clear('rescue-status');
    await press('#rescue');
    await status('rescue-status', /^Done/, /^Stopped/, 'the rescue');
    await sleep(5_000);
    next('done');
  },
};

function stop(): void {
  if (state === null) return;
  const blocked = state.block !== undefined;
  stopped = true;
  state = null;
  try { sessionStorage.removeItem(KEY); } catch { /* gone with the tab */ }
  waiting();
  log('stopped');
  for (const id of ['demo-cursor', 'demo-caption', 'demo-wait']) document.getElementById(id)?.remove();
  // The servers come back with the page.
  if (blocked) location.reload();
}

async function run(): Promise<void> {
  addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
  overlay();
  // Set on the Sepolia pages, where the deployment is Sepolia's: a run from the front page arrives without it.
  if (state !== null && state.exitHost === undefined && here('/sepolia/app')) { state.exitHost = new URL(deployment.services.meshExitUrl ?? location.origin).host; save(); }
  try {
    while (state !== null && state.phase !== 'done') {
      const page = PAGE_OF[state.phase];
      if (!here(page)) { location.href = `${location.origin}${page}`; return; }
      await STEPS[state.phase as Exclude<Phase, 'done'>]();
    }
    if (state === null) return;
    log('the demo is done');
    caption('Opaque', 'Every step of this demo was a real transaction.', [['Close', stop]]);
    sessionStorage.removeItem(KEY);
  } catch (error) {
    if (error === STOP) return;
    waiting();
    log(`stopped at ${state?.phase}: ${(error as Error).message}`);
    caption('Stopped', `${(error as Error).message.split('\n')[0]}. Reload to try this step again.`, [['Stop', stop, true]]);
  }
}

if (state !== null) void run();
else if (here('/sepolia/app') && new URLSearchParams(location.search).has('demo')) {
  // The recording starts first; Play is pressed by hand. A modal of its own, kept above any the
  // page opens (the wallet's Terms come up first on a fresh browser), or the click could not reach it.
  const label = (new URLSearchParams(location.search).get('demo') ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '') || `mumbai-${hex(2)}`;
  overlay();
  const start = Object.assign(document.createElement('dialog'), { id: 'demo-start' });
  start.style.cssText = 'border:1px solid #ff6a00;border-radius:16px;background:#0b0b0b;color:#fff;padding:22px 26px;max-width:min(460px,calc(100vw - 32px));font:500 15px/1.5 system-ui,sans-serif';
  start.innerHTML = '<p style="margin:0 0 6px;color:#ff6a00;font-weight:700">Opaque demo</p><p style="margin:0 0 16px"></p><button type="button" style="padding:8px 20px;border-radius:999px;border:0;background:#ff6a00;color:#0b0b0b;font:700 14px system-ui,sans-serif;cursor:pointer">Play</button>';
  start.querySelectorAll('p')[1]!.textContent = `Start the screen recording, then press Play. It makes a new wallet and claims ${label}.opaque.eth; Esc stops it at any point.`;
  document.body.append(start);
  start.showModal();
  const onTop = new MutationObserver((changes) => {
    if (changes.some((c) => c.target !== start && (c.target as HTMLDialogElement).open)) { start.close(); start.showModal(); }
  });
  onTop.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  start.querySelector('button')!.addEventListener('click', () => {
    onTop.disconnect();
    start.close();
    start.remove();
    state = { phase: 'wallet', label, started: Date.now(), exitHost: new URL(deployment.services.meshExitUrl ?? location.origin).host };
    save();
    history.replaceState(null, '', location.pathname);
    void run();
  });
}
