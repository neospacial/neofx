// The start screen (plan §12.9): two small example animations, made by the app from a generated test
// pattern (no files to load): a Time Map (a radial delay) and a Slit Scan (a vertical line, Time On).

const W = 160, H = 90, HIST = 48;

// The test pattern of frame t: colour bars that move, and a disc that turns.
function pattern(t, out) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const band = Math.floor(((x + t * 1.5) / 20) % 6);
      const c = [[230, 60, 60], [240, 200, 40], [60, 200, 90], [40, 180, 230], [90, 80, 230], [220, 70, 200]][(band + 6) % 6];
      const cx = W / 2 + 34 * Math.cos(t / 9), cy = H / 2 + 22 * Math.sin(t / 9);
      const inDisc = (x - cx) ** 2 + (y - cy) ** 2 < 120;
      out[i] = inDisc ? 255 : c[0] * 0.8;
      out[i + 1] = inDisc ? 255 : c[1] * 0.8;
      out[i + 2] = inDisc ? 255 : c[2] * 0.8;
      out[i + 3] = 255;
    }
  }
}

export function startDemos(timeCanvas, slitCanvas) {
  if (!timeCanvas || !slitCanvas) return () => {};
  const ring = Array.from({ length: HIST }, () => new Uint8ClampedArray(W * H * 4));
  const cols = Array.from({ length: HIST }, () => new Uint8ClampedArray(H * 4));
  const tc = timeCanvas.getContext('2d'), sc = slitCanvas.getContext('2d');
  const ti = tc.createImageData(W, H), si = sc.createImageData(W, H);
  let t = 0, raf = 0, last = 0;
  const step = (now) => {
    raf = requestAnimationFrame(step);
    if (now - last < 40 || document.body.dataset.state !== 'start') return; // 25 fps, on the start screen only
    last = now;
    const cur = ring[t % HIST];
    pattern(t, cur);
    // The source column (x = 50) of this frame.
    const col = cols[t % HIST];
    for (let y = 0; y < H; y++) col.set(cur.subarray((y * W + 50) * 4, (y * W + 50) * 4 + 4), y * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        // Time Map: the delay grows with the distance from the centre (black before frame 0).
        const d = Math.min(HIST - 1, Math.floor((Math.hypot(x - W / 2, (y - H / 2) * 1.6) / 92) * (HIST - 1)));
        const k = t - d;
        if (k < 0) ti.data.set([0, 0, 0, 255], i);
        else ti.data.set(ring[k % HIST].subarray(i, i + 4), i);
        // Slit Scan: right of the line, column x shows the line of frame t − (x − 50).
        const a = x - 50;
        if (a < 0 || a >= HIST) si.data.set(cur.subarray(i, i + 4), i);
        else if (t - a < 0) si.data.set([0, 0, 0, 255], i);
        else si.data.set(cols[(t - a) % HIST].subarray(y * 4, y * 4 + 4), i);
      }
    }
    tc.putImageData(ti, 0, 0);
    sc.putImageData(si, 0, 0);
    t++;
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
