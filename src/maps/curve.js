// Curves (plan §7.5, §12.6): points [[x, y], ...] with x from 0 to 1 -> monotone cubic interpolation
// (Fritsch–Carlson). The GPU gets a lookup table.

export const CURVE_PRESETS = {
  linear: [[0, 0], [1, 1]],
  easeIn: [[0, 0], [0.5, 0.2], [1, 1]],
  easeOut: [[0, 0], [0.5, 0.8], [1, 1]],
  sCurve: [[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]],
  step: [[0, 0], [0.49, 0], [0.51, 1], [1, 1]],
};

// A function x -> y through the points (sorted by x), monotone between them.
export function monotoneCurve(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return () => (n ? p[0][1] : 0);
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1][0] - p[i][0]);
    m.push(dx[i] > 0 ? (p[i + 1][1] - p[i][1]) / dx[i] : 0);
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      t[i] = s * a * m[i];
      t[i + 1] = s * b * m[i];
    }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = dx[i], u = (x - p[i][0]) / h;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p[i][1] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * p[i + 1][1] + (u3 - u2) * h * t[i + 1];
  };
}

// 256 values of the curve, clamped to 0..1.
export function curveTable(points, size = 256) {
  const f = monotoneCurve(points);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.max(0, Math.min(1, f(i / (size - 1))));
  return out;
}
