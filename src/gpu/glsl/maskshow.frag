// The Mask view (plan §12.2): the subject mask in white.
precision highp float;
uniform highp sampler2D u_in;
in vec2 v_uv;
out vec4 o;

void main() {
  float m = texture(u_in, vec2(v_uv.x, 1.0 - v_uv.y)).r;
  o = vec4(vec3(m), 1.0);
}
