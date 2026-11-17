// Datamosh worker (Mode 3). The codec, the muxer and the frame gate are from neomosh
// (src/mosh/codec, src/mosh/mux, src/mosh/capture.js); this worker is the file-source recorder of
// neomosh in one place: it decodes the source file (VideoDecoder), encodes each frame with the
// neomosh H.264 encoder, keeps the frames of the session, decodes them for the view (a hidden I-frame
// at a cut is not shown: the P-frames of the new clip move the old picture, the datamosh), and makes
// the export. The session stays in the memory of this worker.
//
// In:  init { w, h, fps, settings }            a new, empty session            -> state
//      settings { settings }                   the encoder settings of the next clip
//      record { file, startUs, keys, preview, fast }   one clip from the file, from startUs
//      stop                                    end the clip (a pause point)    -> paused
//      bloomStart / bloomStop                  a bloom clip (the last motion again, each frame time)
//      revert { point }                        delete all after pause point i (−1: all) -> state
//      seek { tsUs } / play { tsUs } / playStop    look at the session        -> picture / playEnd
//      shown                                   the page drew the last picture
//      export { mode, cuts, smooth } / exportCancel                 -> exportProgress, exported
// Out: ready { wasm }, frame, paused, state, picture, playEnd, exportProgress, exported, error.

import { Encoder } from './codec/encoder.js';
import { Decoder } from './codec/decoder.js';
import { streamParams, frameSelector } from './codec/headers.js';
import { Remuxer, CutRetime, VIDEO_TIMESCALE } from './mux/remux.js';
import { muxMp4, DataPacker } from './mux/mp4.js';
import { FrameGate } from './capture.js';
import { demuxMp4, turnedCrop } from '../io/demux.js';

const S = {
  w: 0, h: 0, fps: 30, settings: null,
  enc: null, dec: null, pdec: null,
  frames: [], // { type, qp, bits, bitLen, hdrBits, tsUs, bloom }
  points: [], // pause points: { frames (count), tsUs (session end), snap: { Y, U, V } }
  endUs: 0, bytes: 0,
  lastP: null, // the last recorded P-frame that is not a bloom frame (the bloom source)
  run: 0, // a clip (record or bloom) that runs has this number; a stop changes it
  clip: null, // { frames, lastTs }
  look: 0, // session playback run
  wake: null,
  canvas: null, ctx: null, small: null,
  shown: true, // the page drew the last picture (no new one before that)
  exportRun: 0,
};

const post = (m, tr) => self.postMessage(m, tr || []);
const poke = () => {
  if (S.wake) {
    const f = S.wake;
    S.wake = null;
    f();
  }
};
const wait = () => new Promise((r) => (S.wake = r));
const period = () => 1e6 / S.fps;

// Center "cover" crop of a source (vw x vh) to the shape w / h (neomosh geometry.js).
function coverCrop(vw, vh, w, h) {
  const a = w / h;
  let sw = vw, sh = vw / a;
  if (sh > vh) {
    sh = vh;
    sw = vh * a;
  }
  sw = Math.max(1, Math.round(sw));
  sh = Math.max(1, Math.round(sh));
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

// The picture of a decoder for the page: an I420 VideoFrame (the GPU converts the colour), else an
// ImageBitmap (neomosh D31).
let frameOk = typeof VideoFrame === 'function';
let img = null;
function pictureOf(dec) {
  if (frameOk) {
    try {
      const { Y, U, V } = dec;
      const cw = dec.codedW, n = Y.length, cn = U.length;
      const data = new Uint8Array(n + 2 * cn);
      data.set(Y);
      data.set(U, n);
      data.set(V, n + cn);
      return new VideoFrame(data, {
        format: 'I420', codedWidth: cw, codedHeight: dec.codedH, timestamp: 0,
        visibleRect: { x: 0, y: 0, width: S.w, height: S.h },
        layout: [{ offset: 0, stride: cw }, { offset: n, stride: cw >> 1 }, { offset: n + cn, stride: cw >> 1 }],
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
      });
    } catch {
      frameOk = false;
    }
  }
  return bitmapOf(dec);
}

function bitmapOf(dec) {
  const rgba = dec.toRgba();
  if (!img || img.data.buffer !== rgba.buffer || img.data.byteOffset !== rgba.byteOffset) img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), S.w, S.h);
  S.ctx.setTransform(1, 0, 0, 1, 0, 0);
  S.ctx.putImageData(img, 0, 0);
  return S.canvas.transferToImageBitmap();
}

// A small picture (at most 160 px wide) of the decoder, for a pause point card.
function thumbOf(dec) {
  const b = bitmapOf(dec);
  const tw = Math.min(160, S.w), th = Math.max(1, Math.round((tw * S.h) / S.w));
  if (!S.small || S.small.width !== tw || S.small.height !== th) S.small = new OffscreenCanvas(tw, th);
  S.small.getContext('2d').drawImage(b, 0, 0, tw, th);
  b.close();
  return S.small.transferToImageBitmap();
}

const cuts = () => S.frames.reduce((n, f) => n + (f.type === 'hiddenI' ? 1 : 0), 0);

function stateMsg(cmd = 'state') {
  return {
    cmd, w: S.w, h: S.h, fps: S.fps, frames: S.frames.length, durationUs: S.endUs, bytes: S.bytes, cuts: cuts(),
    points: S.points.map((p) => ({ frames: p.frames, tsUs: p.tsUs })), canBloom: !!S.lastP,
  };
}

function init(m) {
  S.run++;
  S.look++;
  Object.assign(S, { w: m.w, h: m.h, fps: m.fps, settings: m.settings, frames: [], points: [], endUs: 0, bytes: 0, lastP: null, clip: null, shown: true });
  S.enc = new Encoder(m.w, m.h, m.settings);
  S.dec = new Decoder(m.w, m.h);
  S.pdec = null;
  S.canvas = new OffscreenCanvas(m.w, m.h);
  S.ctx = S.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  img = null;
  post({ ...stateMsg('ready'), wasm: !!S.enc.k });
}

// One frame of the session: keep it, decode it for the view. source: a picture of the source frame
// (Mosh preview Off), shown in place of the decoded picture.
function addFrame(pkt, tsUs, fileUs, source) {
  const f = { type: pkt.type, qp: pkt.qp, bits: pkt.bits, bitLen: pkt.bitLen, hdrBits: pkt.hdrBits, tsUs, bloom: !!pkt.bloom, settings: pkt.settings };
  S.frames.push(f);
  S.bytes += f.bits.length;
  if (f.type === 'p' && !f.bloom) S.lastP = f;
  S.clip.frames++;
  S.clip.lastTs = tsUs;
  const changed = S.dec.decodePacket(f); // a hidden I-frame is not shown: the old picture stays
  const m = { cmd: 'frame', frames: S.frames.length, tsUs, fileUs, bytes: S.bytes, stats: pkt.stats };
  let picture = null;
  if (S.shown && (source || changed)) {
    picture = source || pictureOf(S.dec);
    S.shown = false;
  } else if (source) source.close();
  post({ ...m, picture }, picture ? [picture] : []);
}

// The end of a clip: a pause point (the decoder picture, to come back to it).
function endClip(ended, lastUs) {
  const c = S.clip;
  S.clip = null;
  if (c && c.frames) {
    S.endUs = c.lastTs + Math.round(period());
    S.points.push({ frames: S.frames.length, tsUs: S.endUs, snap: S.dec.snapshot() });
  }
  const has = S.dec.hasRef || S.frames.length > 0;
  const thumb = c && c.frames && has ? thumbOf(S.dec) : null;
  const picture = has ? pictureOf(S.dec) : null;
  S.shown = true;
  post({ ...stateMsg('paused'), ended: !!ended, lastUs, clipFrames: c ? c.frames : 0, thumb, picture }, [thumb, picture].filter(Boolean));
}

let fileDemux = null; // { key, d } for the last file
const decoderConfig = (d) => ({ codec: d.codec, codedWidth: d.codedWidth, codedHeight: d.codedHeight, ...(d.description ? { description: d.description } : {}) });
async function fileInfo(file) {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  if (fileDemux && fileDemux.key === key) return fileDemux.d;
  const d = await demuxMp4(file);
  let ok = false;
  if (d && typeof VideoDecoder === 'function') {
    try {
      ok = (await VideoDecoder.isConfigSupported(decoderConfig(d))).supported;
    } catch {
      ok = false;
    }
  }
  fileDemux = { key, d: ok ? d : null };
  return fileDemux.d;
}

// One clip from the file (neomosh D25, D38): every frame of the file at the session frame rate, from
// startUs, not faster than real time (so a pause is at the picture on the screen). m.fast (tests):
// no clock. The frame times come from the file.
async function record(m, run) {
  S.clip = { frames: 0, lastTs: S.endUs };
  let ended = false, lastUs = m.startUs;
  const out = [];
  let dec = null;
  try {
    const d = await fileInfo(m.file);
    if (!d) throw new Error('This file cannot be decoded here.');
    if (run !== S.run) return;
    if (S.frames.length) S.enc.newClip(); // the next frame is a hidden I-frame: a cut
    const Sm = d.samples;
    const P = period();
    // Start at the last clean sync sample at or before the start time (decode order).
    const clean = Array.isArray(m.keys) && m.keys.length ? new Set(m.keys) : null;
    let first = 0;
    for (let i = 0; i < Sm.length; i++) if (Sm[i].key && (!clean || clean.has(i)) && Sm[i].us <= m.startUs + 1000) first = i;
    let failure = null;
    dec = new VideoDecoder({ output: (f) => { out.push(f); poke(); }, error: (e) => { failure = e; poke(); } });
    dec.addEventListener('dequeue', poke);
    dec.configure(decoderConfig(d));
    const gate = new FrameGate(S.fps);
    let next = first, flushed = false, start = null, pace = null;
    // Read the samples in runs of up to 4 MB that are next to each other in the file.
    let buf = null, bufFrom = 0, bufTo = 0;
    const readAt = async (s) => {
      if (!buf || s.offset < bufFrom || s.offset + s.size > bufTo) {
        let to = s.offset + s.size;
        for (let j = next + 1; j < Sm.length && Sm[j].offset === to && to - s.offset < 4194304; j++) to += Sm[j].size;
        buf = new Uint8Array(await m.file.slice(s.offset, to).arrayBuffer());
        [bufFrom, bufTo] = [s.offset, to];
      }
      return buf.subarray(s.offset - bufFrom, s.offset - bufFrom + s.size);
    };
    for (;;) {
      if (run !== S.run) break;
      if (failure) throw failure;
      while (next < Sm.length && dec.decodeQueueSize < 4 && out.length < 4) {
        const s = Sm[next];
        dec.decode(new EncodedVideoChunk({ type: next === first || s.key ? 'key' : 'delta', timestamp: s.us, data: await readAt(s) }));
        next++;
        if (run !== S.run) break;
      }
      if (next >= Sm.length && !flushed) {
        flushed = true;
        await dec.flush();
      }
      if (!out.length) {
        if (flushed) {
          ended = true;
          break;
        }
        await wait();
        continue;
      }
      const frame = out.shift();
      const us = frame.timestamp;
      // Before the start (from the sync sample), or not on the session frame rate: not used.
      if (us < m.startUs - 1000 || !gate.next(us / 1000).keep) {
        frame.close();
        continue;
      }
      if (!m.fast) {
        // Never faster than real time: a frame that is late moves the clock.
        const now = performance.now();
        if (!pace || now > pace.wall + (us - pace.us) / 1000) pace = { wall: now, us };
        const due = pace.wall + (us - pace.us) / 1000;
        while (run === S.run && performance.now() < due - 1) {
          await new Promise((r) => {
            const t = setTimeout(r, due - performance.now());
            S.wake = () => {
              clearTimeout(t);
              r();
            };
          });
        }
      }
      if (run !== S.run) {
        frame.close();
        break;
      }
      if (start === null) start = us;
      // The crop in display coordinates (the file turned as a player shows it), then the frame area.
      const fw = frame.displayWidth, fh = frame.displayHeight;
      const turned = d.rotation % 180 !== 0;
      const c = coverCrop(turned ? fh : fw, turned ? fw : fh, S.w, S.h);
      const t = turnedCrop(d.rotation, fw, fh, c, S.w, S.h);
      S.ctx.setTransform(...t.m);
      S.ctx.drawImage(frame, t.sx, t.sy, t.sw, t.sh, 0, 0, t.dw, t.dh);
      frame.close();
      S.ctx.setTransform(1, 0, 0, 1, 0, 0);
      const rgba = S.ctx.getImageData(0, 0, S.w, S.h).data;
      const [Y, U, V] = S.enc.inputFromRgba(rgba);
      const pkt = S.enc.encode(Y, U, V);
      lastUs = us;
      const source = m.preview === false && S.shown ? S.canvas.transferToImageBitmap() : null;
      addFrame(pkt, S.endUs + (us - start), us, source);
    }
  } catch (err) {
    post({ cmd: 'error', message: String(err && err.message ? err.message : err) });
  } finally {
    for (const f of out) f.close();
    if (dec) {
      try {
        dec.close();
      } catch { /* closed */ }
    }
    if (S.clip) endClip(ended, lastUs);
  }
}

// Bloom (neomosh D24): the last P-frame again, one for each frame time, until the stop.
async function bloom(run) {
  if (!S.lastP) {
    post({ cmd: 'error', message: 'Bloom needs a clip with motion first. Record a clip, then pause.' });
    post(stateMsg('paused'));
    return;
  }
  S.clip = { frames: 0, lastTs: S.endUs };
  const src = S.lastP;
  const t0 = performance.now();
  let n = 0;
  try {
    while (run === S.run) {
      const due = t0 + (n * period()) / 1000;
      const now = performance.now();
      if (now < due) await new Promise((r) => setTimeout(r, due - now));
      if (run !== S.run) break;
      addFrame(S.enc.repeat(src), S.endUs + Math.round(n * period()), undefined, null);
      n++;
      if (performance.now() - due > 500) await new Promise((r) => setTimeout(r, 0)); // late: let the messages in
    }
  } catch (err) {
    post({ cmd: 'error', message: String(err && err.message ? err.message : err) });
  } finally {
    endClip(false, undefined);
  }
}

// Delete all after pause point i (−1: all frames).
function revert(i) {
  S.run++;
  S.look++;
  S.pdec = null;
  if (i < 0 || !S.points[i]) {
    S.frames = [];
    S.points = [];
    S.endUs = 0;
    S.bytes = 0;
    S.lastP = null;
    S.enc.restart();
    S.dec = new Decoder(S.w, S.h);
    post(stateMsg());
    return;
  }
  const p = S.points[i];
  S.frames.length = p.frames;
  S.points.length = i + 1;
  S.endUs = p.tsUs;
  S.bytes = S.frames.reduce((n, f) => n + f.bits.length, 0);
  S.lastP = null;
  for (let k = S.frames.length - 1; k >= 0 && !S.lastP; k--) if (S.frames[k].type === 'p' && !S.frames[k].bloom) S.lastP = S.frames[k];
  S.dec.setRef(p.snap.Y, p.snap.U, p.snap.V);
  S.enc.continueSession(); // the next frame is a hidden I-frame
  const picture = pictureOf(S.dec);
  S.shown = true;
  post({ ...stateMsg(), picture }, [picture]);
}

// Look at the session: the picture at a session time (decoded from the pause point before it).
function decodeTo(k) {
  if (!S.pdec) S.pdec = { dec: new Decoder(S.w, S.h), at: 0 };
  const P = S.pdec;
  if (k + 1 < P.at || P.at === 0) {
    let from = 0;
    for (const p of S.points) {
      if (p.frames <= k + 1 && p.frames > from) {
        from = p.frames;
        P.dec.setRef(p.snap.Y, p.snap.U, p.snap.V);
      }
    }
    P.at = from;
  } else {
    // Forward: a pause point between here and k saves the decode of the frames before it.
    for (const p of S.points) {
      if (p.frames <= k + 1 && p.frames > P.at + 30) {
        P.dec.setRef(p.snap.Y, p.snap.U, p.snap.V);
        P.at = p.frames;
      }
    }
  }
  while (P.at <= k) P.dec.decodePacket(S.frames[P.at++]);
  return P.dec;
}

const frameAt = (tsUs) => {
  let lo = 0, hi = S.frames.length - 1, r = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (S.frames[mid].tsUs <= tsUs) {
      r = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return r;
};

function seek(m) {
  S.look++;
  if (!S.frames.length) return;
  const k = frameAt(m.tsUs);
  const picture = pictureOf(decodeTo(k));
  post({ cmd: 'picture', tsUs: S.frames[k].tsUs, picture }, [picture]);
}

async function play(m) {
  const look = ++S.look;
  if (!S.frames.length) return post({ cmd: 'playEnd', tsUs: 0 });
  let k = frameAt(m.tsUs ?? 0);
  if (k >= S.frames.length - 1) k = 0;
  const t0 = performance.now(), us0 = S.frames[k].tsUs;
  S.shown = true;
  for (; k < S.frames.length && look === S.look; k++) {
    const f = S.frames[k];
    const due = t0 + (f.tsUs - us0) / 1000;
    const now = performance.now();
    if (now < due) await new Promise((r) => setTimeout(r, due - now));
    if (look !== S.look) return;
    const dec = decodeTo(k);
    if (S.shown && f.type !== 'hiddenI') {
      const picture = pictureOf(dec);
      S.shown = false;
      post({ cmd: 'picture', tsUs: f.tsUs, picture, playing: true }, [picture]);
    }
  }
  if (look === S.look) post({ cmd: 'playEnd', tsUs: S.endUs });
}

// Upscale export (neomosh plan §9.3): 1080 on the short side, with the H.264 encoder of the browser.
const UP_CODECS = ['avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.640028', 'avc1.4D4033', 'avc1.42E033'];
async function upscaleConfig() {
  if (typeof VideoEncoder === 'undefined' || Math.min(S.w, S.h) >= 1080) return null;
  const s = 1080 / Math.min(S.w, S.h);
  const outW = Math.round((S.w * s) / 2) * 2, outH = Math.round((S.h * s) / 2) * 2;
  const bitrate = Math.round((18e6 * outW * outH) / (1920 * 1080));
  for (const codec of UP_CODECS) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: outW, height: outH, bitrate, framerate: S.fps, avc: { format: 'avc' } });
      if (r.supported) return { codec, outW, outH, bitrate };
    } catch { /* the next one */ }
  }
  return null;
}

// The MP4 samples of the encoder chunks (neomosh upscale.js upscaleSamples).
function upscaleSamples(chunks, lastDuration) {
  const pts = chunks.map((c) => Math.round((c.ts * 9) / 100));
  const sorted = pts.slice().sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error('The encoder gave two pictures with the same time');
  let mediaTime = 0;
  for (let i = 0; i < pts.length; i++) mediaTime = Math.max(mediaTime, sorted[i] - pts[i]);
  const samples = chunks.map((c, i) => ({ data: null, size: c.size, key: c.key, duration: i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : lastDuration, cto: pts[i] - sorted[i] + mediaTime }));
  return { samples, mediaTime };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function exportVideo(m) {
  const run = ++S.exportRun;
  const check = () => {
    if (run !== S.exportRun) throw new Error('Export cancelled');
  };
  try {
    if (!S.frames.length) throw new Error('No frames to export');
    const frames = S.frames.slice(); // (a revert during the export does not change it)
    const params = streamParams(S.w, S.h, S.fps);
    const total = frames.length;
    if (m.mode !== 'upscale') {
      // Original: the recorded frames, copied (no decode, no new encode).
      const rx = new Remuxer(params, { cuts: m.cuts, blobChunk: 8 * 1048576 });
      for (let i = 0; i < total; i++) {
        rx.add(frames[i]);
        if (i % 200 === 199) {
          post({ cmd: 'exportProgress', done: i + 1, total });
          await tick();
          check();
        }
      }
      const r = rx.finish();
      post({ cmd: 'exported', blob: new Blob(r.parts, { type: 'video/mp4' }), size: r.size, frames: r.samples.length, width: S.w, height: S.h, mode: 'original' });
      return;
    }
    const config = await upscaleConfig();
    if (!config) throw new Error('This browser has no H.264 encoder for the Upscale export.');
    check();
    const dec = new Decoder(S.w, S.h);
    const canvas2 = new OffscreenCanvas(config.outW, config.outH);
    const ctx2 = canvas2.getContext('2d', { alpha: false });
    ctx2.imageSmoothingEnabled = !!m.smooth; // Sharp = nearest neighbour (the blocks stay)
    if (m.smooth) ctx2.imageSmoothingQuality = 'high';
    const chunks = [];
    const packer = new DataPacker(8 * 1048576);
    let avcc = null, failure = null;
    const ve = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const d = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (d && !avcc) avcc = new Uint8Array(d instanceof ArrayBuffer ? d.slice(0) : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
        packer.add(data);
        chunks.push({ ts: chunk.timestamp, key: chunk.type === 'key', size: data.length });
      },
      error: (e) => (failure = e),
    });
    try {
      ve.configure({ codec: config.codec, width: config.outW, height: config.outH, bitrate: config.bitrate, framerate: S.fps, avc: { format: 'avc' }, latencyMode: 'quality' });
      const select = frameSelector(m.cuts ?? 'mosh');
      const retime = new CutRetime(); // the same times as the Original export
      let t0 = null, lastKey = -Infinity;
      for (let i = 0; i < total; i++) {
        const f = frames[i];
        if (!select(f)) retime.skip(f);
        else {
          const ts = retime.time(f);
          if (t0 === null) t0 = ts;
          if (dec.decodePacket(f, true)) {
            const rgba = dec.toRgba();
            const im = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), S.w, S.h);
            const b = await createImageBitmap(im);
            ctx2.drawImage(b, 0, 0, config.outW, config.outH);
            b.close();
            const vf = new VideoFrame(canvas2, { timestamp: ts - t0 });
            const key = ts - t0 - lastKey >= 2e6;
            if (key) lastKey = ts - t0;
            ve.encode(vf, { keyFrame: key });
            vf.close();
            while (ve.encodeQueueSize > 2 && !failure) await new Promise((r) => setTimeout(r, 2));
          }
        }
        if (failure) throw failure;
        if (i % 10 === 9) {
          post({ cmd: 'exportProgress', done: i + 1, total });
          await tick();
        }
        check();
      }
      await ve.flush();
      if (failure) throw failure;
    } finally {
      try {
        ve.close();
      } catch { /* closed */ }
    }
    if (!chunks.length || !avcc) throw new Error('The encoder gave no output');
    const { samples, mediaTime } = upscaleSamples(chunks, Math.round(VIDEO_TIMESCALE / S.fps));
    const r = muxMp4({ width: config.outW, height: config.outH, timescale: VIDEO_TIMESCALE, avcc, samples, mediaTime, dataParts: packer.done() });
    post({ cmd: 'exported', blob: new Blob(r.parts, { type: 'video/mp4' }), size: r.size, frames: samples.length, width: config.outW, height: config.outH, mode: 'upscale' });
  } catch (err) {
    post({ cmd: 'exportFailed', message: String(err && err.message ? err.message : err) });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.cmd === 'init') init(m);
    else if (m.cmd === 'shown') S.shown = true;
    else if (!S.enc) post({ cmd: 'error', message: 'No session' });
    else if (m.cmd === 'settings') {
      S.settings = m.settings;
      if (!S.clip) S.enc.setSettings(m.settings);
    } else if (m.cmd === 'record') {
      if (S.clip) return;
      S.look++;
      S.enc.setSettings(S.settings);
      record(m, ++S.run);
    } else if (m.cmd === 'stop' || m.cmd === 'bloomStop') {
      if (S.clip) {
        S.run++;
        poke();
      } else post(stateMsg('paused'));
    } else if (m.cmd === 'bloomStart') {
      if (S.clip) return;
      S.look++;
      bloom(++S.run);
    } else if (m.cmd === 'revert') {
      if (S.clip) return;
      revert(m.point);
    } else if (m.cmd === 'seek') {
      if (!S.clip) seek(m);
    } else if (m.cmd === 'play') {
      if (!S.clip) play(m);
    } else if (m.cmd === 'playStop') {
      S.look++;
      post({ cmd: 'playEnd', stopped: true });
    } else if (m.cmd === 'export') exportVideo(m);
    else if (m.cmd === 'exportCancel') S.exportRun++;
    else if (m.cmd === 'canUpscale') upscaleConfig().then((c) => post({ cmd: 'canUpscale', ok: !!c, width: c ? c.outW : 0, height: c ? c.outH : 0 }));
  } catch (err) {
    post({ cmd: 'error', message: String(err && err.message ? err.message : err) });
  }
};
