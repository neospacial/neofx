#version 300 es
// Store upload (plan §6.3): the source frame (RGB, as the browser gives it), turned to the display
// orientation and scaled to the working size, to BT.709 full-range Y (u_mode 0) or CbCr (u_mode 1).
precision highp float;
uniform sampler2D u_src;
uniform int u_rot;   // 0, 90, 180, 270: clockwise turn of the display picture
uniform int u_mode;
in vec2 v_uv;
out vec4 o;

vec2 srcUv(vec2 d) {
  if (u_rot == 90) return vec2(d.y, 1.0 - d.x);
  if (u_rot == 180) return vec2(1.0 - d.x, 1.0 - d.y);
  if (u_rot == 270) return vec2(1.0 - d.y, d.x);
  return d;
}

void main() {
  vec3 c = texture(u_src, srcUv(v_uv)).rgb;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (u_mode == 0) o = vec4(y, 0.0, 0.0, 1.0);
  else o = vec4((c.b - y) / 1.8556 + 0.5, (c.r - y) / 1.5748 + 0.5, 0.0, 1.0);
}
