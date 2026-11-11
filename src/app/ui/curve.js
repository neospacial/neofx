// Curve editor (plan §12.6): one widget for the map curve, the rate curve, and the decay curve.
// Points with drag; add a point with a click / tap on the line; remove a point with a double-click
// or a long press. Presets: Linear, Ease in, Ease out, S-curve, Step. Monotone cubic interpolation.

import { CURVE_PRESETS, monotoneCurve } from '../../maps/curve.js';

const NAMES = { linear: 'Linear', easeIn: 'Ease in', easeOut: 'Ease out', sCurve: 'S-curve', step: 'Step' };
const HIT = 12; // px

const points = (v) => (Array.isArray(v) ? v.map((p) => [p[0], p[1]]) : (CURVE_PRESETS[v] || CURVE_PRESETS.linear).map((p) => [p[0], p[1]]));

// opts: { label, value (preset name or points), onChange(value, final), key }
export function curveEditor(opts) {
  const row = document.createElement('div');
  row.className = 'setting curve';
  row.dataset.key = opts.key || '';
  const label = document.createElement('label');
  label.textContent = opts.label;
  const canvas = document.createElement('canvas');
  canvas.className = 'curveCanvas';
  canvas.setAttribute('aria-label', `${opts.label} curve`);
  const presets = document.createElement('div');
  presets.className = 'segs curvePresets';
  let pts = points(opts.value);
  let name = Array.isArray(opts.value) ? null : opts.value;
  const W = 220, H = 120, PAD = 8;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  const toPx = ([x, y]) => [PAD + x * (W - 2 * PAD), H - PAD - y * (H - 2 * PAD)];
  const toVal = (px, py) => [Math.min(1, Math.max(0, (px - PAD) / (W - 2 * PAD))), Math.min(1, Math.max(0, (H - PAD - py) / (H - 2 * PAD)))];
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const a = PAD + (i * (W - 2 * PAD)) / 4, b = PAD + (i * (H - 2 * PAD)) / 4;
      ctx.beginPath(); ctx.moveTo(a, PAD); ctx.lineTo(a, H - PAD); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD, b); ctx.lineTo(W - PAD, b); ctx.stroke();
    }
    const f = monotoneCurve(pts);
    ctx.strokeStyle = getComputedStyle(row).getPropertyValue('--accent').trim() || '#eee100';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 100; i++) {
      const [x, y] = toPx([i / 100, Math.min(1, Math.max(0, f(i / 100)))]);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const p of pts) {
      const [x, y] = toPx(p);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    for (const b of presets.children) b.classList.toggle('on', b.dataset.value === name);
  };
  const emit = (final) => opts.onChange(name || pts.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]), final);
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  };
  const nearest = (px, py) => {
    let best = -1, bd = HIT;
    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      const d = Math.hypot(x - px, y - py);
      if (d < bd) [best, bd] = [i, d];
    });
    return best;
  };
  const remove = (i) => {
    if (i <= 0 || i >= pts.length - 1) return; // the ends stay
    pts.splice(i, 1);
    name = null;
    draw();
    emit(true);
  };
  let drag = -1, press = 0, moved = false;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const [px, py] = local(e);
    let i = nearest(px, py);
    if (i < 0) {
      // A click on the line adds a point there.
      const [x] = toVal(px, py);
      const [, cy] = toPx([x, monotoneCurve(pts)(x)]);
      if (Math.abs(cy - py) > HIT * 1.5) return;
      pts.push([x, toVal(px, py)[1]]);
      pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex((p) => p[0] === x);
      name = null;
      draw();
      emit(false);
    }
    drag = i;
    moved = false;
    canvas.setPointerCapture(e.pointerId);
    clearTimeout(press);
    press = setTimeout(() => {
      if (!moved && drag >= 0) {
        const k = drag;
        drag = -1;
        remove(k); // a long press removes the point
      }
    }, 600);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [px, py] = local(e);
    let [x, y] = toVal(px, py);
    moved = true;
    clearTimeout(press);
    // The ends keep their x; the other points stay between their neighbours.
    if (drag === 0) x = 0;
    else if (drag === pts.length - 1) x = 1;
    else x = Math.min(pts[drag + 1][0] - 0.01, Math.max(pts[drag - 1][0] + 0.01, x));
    pts[drag] = [x, y];
    name = null;
    draw();
    emit(false);
  });
  const end = () => {
    clearTimeout(press);
    if (drag >= 0 && moved) emit(true);
    drag = -1;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => remove(nearest(...local(e))));
  for (const [k, text] of Object.entries(NAMES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.dataset.value = k;
    b.addEventListener('click', () => {
      name = k;
      pts = points(k);
      draw();
      emit(true);
    });
    presets.append(b);
  }
  row.setValue = (v) => {
    pts = points(v);
    name = Array.isArray(v) ? null : v;
    draw();
  };
  row.points = () => pts.map((p) => p.slice());
  row.append(label, canvas, presets);
  requestAnimationFrame(draw);
  draw();
  return row;
}
