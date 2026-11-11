// Edge source emitters (plan §8.4). The rotated space: a square of u_D x u_D px about the frame
// centre; x' along the scan direction u_d, y' along u_e. Each fragment is (row r, emitter k) of one
// frame: march the row, find the k-th place where the mask goes from inside (>= 0.5) to outside
// along +x'. Out 0: x' of the edge (sub-pixel; −1e6 = no emitter). Out 1: the colour of the last
// subject pixel.
precision highp float;
precision highp int;
uniform highp sampler2D u_mask;
uniform highp sampler2DArray u_Y;
uniform highp sampler2DArray u_C;
uniform float u_layer;
uniform vec2 u_res;
uniform vec2 u_d, u_e;
uniform float u_D;
uniform int u_K;
uniform int u_slot;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oCol;

float maskAt(vec2 p) {
  if (p.x < 0.0 || p.y < 0.0 || p.x >= u_res.x || p.y >= u_res.y) return 0.0;
  return texture(u_mask, p / u_res).r;
}

vec3 rgbAt(vec2 p) {
  vec2 uv = p / u_res;
  float y = texture(u_Y, vec3(uv, u_layer)).r;
  vec2 c = texture(u_C, vec3(uv, u_layer)).rg - 0.5;
  return clamp(vec3(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x), 0.0, 1.0);
}

void main() {
  int r = int(gl_FragCoord.x);
  int k = int(gl_FragCoord.y) - u_slot * u_K;
  vec2 c = u_res * 0.5;
  float yp = float(r) + 0.5 - 0.5 * u_D;
  vec2 base = c + yp * u_e;
  int n = int(u_D);
  int found = 0;
  float prev = maskAt(base + (0.5 - 0.5 * u_D) * u_d);
  for (int i = 0; i < 8192; i++) {
    if (i + 1 >= n) break;
    float x0 = float(i) + 0.5 - 0.5 * u_D;
    float m1 = maskAt(base + (x0 + 1.0) * u_d);
    if (prev >= 0.5 && m1 < 0.5) {
      if (found == k) {
        oPos = vec4(x0 + (prev - 0.5) / max(prev - m1, 1e-4), 0.0, 0.0, 1.0);
        oCol = vec4(rgbAt(base + x0 * u_d), 1.0);
        return;
      }
      found++;
    }
    prev = m1;
  }
  oPos = vec4(-1e6, 0.0, 0.0, 1.0);
  oCol = vec4(0.0);
}
