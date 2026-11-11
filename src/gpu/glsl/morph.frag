// Morphology (plan §9.1 steps 4, 5): one direction of a separable min (erode) or max (dilate) filter.
precision highp float;
uniform highp sampler2D u_in;
uniform vec2 u_dir;
uniform int u_r;
uniform bool u_max;
in vec2 v_uv;
out vec4 o;

void main() {
  ivec2 size = textureSize(u_in, 0);
  ivec2 p = ivec2(floor(v_uv * vec2(size)));
  float v = texelFetch(u_in, p, 0).r;
  for (int i = 1; i <= 64; i++) {
    if (i > u_r) break;
    float a = texelFetch(u_in, clamp(p + ivec2(u_dir) * i, ivec2(0), size - 1), 0).r;
    float b = texelFetch(u_in, clamp(p - ivec2(u_dir) * i, ivec2(0), size - 1), 0).r;
    v = u_max ? max(v, max(a, b)) : min(v, min(a, b));
  }
  o = vec4(v);
}
