// Preview of one stored frame (Original view; the debug delay view of phase 3). u_layer < 0: black
// (the frame is not in the store, or it is before frame 0: "not online", D8).
uniform float u_layer;
in vec2 v_uv;
out vec4 o;

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); // the canvas has its first row at the bottom
  o = u_layer < 0.0 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(storeRgb(uv, u_layer), 1.0);
}
