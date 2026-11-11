// Copy (and scale) layer 0 of a YUV array plane into a new size (the clean plate, plan §9.2).
precision highp float;
uniform highp sampler2DArray u_in;
in vec2 v_uv;
out vec4 o;

void main() {
  o = texture(u_in, vec3(v_uv, 0.0));
}
