// Jump flooding (Subject distance map, plan §7.3): the nearest subject pixel of each pixel.
// u_init: the seeds (mask >= 0.5) -> own position; else (-1, -1). Then steps of u_k pixels.
precision highp float;
uniform highp sampler2D u_in;  // init: the mask; else RG = the nearest seed (pixels), -1 = none
uniform bool u_init;
uniform int u_k;
in vec2 v_uv;
out vec4 o;

void main() {
  ivec2 size = textureSize(u_in, 0);
  ivec2 p = ivec2(floor(v_uv * vec2(size)));
  vec2 pc = vec2(p) + 0.5;
  if (u_init) {
    o = texelFetch(u_in, p, 0).r >= 0.5 ? vec4(pc, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 1.0);
    return;
  }
  vec2 best = vec2(-1.0);
  float bd = 1e20;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = p + ivec2(x, y) * u_k;
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) continue;
    vec2 s = texelFetch(u_in, q, 0).rg;
    if (s.x < 0.0) continue;
    float d = dot(s - pc, s - pc);
    if (d < bd) { bd = d; best = s; }
  }
  o = vec4(best, 0.0, 1.0);
}
