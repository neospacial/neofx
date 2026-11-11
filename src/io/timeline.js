// The frame timeline of a file (plan §5.2, §6.1, §6.2). No browser APIs, so Node tests can use it.
// Frame t is the t-th presented frame in display order. Samples before the edit list start (us < 0)
// are decoded as references, but they are not frames of the timeline.

// The decoder configuration for a demuxMp4 result.
export function decoderConfig(d) {
  return { codec: d.codec, codedWidth: d.codedWidth, codedHeight: d.codedHeight, ...(d.description ? { description: d.description } : {}) };
}

// The display size (after the tkhd rotation).
export function displaySize(d) {
  return d.rotation % 180 ? { width: d.codedHeight, height: d.codedWidth } : { width: d.codedWidth, height: d.codedHeight };
}

const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

// Returns { frames: [{ us, dur, sample }], fps, durationUs, keys, indexOfUs: Map }.
// sample: the decode index of the frame's sample. dur: microseconds to the next frame.
export function buildTimeline(d) {
  const S = d.samples;
  const order = [];
  for (let i = 0; i < S.length; i++) if (S[i].us >= 0) order.push(i);
  order.sort((a, b) => S[a].us - S[b].us);
  const frames = order.map((i) => ({ us: S[i].us, dur: 0, sample: i }));
  for (let t = 0; t + 1 < frames.length; t++) frames[t].dur = frames[t + 1].us - frames[t].us;
  const med = median(frames.slice(0, -1).map((f) => f.dur).filter((x) => x > 0));
  if (frames.length) {
    const last = frames[frames.length - 1];
    const s = S[last.sample];
    last.dur = s.duration && d.timescale ? Math.round((s.duration * 1e6) / d.timescale) : med || 33333;
  }
  const fps = med ? 1e6 / med : frames.length ? 1e6 / frames[0].dur : 30;
  const keys = [];
  for (let i = 0; i < S.length; i++) if (S[i].key) keys.push(i);
  const indexOfUs = new Map(frames.map((f, t) => [f.us, t]));
  const end = frames.length ? frames[frames.length - 1].us + frames[frames.length - 1].dur : 0;
  return { frames, fps, durationUs: end, keys, indexOfUs, samples: S };
}

// The decode index of the sync sample to start from, to show frame t: the last sync sample at or
// before the frame's sample (decode order), with a display time at or before the frame.
export function keyBefore(tl, t) {
  const f = tl.frames[t];
  const K = tl.keys;
  let lo = 0, hi = K.length - 1, k = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (K[m] <= f.sample) {
      k = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  while (k > 0 && tl.samples[K[k]].us > f.us) k--;
  return K[k];
}

// The decode work for a sorted list of frame indices: [{ start, end, frames }]. Each segment decodes
// the samples start..end (decode order, inclusive) from a sync sample, then flushes. A frame joins the
// current segment when the decode of that segment gets to its sync sample without a jump.
export function planSegments(tl, indices) {
  const out = [];
  let cur = null;
  for (const t of indices) {
    const k = keyBefore(tl, t);
    const e = tl.frames[t].sample;
    if (cur && k >= cur.start && k <= cur.end + 1) {
      cur.end = Math.max(cur.end, e);
      cur.frames.push(t);
    } else {
      cur = { start: k, end: e, frames: [t] };
      out.push(cur);
    }
  }
  return out;
}

// The frame index at a time (microseconds): the last frame that starts at or before it.
export function frameAtUs(tl, us) {
  const F = tl.frames;
  let lo = 0, hi = F.length - 1, r = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (F[m].us <= us) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}

// Evenly spaced frame indices for the timeline thumbnails (one for each 2 %: count 50).
export function thumbIndices(n, count = 50) {
  const out = [];
  for (let i = 0; i < count && n; i++) {
    const t = Math.min(n - 1, Math.floor(((i + 0.5) * n) / count));
    if (!out.length || out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

// Is this sync sample a clean start for a decoder (H.264 IDR; HEVC IDR or BLA)? An open-GOP I-frame
// (H.264 recovery point, HEVC CRA) is a sync sample in the file, but Chrome's decoder does not start
// there. data: the first bytes of the sample (length-prefixed NAL units). Other codecs: true.
export function isCleanStart(d, data) {
  const avc = /^avc[13]\./.test(d.codec), hevc = /^(hvc1|hev1)\./.test(d.codec);
  if (!(avc || hevc) || !d.description) return true;
  const len = avc ? (d.description[4] & 3) + 1 : (d.description[21] & 3) + 1;
  for (let o = 0; o + len < data.length;) {
    let n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + data[o + i];
    const h = data[o + len];
    if (avc) {
      const t = h & 31;
      if (t === 5) return true;
      if (t === 1) return false;
    } else {
      const t = (h >> 1) & 63;
      if (t >= 16 && t <= 20) return true;
      if (t < 16 || t === 21) return false;
    }
    o += len + n;
  }
  return false;
}
