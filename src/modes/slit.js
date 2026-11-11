// Mode 2, Slit Scan, line source (plan §8.1 – §8.3, §8.5): geometry and age. No browser APIs.

import { monotoneCurve, CURVE_PRESETS } from '../maps/curve.js';

export const RATE_TYPES = [['constant', 'Constant'], ['accelerate', 'Accelerate'], ['decelerate', 'Decelerate'], ['exponential', 'Exponential'], ['curve', 'Curve']];
export const MAX_HISTORY = 4096;

// The rate r (px/frame) at age a (frames), u = a / M (plan §8.5).
export function rateAt(sl, a) {
  const M = Math.max(1, sl.maxAge);
  const u = Math.min(1, Math.max(0, a / M));
  const r0 = sl.rate, r1 = sl.rateEnd;
  switch (sl.rateType) {
    case 'accelerate': return r0 + (r1 - r0) * u * u;
    case 'decelerate': return r0 + (r1 - r0) * (1 - (1 - u) * (1 - u));
    case 'exponential': return r0 * (r1 / r0) ** u;
    case 'curve': {
      const pts = Array.isArray(sl.curve) ? sl.curve : CURVE_PRESETS[sl.curve] || CURVE_PRESETS.linear;
      return r0 + (r1 - r0) * monotoneCurve(pts)(u);
    }
    default: return r0;
  }
}

// S(a): the distance (px) that a pixel moves by the age a, for a = 0 .. M (the rate at the middle of
// each frame of age). Float32Array of M + 1.
export function distanceTable(sl) {
  const M = Math.max(1, Math.round(sl.maxAge));
  const S = new Float32Array(M + 1);
  for (let a = 1; a <= M; a++) S[a] = S[a - 1] + Math.max(1e-4, rateAt(sl, a - 0.5));
  return S;
}

// A(s): the age (frames, a float) at the distance s, or Infinity beyond S(M). The inverse of S
// (binary search, then linear between the entries), as the shader does it.
export function ageAt(S, s) {
  const M = S.length - 1;
  if (s > S[M]) return Infinity;
  let lo = 0, hi = M;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (S[m] <= s) lo = m;
    else hi = m - 1;
  }
  if (lo >= M) return M;
  return lo + (s - S[lo]) / (S[lo + 1] - S[lo]);
}

// The line in working pixels (plan §8.1). angle: the direction of the line (90° = vertical). d: the
// scan direction (perpendicular, 90° clockwise from the line; Flip turns it 180°). The point is
// snapped to a pixel centre, so lines at 0°, 90°, 180°, 270° read exact pixels.
// Returns { L, d, e, len, c }: the history row has len samples; sample i is at L + (i − c) e.
export function lineGeometry(sl, w, h, maxTexture = 8192) {
  const a = (sl.angle * Math.PI) / 180;
  const snap = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v);
  const e = [snap(Math.cos(a)), snap(Math.sin(a))];
  let d = [snap(Math.sin(a)), snap(-Math.cos(a))]; // 90° -> (1, 0): to the right
  if (sl.flip) d = [-d[0], -d[1]];
  const L = [Math.min(w - 1, Math.floor(sl.x * w)) + 0.5, Math.min(h - 1, Math.floor(sl.y * h)) + 0.5];
  const len = Math.min(maxTexture, 2 * Math.ceil(Math.hypot(w, h)) + 4);
  return { L, d, e, len, c: len >> 1 };
}

// The history rows: one for each frame, at most MAX_HISTORY and the texture limit.
export const historyRows = (frames, maxTexture = 8192) => Math.max(1, Math.min(frames, MAX_HISTORY, maxTexture));
