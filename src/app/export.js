// Export (plan §11.2): probe the encoder, make the engine at the export size (and the Mode 2 analysis
// pass), decode from the warm-up start, render each frame, encode it (VideoEncoder in the encode
// worker, encodeQueueSize <= 8), copy the audio packets of the range, mux (video + audio), and save
// (a Blob, or a file in the Origin Private File System when it is large). Frame times are the source
// times (the source timescale), so VFR and the audio sync stay.

import { makeWorker } from './player.js';
import { demuxMp4 } from '../io/demux.js';
import { muxMp4, DataPacker, readPackets } from '../io/mp4.js';
import { codecCandidates, bitrateFor, exportSizes, chunkSamples, FrameMatcher, checkSamples } from '../io/encoder-config.js';

const MAX_ENCODE_QUEUE = 8;
const OPFS_LIMIT = 1024 * 1048576; // larger files go to the Origin Private File System

// The first supported encoder configuration for a size (plan §3, §11.2), or null.
export async function probeEncoder(w, h, fps, opts = {}) {
  if (typeof VideoEncoder === 'undefined') return null;
  const prefs = opts.hardware === 'software' ? ['prefer-software', 'no-preference'] : ['prefer-hardware', 'no-preference'];
  const bitrate = bitrateFor(w, h, fps, opts.quality ?? 'high', opts.mbps);
  for (const codec of codecCandidates(w, h, fps)) {
    for (const hardwareAcceleration of prefs) {
      const config = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch { /* the next one */ }
    }
  }
  return null;
}

// Save the parts of the file: a Blob, or (large, or opts.opfs) a file in the OPFS.
export async function saveParts(parts, size, name, opts = {}) {
  const low = typeof navigator !== 'undefined' && navigator.deviceMemory && navigator.deviceMemory <= 4 && size > 256 * 1048576;
  if ((opts.opfs || size > OPFS_LIMIT || low) && navigator.storage && navigator.storage.getDirectory) {
    try {
      const dir = await navigator.storage.getDirectory();
      const fh = await dir.getFileHandle('neofx-export.mp4', { create: true });
      const w = await fh.createWritable();
      for (const p of parts) await w.write(p);
      await w.close();
      const file = await fh.getFile();
      return { blob: new File([file], name, { type: 'video/mp4' }), opfs: true };
    } catch {
      if (opts.opfs) throw new Error('The browser storage (OPFS) cannot hold the file.');
    }
  }
  return { blob: new File(parts, name, { type: 'video/mp4' }), opfs: false };
}

export class Exporter {
  // app: { gpu, decodeSrc, encodeSrc, file(), info(), settings, configure(w, h) -> reply,
  //        analyse() -> Promise (Mode 2 at the export size), depth() (history frames), restore() }
  constructor(app) {
    this.app = app;
    this.cancelled = false;
    this.workers = [];
  }

  cancel() {
    this.cancelled = true;
    for (const w of this.workers) w.terminate();
    if (this.wake) this.wake();
    if (this.abortDecode) this.abortDecode(); // the decode worker sends nothing more
  }

  check() {
    if (this.cancelled) throw new Error('Export cancelled');
  }

  // opts: { width, height, quality, mbps, keyint (s), range: [a, b], audio (bool), hardware, name, opfs }
  // onProgress({ done, total, fps, eta (s), phase }). Returns { blob, name, size, opfs, config, width, height }.
  async run(opts, onProgress) {
    const A = this.app;
    const info = A.info();
    const file = A.file();
    const [a, b] = opts.range;
    const total = b - a + 1;
    onProgress({ done: 0, total, fps: 0, eta: 0, phase: 'prepare' });
    // 1. The encoder (a lower size when the size is not supported).
    let { width, height } = opts;
    let config = await probeEncoder(width, height, info.fps, opts);
    if (!config) {
      for (const s of exportSizes(info.width, info.height)) {
        if (s.width * s.height >= width * height) continue;
        config = await probeEncoder(s.width, s.height, info.fps, opts);
        if (config) {
          ({ width, height } = s);
          break;
        }
      }
    }
    if (!config) throw new Error('This browser has no H.264 encoder for this video.');
    this.check();
    // The exact frame times (source timescale) and the audio packets.
    const d = await demuxMp4(file);
    const ts = d.timescale;
    const ptsOf = d.samples.map((s) => s.dts + s.cto - d.mediaTime);
    const frameSample = info.frameSamples; // frame index -> sample index
    const pts = (t) => ptsOf[frameSample[t]];
    // 2. The engine at the export size; Mode 2: the analysis pass at that size.
    await A.gpu.call({ cmd: 'exporting', on: true });
    try {
      const conf = await A.configure(width, height);
      const depth = A.depth();
      if (depth > conf.n - 1) throw new Error(`The Max delay (${depth} frames) is more than the buffer at ${Math.min(width, height)}p (${conf.n} frames). Choose a lower resolution.`);
      if (A.settings.mode === 'slitscan') {
        onProgress({ done: 0, total, fps: 0, eta: 0, phase: 'analysis' });
        await A.analyse((f) => onProgress({ done: 0, total, fps: 0, eta: 0, phase: 'analysis', analysis: f }));
      }
      this.check();
      // 3. The encoder worker.
      const enc = makeWorker(A.encodeSrc);
      this.workers.push(enc);
      const chunks = [];
      const packer = new DataPacker(32 * 1048576);
      let description = null, queue = 0, failure = null;
      const frames = new FrameMatcher(); // chunk timestamp -> frame index (nearest, not exact)
      // Tests: change the chunk timestamps as Safari does (opts.skewChunks: µs -> µs).
      const skew = typeof opts.skewChunks === 'function' ? opts.skewChunks : null;
      const poke = () => {
        if (this.wake) {
          const f = this.wake;
          this.wake = null;
          f();
        }
      };
      enc.onmessage = (e) => {
        const m = e.data;
        if (m.cmd === 'chunk') {
          if (m.description && !description) description = m.description;
          packer.add(m.data);
          const t = frames.match(skew ? skew(m.timestamp) : m.timestamp);
          if (t < 0) failure = new Error(`The encoder gave a frame with an unknown time (${m.timestamp} µs).`);
          else chunks.push({ pts: pts(t) - pts(a), size: m.data.length, key: m.key });
        } else if (m.cmd === 'queue') queue = m.size;
        else if (m.cmd === 'error') failure = new Error(m.message);
        else if (m.cmd === 'flushed') this.flushed = true;
        poke();
      };
      const waitFor = async (cond) => {
        while (!cond()) {
          if (failure) throw failure;
          this.check();
          await new Promise((r) => (this.wake = r));
        }
      };
      enc.postMessage({ cmd: 'configure', config });
      // 4. Decode from the warm-up start (the history of frame a), render, encode.
      const dec = makeWorker(A.decodeSrc);
      this.workers.push(dec);
      const from = Math.max(0, a - depth);
      let done = 0, lastKey = -Infinity;
      const t0 = performance.now();
      await new Promise((resolve, reject) => {
        const fail = (err) => reject(err);
        this.abortDecode = () => reject(new Error('Export cancelled'));
        // One message at a time (the frames go to the GPU and the encoder in order).
        let chain = Promise.resolve();
        dec.onmessage = (e) => {
          chain = chain.then(() => handle(e.data));
        };
        const handle = async (m) => {
          try {
            if (m.cmd === 'info') dec.postMessage({ cmd: 'play', job: 1, from, to: b });
            else if (m.cmd === 'error') fail(new Error(m.message));
            else if (m.cmd === 'done') resolve();
            else if (m.cmd === 'frame') {
              const t = m.index;
              if (this.cancelled) {
                m.frame.close();
                return;
              }
              const show = t >= a;
              const us = Math.round(((pts(t) - pts(a)) * 1e6) / ts);
              const durUs = Math.round(((t + 1 < info.times.length ? pts(t + 1) - pts(t) : d.samples[frameSample[t]].duration) * 1e6) / ts);
              const r = await A.gpu.call({ cmd: 'upload', index: t, frame: m.frame, show, grab: show ? { timestamp: us, duration: durUs } : undefined }, [m.frame]);
              if (show) {
                frames.add(us, t);
                const key = us - lastKey >= opts.keyint * 1e6;
                if (key) lastKey = us;
                await waitFor(() => queue <= MAX_ENCODE_QUEUE);
                queue++;
                enc.postMessage({ cmd: 'frame', frame: r.frame, key }, [r.frame]);
                done++;
                const sec = (performance.now() - t0) / 1000;
                const fps = done / Math.max(sec, 1e-3);
                onProgress({ done, total, fps, eta: (total - done) / Math.max(fps, 1e-3), phase: 'encode' });
              } else if (t % 4 === 0) onProgress({ done: 0, total, fps: 0, eta: 0, phase: 'warmup', warm: (t - from + 1) / Math.max(1, a - from) });
              dec.postMessage({ cmd: 'ack' });
            }
          } catch (err) {
            fail(err);
          }
        };
        dec.postMessage({ cmd: 'open', file });
      });
      this.check();
      this.flushed = false;
      enc.postMessage({ cmd: 'flush' });
      await waitFor(() => this.flushed);
      if (chunks.length !== total) throw new Error(`The encoder gave ${chunks.length} of ${total} frames.`);
      // 5. Mux: video (the source timescale) + the audio packets of the range (copied, D16).
      const lastDur = d.samples[frameSample[b]].duration;
      const { samples, mediaTime } = chunkSamples(chunks, lastDur);
      // Never write a file with broken frame times (it would play too fast, or not at all).
      const bad = checkSamples(samples);
      if (bad) throw new Error(`The export stopped: ${bad}. Please report this with the name of the browser.`);
      const video = { width, height, timescale: ts, avcc: description, samples, mediaTime, dataParts: packer.done() };
      let audio = null;
      const au = d.audio;
      if (opts.audio && au) {
        const usA = info.times[a], usB = info.times[b] + (info.times[b + 1] !== undefined ? info.times[b + 1] - info.times[b] : (lastDur * 1e6) / ts);
        // Whole packets of the range; from frame 0, also the priming packets before time 0 (with the
        // source edit list).
        const list = au.samples.filter((s) => (a === 0 || s.us >= usA - 1) && s.us < usB - 1);
        if (list.length) {
          // Read the packets into memory now (a few large reads). Slices of the source file in the
          // result would be read again, one small read for each packet, when the browser saves it
          // (on Android, through the content provider of the picked file: very slow).
          onProgress({ done, total, fps: 0, eta: 0, phase: 'audio' });
          const data = await readPackets(file, list);
          this.check();
          audio = {
            ...au,
            mediaTime: a === 0 ? au.mediaTime : 0,
            samples: list.map((s) => ({ size: s.size, duration: s.duration })),
            dataParts: [data],
          };
        }
      }
      onProgress({ done, total, fps: 0, eta: 0, phase: 'mux' });
      const r = muxMp4(video, { audio });
      const name = opts.name;
      const saved = await saveParts(r.parts, r.size, name, { opfs: opts.opfs });
      return { ...saved, name, size: r.size, config, width, height, frames: chunks.length, audio: !!audio };
    } finally {
      for (const w of this.workers) w.terminate();
      this.workers = [];
      await A.gpu.call({ cmd: 'exporting', on: false });
    }
  }
}
