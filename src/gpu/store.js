// Frame store sizes (plan §6.3, §6.4). No browser APIs, so Node tests can use it.

export const MAX_STORE_LAYERS = 1000;
export const BUDGET_DESKTOP = 1024 * 1048576;
export const BUDGET_ANDROID = 384 * 1048576;
// iPhone / iPad: the GPU memory counts in the memory limit of the Safari tab (WebKit, also Opera
// and Chrome on iOS); above it, the tab is reset (the page flashes, the GPU context is lost).
export const BUDGET_IOS = 256 * 1048576;

// The working size for a display size and a short side (0 = source). Never above the source. Even.
export function workingSize(w, h, short) {
  const s = short ? Math.min(1, short / Math.min(w, h)) : 1;
  return { width: Math.max(2, Math.round((w * s) / 2) * 2), height: Math.max(2, Math.round((h * s) / 2) * 2) };
}

// YUV 4:2:0 in the store: Y (R8, full size) + CbCr (RG8, half size) = 1.5 bytes for each pixel.
export const frameBytes = (w, h) => w * h + 2 * (w / 2) * (h / 2);

// iPadOS gives a Mac user agent: a Mac with touch points is an iPad.
export const isIOS = (userAgent = '', touchPoints = 0) => /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1);

export const defaultBudget = (userAgent = '', touchPoints = 0) => {
  if (isIOS(userAgent, touchPoints)) return BUDGET_IOS;
  return /Android/i.test(userAgent) ? BUDGET_ANDROID : BUDGET_DESKTOP;
};

// N = min(MAX_ARRAY_TEXTURE_LAYERS, floor(budget / bytesPerFrame), 1000), at least 1.
export function layerCount(budget, maxLayers, w, h) {
  return Math.max(1, Math.min(maxLayers, Math.floor(budget / frameBytes(w, h)), MAX_STORE_LAYERS));
}

// "Buffer: 240 frames at 540p (≈ 330 MB)".
export function bufferText(n, w, h) {
  return `Buffer: ${n} frames at ${Math.min(w, h)}p (≈ ${Math.round((n * frameBytes(w, h)) / 1048576)} MB)`;
}
