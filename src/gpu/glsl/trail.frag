// The trail texture: rgb = the emitter colour, a = coverage and age (0 = empty; else 0.02 + 0.98 age/M).
precision highp float;
precision highp int;
uniform int u_M;
flat in vec4 v_col;
flat in float v_age;
out vec4 o;

void main() {
  o = vec4(v_col.rgb, 0.02 + 0.98 * v_age / float(max(u_M, 1)));
}
