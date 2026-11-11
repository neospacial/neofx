// Clean plate (plan §9.2): the median of each pixel and channel over frames that are evenly spaced
// over the video. A moving subject is in each pixel for less than half of the frames, so the median
// is the empty scene. The app gives the planes of the frames as the store keeps them (Y, CbCr), so
// that the background difference compares like with like.

export const PLATE_FRAMES = 31;

// The frame indices for a video of n frames.
export function plateIndices(n, count = PLATE_FRAMES) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(n - 1, Math.round(((i + 0.5) * n) / count - 0.5));
    if (!out.length || out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

// arrays: Uint8Arrays of the same length (one for each frame). The median of each element.
export function medianBytes(arrays) {
  const n = arrays.length;
  const len = arrays[0].length;
  const out = new Uint8Array(len);
  const v = new Uint8Array(n);
  const mid = n >> 1;
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < n; k++) v[k] = arrays[k][i];
    // Insertion sort (n is small).
    for (let a = 1; a < n; a++) {
      const x = v[a];
      let b = a - 1;
      while (b >= 0 && v[b] > x) {
        v[b + 1] = v[b];
        b--;
      }
      v[b + 1] = x;
    }
    out[i] = n % 2 ? v[mid] : (v[mid - 1] + v[mid] + 1) >> 1;
  }
  return out;
}
