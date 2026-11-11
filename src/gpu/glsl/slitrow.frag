// Slit history (plan §8.3): one row = the pixels of the source line of one frame. The frame is read
// from a YUV array layer (the store, or the staging layer of the analysis pass). Slit width: the
// average of u_width pixels across the line.
precision highp float;
uniform highp sampler2DArray u_Y;
uniform highp sampler2DArray u_C;
uniform float u_layer;
uniform vec2 u_res;   // working size
uniform vec2 u_L, u_d, u_e;
uniform float u_c;
uniform int u_width;
out vec4 o;

vec3 yuvAt(vec2 p) {
  vec2 uv = p / u_res;
  float y = texture(u_Y, vec3(uv, u_layer)).r;
  vec2 c = texture(u_C, vec3(uv, u_layer)).rg - 0.5;
  return clamp(vec3(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x), 0.0, 1.0);
}

void main() {
  float i = floor(gl_FragCoord.x);
  vec2 q = u_L + (i - u_c) * u_e;
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 16; j++) {
    if (j >= u_width) break;
    sum += yuvAt(q + u_d * (float(j) - 0.5 * float(u_width - 1)));
  }
  o = vec4(sum / float(u_width), 1.0);
}
