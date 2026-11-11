#version 300 es
// One triangle that covers the target. v_uv: 0..1, v = 0 at the first row (image top, in texture space).
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
