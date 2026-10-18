// The page's motion: the hero ring that leans toward you, the story the scroll
// plays on one sticky ring, reveals, counters, and a still version for anyone
// whose system asks for reduced motion.

import { THEMES, blendTheme, createRing, rgba } from './ring.js';

// index.html's head marks the page `js` (and `reduced`) before anything paints.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const range = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
const ease = (t) => 1 - (1 - t) ** 3;
const narrow = matchMedia('(max-width: 760px)');

/** Runs a ring only while its canvas is on screen. */
const whileVisible = (canvas, ring) => new IntersectionObserver(([e]) => (e.isIntersecting ? ring.start() : ring.stop())).observe(canvas);

/** A ring that leans toward the pointer anywhere over `area`. */
function leaning(canvas, area, size, dot, onDraw) {
  const ring = createRing(canvas, { reduced, size, dot, follow: true, onDraw });
  ring.set('idle');
  whileVisible(canvas, ring);
  area.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); ring.setPointer({ x: e.clientX - r.left, y: e.clientY - r.top }); });
  area.addEventListener('pointerleave', () => ring.setPointer(null));
  return ring;
}
const heroEl = $('.hero');

// ── the ledger behind the hero: public lines everywhere, blacked out inside the ring ──
// Made-up XRPL activity: nothing is fetched, so the page tells no ledger server who is looking.
const ledgerCanvas = $('.hero__ledger');
const lx = ledgerCanvas.getContext('2d');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FONT = '12.5px ui-monospace, SFMono-Regular, Menlo, monospace';
let seed = 20261018, ledgerIndex = 4812207;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chars = (n) => Array.from({ length: n }, () => pick(B58)).join('');
const addr = () => `r${chars(3)}…${chars(4)}`;
const amount = () => (rnd() < 0.5 ? (rnd() * 900 + 1).toFixed(2) : String(Math.ceil(rnd() * 40) * 25));
function record() {
  if (rnd() < 0.25) ledgerIndex += 1;
  const k = rnd();
  const [type, detail] = k < 0.55 ? ['Payment', `${addr()} → ${addr()}  ${amount()} ${pick(['XRP', 'XRP', 'RLUSD', 'USDC'])}`]
    : k < 0.75 ? ['OfferCreate', `${addr()}  ${amount()} ${pick(['XRP', 'RLUSD'])} for ${pick(['USDC', 'RLUSD', 'XRP'])}`]
    : k < 0.9 ? ['TrustSet', `${addr()}  ${pick(['RLUSD', 'USDC'])} limit ${pick(['5000', '250000', '1000000'])}`]
    : ['NFTokenMint', `${addr()}  taxon ${Math.floor(rnd() * 90)}`];
  return `${ledgerIndex.toLocaleString('en-US')}  ${type.padEnd(11)}  ${detail.padEnd(46)}  tesSUCCESS`;
}
function ledgerRow(cols) {
  let text = '';
  while (text.length < cols) text += (text ? '      ' : '') + record();
  return { text, words: [...text.matchAll(/\S+/g)].map((m) => [m.index, m[0].length]) };
}
const ledger = { rows: [], cols: 0, offset: 0, last: 0, W: 0, H: 0, cw: 7.5, lh: 22, fade: null };
function drawLedger({ dots, dotSize }) {
  // The lens is the ring as drawn this frame: through the opening, its lean and its glide aside.
  let x = 0, y = 0, r = 0;
  for (const d of dots) { x += d.x; y += d.y; }
  x /= dots.length; y /= dots.length;
  for (const d of dots) r += Math.hypot(d.x - x, d.y - y);
  r = r / dots.length + dotSize;

  const W = heroEl.clientWidth, H = heroEl.clientHeight;
  if (W !== ledger.W || H !== ledger.H) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    ledgerCanvas.width = Math.round(W * dpr); ledgerCanvas.height = Math.round(H * dpr);
    lx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lx.font = FONT;
    const cw = lx.measureText('0').width, cols = Math.ceil(W / cw) + 4;
    // Clear behind the headline, plain toward the ring.
    const fade = narrow.matches ? lx.createLinearGradient(0, 0, 0, H) : lx.createLinearGradient(0, 0, W, 0);
    for (const [at, a] of narrow.matches ? [[0, 0.13], [0.22, 0.13], [0.42, 0]] : [[0, 0], [0.42, 0], [0.66, 0.14], [1, 0.14]]) fade.addColorStop(at, `rgba(244, 239, 233, ${a})`);
    Object.assign(ledger, { W, H, cw, cols, fade, rows: Array.from({ length: Math.ceil(H / ledger.lh) + 2 }, () => ledgerRow(cols)) });
  }
  const now = performance.now() / 1000;
  if (!reduced && ledger.last) ledger.offset += 16 * Math.min(0.05, now - ledger.last);
  ledger.last = now;
  while (ledger.offset >= ledger.lh) { ledger.offset -= ledger.lh; ledger.rows.shift(); ledger.rows.push(ledgerRow(ledger.cols)); }

  const { lh, cw, rows } = ledger, top = lh / 2 - ledger.offset;
  lx.clearRect(0, 0, W, H);
  lx.font = FONT; lx.textBaseline = 'middle';
  // Outside the ring, the public ledger.
  lx.save();
  lx.beginPath(); lx.rect(0, 0, W, H); lx.arc(x, y, r, 0, Math.PI * 2); lx.clip('evenodd');
  lx.fillStyle = ledger.fade;
  rows.forEach((row, i) => lx.fillText(row.text, 0, top + i * lh));
  lx.restore();
  // Inside it, every word is blacked out.
  lx.save();
  lx.beginPath(); lx.arc(x, y, r, 0, Math.PI * 2); lx.clip();
  lx.fillStyle = 'rgba(255, 122, 24, 0.17)';
  rows.forEach((row, i) => {
    const ry = top + i * lh;
    if (Math.abs(ry - y) > r + lh) return;
    for (const [s, n] of row.words) if (s * cw < x + r && (s + n) * cw > x - r) lx.fillRect(s * cw, ry - 5, n * cw - 2, 10);
  });
  lx.restore();
}
const hero = leaning($('.hero__ring'), heroEl, 0.27, 0.13, drawLedger);
leaning($('.final__ring'), $('.final'), 0.34, 0.12);

// ── the opening: a big ring, the words inside it, then the ring steps aside ──
const BIG = { x: 0.5, y: 0.5, size: 0.42, dot: 1.6 };
const settled = () => (narrow.matches ? { x: 0.78, y: 0.15, size: 0.25, dot: 1 } : { x: 0.75, y: 0.5, size: 0.27, dot: 1 });
// The page holds still while the opening plays; Esc, or a link in the nav, ends it early.
const hold = (e) => e.preventDefault();
function lockScroll(on) {
  document.documentElement.classList.toggle('is-locked', on);
  for (const type of ['wheel', 'touchmove']) (on ? addEventListener : removeEventListener)(type, hold, { passive: false });
}
async function opening() {
  const title = $('.hero__title');
  let done = false;
  const onKey = (e) => { if (e.key === 'Escape') finish(); };
  const onClick = (e) => { if (e.target.closest('a')) finish(); };
  const finish = () => {
    if (done) return;
    done = true;
    removeEventListener('keydown', onKey);
    removeEventListener('click', onClick, true);
    lockScroll(false);
    hero.place(settled());
    title.style.transform = '';
    heroEl.classList.add('show-title', 'show-rest');
    hero.setFollow(true);
    narrow.addEventListener('change', () => hero.place(settled()));

  };
  // Straight to the end for reduced motion, or a link to a section further down.
  if (reduced || location.hash) { hero.place(settled(), { instant: true }); finish(); return; }
  history.scrollRestoration = 'manual';
  scrollTo(0, 0);
  lockScroll(true);
  hero.setFollow(false);
  hero.place(BIG, { instant: true });
  hero.bloom();
  addEventListener('keydown', onKey);
  addEventListener('click', onClick, true);

  await wait(1000);
  await Promise.race([document.fonts.ready, wait(800)]);
  if (done) return;
  // The headline, smaller, centred in the ring: measured where it will end, moved to the middle.
  const r = title.getBoundingClientRect(), h = heroEl.getBoundingClientRect();
  const ring = 2 * BIG.size * Math.min(h.width, h.height);
  const scale = Math.min(1, (ring * 0.62) / r.width);
  title.style.transform = `translate(${h.left + h.width / 2 - (r.left + r.width / 2)}px, ${h.top + h.height / 2 - (r.top + r.height / 2)}px) scale(${scale})`;
  heroEl.classList.add('show-title');

  await wait(1500);
  if (done) return;
  title.style.transition = 'transform 1.2s cubic-bezier(0.65, 0, 0.35, 1)';
  title.style.transform = '';
  hero.place(settled());
  await wait(500);
  heroEl.classList.add('show-rest');
  await wait(900);
  finish();
}
void opening();

// ── the story ─────────────────────────────────────────────────────────────
const SCENES = ['deposit', 'hide', 'relays', 'paid', 'apps'];
const LOOK = ['dark', 'cream', 'dark', 'dark', 'orange'];
const STILL = [0.45, 0.15, 0.5, 0.35, 0.85]; // the most telling moment of each, for the still version
const story = $('.story');
const stage = $('.story__stage');
const steps = [...document.querySelectorAll('.step')];
const rail = [...document.querySelectorAll('.rail li')];

if (reduced) {
  // No pinning: each scene is its own block with the ring stopped at its key moment.
  const stills = steps.map((step, i) => {
    const theme = THEMES[LOOK[i]];
    step.style.setProperty('--step-bg', rgba(theme.bg));
    step.style.setProperty('--step-fg', rgba(theme.fg));
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    step.append(canvas);
    const ring = createRing(canvas, { reduced: true, size: 0.3 });
    ring.setTheme(theme);
    ring.set(SCENES[i], STILL[i]);
    return () => ring.set(SCENES[i], STILL[i]);
  });
  // Canvas labels use the web fonts; draw again once they are in.
  void document.fonts.ready.then(() => stills.forEach((redraw) => redraw()));
} else {
  const ring = createRing($('.story__ring'), { size: 0.3 });
  whileVisible($('.story__ring'), ring);
  let shown = -1;
  const update = () => {
    const box = story.getBoundingClientRect();
    const progress = clamp(-box.top / (box.height - innerHeight), 0, 1);
    const x = Math.min(progress * SCENES.length, SCENES.length - 1e-4);
    const i = Math.floor(x), p = x - i;
    ring.set(SCENES[i], p);
    // Each scene's colours arrive over its first stretch of scroll.
    const theme = blendTheme(THEMES[LOOK[Math.max(0, i - 1)]], THEMES[LOOK[i]], i === 0 ? 1 : Math.min(1, p / 0.12));
    ring.setTheme(theme);
    stage.style.setProperty('--stage-bg', rgba(theme.bg));
    stage.style.setProperty('--stage-fg', rgba(theme.fg));
    stage.style.setProperty('--stage-muted', rgba(theme.muted));
    stage.style.setProperty('--stage-line', rgba(theme.line));
    if (i !== shown) { steps.forEach((s, n) => s.classList.toggle('is-active', n === i)); shown = i; }
    rail.forEach((li, n) => li.style.setProperty('--fill', String(n < i ? 1 : n === i ? p : 0)));
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

// ── small rings of eight: the phone's button, a tile, the note, the cards ──
const dots = (fill) => `<svg viewBox="0 0 40 40" aria-hidden="true">${Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4 - Math.PI / 2;
  return `<circle cx="${(20 + 13 * Math.cos(a)).toFixed(2)}" cy="${(20 + 13 * Math.sin(a)).toFixed(2)}" r="3.6" fill="${fill}"/>`;
}).join('')}</svg>`;
for (const el of document.querySelectorAll('[data-dots]')) el.innerHTML = dots(el.dataset.dots);

// ── the updates bell: its dot shows until the newest update is opened once in this browser ──
const LATEST = '2026-10-18';
const seen = () => { try { return localStorage.getItem('opaque:updates-seen') === LATEST; } catch { return false; } };
if (seen()) $('.bell').classList.add('is-read');
$('#updates').addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  $('.bell').classList.add('is-read');
  try { localStorage.setItem('opaque:updates-seen', LATEST); } catch {}
});
// A code that keeps its three corners and flickers everywhere else; the middle is the ring's note.
$('.tile__qr').innerHTML = Array.from({ length: 49 }, (_, i) => {
  const x = i % 7, y = Math.floor(i / 7);
  const corner = (x < 2 || x > 4) && (y < 2 || y > 4) && !(x > 4 && y > 4);
  const kind = x === 3 && y === 3 ? 'mid' : corner ? 'on fix' : (x * 5 + y * 3 + x * y) % 4 === 0 ? 'on' : '';
  return `<i class="${kind}" style="--k: ${(x * 3 + y * 5) % 7}"></i>`;
}).join('');
// Each row twice over, so sliding it by half loops without a seam.
for (const row of document.querySelectorAll('.flow__row')) row.append(...[...row.children].map((c) => c.cloneNode(true)));

// ── the wallet tour: the phone, its outline behind the headline, then the tiles ──
const tour = $('.tour');
const phone = tour.querySelector('.phone');
const tiles = [...tour.querySelectorAll('.tile')];
const pinTour = matchMedia('(min-width: 861px)');
const showcase = phone.cloneNode(true);
showcase.querySelector('.screen--send').remove();
$('.final__phone').append(showcase);

function tourFrame() {
  if (reduced || !pinTour.matches) return;
  const box = tour.getBoundingClientRect();
  const p = clamp(-box.top / (box.height - innerHeight), 0, 1);
  const set = (k, v) => tour.style.setProperty(k, v.toFixed(3));
  const grow = range(p, 0.24, 0.4), gone = range(p, 0.48, 0.58);
  set('--list', range(p, 0.04, 0.2));
  set('--veil', range(p, 0.2, 0.32) * (1 - range(p, 0.54, 0.64)));
  set('--show', grow * (1 - gone));
  set('--grow', ease(grow) + gone * 0.5);
  tiles.forEach((t, i) => t.style.setProperty('--in', ease(range(p, 0.6 + i * 0.05, 0.78 + i * 0.05)).toFixed(3)));
  phone.dataset.screen = p < 0.5 ? 'home' : p < 0.92 ? 'send' : 'sent';
}
pinTour.addEventListener('change', () => {
  tour.removeAttribute('style');
  tiles.forEach((t) => t.removeAttribute('style'));
  tourFrame();
});
// Unpinned, on a phone, the screens take turns on their own.
let beat = 0;
if (!reduced) setInterval(() => { if (!pinTour.matches) phone.dataset.screen = ['home', 'send', 'sent'][(beat = (beat + 1) % 3)]; }, 2600);

// The note and the phone in the last banner drift against the scroll.
const panel = $('.final__panel');
const drift = () => {
  const r = panel.getBoundingClientRect();
  panel.style.setProperty('--t', clamp((innerHeight / 2 - (r.top + r.height / 2)) / innerHeight, -1, 1).toFixed(3));
};
if (!reduced) {
  const onScroll = () => { tourFrame(); drift(); };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  onScroll();
}

// ── the nav's menus: hover or click opens one panel; Esc, or a click away, closes ──
const nav = $('#nav');
const triggers = [...nav.querySelectorAll('.menu__trigger')];
const panelOf = (t) => document.getElementById(t.getAttribute('aria-controls'));
const hoverable = matchMedia('(hover: hover) and (min-width: 861px)');
let closing = 0;
function openMenu(trigger) {
  clearTimeout(closing);
  for (const t of triggers) {
    const on = t === trigger;
    t.setAttribute('aria-expanded', String(on));
    panelOf(t).toggleAttribute('data-open', on);
  }
}
const closeSoon = () => { closing = setTimeout(() => openMenu(null), 180); };
for (const t of triggers) {
  t.addEventListener('click', () => openMenu(t.getAttribute('aria-expanded') === 'true' ? null : t));
  t.addEventListener('pointerenter', () => { if (hoverable.matches) openMenu(t); });
  t.addEventListener('pointerleave', () => { if (hoverable.matches) closeSoon(); });
  const panel = panelOf(t);
  panel.addEventListener('pointerenter', () => clearTimeout(closing));
  panel.addEventListener('pointerleave', () => { if (hoverable.matches) closeSoon(); });
  panel.querySelectorAll('.menu__link, .menu__card').forEach((a, i) => a.style.setProperty('--i', String(i)));
}
const toggle = $('.menu__toggle');
const setSheet = (on) => { nav.toggleAttribute('data-sheet', on); toggle.setAttribute('aria-expanded', String(on)); };
toggle.addEventListener('click', () => setSheet(!nav.hasAttribute('data-sheet')));
nav.addEventListener('click', (e) => { if (e.target.closest('.menu__sheet a')) { openMenu(null); setSheet(false); } });
document.addEventListener('click', (e) => { if (!nav.contains(e.target)) { openMenu(null); setSheet(false); } });
// In-page links scroll without leaving a #fragment in the address bar. The skip
// link keeps the browser's own jump, which also moves keyboard focus.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]:not(.skip)');
  const id = a?.getAttribute('href').slice(1);
  const target = id === 'top' ? document.documentElement : id && document.getElementById(id);
  if (!target) return;
  e.preventDefault();
  if (id === 'top') scrollTo(0, 0); else target.scrollIntoView();
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = triggers.find((t) => t.getAttribute('aria-expanded') === 'true');
  openMenu(null); setSheet(false);
  open?.focus();
});

// ── small rings for the connect cards ─────────────────────────────────────
function miniRing(kind) {
  const dots = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    return { x: 44 + 28 * Math.cos(a), y: 44 + 28 * Math.sin(a), lead: i === 0 };
  });
  const parts = dots.map((d) => `<circle cx="${d.x.toFixed(2)}" cy="${d.y.toFixed(2)}" r="${d.lead && kind !== 'qr' ? 6 : 4.5}" fill="#ff7a18" opacity="${d.lead || kind === 'qr' ? 1 : 0.55}"/>`);
  const lead = dots[0];
  if (kind === 'popup') parts.push(`<circle cx="${lead.x}" cy="${lead.y}" r="11" fill="none" stroke="#f4efe9" stroke-width="1.5"/>`);
  if (kind === 'extension') for (const r of [11, 16]) parts.push(`<circle cx="${lead.x}" cy="${lead.y}" r="${r}" fill="none" stroke="#ffa052" stroke-width="1.25" opacity="${r === 11 ? 0.8 : 0.45}"/>`);
  if (kind === 'qr') parts.push('<path d="M4 18V4h14M70 4h14v14M84 70v14H70M18 84H4V70" fill="none" stroke="#f4efe9" stroke-width="2" stroke-linecap="round"/>');
  return `<svg viewBox="0 0 88 88" aria-hidden="true">${parts.join('')}</svg>`;
}
for (const icon of document.querySelectorAll('[data-ring]')) icon.innerHTML = miniRing(icon.dataset.ring);

// ── reveals and counters ──────────────────────────────────────────────────
function count(el) {
  const to = Number(el.dataset.count), from = Number(el.dataset.from ?? 0);
  if (reduced || from === to) return;
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / 1100);
    el.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(tick);
  };
  el.textContent = String(from);
  requestAnimationFrame(tick);
}
const reveal = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('is-in');
    e.target.querySelectorAll('[data-count]').forEach(count);
    reveal.unobserve(e.target);
  }
}, { threshold: 0.2 });
document.querySelectorAll('[data-reveal]').forEach((el) => reveal.observe(el));
