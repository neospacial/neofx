// Map adjustments (plan §7.5), in the fixed order: levels -> gamma / contrast -> curve -> posterize
// -> invert. (The transform and the tile are in mapgen.frag; the blur is mapblur.frag.)
precision highp float;
uniform highp sampler2D u_in;
uniform highp sampler2D u_curve; // 256 x 1
uniform bool u_useCurve;
uniform float u_black, u_white, u_gamma, u_contrast;
uniform int u_posterize; // 0, or 2..64 levels
uniform bool u_invert;
in vec2 v_uv;
out vec4 o;

void main() {
  float v = texelFetch(u_in, ivec2(floor(v_uv * vec2(textureSize(u_in, 0)))), 0).r;
  v = clamp((v - u_black) / max(u_white - u_black, 1e-4), 0.0, 1.0);
  v = pow(v, 1.0 / max(u_gamma, 1e-3));
  float k = tan((u_contrast + 1.0) * 0.785398); // contrast -1..1 -> slope 0..inf (0 -> 1)
  v = clamp((v - 0.5) * k + 0.5, 0.0, 1.0);
  if (u_useCurve) {
    float x = v * 255.0;
    float i = floor(min(x, 254.0));
    v = mix(texelFetch(u_curve, ivec2(int(i), 0), 0).r, texelFetch(u_curve, ivec2(int(i) + 1, 0), 0).r, x - i);
  }
  if (u_posterize > 1) v = min(floor(v * float(u_posterize)), float(u_posterize - 1)) / float(u_posterize - 1);
  if (u_invert) v = 1.0 - v;
  o = vec4(v);
}
