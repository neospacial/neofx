// Mode 2, Slit Scan, line source (plan §8.2, §8.3). For each pixel: s = distance from the line along
// the scan direction, y' = position along the line. s < 0: the original (not the effect side).
// Time Off: the line of frame t. Time On: age a = A(s) (inverse of the distance table S); a > Max age:
// the original; src = t − a < 0: black (Replace) or the original (Blend) (D8); else the history row
// of frame round(src) (Sharp) or a mix of 2 rows (Blend). u_view: 0 result, 1 original, 2 age (heat).
uniform vec2 u_res;
uniform int u_t;
uniform vec2 u_L, u_d, u_e;
uniform float u_c;
uniform float u_len;
uniform highp sampler2D u_hist;          // len x H (RGBA8)
uniform highp isampler2D u_rows;         // H x 1: the frame index of each row
uniform int u_H;
uniform highp sampler2D u_S;             // the distance table, 1024 wide
uniform int u_M;                         // Max age
uniform bool u_timeOn;
uniform bool u_sharp;
uniform int u_view;
uniform int u_comp;
// Edge source (plan §8.4): the trail texture in the rotated space; Time Off: the emitters of frame t.
uniform bool u_edge;
uniform highp sampler2D u_trail;
uniform highp sampler2D u_epos;
uniform highp sampler2D u_ecol;
uniform highp isampler2D u_eframes;
uniform int u_eH, u_eK;
uniform float u_eD;
uniform vec2 u_ed, u_ee;
in vec2 v_uv;
out vec4 o;

float S(int i) { return texelFetch(u_S, ivec2(i % 1024, i / 1024), 0).r; }

// A(s): the largest i with S(i) <= s, then linear to the next entry.
float ageOf(float s) {
  int lo = 0, hi = u_M;
  for (int k = 0; k < 14; k++) {
    if (lo >= hi) break;
    int m = (lo + hi + 1) / 2;
    if (S(m) <= s) lo = m; else hi = m - 1;
  }
  if (lo >= u_M) return float(u_M);
  return float(lo) + (s - S(lo)) / (S(lo + 1) - S(lo));
}

// The history of frame k at column x (texture units); a = 0 when the row is not there.
vec4 row(int k, float x) {
  if (k < 0) return vec4(0.0);
  int r = k % u_H;
  if (texelFetch(u_rows, ivec2(r, 0), 0).r != k) return vec4(0.0);
  return vec4(texture(u_hist, vec2(x, (float(r) + 0.5) / float(u_H))).rgb, 1.0);
}

vec3 heat(float u) { // dark blue -> red -> yellow
  return clamp(vec3(1.5 * u, 1.5 * u - 0.5, 0.6 - 1.2 * abs(u - 0.25) + max(0.0, 2.0 * u - 1.6)), 0.0, 1.0);
}

// The edge effect at pixel p (working px): rgb, a = 1 when there is a trail; age in .w of the out.
vec4 edgeEffect(vec2 p, out float age) {
  age = 0.0;
  vec2 q = p - u_res * 0.5;
  float xp = dot(q, u_ed), yp = dot(q, u_ee);
  int r = int(floor(yp + 0.5 * u_eD));
  if (r < 0 || float(r) >= u_eD) return vec4(0.0);
  if (u_timeOn) {
    vec4 t = texelFetch(u_trail, ivec2(int(floor(xp + 0.5 * u_eD)), r), 0);
    if (t.a <= 0.0) return vec4(0.0);
    age = (t.a - 0.02) / 0.98 * float(u_M);
    return vec4(t.rgb, 1.0);
  }
  // Time Off: the colour of the nearest emitter of frame t before x' repeats to the next one.
  int slot = u_t % u_eH;
  if (texelFetch(u_eframes, ivec2(slot, 0), 0).r != u_t) return vec4(0.0);
  float best = -1e9;
  vec4 c = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    if (k >= u_eK) break;
    float x = texelFetch(u_epos, ivec2(r, slot * u_eK + k), 0).r;
    if (x > -1e5 && x <= xp + 0.5 && x > best) {
      best = x;
      c = vec4(texelFetch(u_ecol, ivec2(r, slot * u_eK + k), 0).rgb, 1.0);
    }
  }
  return c;
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec3 base = frameAt(u_t, uv).rgb;
  if (u_view == 1) { o = vec4(base, 1.0); return; }
  if (u_edge) {
    float age;
    vec4 e = edgeEffect(uv * u_res, age);
    if (u_view == 2) { o = vec4(e.a > 0.0 ? heat(age / float(max(u_M, 1))) : base * 0.3, 1.0); return; }
    // No trail: the original (an empty pixel is transparent, §10.1).
    vec3 col = e.a > 0.0 ? ageLook(e.rgb, age) : base;
    vec3 res = e.a > 0.0 ? (u_comp == 0 ? col : composite(base, col, u_opacity * decayAlpha(age))) : base;
    o = vec4(subjectOver(res, base, uv), 1.0);
    return;
  }
  vec2 p = uv * u_res - u_L;
  float s = dot(p, u_d);
  float x = (dot(p, u_e) + u_c + 0.5) / u_len;
  if (s < -1e-3) { o = vec4(u_view == 2 ? base * 0.3 : subjectOver(base, base, uv), 1.0); return; }
  s = max(s, 0.0);
  float a = 0.0;
  vec4 c;
  if (!u_timeOn) {
    c = row(u_t, x);
  } else {
    if (s > S(u_M)) { o = vec4(u_view == 2 ? base * 0.3 : subjectOver(base, base, uv), 1.0); return; } // older than Max age
    a = ageOf(s);
    float src = float(u_t) - a;
    if (u_view == 2) { o = vec4(src < -1e-3 ? vec3(0.0) : heat(a / float(max(u_M, 1))), 1.0); return; }
    if (src < -1e-3) { o = vec4(subjectOver(u_comp == 0 ? vec3(0.0) : base, base, uv), 1.0); return; } // not online
    src = max(src, 0.0);
    if (u_sharp) c = row(int(floor(src + 0.5)), x);
    else {
      float k0 = floor(src), f = src - k0;
      c = row(int(k0), x);
      if (f > 0.0) c = mix(c, row(int(k0) + 1, x), f);
    }
  }
  if (u_view == 2) { o = vec4(heat(0.0), 1.0); return; }
  if (c.a == 0.0) { o = vec4(subjectOver(u_comp == 0 ? vec3(0.0) : base, base, uv), 1.0); return; } // the row is not there yet
  vec3 col = ageLook(c.rgb, a);
  o = vec4(subjectOver(u_comp == 0 ? col : composite(base, col, u_opacity * decayAlpha(a)), base, uv), 1.0);
}
