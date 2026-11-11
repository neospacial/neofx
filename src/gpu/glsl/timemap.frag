// Mode 1, Time Map (plan §7.1). For each pixel: d = map value × Max delay (frames, after the delay
// steps), src = t − d. src < 0: black (not online, D8). Frame blend: mix the two frames around src;
// else the frame t − round(d). Each frame comes from the store at the same pixel. A frame that is not
// in the store is black. u_view: 0 = result, 1 = original (frame t), 2 = the map.
uniform highp sampler2D u_map;
uniform int u_t;
uniform float u_max;
uniform int u_steps;
uniform bool u_blend;
uniform int u_view;
uniform int u_comp;     // effect composite: 0 replace, 1 blend
uniform vec2 u_shift;   // spatial offset at v = 1 (uv units)
in vec2 v_uv;
out vec4 o;

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); // the canvas has its first row at the bottom
  vec3 base = frameAt(u_t, uv).rgb;
  if (u_view == 1) { o = vec4(base, 1.0); return; }
  float v = texture(u_map, uv).r;
  if (u_view == 2) { o = vec4(v, v, v, 1.0); return; }
  if (u_steps > 1) v = min(floor(v * float(u_steps)), float(u_steps - 1)) / float(u_steps - 1);
  float d = v * u_max;
  float src = float(u_t) - d;
  // Not online (D8): black with Replace; transparent (the base shows) with Blend (§10.1).
  if (src < -1e-3) { o = vec4(subjectOver(u_comp == 0 ? vec3(0.0) : base, base, uv), 1.0); return; } // the epsilon: float error of v × Max
  src = max(src, 0.0);
  vec2 suv = uv + v * u_shift; // spatial offset: the delayed pixel also moves
  vec3 c;
  if (u_blend) {
    float k0 = floor(src);
    float f = src - k0;
    c = frameAt(int(k0), suv).rgb;
    if (f > 0.0) c = mix(c, frameAt(int(k0) + 1, suv).rgb, f);
  } else {
    c = frameAt(u_t - int(floor(d + 0.5)), suv).rgb;
  }
  c = ageLook(c, d);
  o = vec4(subjectOver(u_comp == 0 ? c : composite(base, c, u_opacity * decayAlpha(d)), base, uv), 1.0);
}
