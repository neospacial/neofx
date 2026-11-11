// Read the frame store (plan §6.3): Y and CbCr layers -> RGB (BT.709 full range).
uniform highp sampler2DArray u_storeY;
uniform highp sampler2DArray u_storeC;
uniform highp isampler2D u_layers; // N x 1: the frame index in each store layer
uniform int u_n;

vec3 storeRgb(vec2 uv, float layer) {
  float y = texture(u_storeY, vec3(uv, layer)).r;
  vec2 c = texture(u_storeC, vec3(uv, layer)).rg - 0.5;
  return clamp(vec3(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x), 0.0, 1.0);
}

// The layer of frame k, or -1 when frame k is not in the store (or k < 0).
int layerOf(int k) {
  if (k < 0 || u_n < 1) return -1;
  int l = k % u_n;
  return texelFetch(u_layers, ivec2(l, 0), 0).r == k ? l : -1;
}

// The colour of frame k at uv, and a = 1 when frame k is in the store (else black, a = 0).
vec4 frameAt(int k, vec2 uv) {
  int l = layerOf(k);
  return l < 0 ? vec4(0.0) : vec4(storeRgb(uv, float(l)), 1.0);
}

// The luma of frame k at uv (0 when not in the store).
float lumaAt(int k, vec2 uv) {
  int l = layerOf(k);
  return l < 0 ? 0.0 : texture(u_storeY, vec3(uv, float(l))).r;
}
