// The start screen (plan §12.9): two small example animations, made by the app from a generated test
// pattern (no files to load): a Time Map (a radial delay) and a Slit Scan (a vertical line, Time On).

const W = 160, H = 90, HIST = 48;
const LINE_X = 50; // the source column of the Slit Scan example

// A colour as one 32-bit pixel of an ImageData (the byte order of the device).
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const rgb = (r, g, b) => (LITTLE ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
const BLACK = rgb(0, 0, 0), WHITE = rgb(255, 255, 255);
const BANDS = [[230, 60, 60], [240, 200, 40], [60, 200, 90], [40, 180, 230], [90, 80, 230], [220, 70, 200]].map((c) => rgb(Math.round(c[0] * 0.8), Math.round(c[1] * 0.8), Math.round(c[2] * 0.8)));

// The test pattern of frame t: colour bars that move, and a disc that turns. out: W × H pixels.
function pattern(t, out) {
  const cx = W / 2 + 34 * Math.cos(t / 9), cy = H / 2 + 22 * Math.sin(t / 9);
  for (let x = 0; x < W; x++) {
    const band = BANDS[(Math.floor(((x + t * 1.5) / 20) % 6) + 6) % 6];
    const dx2 = (x - cx) ** 2;
    for (let y = 0; y < H; y++) out[y * W + x] = dx2 + (y - cy) ** 2 < 120 ? WHITE : band;
  }
}

// The Time Map delay of each pixel: it grows with the distance from the centre.
const DELAY = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) DELAY[y * W + x] = Math.min(HIST - 1, Math.floor((Math.hypot(x - W / 2, (y - H / 2) * 1.6) / 92) * (HIST - 1)));
}

// Returns { start(), stop() }: the animations run only between start and stop (the start screen).
export function startDemos(timeCanvas, slitCanvas) {
  if (!timeCanvas || !slitCanvas) return { start() {}, stop() {} };
  const ring = Array.from({ length: HIST }, () => new Uint32Array(W * H));
  const cols = Array.from({ length: HIST }, () => new Uint32Array(H));
  const tc = timeCanvas.getContext('2d'), sc = slitCanvas.getContext('2d');
  const ti = tc.createImageData(W, H), si = sc.createImageData(W, H);
  const tp = new Uint32Array(ti.data.buffer), sp = new Uint32Array(si.data.buffer);
  let t = 0, raf = 0, last = 0;
  const step = (now) => {
    raf = requestAnimationFrame(step);
    if (now - last < 40) return; // 25 fps
    last = now;
    const cur = ring[t % HIST];
    pattern(t, cur);
    // The source column of this frame.
    const col = cols[t % HIST];
    for (let y = 0; y < H; y++) col[y] = cur[y * W + LINE_X];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        // Time Map: the frame t − delay (black before frame 0).
        const k = t - DELAY[i];
        tp[i] = k < 0 ? BLACK : ring[k % HIST][i];
        // Slit Scan: right of the line, column x shows the line of frame t − (x − LINE_X).
        const a = x - LINE_X;
        if (a < 0 || a >= HIST) sp[i] = cur[i];
        else sp[i] = t - a < 0 ? BLACK : cols[(t - a) % HIST][y];
      }
    }
    tc.putImageData(ti, 0, 0);
    sc.putImageData(si, 0, 0);
    t++;
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const start = () => {
    if (!raf) raf = requestAnimationFrame(step);
  };
  start();
  return { start, stop };
}
