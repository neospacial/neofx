// Read the frame store (plan §6.3): Y and CbCr layers -> RGB (BT.709 full range).
uniform highp sampler2DArray u_storeY;
uniform highp sampler2DArray u_storeC;

vec3 storeRgb(vec2 uv, float layer) {
  float y = texture(u_storeY, vec3(uv, layer)).r;
  vec2 c = texture(u_storeC, vec3(uv, layer)).rg - 0.5;
  return clamp(vec3(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x), 0.0, 1.0);
}
