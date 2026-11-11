// Decode worker (plan §5.1, §6.2). Frame-exact decode of an MP4/MOV file with a VideoDecoder, not in
// real time. Patterns from neomosh src/app/worker.js (file source): read runs of samples, feed the
// decoder a few samples ahead, back-pressure on the frames that the page has not given back.
//
// Messages in:
//   { cmd: 'open', file }                       -> 'info' or 'error'
//   { cmd: 'seek', job, t, from }               -> 'frame' for each frame from .. t, then 'done'
//   { cmd: 'play', job, from, to }              -> 'frame' for each frame from .. to, then 'done'
//   { cmd: 'thumbs', job, count, width }        -> 'thumb' { i, index, bitmap } for each, then 'done'
//   { cmd: 'stop' }                             cancel the job in progress
//   { cmd: 'ack' }                              the page closed one frame
// 'frame': { job, index, frame (VideoFrame, transferred), warm (true: before t) }.

import { demuxMp4, turnedCrop } from './demux.js';
import { buildTimeline, decoderConfig, displaySize, isCleanStart, planSegments, thumbIndices } from './timeline.js';

const MAX_IN_FLIGHT = 4; // frames at the page, not given back yet
const MAX_QUEUE = 6; // samples in the decoder queue

const W = {
  file: null,
  d: null,
  tl: null,
  job: 0, // the job that runs; a new job or 'stop' changes it
  inFlight: 0,
  wake: null,
};

const poke = () => {
  if (W.wake) {
    const f = W.wake;
    W.wake = null;
    f();
  }
};
const wait = () => new Promise((r) => (W.wake = r));
const post = (m, tr) => self.postMessage(m, tr || []);

// Read the samples in runs of up to 4 MB that are next to each other in the file.
class SampleReader {
  constructor(file, samples) {
    this.file = file;
    this.S = samples;
    this.buf = null;
    this.from = 0;
    this.to = 0;
  }

  async read(i) {
    const s = this.S[i];
    if (!this.buf || s.offset < this.from || s.offset + s.size > this.to) {
      let to = s.offset + s.size;
      for (let j = i + 1; j < this.S.length && this.S[j].offset === to && to - s.offset < 4194304; j++) to += this.S[j].size;
      this.buf = new Uint8Array(await this.file.slice(s.offset, to).arrayBuffer());
      this.from = s.offset;
      this.to = to;
    }
    return this.buf.subarray(s.offset - this.from, s.offset - this.from + s.size);
  }
}

// Decode the segments of a job. want(index) -> true for a frame to give to deliver(index, frame).
// deliver can wait (back-pressure). Returns false when the job was cancelled.
async function decodeSegments(job, segments, want, deliver) {
  const S = W.tl.samples;
  const reader = new SampleReader(W.file, S);
  const out = [];
  let failure = null;
  const dec = new VideoDecoder({
    output: (f) => {
      out.push(f);
      poke();
    },
    error: (e) => {
      failure = e;
      poke();
    },
  });
  dec.addEventListener('dequeue', poke);
  const live = () => job === W.job;
  // Give or close the decoded frames.
  const drain = async () => {
    while (out.length) {
      const f = out.shift();
      const t = W.tl.indexOfUs.get(f.timestamp);
      if (t === undefined || !want(t) || !live()) {
        f.close();
        continue;
      }
      await deliver(t, f);
    }
  };
  try {
    for (const seg of segments) {
      if (!live()) return false;
      if (dec.state !== 'configured') dec.configure(decoderConfig(W.d));
      for (let i = seg.start; i <= seg.end; i++) {
        while (live() && !failure && (dec.decodeQueueSize >= MAX_QUEUE || out.length)) {
          if (out.length) await drain();
          else await wait();
        }
        if (failure) throw failure;
        if (!live()) return false;
        const s = S[i];
        dec.decode(new EncodedVideoChunk({ type: i === seg.start ? 'key' : 'delta', timestamp: s.us, data: await reader.read(i) }));
      }
      // The flush gives the last frames (in display order); then the next segment starts at a sync sample.
      const flushed = dec.flush().then(() => 'ok', (e) => e);
      let done = false;
      flushed.then(() => {
        done = true;
        poke();
      });
      while (!done && live() && !failure) {
        if (out.length) await drain();
        else await wait();
      }
      if (!live()) return false;
      const r = await flushed;
      if (r !== 'ok') throw r;
      await drain();
      if (failure) throw failure;
    }
    return live();
  } finally {
    for (const f of out) f.close();
    try {
      dec.close();
    } catch { /* closed */ }
  }
}

// Wait until the page has fewer than MAX_IN_FLIGHT frames, then send the frame.
async function sendFrame(job, t, frame, warm) {
  while (W.inFlight >= MAX_IN_FLIGHT && job === W.job) await wait();
  if (job !== W.job) {
    frame.close();
    return;
  }
  W.inFlight++;
  post({ cmd: 'frame', job, index: t, warm, frame }, [frame]);
}

async function open(file) {
  const d = await demuxMp4(file);
  if (!d) return post({ cmd: 'error', message: 'Only MP4 and MOV files are supported.' });
  let ok = false;
  try {
    ok = typeof VideoDecoder === 'function' && (await VideoDecoder.isConfigSupported(decoderConfig(d))).supported;
  } catch {
    ok = false;
  }
  if (!ok) return post({ cmd: 'error', message: `This browser cannot decode this file (codec: ${d.codec}).` });
  const tl = buildTimeline(d);
  if (!tl.frames.length) return post({ cmd: 'error', message: 'This file has no video frames.' });
  // Seeks start only at clean sync samples (IDR). The first sample is always one.
  const clean = [];
  for (const k of tl.keys) {
    const s = d.samples[k];
    const head = new Uint8Array(await file.slice(s.offset, s.offset + Math.min(s.size, 4096)).arrayBuffer());
    if (!clean.length || isCleanStart(d, head)) clean.push(k);
  }
  tl.keys = clean;
  Object.assign(W, { file, d, tl });
  const a = d.audio;
  post({
    cmd: 'info',
    name: file.name,
    codec: d.codec,
    rotation: d.rotation,
    codedWidth: d.codedWidth,
    codedHeight: d.codedHeight,
    ...displaySize(d),
    fps: tl.fps,
    durationUs: tl.durationUs,
    times: tl.frames.map((f) => f.us),
    keyFrames: tl.frames.map((f, t) => (clean.includes(f.sample) ? t : -1)).filter((t) => t >= 0),
    audio: a ? { codec: a.codec, channels: a.channels, sampleRate: a.sampleRate, durationUs: a.durationUs } : null,
  });
}

async function seek(m) {
  const n = W.tl.frames.length;
  const t = Math.max(0, Math.min(n - 1, m.t));
  const from = Math.max(0, Math.min(t, m.from ?? t - (m.depth || 0)));
  const list = [];
  for (let i = from; i <= t; i++) list.push(i);
  const ok = await decodeSegments(m.job, planSegments(W.tl, list), (i) => i >= from && i <= t, (i, f) => sendFrame(m.job, i, f, i < t));
  if (ok) post({ cmd: 'done', job: m.job });
}

async function play(m) {
  const n = W.tl.frames.length;
  const from = Math.max(0, Math.min(n - 1, m.from));
  const to = Math.max(from, Math.min(n - 1, m.to ?? n - 1));
  // One segment: from the sync sample of 'from' to the last sample that 'to' needs.
  const seg = planSegments(W.tl, [from])[0];
  let end = seg.end;
  for (let i = from; i <= to; i++) end = Math.max(end, W.tl.frames[i].sample);
  seg.end = end;
  const ok = await decodeSegments(m.job, [seg], (i) => i >= from && i <= to, (i, f) => sendFrame(m.job, i, f, false));
  if (ok) post({ cmd: 'done', job: m.job });
}

async function thumbs(m) {
  if (typeof OffscreenCanvas === 'undefined') return post({ cmd: 'done', job: m.job });
  const list = thumbIndices(W.tl.frames.length, m.count || 50);
  const { width: dw, height: dh } = displaySize(W.d);
  const w = m.width || 160;
  const h = Math.max(1, Math.round((w * dh) / dw));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const pos = new Map(list.map((t, i) => [t, i]));
  const ok = await decodeSegments(m.job, planSegments(W.tl, list), (t) => pos.has(t), async (t, f) => {
    const c = turnedCrop(W.d.rotation, f.displayWidth, f.displayHeight, { sx: 0, sy: 0, sw: W.d.rotation % 180 ? f.displayHeight : f.displayWidth, sh: W.d.rotation % 180 ? f.displayWidth : f.displayHeight }, w, h);
    ctx.setTransform(...c.m);
    ctx.drawImage(f, c.sx, c.sy, c.sw, c.sh, 0, 0, c.dw, c.dh);
    f.close();
    const bitmap = canvas.transferToImageBitmap();
    post({ cmd: 'thumb', job: m.job, i: pos.get(t), index: t, bitmap }, [bitmap]);
  });
  if (ok) post({ cmd: 'done', job: m.job });
}

// The jobs run one at a time. A new job cancels the one in progress (plan §6.2).
let chain = Promise.resolve();
const runJob = (fn, m) => {
  W.job = m.job;
  poke();
  chain = chain.then(() => (m.job === W.job ? fn(m) : null)).catch((e) => {
    if (m.job === W.job) post({ cmd: 'error', job: m.job, message: String(e && e.message ? e.message : e) });
  });
};

self.onmessage = (e) => {
  const m = e.data;
  if (m.cmd === 'ack') {
    W.inFlight = Math.max(0, W.inFlight - 1);
    poke();
  } else if (m.cmd === 'stop') {
    W.job = -1;
    poke();
  } else if (m.cmd === 'open') {
    W.job = -1;
    poke();
    chain = chain.then(() => open(m.file)).catch((err) => post({ cmd: 'error', message: String(err && err.message ? err.message : err) }));
  } else if (m.cmd === 'seek') runJob(seek, m);
  else if (m.cmd === 'play') runJob(play, m);
  else if (m.cmd === 'thumbs') runJob(thumbs, m);
};
