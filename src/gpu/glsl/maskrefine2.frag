// Edge refine, step 2: in the band about the mask edge (between the mask made smaller and the mask
// made larger), a pixel is subject when its colour is nearer to the subject colours near it than to
// the background colours near it. Where the two are the same colour, the mask stays as it is.
precision highp float;
uniform highp sampler2D u_in;  // the mask
uniform highp sampler2D u_fg;  // sums of the sure subject (colour × m, m)
uniform highp sampler2D u_bg;  // sums of the sure background
uniform highp sampler2D u_ero; // the mask made smaller
uniform highp sampler2D u_dil; // the mask made larger
uniform highp sampler2DArray u_Y;
uniform highp sampler2DArray u_C;
uniform float u_layer;
uniform float u_soft; // the softness of the new edge
in vec2 v_uv;
out vec4 o;

void main() {
  float m = texture(u_in, v_uv).r;
  o = vec4(m);
  if (texture(u_ero, v_uv).r > 0.5 || texture(u_dil, v_uv).r < 0.5) return; // not in the band
  vec4 F = texture(u_fg, v_uv), B = texture(u_bg, v_uv);
  if (F.a < 0.02 || B.a < 0.02) return; // no sure subject or background near
  vec3 k = vec3(1.0, 2.0, 2.0); // the colour difference counts more than the brightness
  vec3 c = vec3(texture(u_Y, vec3(v_uv, u_layer)).r, texture(u_C, vec3(v_uv, u_layer)).rg) * k;
  vec3 f = F.rgb / F.a * k, b = B.rgb / B.a * k;
  float dF = length(c - f), dB = length(c - b);
  float a = smoothstep(0.5 - u_soft, 0.5 + u_soft, dB / (dF + dB + 1e-4));
  o = vec4(mix(m, a, clamp(length(f - b) * 8.0 - 0.2, 0.0, 1.0)));
}
