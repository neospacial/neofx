// Edge refine, step 1 (plan §9.1, after the clean-up): the mean colour of the sure subject (or of the
// sure background) near each pixel. One direction of a separable sum of (colour × m, m), where m is
// the sure area (the mask made smaller, or the inverse of the mask made larger). u_first: from the
// frame and m; else: the second direction, from the sums of the first.
precision highp float;
uniform highp sampler2D u_in;
uniform highp sampler2DArray u_Y; // the frame, as the store keeps it
uniform highp sampler2DArray u_C;
uniform float u_layer;
uniform bool u_first;
uniform bool u_invert;
uniform vec2 u_dir; // (1, 0) or (0, 1)
uniform int u_r;    // radius (px)
in vec2 v_uv;
out vec4 o;

void main() {
  vec2 size = vec2(textureSize(u_in, 0));
  vec2 px = u_dir / size;
  float stp = max(1.0, float(u_r) / 12.0);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float off = float(i) * stp;
    if (abs(off) > float(u_r)) continue;
    vec2 q = clamp(v_uv + px * off, 0.5 / size, 1.0 - 0.5 / size);
    float w = 1.0 - abs(off) / (float(u_r) + 1.0);
    vec4 v;
    if (u_first) {
      float m = texture(u_in, q).r;
      m = step(0.5, u_invert ? 1.0 - m : m);
      v = vec4(vec3(texture(u_Y, vec3(q, u_layer)).r, texture(u_C, vec3(q, u_layer)).rg) * m, m);
    } else v = texture(u_in, q);
    sum += w * v;
    wsum += w;
  }
  o = sum / wsum;
}
