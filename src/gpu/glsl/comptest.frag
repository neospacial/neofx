// Tests (plan §13.2): the compositor on given colours. u_b: base, u_s: effect (alpha in .a).
uniform highp sampler2D u_b;
uniform highp sampler2D u_s;
in vec2 v_uv;
out vec4 o;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(u_s, p, 0);
  o = vec4(composite(texelFetch(u_b, p, 0).rgb, s.rgb, s.a), 1.0);
}
