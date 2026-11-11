// Mode 1, Time Map (plan §7.1). For each pixel: d = map value × Max delay (frames, after the delay
// steps), src = t − d. src < 0: black (not online, D8). Frame blend: mix the two frames around src;
// else the frame t − round(d). Each frame comes from the store at the same pixel. A frame that is not
// in the store is black. u_view: 0 = result, 1 = original (frame t), 2 = the map.
uniform sampler2D u_map;
uniform highp isampler2D u_layers; // N x 1: the frame index in each store layer
uniform int u_n;
uniform int u_t;
uniform float u_max;
uniform int u_steps;
uniform bool u_blend;
uniform int u_view;
in vec2 v_uv;
out vec4 o;

// The color of frame k at uv, and in.a = 1 when frame k is in the store.
vec4 frameAt(int k, vec2 uv) {
  if (k < 0) return vec4(0.0);
  int l = k % u_n;
  if (texelFetch(u_layers, ivec2(l, 0), 0).r != k) return vec4(0.0);
  return vec4(storeRgb(uv, float(l)), 1.0);
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); // the canvas has its first row at the bottom
  if (u_view == 1) { o = vec4(frameAt(u_t, uv).rgb, 1.0); return; }
  float v = texture(u_map, uv).r;
  if (u_view == 2) { o = vec4(v, v, v, 1.0); return; }
  if (u_steps > 1) v = min(floor(v * float(u_steps)), float(u_steps - 1)) / float(u_steps - 1);
  float d = v * u_max;
  float src = float(u_t) - d;
  if (src < -1e-3) { o = vec4(0.0, 0.0, 0.0, 1.0); return; } // the epsilon: float error of v × Max
  src = max(src, 0.0);
  vec3 c;
  if (u_blend) {
    float k0 = floor(src);
    float f = src - k0;
    c = frameAt(int(k0), uv).rgb;
    if (f > 0.0) c = mix(c, frameAt(int(k0) + 1, uv).rgb, f);
  } else {
    c = frameAt(u_t - int(floor(d + 0.5)), uv).rgb;
  }
  o = vec4(c, 1.0);
}
