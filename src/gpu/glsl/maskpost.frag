// Mask pipeline (plan §9.1): the fill-holes / keep-largest fix (step 4, from the CPU pass), or the
// temporal smooth with hysteresis (step 6).
precision highp float;
uniform highp sampler2D u_in;
uniform bool u_doFix;
uniform highp sampler2D u_fix;  // R = fill, G = remove (small size)
uniform bool u_doTemporal;
uniform bool u_usePrev;
uniform highp sampler2D u_prev;
uniform float u_smooth;
uniform bool u_hyst;
uniform float u_tLow, u_tHigh;
in vec2 v_uv;
out vec4 o;

void main() {
  float m = texelFetch(u_in, ivec2(floor(v_uv * vec2(textureSize(u_in, 0)))), 0).r;
  if (u_doFix) {
    vec2 f = texture(u_fix, v_uv).rg;
    if (f.r > 0.5) m = 1.0;
    if (f.g > 0.5) m = 0.0;
  }
  if (u_doTemporal) {
    float p = u_usePrev ? texture(u_prev, v_uv).r : 0.0;
    if (u_usePrev) m = mix(m, p, u_smooth);
    if (u_hyst) m = (u_usePrev && p > 0.5) ? step(u_tLow, m) : step(u_tHigh, m);
  }
  o = vec4(m);
}
