// The cutout overlay (painting the matte): the frame with the background dark and violet, the subject
// as it is, and the matte strokes (Always subject: green, Never subject: red).
precision highp float;
uniform highp sampler2D u_in;    // the mask
uniform highp sampler2D u_matte; // R = always subject, G = never subject
uniform highp sampler2DArray u_Y;
uniform highp sampler2DArray u_C;
uniform float u_layer; // < 0: the frame is not in the store
in vec2 v_uv;
out vec4 o;

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  float y = texture(u_Y, vec3(uv, u_layer)).r;
  vec2 c = texture(u_C, vec3(uv, u_layer)).rg - 0.5;
  vec3 rgb = u_layer < 0.0 ? vec3(0.0) : clamp(vec3(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x), 0.0, 1.0);
  float m = texture(u_in, uv).r;
  vec3 col = mix(rgb * 0.3 + vec3(0.22, 0.0, 0.3), rgb, m);
  vec2 g = texture(u_matte, uv).rg;
  col = mix(col, vec3(0.2, 1.0, 0.4), 0.3 * g.r);
  col = mix(col, vec3(1.0, 0.15, 0.15), 0.3 * g.g);
  o = vec4(col, 1.0);
}
