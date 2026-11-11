// Mask clean-up on a small copy (plan §9.1 step 4): Fill holes and Keep largest region.
// b: Uint8Array of 0/1 (w x h). Returns { fill, remove }: Uint8Array of 0/1 (the pixels to set to
// subject, and to background). 4-connected regions.

function regions(b, w, h, value) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [], border = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (b[i] !== value || label[i] >= 0) continue;
    const id = sizes.length;
    let n = 0, top = 0, edge = false;
    stack[top++] = i;
    label[i] = id;
    while (top) {
      const p = stack[--top];
      n++;
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && b[p - 1] === value && label[p - 1] < 0) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && b[p + 1] === value && label[p + 1] < 0) { label[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && b[p - w] === value && label[p - w] < 0) { label[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && b[p + w] === value && label[p + w] < 0) { label[p + w] = id; stack[top++] = p + w; }
    }
    sizes.push(n);
    border.push(edge);
  }
  return { label, sizes, border };
}

// fillPercent: fill the background regions that do not touch the border and are smaller than this
// part of the frame (0 = off). keepLargest: remove all subject regions but the largest.
export function cleanRegions(b, w, h, fillPercent, keepLargest) {
  const fill = new Uint8Array(w * h), remove = new Uint8Array(w * h);
  if (fillPercent > 0) {
    const r = regions(b, w, h, 0);
    const max = (fillPercent / 100) * w * h;
    for (let i = 0; i < w * h; i++) {
      const id = r.label[i];
      if (id >= 0 && !r.border[id] && r.sizes[id] < max) fill[i] = 1;
    }
  }
  if (keepLargest) {
    const c = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) c[i] = b[i] || fill[i] ? 1 : 0;
    const r = regions(c, w, h, 1);
    let best = -1;
    r.sizes.forEach((n, id) => {
      if (best < 0 || n > r.sizes[best]) best = id;
    });
    for (let i = 0; i < w * h; i++) if (r.label[i] >= 0 && r.label[i] !== best) remove[i] = 1;
  }
  return { fill, remove };
}
