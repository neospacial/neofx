// Map generator (plan §7.3, §7.4, §7.6). Into the raw map texture (one value for each pixel).
// The coordinates: offset -> tile (repeat or mirror) -> animation (rotate, pulse, about the frame
// centre) -> the source: a built-in map (u_type), the custom image / video map, the luma of frame t
// (self), or the motion of frames t-K .. t.
#define PI 3.14159265359
uniform vec2 u_res;
uniform int u_src;      // 0 built-in, 1 custom (image or video)
uniform int u_type;     // MAPS index
uniform float u_k[12];  // the params of the map
uniform float u_phase;  // phase speed × t (cycles)
uniform float u_rot;    // rotation speed × t (degrees)
uniform float u_pulse;  // the pulse scale at t
uniform float u_seed;   // the seed change: floor(t / every)
uniform vec2 u_offset;  // 0..1 of the frame
uniform vec2 u_tile;
uniform bool u_mirror;
uniform int u_t;
// Custom map (R8 array: an image = 1 layer, a video = its frames).
uniform highp sampler2DArray u_custom;
uniform float u_layer;
uniform vec2 u_csize;   // its size in pixels
uniform int u_fit;      // 0 fill, 1 fit, 2 stretch
uniform float u_outside;
uniform vec2 u_pos;     // 0..1 of the frame
uniform float u_scale;
uniform float u_crot;   // degrees
uniform vec2 u_flip;    // -1 or 1
in vec2 v_uv;
out vec4 o;

uint hash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
// 0..1 for an integer cell and a seed.
float rnd(vec2 cell, float seed) {
  return float(hash3(uvec3(ivec3(int(floor(cell.x)) + 32768, int(floor(cell.y)) + 32768, int(seed)))) & 0xffffffu) / 16777216.0;
}
float vnoise(vec2 p, float seed) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rnd(i, seed), rnd(i + vec2(1, 0), seed), u.x), mix(rnd(i + vec2(0, 1), seed), rnd(i + vec2(1, 1), seed), u.x), u.y);
}
vec2 rnd2(vec2 cell, float seed) {
  return vec2(rnd(cell, seed), rnd(cell, seed + 7919.0));
}
// Phase: a clamped ramp (phase 0), or a repeated ramp that moves (phase != 0).
float ramp(float s) {
  return u_phase == 0.0 ? clamp(s, 0.0, 1.0) : fract(s - u_phase);
}
vec2 dir(float deg) {
  float a = radians(deg);
  return vec2(cos(a), sin(a));
}

float builtin(vec2 P) {
  vec2 R = u_res;
  float seed = u_k[3] + u_seed; // where the seed is param 3 (fbm); others set their own below
  if (u_type == 0) { // linear: angle, x, y, width
    vec2 d = dir(u_k[0]);
    float span = abs(R.x * d.x) + abs(R.y * d.y);
    return ramp(dot(P - vec2(u_k[1], u_k[2]) * R, d) / max(u_k[3] * span, 1e-3) + 0.5);
  }
  if (u_type == 1) { // mirrored: angle, x, y, width
    vec2 d = dir(u_k[0]);
    float span = abs(R.x * d.x) + abs(R.y * d.y);
    return ramp(abs(dot(P - vec2(u_k[1], u_k[2]) * R, d)) / max(0.5 * u_k[3] * span, 1e-3));
  }
  vec2 q = (P - vec2(u_k[0], u_k[1]) * R) / R.y; // from the centre, in frame heights
  if (u_type == 2) { // radial: x, y, radius, aspect
    q.x /= u_k[3];
    return ramp(length(q) / u_k[2]);
  }
  if (u_type == 3) { // angular: x, y, start, turns
    float a = atan(q.y, q.x) - radians(u_k[2]);
    return fract(a / (2.0 * PI) * u_k[3] - u_phase);
  }
  if (u_type == 4) { // spiral: x, y, arms, tightness
    float a = atan(q.y, q.x);
    return fract(a / (2.0 * PI) * u_k[2] + length(q) * u_k[3] - u_phase);
  }
  if (u_type == 5) { // box: x, y, size, roundness (0 box, 0.5 circle, 1 diamond)
    float r = u_k[3];
    float n = r < 0.5 ? exp2(4.0 - 6.0 * r) : 2.0 - 2.0 * (r - 0.5);
    vec2 a = abs(q) / u_k[2];
    float m = max(a.x, a.y);
    float norm = m <= 0.0 ? 0.0 : m * pow(pow(a.x / m, n) + pow(a.y / m, n), 1.0 / n);
    return ramp(norm);
  }
  vec2 uv = P / R;
  if (u_type == 6) { // four corners
    float v = mix(mix(u_k[0], u_k[1], uv.x), mix(u_k[2], u_k[3], uv.x), uv.y);
    return u_phase == 0.0 ? v : fract(v - u_phase);
  }
  vec2 h = P / R.y; // frame-height units from the top left
  if (u_type == 7) { // stripes: count, angle, softness, duty
    float f = fract(dot(h, dir(u_k[1])) * u_k[0] - u_phase);
    float duty = u_k[3];
    float f2 = f > 0.5 * (1.0 + duty) ? f - 1.0 : f;
    float e = min(f2, duty - f2);
    return clamp(e / max(u_k[2], 1e-4) + 0.5, 0.0, 1.0);
  }
  if (u_type == 8) { // sine: fx, fy, angle, phase
    vec2 d = dir(u_k[2]);
    float x = dot(h, d), y = dot(h, vec2(-d.y, d.x));
    float ph = u_k[3] + u_phase, s = 0.0, n = 0.0;
    if (u_k[0] > 0.0) { s += sin(2.0 * PI * (u_k[0] * x + ph)); n += 1.0; }
    if (u_k[1] > 0.0) { s += sin(2.0 * PI * (u_k[1] * y + ph)); n += 1.0; }
    return 0.5 + 0.5 * s / max(n, 1.0);
  }
  if (u_type == 9) { // rings: x, y, count, softness
    float f = fract(length(q) * u_k[2] - u_phase);
    return mix(f, 0.5 - 0.5 * cos(2.0 * PI * f), u_k[3]);
  }
  if (u_type == 10) { // checker: cells, softness
    vec2 c = h * u_k[0] + vec2(u_phase, 0.0);
    float s = sin(PI * c.x) * sin(PI * c.y);
    return u_k[1] < 1e-4 ? step(0.0, s) : clamp(0.5 + s / (2.0 * u_k[1]), 0.0, 1.0);
  }
  if (u_type == 11) { // fbm: scale, octaves, roughness, seed
    vec2 p = h * u_k[0] + vec2(u_phase, 0.0);
    float sum = 0.0, amp = 1.0, total = 0.0;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= u_k[1]) break;
      sum += amp * vnoise(p, seed + float(i) * 101.0);
      total += amp;
      amp *= u_k[2];
      p *= 2.0;
    }
    return sum / max(total, 1e-4);
  }
  if (u_type == 12) { // ridged: scale, octaves, seed
    vec2 p = h * u_k[0] + vec2(u_phase, 0.0);
    float sum = 0.0, amp = 1.0, total = 0.0;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= u_k[1]) break;
      float n = 1.0 - abs(2.0 * vnoise(p, u_k[2] + u_seed + float(i) * 101.0) - 1.0);
      sum += amp * n * n;
      total += amp;
      amp *= 0.5;
      p *= 2.0;
    }
    return sum / max(total, 1e-4);
  }
  if (u_type == 13 || u_type == 14) { // worley: scale, seed, metric; voronoi: scale, seed
    vec2 p = h * u_k[0] + vec2(u_phase, 0.0);
    vec2 i = floor(p);
    float best = 1e9, val = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 c = i + vec2(x, y);
      vec2 d = c + rnd2(c, u_k[1] + u_seed) - p;
      float m = u_type == 13 && u_k[2] > 1.5 ? max(abs(d.x), abs(d.y)) : u_type == 13 && u_k[2] > 0.5 ? abs(d.x) + abs(d.y) : length(d);
      if (m < best) { best = m; val = rnd(c, u_k[1] + u_seed + 31.0); }
    }
    return u_type == 13 ? clamp(best, 0.0, 1.0) : val;
  }
  if (u_type == 15) { // blocks: bw, bh, seed
    return rnd(floor((P + vec2(u_phase * u_k[0], 0.0)) / vec2(u_k[0], u_k[1])), u_k[2] + u_seed);
  }
  if (u_type == 16) { // rows: size, direction (1 = columns), seed
    float c = u_k[1] > 0.5 ? P.x : P.y;
    return rnd(vec2(floor(c / u_k[0] + u_phase), 0.0), u_k[2] + u_seed);
  }
  if (u_type == 17) { // bayer: matrix (2^n), base
    int n = int(u_k[0] + 0.5);
    ivec2 ip = ivec2(floor(P));
    int b = 0;
    for (int i = 0; i < 3; i++) {
      if (i >= n) break;
      int sh = n - 1 - i;
      int x = (ip.x >> i) & 1, y = (ip.y >> i) & 1;
      b |= ((x ^ y) << (2 * sh + 1)) | (y << (2 * sh));
    }
    float size = float(1 << (2 * n));
    return u_k[1] > (float(b) + 0.5) / size ? 1.0 : 0.0;
  }
  if (u_type == 18) return lumaAt(u_t, P / R); // self: the luma of frame t
  if (u_type == 19) { // motion: gain, frames
    float s = 0.0;
    int K = int(u_k[1] + 0.5);
    for (int k = 0; k < 8; k++) {
      if (k >= K) break;
      if (layerOf(u_t - k - 1) < 0) break;
      s += abs(lumaAt(u_t - k, P / R) - lumaAt(u_t - k - 1, P / R));
    }
    return clamp(s / float(K) * u_k[0], 0.0, 1.0);
  }
  return 0.0; // subject maps: phase 8
}

float custom(vec2 P) {
  vec2 R = u_res;
  vec2 p = P - R * 0.5 - u_pos * R;
  float a = radians(-u_crot);
  p = mat2(cos(a), sin(a), -sin(a), cos(a)) * p / max(u_scale, 1e-3);
  p *= u_flip;
  vec2 uv;
  if (u_fit == 2) uv = p / R + 0.5;
  else {
    float s = u_fit == 0 ? max(R.x / u_csize.x, R.y / u_csize.y) : min(R.x / u_csize.x, R.y / u_csize.y);
    uv = p / (u_csize * s) + 0.5;
  }
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return u_outside;
  return texture(u_custom, vec3(uv, u_layer)).r;
}

void main() {
  vec2 R = u_res;
  vec2 uv = v_uv + u_offset;
  // Tile: each tile has the full map; mirror: every second tile is flipped.
  vec2 tu = uv * u_tile;
  vec2 f = fract(tu);
  if (u_mirror) f = mix(f, 1.0 - f, mod(floor(tu), 2.0));
  vec2 P = f * R;
  if (u_src == 1) { o = vec4(custom(P)); return; }
  // Animation: rotate and scale about the frame centre.
  vec2 c = R * 0.5;
  float a = radians(-u_rot);
  P = c + mat2(cos(a), sin(a), -sin(a), cos(a)) * (P - c) / u_pulse;
  o = vec4(builtin(P));
}
