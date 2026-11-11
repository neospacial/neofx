// A JS reference of the map pipeline (gpu/glsl/mapgen.frag, mapadjust.frag) for the maps that need
// no random numbers and no frames: the GPU result must match it. Not the blur.

import { MAP_INDEX, paramArray } from '../../src/maps/builtin.js';
import { curveTable, CURVE_PRESETS } from '../../src/maps/curve.js';

const fract = (x) => x - Math.floor(x);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const dir = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

function builtin(type, k, P, R, phase) {
  const ramp = (s) => (phase === 0 ? clamp(s) : fract(s - phase));
  const [W, H] = R;
  if (type === 0 || type === 1) {
    const d = dir(k[0]);
    const span = Math.abs(W * d[0]) + Math.abs(H * d[1]);
    const s = (P[0] - k[1] * W) * d[0] + (P[1] - k[2] * H) * d[1];
    return type === 0 ? ramp(s / Math.max(k[3] * span, 1e-3) + 0.5) : ramp(Math.abs(s) / Math.max(0.5 * k[3] * span, 1e-3));
  }
  const q = [(P[0] - k[0] * W) / H, (P[1] - k[1] * H) / H];
  if (type === 2) return ramp(Math.hypot(q[0] / k[3], q[1]) / k[2]);
  if (type === 3) return fract(((Math.atan2(q[1], q[0]) - (k[2] * Math.PI) / 180) / (2 * Math.PI)) * k[3] - phase);
  if (type === 4) return fract((Math.atan2(q[1], q[0]) / (2 * Math.PI)) * k[2] + Math.hypot(...q) * k[3] - phase);
  if (type === 5) {
    const r = k[3];
    const n = r < 0.5 ? 2 ** (4 - 6 * r) : 2 - 2 * (r - 0.5);
    const a = [Math.abs(q[0]) / k[2], Math.abs(q[1]) / k[2]];
    const m = Math.max(...a);
    return ramp(m <= 0 ? 0 : m * ((a[0] / m) ** n + (a[1] / m) ** n) ** (1 / n));
  }
  const uv = [P[0] / W, P[1] / H];
  if (type === 6) {
    const v = (k[0] + (k[1] - k[0]) * uv[0]) * (1 - uv[1]) + (k[2] + (k[3] - k[2]) * uv[0]) * uv[1];
    return phase === 0 ? v : fract(v - phase);
  }
  const h = [P[0] / H, P[1] / H];
  if (type === 7) {
    const d = dir(k[1]);
    const f = fract((h[0] * d[0] + h[1] * d[1]) * k[0] - phase);
    const duty = k[3];
    const f2 = f > 0.5 * (1 + duty) ? f - 1 : f;
    return clamp(Math.min(f2, duty - f2) / Math.max(k[2], 1e-4) + 0.5);
  }
  if (type === 8) {
    const d = dir(k[2]);
    const x = h[0] * d[0] + h[1] * d[1], y = -h[0] * d[1] + h[1] * d[0];
    const ph = k[3] + phase;
    let s = 0, n = 0;
    if (k[0] > 0) { s += Math.sin(2 * Math.PI * (k[0] * x + ph)); n++; }
    if (k[1] > 0) { s += Math.sin(2 * Math.PI * (k[1] * y + ph)); n++; }
    return 0.5 + (0.5 * s) / Math.max(n, 1);
  }
  if (type === 9) {
    const f = fract(Math.hypot(...q) * k[2] - phase);
    return f + (0.5 - 0.5 * Math.cos(2 * Math.PI * f) - f) * k[3];
  }
  if (type === 10) {
    const c = [h[0] * k[0] + phase, h[1] * k[0]];
    const s = Math.sin(Math.PI * c[0]) * Math.sin(Math.PI * c[1]);
    return k[1] < 1e-4 ? (s >= 0 ? 1 : 0) : clamp(0.5 + s / (2 * k[1]));
  }
  if (type === 17) {
    const n = Math.round(k[0]);
    const ix = Math.floor(P[0]), iy = Math.floor(P[1]);
    let b = 0;
    for (let i = 0; i < n; i++) {
      const sh = n - 1 - i, x = (ix >> i) & 1, y = (iy >> i) & 1;
      b |= ((x ^ y) << (2 * sh + 1)) | (y << (2 * sh));
    }
    return k[1] > (b + 0.5) / (1 << (2 * n)) ? 1 : 0;
  }
  throw new Error(`no reference for map ${type}`);
}

export function adjust(v, A) {
  v = clamp((v - A.black) / Math.max(A.white - A.black, 1e-4));
  v = v ** (1 / Math.max(A.gamma, 1e-3));
  const c = Math.max(-0.99, Math.min(0.99, A.contrast));
  v = clamp((v - 0.5) * Math.tan((c + 1) * 0.785398) + 0.5);
  const pts = Array.isArray(A.curve) ? A.curve : CURVE_PRESETS[A.curve];
  if (JSON.stringify(pts) !== JSON.stringify(CURVE_PRESETS.linear)) {
    const tb = curveTable(pts);
    const x = v * 255, i = Math.floor(Math.min(x, 254));
    v = tb[i] + (tb[i + 1] - tb[i]) * (x - i);
  }
  if (A.posterize > 1) v = Math.min(Math.floor(v * A.posterize), A.posterize - 1) / (A.posterize - 1);
  if (A.invert) v = 1 - v;
  return v;
}

// The map value of pixel (x, y) at frame t, for a built-in map (map: the settings.map object).
export function mapRef(map, t, x, y, W, H) {
  const A = map.adjust, an = map.anim;
  let uv = [(x + 0.5) / W + A.offsetX, (y + 0.5) / H + A.offsetY];
  const tile = [Math.max(1, A.tileX), Math.max(1, A.tileY)];
  let f = [0, 1].map((i) => {
    const tu = uv[i] * tile[i];
    let g = fract(tu);
    if (A.mirrorTile && Math.floor(tu) % 2 !== 0) g = 1 - g;
    return g;
  });
  let P = [f[0] * W, f[1] * H];
  const c = [W / 2, H / 2];
  const a = (-an.rotSpeed * t * Math.PI) / 180;
  const pulse = 1 + an.pulseAmount * Math.sin((2 * Math.PI * t) / Math.max(1, an.pulsePeriod));
  const d = [(P[0] - c[0]) / pulse, (P[1] - c[1]) / pulse];
  P = [c[0] + Math.cos(a) * d[0] - Math.sin(a) * d[1], c[1] + Math.sin(a) * d[0] + Math.cos(a) * d[1]];
  const v = builtin(MAP_INDEX[map.type], paramArray(map.type, map.params[map.type]), P, [W, H], an.phaseSpeed * t);
  return adjust(v, A);
}

// The custom map value (image) of pixel (x, y). img: { w, h, get(ix, iy) -> 0..1 }; im: settings.map.image.
export function customRef(img, im, x, y, W, H) {
  let p = [x + 0.5 - W / 2 - im.x * W, y + 0.5 - H / 2 - im.y * H];
  const a = (-im.rotation * Math.PI) / 180;
  p = [(Math.cos(a) * p[0] - Math.sin(a) * p[1]) / im.scale, (Math.sin(a) * p[0] + Math.cos(a) * p[1]) / im.scale];
  p = [p[0] * (im.flipX ? -1 : 1), p[1] * (im.flipY ? -1 : 1)];
  let uv;
  if (im.fit === 'stretch') uv = [p[0] / W + 0.5, p[1] / H + 0.5];
  else {
    const s = (im.fit === 'fill' ? Math.max : Math.min)(W / img.w, H / img.h);
    uv = [p[0] / (img.w * s) + 0.5, p[1] / (img.h * s) + 0.5];
  }
  if (uv[0] < 0 || uv[1] < 0 || uv[0] > 1 || uv[1] > 1) return im.outside;
  // Bilinear, clamp to edge.
  const tx = uv[0] * img.w - 0.5, ty = uv[1] * img.h - 0.5;
  const x0 = Math.floor(tx), y0 = Math.floor(ty), fx = tx - x0, fy = ty - y0;
  const g = (ix, iy) => img.get(Math.max(0, Math.min(img.w - 1, ix)), Math.max(0, Math.min(img.h - 1, iy)));
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
}
