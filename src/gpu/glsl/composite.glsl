// Compositor (plan §10). The effect layer goes on the base with a blend mode (W3C Compositing and
// Blending Level 1 formulas; Add, Subtract, Divide as in common editors) and an alpha:
//   result = (1 − αs) · Cb + αs · B(Cb, Cs)      (the base is opaque)
// Linear blend: the colours go to linear light (sRGB curve) for the blend and back.
uniform int u_blendMode;
uniform bool u_linear;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

float bDodge(float b, float s) { return b == 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float bBurn(float b, float s) { return b >= 1.0 ? 1.0 : s == 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float bHard(float b, float s) { return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0); }
float bSoft(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float bDivide(float b, float s) { return s == 0.0 ? (b == 0.0 ? 0.0 : 1.0) : min(1.0, b / s); }

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn); // max -> s, min -> 0, mid scaled (the W3C SetSat)
}

vec3 blendColor(vec3 b, vec3 s, int m) {
  if (m == 0) return s;
  if (m == 1) return min(b + s, 1.0);
  if (m == 2) return b + s - b * s;
  if (m == 3) return max(b, s);
  if (m == 4) return vec3(bDodge(b.r, s.r), bDodge(b.g, s.g), bDodge(b.b, s.b));
  if (m == 5) return vec3(bHard(s.r, b.r), bHard(s.g, b.g), bHard(s.b, b.b)); // overlay = hard light, swapped
  if (m == 6) return vec3(bSoft(b.r, s.r), bSoft(b.g, s.g), bSoft(b.b, s.b));
  if (m == 7) return vec3(bHard(b.r, s.r), bHard(b.g, s.g), bHard(b.b, s.b));
  if (m == 8) return b * s;
  if (m == 9) return min(b, s);
  if (m == 10) return vec3(bBurn(b.r, s.r), bBurn(b.g, s.g), bBurn(b.b, s.b));
  if (m == 11) return max(b - s, 0.0);
  if (m == 12) return abs(b - s);
  if (m == 13) return b + s - 2.0 * b * s;
  if (m == 14) return vec3(bDivide(b.r, s.r), bDivide(b.g, s.g), bDivide(b.b, s.b));
  if (m == 15) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 16) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 17) return setLum(s, lum(b));
  return setLum(b, lum(s)); // 18 luminosity
}

// The effect colour cs with alpha a over the opaque base cb.
vec3 composite(vec3 cb, vec3 cs, float a) {
  if (u_linear) {
    cb = toLinear(cb);
    cs = toLinear(cs);
  }
  vec3 r = clamp((1.0 - a) * cb + a * blendColor(cb, cs, u_blendMode), 0.0, 1.0);
  return u_linear ? toSrgb(r) : r;
}
