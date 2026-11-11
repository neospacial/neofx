// Map blur (plan §7.5): one direction of a separable Gaussian (sigma = radius / 2).
precision highp float;
uniform highp sampler2D u_in;
uniform vec2 u_dir; // (1, 0) or (0, 1)
uniform float u_radius;
in vec2 v_uv;
out vec4 o;

void main() {
  ivec2 size = textureSize(u_in, 0);
  ivec2 p = ivec2(floor(v_uv * vec2(size)));
  float sigma = max(u_radius * 0.5, 0.5);
  float sum = 0.0, wsum = 0.0;
  int r = int(ceil(u_radius));
  for (int i = -64; i <= 64; i++) {
    if (i < -r || i > r) continue;
    ivec2 q = clamp(p + ivec2(u_dir) * i, ivec2(0), size - 1);
    float w = exp(-float(i * i) / (2.0 * sigma * sigma));
    sum += w * texelFetch(u_in, q, 0).r;
    wsum += w;
  }
  o = vec4(sum / wsum);
}
