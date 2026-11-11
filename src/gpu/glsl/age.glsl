// Alpha and age (plan §10.3). Age: frames (Mode 1: the delay d).
uniform float u_opacity;
uniform int u_decay;            // 0 full, 1 linear, 2 exponential (half-life), 3 curve
uniform float u_decayLen;       // frames
uniform highp sampler2D u_decayCurve; // 256 x 1: alpha = 1 − curve(age / length)
uniform float u_maxAge;         // the age at "max age" (tint and brightness)
uniform bool u_tintOn;
uniform vec3 u_tint[4];         // new -> old
uniform int u_tintN;            // 2..4
uniform float u_tintAmount;
uniform float u_ageBright;      // the brightness multiplier at max age

float decayAlpha(float age) {
  float u = age / max(u_decayLen, 1e-3);
  if (u_decay == 1) return clamp(1.0 - u, 0.0, 1.0);
  if (u_decay == 2) return exp2(-u);
  if (u_decay == 3) {
    float x = clamp(u, 0.0, 1.0) * 255.0;
    float i = floor(min(x, 254.0));
    return 1.0 - mix(texelFetch(u_decayCurve, ivec2(int(i), 0), 0).r, texelFetch(u_decayCurve, ivec2(int(i) + 1, 0), 0).r, x - i);
  }
  return 1.0;
}

// Age tint (a ramp of 2 to 4 colours, multiplied, by amount) and age brightness.
vec3 ageLook(vec3 c, float age) {
  float u = clamp(age / max(u_maxAge, 1e-3), 0.0, 1.0);
  if (u_tintOn) {
    float x = u * float(u_tintN - 1);
    int i = min(int(floor(x)), u_tintN - 2);
    vec3 t = mix(u_tint[i], u_tint[i + 1], x - float(i));
    c = mix(c, c * t, u_tintAmount);
  }
  return clamp(c * mix(1.0, u_ageBright, u), 0.0, 1.0);
}
