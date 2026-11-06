// The demo's opening, on the ETHGlobal Mumbai page: only a build made with VITE_DEMO=1
// (npm run demo:on) has this file (site/vite.config.js). At /ethglobal-mumbai?demo=<label>, Play
// reloads the page and scrolls all of it at a steady pace, then hands over to the wallet's autopilot
// (src/demo/autopilot.ts) through this tab's sessionStorage. Esc stops it.

const KEY = 'opaque-demo';
const TOUR = 'opaque-demo-tour';
const SECONDS = 32;
const started = Date.now();
const log = (line) => {
  const s = Math.floor((Date.now() - started) / 1000);
  console.info(`[opaque demo ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}] ${line}`);
};
const read = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* this tab only */ } };

const params = new URLSearchParams(location.search);
const touring = read(TOUR);
if (touring !== null) void tour(touring);
else if (params.has('demo')) offer((params.get('demo') ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '') || `mumbai-${Math.random().toString(16).slice(2, 6)}`);

/** The recording starts first: Play, then the page loads again from the top. */
function offer(label) {
  const d = Object.assign(document.createElement('dialog'), { id: 'demo-start' });
  d.style.cssText = 'border:1px solid #ff6a00;border-radius:16px;background:#0b0b0b;color:#fff;padding:22px 26px;max-width:min(460px,calc(100vw - 32px));font:500 15px/1.5 system-ui,sans-serif';
  d.innerHTML = '<p style="margin:0 0 6px;color:#ff6a00;font-weight:700">Opaque demo</p><p style="margin:0 0 16px"></p><button type="button" style="padding:8px 20px;border-radius:999px;border:0;background:#ff6a00;color:#0b0b0b;font:700 14px system-ui,sans-serif;cursor:pointer">Play</button>';
  d.querySelectorAll('p')[1].textContent = `Start the screen recording, then press Play. This page scrolls to the end, then the wallet takes over and claims ${label}.opaque.eth. Esc stops it.`;
  document.body.append(d);
  d.showModal();
  d.querySelector('button').addEventListener('click', () => {
    write(TOUR, label);
    try { sessionStorage.removeItem('opaque:opening'); } catch { /* it plays anyway */ }
    location.replace(location.pathname);
  });
}

async function tour(label) {
  let stopped = false;
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { stopped = true; try { sessionStorage.removeItem(TOUR); } catch { /* gone */ } } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  log('Front page: the opening');
  // A page whose opening holds it still (the home page's) is waited for.
  while (document.documentElement.classList.contains('is-locked') && !stopped) await wait(200);
  await wait(2_500);
  log('Front page: scrolling to the end');
  const from = scrollY;
  const end = () => document.documentElement.scrollHeight - innerHeight;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      if (stopped) return resolve();
      const t = Math.min(1, (now - t0) / (SECONDS * 1000));
      // Eased at both ends, steady in between.
      const eased = t < 0.08 ? (t / 0.08) ** 2 * 0.04 : t > 0.92 ? 1 - ((1 - t) / 0.08) ** 2 * 0.04 : 0.04 + (t - 0.08) / 0.84 * 0.92;
      scrollTo({ top: from + (end() - from) * eased, behavior: 'instant' });
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  if (stopped) return log('stopped');
  await wait(2_000);
  try { sessionStorage.removeItem(TOUR); } catch { /* gone */ }
  write(KEY, JSON.stringify({ phase: 'aims', label, started: Date.now() }));
  log('Front page: to the wallet');
  location.href = '/sepolia/app';
}
