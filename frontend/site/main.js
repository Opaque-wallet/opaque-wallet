// The page's motion: the hero ring that leans toward you, the story the scroll
// plays on one sticky ring, reveals, counters, and a still version for anyone
// whose system asks for reduced motion.

import { THEMES, blendTheme, createRing, rgba } from './ring.js';

// index.html's head marks the page `js` (and `reduced`) before anything paints.
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a ring only while its canvas is on screen. */
const whileVisible = (canvas, ring) => new IntersectionObserver(([e]) => (e.isIntersecting ? ring.start() : ring.stop())).observe(canvas);

/** A ring that leans toward the pointer anywhere over `area`. */
function leaning(canvas, area, size, dot) {
  const ring = createRing(canvas, { reduced, size, dot, follow: true });
  ring.set('idle');
  whileVisible(canvas, ring);
  area.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); ring.setPointer({ x: e.clientX - r.left, y: e.clientY - r.top }); });
  area.addEventListener('pointerleave', () => ring.setPointer(null));
  return ring;
}
const heroEl = $('.hero');
const hero = leaning($('.hero__ring'), heroEl, 0.27, 0.13);
leaning($('.final__ring'), $('.final'), 0.34, 0.12);

// ── the opening: a big ring, the words inside it, then the ring steps aside ──
const narrow = matchMedia('(max-width: 760px)');
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
