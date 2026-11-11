#version 300 es
// Built-in map (plan §7.3): Linear. The map value v (0..1) for each pixel of the working size.
// Linear: v grows along the direction of 'angle' (0° = to the right, 90° = down). The point (x, y)
// (0..1 of the frame) has v = 0.5. 'width' = the length of the ramp, as a part of the frame extent
// along that direction (1 = the full frame).
precision highp float;
uniform vec2 u_res;
uniform float u_angle; // degrees
uniform vec2 u_center; // 0..1
uniform float u_width;
in vec2 v_uv;
out vec4 o;

void main() {
  vec2 p = v_uv * u_res; // pixel centre, first row at the top
  float a = radians(u_angle);
  vec2 d = vec2(cos(a), sin(a));
  float span = abs(u_res.x * d.x) + abs(u_res.y * d.y);
  float v = clamp(dot(p - u_center * u_res, d) / max(u_width * span, 1e-3) + 0.5, 0.0, 1.0);
  o = vec4(v, v, v, 1.0);
}
