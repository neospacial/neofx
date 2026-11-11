// Export settings and the H.264 encoder configuration (plan §3, §11). No browser APIs.

// H.264 levels (ITU-T H.264 Table A-1): [level_idc, max macroblocks for each frame, max macroblocks/s].
const LEVELS = [
  [30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [41, 8192, 245760],
  [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600], [60, 139264, 4177920],
];

// The smallest level for a size and a frame rate (level_idc, for example 40 = 4.0), or null.
export function h264Level(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * Math.max(1, fps);
  for (const [idc, fs, mbps] of LEVELS) if (mbs <= fs && rate <= mbps) return idc;
  return null;
}

const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();

// The codec strings to probe, in order (plan §3): High, then Main, then Baseline, at the level for the
// size and frame rate.
export function codecCandidates(w, h, fps) {
  const lvl = h264Level(w, h, fps);
  if (!lvl) return [];
  return [`avc1.6400${hex2(lvl)}`, `avc1.4D00${hex2(lvl)}`, `avc1.42E0${hex2(lvl)}`];
}

// Quality presets: bits for each pixel for each frame (plan §11.1: High ≈ 0.12).
export const QUALITY = { low: 0.05, medium: 0.08, high: 0.12, veryhigh: 0.2 };

export function bitrateFor(w, h, fps, quality, mbps) {
  if (quality === 'custom') return Math.round(Math.max(0.1, mbps) * 1e6);
  return Math.round(w * h * Math.max(1, fps) * (QUALITY[quality] ?? QUALITY.high));
}

// The export sizes (plan §11.1): Source, then 2160, 1440, 1080, 720, 540 on the short side, never
// above the source. Even numbers. Returns [{ id, label, width, height }].
export function exportSizes(w, h) {
  const out = [{ id: 'source', label: `Source (${w}×${h})`, width: w - (w % 2), height: h - (h % 2) }];
  const short = Math.min(w, h);
  for (const s of [2160, 1440, 1080, 720, 540]) {
    if (s >= short) continue;
    const k = s / short;
    const ww = Math.round((w * k) / 2) * 2, hh = Math.round((h * k) / 2) * 2;
    out.push({ id: String(s), label: `${s}p (${ww}×${hh})`, width: ww, height: hh });
  }
  return out;
}

// The default file name (plan §11.1).
export const exportName = (source) => `${(source || 'video').replace(/\.[^.]+$/, '')}-neofx.mp4`;

// The encoded chunks (decode order) -> MP4 samples. chunks: [{ pts (timescale units), size, key }].
// The decode times are the sorted display times, moved back by the largest reorder delay, so that
// each composition offset is >= 0 (B-frames); mediaTime (the edit list) is that delay.
// lastDuration: the duration of the last frame (display order). Returns { samples, mediaTime }.
export function chunkSamples(chunks, lastDuration) {
  const sorted = chunks.map((c) => c.pts).sort((a, b) => a - b);
  let delay = 0;
  chunks.forEach((c, i) => (delay = Math.max(delay, sorted[i] - c.pts)));
  const dts = sorted.map((p) => p - delay);
  const samples = chunks.map((c, i) => ({
    size: c.size, data: c.data, key: c.key, cto: c.pts - dts[i],
    duration: i + 1 < chunks.length ? dts[i + 1] - dts[i] : lastDuration,
  }));
  return { samples, mediaTime: delay };
}

// Encoded chunks -> source frames (plan §11.2). An encoder can give the chunk timestamps a little
// different from the timestamps of the frames (Safari: VideoToolbox keeps its own time scale, and
// rounds), and in a different order (B-frames). So a chunk is not found by an exact key: it is the
// frame with the nearest timestamp that has no chunk yet, within half of the frame interval.
export class FrameMatcher {
  constructor() {
    this.us = []; // the timestamps of the frames given to the encoder (increasing)
    this.t = []; // their frame indices
    this.used = [];
  }

  add(us, t) {
    this.us.push(us);
    this.t.push(t);
    this.used.push(false);
  }

  // The frame index of a chunk timestamp, or -1.
  match(ts) {
    const U = this.us;
    if (!U.length) return -1;
    let lo = 0, hi = U.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (U[m] < ts) lo = m + 1;
      else hi = m;
    }
    let best = -1, bd = Infinity;
    for (let i = Math.max(0, lo - 2); i <= Math.min(U.length - 1, lo + 2); i++) {
      if (this.used[i]) continue;
      const d = Math.abs(U[i] - ts);
      if (d < bd) [best, bd] = [i, d];
    }
    if (best < 0) return -1;
    const gap = Math.min(best > 0 ? U[best] - U[best - 1] : Infinity, best + 1 < U.length ? U[best + 1] - U[best] : Infinity);
    if (bd > Math.max(1000, (Number.isFinite(gap) ? gap : 1e6) / 2)) return -1;
    this.used[best] = true;
    return this.t[best];
  }
}

// A sample list that the muxer can write: whole, positive durations and offsets. Else the reason.
export function checkSamples(samples) {
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isInteger(s.duration) || s.duration <= 0) return `frame ${i} has the duration ${s.duration}`;
    if (!Number.isInteger(s.cto ?? 0) || (s.cto ?? 0) < 0) return `frame ${i} has the time offset ${s.cto}`;
  }
  return '';
}
