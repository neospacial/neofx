// The subject layer (plan §9.4, §10.4): the current frame × the subject mask, on top of the result,
// with its own blend mode and opacity, an optional outline, and spill suppression (chroma key).
uniform bool u_subOn;
uniform highp sampler2D u_subMask;
uniform highp sampler2D u_outline;  // the subject mask, dilated by the outline width
uniform bool u_outlineOn;
uniform vec3 u_outlineColor;
uniform float u_subOpacity;
uniform int u_subBlend;
uniform float u_spill;
uniform vec3 u_keyRgb;

vec3 despill(vec3 c) {
  vec3 k = u_keyRgb - dot(u_keyRgb, vec3(0.2126, 0.7152, 0.0722));
  float n = length(k);
  if (n < 1e-3 || u_spill <= 0.0) return c;
  k /= n;
  float a = max(0.0, dot(c - dot(c, vec3(0.2126, 0.7152, 0.0722)), k));
  return clamp(c - k * a * u_spill, 0.0, 1.0);
}

vec3 subjectOver(vec3 result, vec3 subj, vec2 uv) {
  if (!u_subOn) return result;
  float m = texture(u_subMask, uv).r;
  vec3 r = compositeWith(result, despill(subj), m * u_subOpacity, u_subBlend, u_linear);
  if (u_outlineOn) r = mix(r, u_outlineColor, clamp(texture(u_outline, uv).r - m, 0.0, 1.0));
  return r;
}
