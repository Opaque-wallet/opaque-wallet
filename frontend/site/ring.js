// The ring of eight on a canvas. Eight notes of the same size that turn, lean
// toward the cursor, and act out a payment as a scene's progress runs 0 → 1:
//
//   idle     turning, a pulse chasing round
//   deposit  a note drops into the empty slot
//   hide     one note is marked yours, then all eight shuffle
//   relays   it leaves in three layers and loses one at each relay
//   paid     it lands on a fresh address; a new note takes its place
//   apps     three notes become three apps' accounts, unlinked
//
// Scenes join end to end, so scrolling through them in order is continuous.
// Positions ease toward their targets on a spring: a jump in scroll still moves.

const TAU = Math.PI * 2;
const N = 8;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const range = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// Colours as [r, g, b, a], so a scene change can blend them.
export const THEMES = {
  dark: { bg: [7, 6, 8, 1], fg: [244, 239, 233, 1], muted: [170, 161, 155, 1], dot: [255, 122, 24, 1], glow: [255, 122, 24, 1], line: [244, 239, 233, 0.16], card: [21, 17, 23, 1] },
  cream: { bg: [244, 239, 233, 1], fg: [7, 6, 8, 1], muted: [92, 83, 77, 1], dot: [255, 122, 24, 1], glow: [255, 122, 24, 0], line: [7, 6, 8, 0.16], card: [233, 225, 216, 1] },
  orange: { bg: [255, 122, 24, 1], fg: [7, 6, 8, 1], muted: [7, 6, 8, 0.7], dot: [7, 6, 8, 1], glow: [7, 6, 8, 0], line: [7, 6, 8, 0.24], card: [7, 6, 8, 0.08] },
};
export const blendTheme = (a, b, t) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k].map((v, i) => lerp(v, b[k][i], t))]));
export const rgba = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a.toFixed(3)})`;

// Where each note ends up after the shuffle (one full extra turn keeps slots aligned).
const SHUFFLE = [3, 6, 0, 5, 7, 2, 4, 1];
const MINE = 0;        // the note dropped in and marked yours
const TRAVELLER = 0;   // the note that pays (it is yours)
const APP_NOTES = [1, 4, 6];
const APPS = [
  { angle: -2.45, name: 'DEX', addr: 'rGEU…' },
  { angle: -0.7, name: 'NFT market', addr: 'rUvv…' },
  { angle: 1.57, name: 'Game', addr: 'rP3k…' },
];

/** size: the ring's radius as a share of the canvas's shorter side; dot: a note's diameter as a share of that radius.
 *  onDraw, if given, hears where every note is after each frame. */
export function createRing(canvas, { reduced = false, size = 0.3, dot = 0.11, follow = false, onDraw = null } = {}) {
  const ctx = canvas.getContext('2d');
  const dots = Array.from({ length: N }, () => ({ x: 0, y: 0, s: 1, a: 1, g: 1, hl: 0, layers: 0, sq: 0, z: 0 }));
  const state = { scene: 'idle', p: 0, rot: 0, last: 0, pointer: null, theme: THEMES.dark, ready: false, running: false, frame: 0, followOn: follow, bloom: false };
  // Where the ring sits (fractions of the canvas) and how big its notes are; `cur` glides toward `place`.
  const place = { x: 0.5, y: 0.5, size, dot: 1 };
  const cur = { ...place };
  const speed = reduced ? 0 : 0.24; // radians a second
  let W = 0, H = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!state.running) renderStill();
  }

  // A circle tilted in 3D, in perspective: nearer notes larger and brighter.
  function project(cx, cy, R, ang, ax, ay) {
    const px = R * Math.cos(ang), py = R * Math.sin(ang);
    const y1 = py * Math.cos(ax), z1 = py * Math.sin(ax);
    const x2 = px * Math.cos(ay) + z1 * Math.sin(ay), z2 = -px * Math.sin(ay) + z1 * Math.cos(ay);
    const p = 800 / (800 + z2);
    return { x: cx + x2 * p, y: cy + y1 * p, p, z: z2 };
  }
  const geo = () => ({ cx: W * cur.x, cy: H * cur.y, R: Math.min(W, H) * cur.size, wide: W >= H * 1.1 });
  const slotAngle = (slot, extra = 0) => state.rot + extra + slot * TAU / N - TAU / 4;

  function ring({ cx, cy, R, now, ax = 0, ay = 0, pulse = !reduced, angleOf }) {
    return dots.map((_, i) => {
      const q = project(cx, cy, R, angleOf(i), ax, ay);
      const beat = pulse ? 0.22 * Math.max(0, Math.sin(now * 2 - i * TAU / N)) ** 2 : 0;
      return { x: q.x, y: q.y, s: q.p * (1 + beat), a: clamp(0.62 + 0.38 * q.p, 0, 1), g: 1 + beat * 2.5, hl: 0, layers: 0, sq: 0, z: q.z };
    });
  }
  const bez = (A, C, B, t) => ({ x: (1 - t) ** 2 * A.x + 2 * (1 - t) * t * C.x + t ** 2 * B.x, y: (1 - t) ** 2 * A.y + 2 * (1 - t) * t * C.y + t ** 2 * B.y });
  const arc = (A, B) => ({ x: (A.x + B.x) / 2, y: Math.min(A.y, B.y) - Math.min(W, H) * 0.12 });

  // The relays, the fresh address and the apps, in this canvas's own space.
  function stops(g) {
    const relays = (g.wide ? [[0.52, 0.34], [0.68, 0.62], [0.82, 0.36]] : [[0.22, 0.58], [0.74, 0.66], [0.3, 0.8]]).map(([x, y]) => ({ x: W * x, y: H * y }));
    const dest = g.wide ? { x: W * 0.9, y: H * 0.64 } : { x: W * 0.76, y: H * 0.9 };
    const side = g.wide ? { x: W * 0.24, y: H * 0.5 } : { x: W * 0.5, y: H * 0.26 };
    return { relays, dest, side, R: g.R * (g.wide ? 0.72 : 0.6) };
  }

  const scenes = {
    idle(p, now) {
      const g = geo();
      const wobble = reduced ? 0 : 1;
      let ax = 0.2 * wobble * Math.sin(now * 0.5), ay = 0.16 * wobble * Math.cos(now * 0.37);
      let { cx, cy } = g;
      const pt = state.followOn ? state.pointer : null;
      if (pt) {
        const nx = clamp((pt.x - cx) / (W / 2), -1, 1), ny = clamp((pt.y - cy) / (H / 2), -1, 1);
        ax = -ny * 0.55; ay = nx * 0.55; cx += nx * g.R * 0.12; cy += ny * g.R * 0.12;
      }
      const targets = ring({ ...g, cx, cy, now, ax, ay, angleOf: (i) => slotAngle(i) });
      for (const d of targets) d.s *= cur.dot;
      if (pt) for (const d of targets) {
        const near = Math.exp(-((Math.hypot(d.x - pt.x, d.y - pt.y) / (g.R * 0.6)) ** 2));
        d.s *= 1 + 0.6 * near; d.g += 1.4 * near; d.a = clamp(d.a + 0.3 * near, 0, 1);
      }
      return { targets, extras: {} };
    },

    deposit(p, now) {
      const g = geo();
      const targets = ring({ ...g, now, pulse: false, angleOf: (i) => slotAngle(i) });
      const drop = easeOut(range(p, 0.08, 0.62));
      const slot = targets[MINE];
      targets[MINE] = { ...slot, x: lerp(g.cx, slot.x, drop), y: lerp(-g.R, slot.y, drop), a: drop > 0 ? 1 : 0, g: 1.6, snap: true };
      const wake = range(p, 0.6, 0.9);
      targets.forEach((d, i) => { if (i !== MINE) d.a *= lerp(0.45, 1, wake); });
      return { targets, extras: {} };
    },

    hide(p, now) {
      const g = geo();
      const mix = easeInOut(range(p, 0.3, 0.85));
      const angleOf = (i) => slotAngle(i + ((SHUFFLE[i] - i + N) % N) * mix, TAU * mix);
      const targets = ring({ ...g, now, pulse: false, angleOf, ax: reduced ? 0 : 0.14 * Math.sin(now * 0.5) });
      const mark = range(p, 0.02, 0.18) * (1 - range(p, 0.4, 0.65));
      targets.forEach((d, i) => { if (i !== MINE) d.a *= lerp(0.5, 1, range(p, 0.3, 0.5)); });
      const mine = targets[MINE];
      targets[MINE] = { ...mine, a: 1, s: mine.s * (1 + 0.3 * mark), g: 1 + 2 * mark, hl: mark };
      return { targets, extras: { tag: mark > 0.15 ? { x: targets[MINE].x, y: targets[MINE].y, a: mark } : null } };
    },

    relays(p, now) {
      const g = geo(), s = stops(g);
      const out = easeOut(range(p, 0, 0.16));
      const cx = lerp(g.cx, s.side.x, out), cy = lerp(g.cy, s.side.y, out), R = lerp(g.R, s.R, out);
      const targets = ring({ cx, cy, R, now, pulse: false, angleOf: (i) => slotAngle(SHUFFLE[i]) });
      const slot = targets[TRAVELLER];
      const lift = { x: lerp(slot.x, s.relays[0].x, 0.2), y: slot.y - Math.min(W, H) * 0.08 };
      const pts = [lift, ...s.relays];
      let d = { ...slot };
      if (p >= 0.1 && p < 0.22) {
        const t = easeOut(range(p, 0.1, 0.22));
        d = { ...slot, x: lerp(slot.x, lift.x, t), y: lerp(slot.y, lift.y, t), s: lerp(slot.s, 1.3, t), a: 1, g: 2, layers: 3 * t, snap: true };
      } else if (p >= 0.22) {
        const seg = Math.min(2, Math.floor((p - 0.22) / 0.22));
        const t = easeOut(range(p, 0.22 + seg * 0.22, 0.44 + seg * 0.22));
        const q = bez(pts[seg], arc(pts[seg], pts[seg + 1]), pts[seg + 1], t);
        d = { ...slot, x: q.x, y: q.y, s: 1.3, a: 1, g: 2, layers: 3 - seg - (t > 0.97 ? 1 : 0), snap: true };
      }
      targets[TRAVELLER] = d;
      targets.forEach((x, i) => { if (i !== TRAVELLER) x.a *= lerp(1, 0.5, range(p, 0.1, 0.22)); });
      return {
        targets,
        extras: {
          path: { pts, a: 0.6 * range(p, 0.08, 0.2) },
          relays: s.relays.map((r, i) => ({ ...r, a: range(p, 0.04, 0.16), pulse: range(p, 0.44 + 0.22 * i, 0.56 + 0.22 * i), label: `Relay ${i + 1}` })),
        },
      };
    },

    paid(p, now) {
      const g = geo(), s = stops(g);
      const back = easeOut(range(p, 0.72, 1));
      const cx = lerp(s.side.x, g.cx, back), cy = lerp(s.side.y, g.cy, back), R = lerp(s.R, g.R, back);
      const targets = ring({ cx, cy, R, now, pulse: false, angleOf: (i) => slotAngle(SHUFFLE[i]) });
      const slot = targets[TRAVELLER];
      const R3 = s.relays[2];
      let d;
      if (p < 0.4) {
        const t = easeOut(range(p, 0, 0.4));
        const q = bez(R3, arc(R3, s.dest), s.dest, t);
        d = { ...slot, x: q.x, y: q.y, s: 1.3, a: 1, g: 2, sq: t, snap: true };
      } else if (p < 0.7) {
        d = { ...slot, x: s.dest.x, y: s.dest.y, s: 1.3, a: 1 - range(p, 0.6, 0.7), g: 2, sq: 1, snap: true };
      } else {
        // A fresh note takes the empty place in the pool.
        d = { ...slot, a: slot.a * range(p, 0.7, 0.85), g: 1 + 2 * (1 - range(p, 0.7, 1)), snap: true };
      }
      targets[TRAVELLER] = d;
      targets.forEach((x, i) => { if (i !== TRAVELLER) x.a *= lerp(0.5, 1, range(p, 0.6, 0.9)); });
      const fade = 1 - range(p, 0.7, 0.85);
      return {
        targets,
        extras: {
          path: { pts: [R3, s.dest], a: 0.6 * fade * (1 - range(p, 0.4, 0.6)) },
          relays: s.relays.map((r, i) => ({ ...r, a: fade, pulse: 0, label: `Relay ${i + 1}` })),
          dest: { ...s.dest, a: range(p, 0.2, 0.4) * fade, label: 'Fresh address' },
        },
      };
    },

    apps(p, now) {
      const g = geo();
      const open = easeOut(range(p, 0, 0.22)), fly = easeOut(range(p, 0.2, 0.55));
      const targets = ring({ ...g, R: g.R * (1 + 0.3 * open), now, pulse: false, angleOf: (i) => slotAngle(SHUFFLE[i] + 0.18 * open * Math.sin(i * 2.3)) });
      const D = Math.min(g.R * 1.85, Math.min(W, H) * 0.4);
      const apps = APPS.map((a) => ({
        ...a,
        x: clamp(g.cx + Math.cos(a.angle) * D * (g.wide ? 1.4 : 1), 70, W - 70),
        y: clamp(g.cy + Math.sin(a.angle) * D, 64, H - 72),
      }));
      APP_NOTES.forEach((i, n) => {
        const from = targets[i], to = apps[n];
        targets[i] = { ...from, x: lerp(from.x, to.x, fly), y: lerp(from.y, to.y, fly), s: lerp(from.s, 1.6, fly), sq: fly, a: 1, g: 1 + fly };
      });
      targets.forEach((d, i) => { if (!APP_NOTES.includes(i)) d.a *= lerp(1, 0.4, fly); });
      return { targets, extras: { apps: apps.map((a) => ({ ...a, a: range(p, 0.28, 0.5) })), cuts: { a: range(p, 0.55, 0.75), apps } } };
    },
  };

  // ── drawing ─────────────────────────────────────────────────────────────
  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(str, x, y, colour, font) {
    ctx.font = font; ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(str, x, y);
  }
  const LABEL = '600 13px Quicksand, system-ui, sans-serif';
  function drawDot(d, dotSize, th) {
    const r = (dotSize / 2) * d.s;
    const a = clamp(d.a, 0, 1);
    ctx.globalAlpha = a;
    ctx.shadowColor = rgba(th.glow);
    ctx.shadowBlur = th.glow[3] > 0 ? dotSize * 1.2 * d.g : 0;
    ctx.fillStyle = rgba(th.dot);
    if (d.sq > 0.02) { const half = r * (1 + 0.2 * d.sq); rounded(d.x - half, d.y - half, half * 2, half * 2, lerp(half, half * 0.3, d.sq)); }
    else { ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, TAU); }
    ctx.fill();
    ctx.shadowBlur = 0;
    if (d.hl > 0.01) {
      ctx.globalAlpha = d.hl * a;
      ctx.fillStyle = rgba(th.bg); ctx.beginPath(); ctx.arc(d.x, d.y, r * 0.4, 0, TAU); ctx.fill();
      ctx.strokeStyle = rgba(th.fg); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(d.x, d.y, r + 8, 0, TAU); ctx.stroke();
    }
    for (let k = 1; k <= Math.ceil(d.layers); k++) {
      ctx.globalAlpha = clamp(d.layers - (k - 1), 0, 1) * 0.7 * a;
      ctx.strokeStyle = rgba(th.dot); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(d.x, d.y, r + 6 * k, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawExtras(x, th, dotSize) {
    const fg = rgba(th.fg), muted = rgba(th.muted), line = rgba(th.line);
    if (x.path && x.path.a > 0.01) {
      ctx.globalAlpha = x.path.a; ctx.strokeStyle = muted; ctx.lineWidth = 1.25; ctx.setLineDash([3, 7]);
      ctx.beginPath(); ctx.moveTo(x.path.pts[0].x, x.path.pts[0].y);
      for (let i = 1; i < x.path.pts.length; i++) { const c = arc(x.path.pts[i - 1], x.path.pts[i]); ctx.quadraticCurveTo(c.x, c.y, x.path.pts[i].x, x.path.pts[i].y); }
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    for (const r of x.relays ?? []) {
      if (r.a < 0.01) continue;
      ctx.globalAlpha = r.a; ctx.strokeStyle = rgba(th.dot); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, 12, 0, TAU); ctx.stroke();
      text(r.label, r.x, r.y + 30, muted, LABEL);
      if (r.pulse > 0 && r.pulse < 1) { ctx.globalAlpha = r.a * (1 - r.pulse) * 0.8; ctx.beginPath(); ctx.arc(r.x, r.y, 12 + 32 * r.pulse, 0, TAU); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    if (x.dest && x.dest.a > 0.01) { ctx.globalAlpha = x.dest.a; text(x.dest.label, x.dest.x, x.dest.y + dotSize + 22, muted, LABEL); ctx.globalAlpha = 1; }
    if (x.cuts && x.cuts.a > 0.01) {
      const a = x.cuts.apps;
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        ctx.globalAlpha = x.cuts.a * 0.8; ctx.strokeStyle = line; ctx.lineWidth = 1.25; ctx.setLineDash([3, 7]);
        ctx.beginPath(); ctx.moveTo(a[i].x, a[i].y); ctx.lineTo(a[j].x, a[j].y); ctx.stroke(); ctx.setLineDash([]);
        const mx = (a[i].x + a[j].x) / 2, my = (a[i].y + a[j].y) / 2;
        ctx.globalAlpha = x.cuts.a; ctx.fillStyle = rgba(th.bg); ctx.beginPath(); ctx.arc(mx, my, 11, 0, TAU); ctx.fill();
        ctx.strokeStyle = fg; ctx.lineWidth = 1.75; ctx.beginPath();
        ctx.moveTo(mx - 4, my - 4); ctx.lineTo(mx + 4, my + 4); ctx.moveTo(mx + 4, my - 4); ctx.lineTo(mx - 4, my + 4); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const app of x.apps ?? []) {
      if (app.a < 0.01) continue;
      ctx.globalAlpha = app.a; ctx.fillStyle = rgba(th.card); ctx.strokeStyle = line; ctx.lineWidth = 1;
      rounded(app.x - 48, app.y - 36, 96, 72, 14); ctx.fill(); ctx.stroke();
      text(app.name, app.x, app.y - 52, fg, '600 14px Poppins, system-ui, sans-serif');
      text(app.addr, app.x, app.y + 54, muted, '500 12px ui-monospace, Menlo, monospace');
      ctx.globalAlpha = 1;
    }
    if (x.tag) { ctx.globalAlpha = x.tag.a; text('yours', x.tag.x, x.tag.y - dotSize * 1.5 - 14, fg, '700 13px Quicksand, system-ui, sans-serif'); ctx.globalAlpha = 1; }
  }

  function draw(extras) {
    const th = state.theme;
    ctx.clearRect(0, 0, W, H);
    const g = geo();
    const dotSize = g.R * dot;
    drawExtras(extras, th, dotSize);
    [...dots].sort((a, b) => b.z - a.z).forEach((d) => drawDot(d, dotSize, th));
    onDraw?.({ dots, dotSize, cx: g.cx, cy: g.cy });
  }

  function step(now, stiffness) {
    const { targets, extras } = scenes[state.scene](state.p, now);
    const k = 1 - Math.exp(-stiffness);
    dots.forEach((d, i) => {
      const t = targets[i];
      for (const key of ['x', 'y', 's', 'a', 'g', 'hl', 'layers', 'sq', 'z']) {
        if (!state.ready || stiffness === Infinity || (t.snap && (key === 'x' || key === 'y'))) d[key] = t[key];
        else d[key] += (t[key] - d[key]) * k;
      }
    });
    state.ready = true;
    draw(extras);
  }
  function renderStill() { if (W > 0) step(performance.now() / 1000, Infinity); }

  function loop(ms) {
    if (!state.running) return;
    const now = ms / 1000;
    const dt = state.last === 0 ? 0 : Math.min(0.05, now - state.last);
    state.last = now;
    state.rot += speed * dt;
    const glide = 1 - Math.exp(-3.2 * dt);
    for (const k of Object.keys(place)) cur[k] += (place[k] - cur[k]) * glide;
    if (state.bloom) {
      // The first frame of a bloom: every note starts at the centre, unseen.
      const g = geo();
      for (const d of dots) Object.assign(d, { x: g.cx, y: g.cy, s: 0.2, a: 0 });
      state.bloom = false;
    }
    step(now, 9 * dt);
    state.frame = requestAnimationFrame(loop);
  }

  new ResizeObserver(resize).observe(canvas);
  resize();

  return {
    /** Which scene, and how far through it (0 to 1). */
    set(scene, p = 0) { state.scene = scene; state.p = clamp(p, 0, 1); if (!state.running) renderStill(); },
    setTheme(theme) { state.theme = theme; if (!state.running) renderStill(); },
    /** A point in this canvas's own pixels, or null when the cursor leaves. */
    setPointer(pt) { state.pointer = pt; },
    setFollow(on) { state.followOn = on; if (!on) state.pointer = null; },
    /** Moves the ring (x, y as fractions of the canvas, size of its shorter side, dot as a scale); it glides unless instant. */
    place(next, { instant = false } = {}) { Object.assign(place, next); if (instant) Object.assign(cur, place); if (!state.running) renderStill(); },
    /** On its next running frame, the ring grows out of its centre. */
    bloom() { state.bloom = true; },
    start() { if (state.running) return; state.running = true; state.last = 0; state.frame = requestAnimationFrame(loop); },
    stop() { state.running = false; cancelAnimationFrame(state.frame); },
  };
}
