#version 300 es
// Edge source trail (plan §8.4): one quad for each (row r, emitter k, age a). The emitter k of frame
// t − a is at x_e + S(a). Join it to the emitter k of frame t − a − 1 at x_e' + S(a + 1) when
// |x_e − x_e'| < the join limit; else a point (1 px). Depth = age: the youngest pixel wins.
precision highp float;
precision highp int;
uniform highp sampler2D u_pos;     // R x (H K): x' of each emitter
uniform highp sampler2D u_col;
uniform highp isampler2D u_frames; // H x 1: the frame of each slot
uniform highp sampler2D u_S;       // the distance table, 1024 wide
uniform int u_t, u_H, u_K, u_M;
uniform float u_D;
uniform float u_join;
flat out vec4 v_col;
flat out float v_age;

float S(int i) { return texelFetch(u_S, ivec2(i % 1024, i / 1024), 0).r; }
// The x' of emitter k of frame f in row r, or −1e6.
float xe(int r, int f, int k) {
  if (f < 0) return -1e6;
  int slot = f % u_H;
  if (texelFetch(u_frames, ivec2(slot, 0), 0).r != f) return -1e6;
  return texelFetch(u_pos, ivec2(r, slot * u_K + k), 0).r;
}

void main() {
  int id = gl_InstanceID;
  int a = id % u_M;
  int k = (id / u_M) % u_K;
  int r = id / (u_M * u_K);
  int f = u_t - a;
  float x0 = xe(r, f, k);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside: nothing
  v_col = vec4(0.0);
  v_age = float(a);
  if (x0 < -1e5) return;
  float X0 = x0 + S(a), X1 = X0;
  float x1 = xe(r, f - 1, k);
  if (x1 > -1e5 && abs(x1 - x0) < u_join) X1 = x1 + S(a + 1);
  float lo = min(X0, X1) - 0.5 + 0.5 * u_D, hi = max(X0, X1) + 0.5 + 0.5 * u_D;
  int v = gl_VertexID;
  float x = (v == 0 || v == 3 || v == 5) ? lo : hi;
  float y = (v == 0 || v == 1 || v == 3) ? float(r) : float(r + 1);
  gl_Position = vec4(x / u_D * 2.0 - 1.0, y / u_D * 2.0 - 1.0, float(a) / float(u_M + 1) * 2.0 - 1.0, 1.0);
  int slot = f % u_H;
  v_col = texelFetch(u_col, ivec2(r, slot * u_K + k), 0);
}
