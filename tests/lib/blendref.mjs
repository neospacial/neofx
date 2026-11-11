// A JS reference of the compositor (plan §10, §13.2): W3C Compositing and Blending Level 1
// (https://www.w3.org/TR/compositing-1/ §9), with Add, Subtract, Divide as in common editors.

const clamp = (x) => Math.min(1, Math.max(0, x));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);

const dodge = (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const burn = (b, s) => (b >= 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const hard = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
const soft = (b, s) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};
const divide = (b, s) => (s === 0 ? (b === 0 ? 0 : 1) : Math.min(1, b / s));

const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c) {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  if (n < 0) c = c.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) c = c.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return c;
}
const setLum = (c, l) => {
  const d = l - lum(c);
  return clipColor(c.map((v) => v + d));
};
const sat = (c) => Math.max(...c) - Math.min(...c);
function setSat(c, s) {
  const mx = Math.max(...c), mn = Math.min(...c);
  if (mx <= mn) return [0, 0, 0];
  return c.map((v) => ((v - mn) * s) / (mx - mn));
}

const SEP = {
  normal: (b, s) => s, add: (b, s) => Math.min(1, b + s), screen: (b, s) => b + s - b * s, lighten: Math.max, colordodge: dodge,
  overlay: (b, s) => hard(s, b), softlight: soft, hardlight: hard, multiply: (b, s) => b * s, darken: Math.min, colorburn: burn,
  subtract: (b, s) => Math.max(0, b - s), difference: (b, s) => Math.abs(b - s), exclusion: (b, s) => b + s - 2 * b * s, divide,
};
const NONSEP = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

export function blend(mode, b, s) {
  if (NONSEP[mode]) return NONSEP[mode](b, s);
  return b.map((v, i) => SEP[mode](v, s[i]));
}

// The effect colour cs (0..1 RGB) with alpha a over the opaque base cb.
export function composite(mode, cb, cs, a, linear = false) {
  if (linear) {
    cb = cb.map(toLinear);
    cs = cs.map(toLinear);
  }
  const B = blend(mode, cb, cs);
  const r = cb.map((v, i) => clamp((1 - a) * v + a * B[i]));
  return linear ? r.map(toSrgb) : r;
}
