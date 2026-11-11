// Mask pipeline steps 1–3 (plan §9.1): the methods (background difference, chroma key, luma key;
// each a soft mask), combined (union or intersect), or an imported mask; then the garbage matte.
uniform int u_t;
uniform highp sampler2DArray u_plateY; // the clean plate, YUV as the store (layer 0)
uniform highp sampler2DArray u_plateC;
uniform bool u_bgOn;
uniform float u_lightTol, u_thr, u_soft, u_shadow;
uniform bool u_ckOn;
uniform vec2 u_keyC;                 // the key colour (CbCr)
uniform float u_ckTol, u_ckSoft;
uniform bool u_lkOn;
uniform float u_low, u_high, u_lkSoft;
uniform bool u_lkInvert;
uniform bool u_union;
uniform bool u_imp;                  // imported mask (replaces steps 1–3)
uniform highp sampler2DArray u_impTex;
uniform float u_impLayer;
uniform highp sampler2D u_matte;     // R = always subject, G = never subject
in vec2 v_uv;
out vec4 o;

// 0 below e0, 1 above e1, linear between (a hard step when e0 == e1).
float ramp(float e0, float e1, float x) { return e1 > e0 ? clamp((x - e0) / (e1 - e0), 0.0, 1.0) : step(e0, x); }

void main() {
  vec2 uv = v_uv;
  float m;
  if (u_imp) m = texture(u_impTex, vec3(uv, u_impLayer)).r;
  else {
    // Frame t and the plate as the store keeps them (Y, CbCr): the same 4:2:0 path for both.
    int l = layerOf(u_t);
    vec3 c = l < 0 ? vec3(0.0, 0.5, 0.5) : vec3(texture(u_storeY, vec3(uv, float(l))).r, texture(u_storeC, vec3(uv, float(l))).rg);
    float acc = u_union ? 0.0 : 1.0;
    bool any = false;
    if (u_bgOn) {
      vec3 p = vec3(texture(u_plateY, vec3(uv, 0.0)).r, texture(u_plateC, vec3(uv, 0.0)).rg);
      float dY = abs(c.x - p.x) * (1.0 - u_lightTol);
      float dC = length(c.yz - p.yz);
      float v = ramp(u_thr - 0.5 * u_soft, u_thr + 0.5 * u_soft, length(vec2(dY, 2.0 * dC)));
      if (u_shadow > 0.0 && c.x < p.x && p.x - c.x < u_shadow * p.x && dC < 0.03) v = 0.0; // a shadow
      acc = u_union ? max(acc, v) : min(acc, v);
      any = true;
    }
    if (u_ckOn) {
      float v = ramp(u_ckTol, u_ckTol + u_ckSoft, length(c.yz - u_keyC));
      acc = u_union ? max(acc, v) : min(acc, v);
      any = true;
    }
    if (u_lkOn) {
      float v = ramp(u_low - u_lkSoft, u_low, c.x) * (1.0 - ramp(u_high, u_high + u_lkSoft, c.x));
      if (u_lkInvert) v = 1.0 - v;
      acc = u_union ? max(acc, v) : min(acc, v);
      any = true;
    }
    m = any ? acc : 0.0;
  }
  vec2 g = texture(u_matte, uv).rg;
  m = min(max(m, g.r), 1.0 - g.g);
  o = vec4(m);
}
