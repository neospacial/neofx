// Garbage matte brush (plan §9.1 step 3): a stroke (a polyline of up to 64 points, in pixels of the
// matte) into the matte. R = always subject, G = never subject. u_mode: 0 always, 1 never, 2 erase.
precision highp float;
uniform highp sampler2D u_in;
uniform vec2 u_pts[64];
uniform int u_np;
uniform float u_radius;
uniform float u_hardness;
uniform int u_mode;
in vec2 v_uv;
out vec4 o;

void main() {
  vec2 size = vec2(textureSize(u_in, 0));
  vec2 p = v_uv * size;
  float d = 1e9;
  for (int i = 0; i < 64; i++) {
    if (i >= u_np) break;
    vec2 a = u_pts[i], b = u_pts[min(i + 1, u_np - 1)];
    vec2 ab = b - a;
    float h = dot(ab, ab) > 0.0 ? clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0) : 0.0;
    d = min(d, length(p - a - ab * h));
  }
  float inner = u_radius * u_hardness;
  float a = 1.0 - clamp((d - inner) / max(u_radius - inner, 1e-3), 0.0, 1.0);
  vec2 g = texelFetch(u_in, ivec2(floor(p)), 0).rg;
  if (u_mode == 0) g = vec2(max(g.r, a), g.g * (1.0 - a));
  else if (u_mode == 1) g = vec2(g.r * (1.0 - a), max(g.g, a));
  else g *= 1.0 - a;
  o = vec4(g, 0.0, 1.0);
}
