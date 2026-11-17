// The sound of the preview: the audio track of the open file (AAC or Opus), decoded with the
// WebCodecs AudioDecoder while the video plays, and played with Web Audio. The video clock leads:
// the file time us plays at the wall time clock.wall + (us − clock.us) / 1000 (the clock of the
// player), so the sound and the pictures stay together. Only in playback at normal speed: a seek,
// a step, or the reverse play has no sound. The packets are read and decoded about 1.5 s ahead.

import { demuxMp4 } from '../io/demux.js';
import { readPackets } from '../io/mp4.js';

const AHEAD_US = 1500000; // decode this far ahead of the playhead
const BATCH_US = 1000000; // read the packets of about this much time at once
const PRIME = 3; // packets decoded before the start (AAC needs the one before to start clean)

const audioConfig = (a) => ({ codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, ...(a.description ? { description: a.description } : {}) });

export class PreviewAudio {
  constructor() {
    this.track = null; // the audio track of the open file, or null
    this.file = null;
    this.ctx = null;
    this.gain = null;
    this.muted = false;
    this.gen = 0; // a start or a stop changes it
    this.run = null; // the playback that runs: { us, wall, dec, next, sources, timer }
    this.reason = ''; // why there is no sound (the mute button tells it)
    this.stats = { scheduled: 0, late: 0, trimmed: 0 };
  }

  get available() {
    return !!this.track;
  }

  // A new file: its audio track, when this browser can decode it.
  async open(file) {
    this.stop();
    this.track = null;
    this.file = file;
    this.reason = '';
    if (typeof AudioDecoder !== 'function' || typeof AudioContext !== 'function') {
      this.reason = 'This browser cannot decode the sound.';
      return false;
    }
    let d = null;
    try {
      d = await demuxMp4(file);
    } catch {
      d = null;
    }
    if (this.file !== file) return false; // another file came
    const a = d && d.audio;
    if (!a || !a.samples.length) {
      this.reason = 'This video has no sound.';
      return false;
    }
    try {
      if (!(await AudioDecoder.isConfigSupported(audioConfig(a))).supported) throw new Error();
    } catch {
      this.reason = `This browser cannot decode the sound (${a.codec}).`;
      return false;
    }
    if (this.file !== file) return false;
    this.track = a;
    return true;
  }

  close() {
    this.stop();
    this.track = null;
    this.file = null;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : 1;
    if (this.muted) this.stop();
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
    }
    // (A play from a key or a touch is a user gesture: the browser lets the context run.)
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // A playback from file time us is about to start: read and decode its first packets now, so that
  // they are ready when the clock starts (no sound lost at the start).
  prepare(us) {
    this.start(us, null);
  }

  // The playback clock started (or started again): the file time us is shown at the wall time
  // wall (performance.now() ms). wall null: not yet (prepare).
  start(us, wall) {
    const r = this.run;
    if (wall !== null && r && r.wall === null && Math.abs(r.from - us) < 100000) {
      // The prepared run: the clock is known now; the decoded packets that wait are scheduled.
      Object.assign(r, { us, wall, from: us });
      this.sync(r);
      for (const d of r.queue.splice(0)) this.schedule(r, this.gen, d);
      return;
    }
    this.stop();
    if (!this.track || this.muted) return;
    const ctx = this.ensureContext();
    const gen = ++this.gen;
    const S = this.track.samples;
    // The first packet that ends after us, and some before it for the decoder to start.
    let i = 0;
    while (i < S.length && S[i].us + (S[i].duration * 1e6) / this.track.timescale <= us) i++;
    const run = { us, wall, from: us, next: Math.max(0, i - PRIME), sources: new Set(), queue: [], timer: 0, dec: null, offset: 0, busy: false };
    this.run = run;
    if (wall !== null) this.sync(run);
    run.dec = new AudioDecoder({
      output: (data) => this.schedule(run, gen, data),
      error: () => this.stop(),
    });
    try {
      run.dec.configure(audioConfig(this.track));
    } catch {
      this.stop();
      return;
    }
    const pump = () => {
      if (gen !== this.gen) return;
      this.pump(run, gen).finally(() => {
        if (gen === this.gen) run.timer = setTimeout(pump, 200);
      });
    };
    pump();
    void ctx;
  }

  stop() {
    this.gen++;
    const run = this.run;
    this.run = null;
    if (!run) return;
    clearTimeout(run.timer);
    for (const s of run.sources) {
      try {
        s.stop();
      } catch { /* not started */ }
      s.disconnect();
    }
    run.sources.clear();
    for (const d of run.queue) d.close();
    run.queue.length = 0;
    if (run.dec && run.dec.state !== 'closed') {
      try {
        run.dec.close();
      } catch { /* closed */ }
    }
  }

  // The map from the wall clock to the audio clock (context seconds = wall ms / 1000 + offset), less
  // the output latency of the device, so the sound comes out at the time of its picture. It is
  // measured again for each packet and moves only when it changed by more than 20 ms (no clicks).
  sync(run) {
    const ctx = this.ctx;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const off = ctx.currentTime - performance.now() / 1000 - lat;
    if (!run.synced || Math.abs(off - run.offset) > 0.02) {
      run.offset = off;
      run.synced = true;
    }
  }

  ctxTime(run, us) {
    return (run.wall + (us - run.us) / 1000) / 1000 + run.offset;
  }

  // Read and decode the packets up to AHEAD_US after the playhead.
  async pump(run, gen) {
    if (run.busy) return;
    run.busy = true;
    try {
      const S = this.track.samples;
      const now = run.wall === null ? run.from : run.us + (performance.now() - run.wall) * 1000;
      while (gen === this.gen && run.next < S.length && S[run.next].us < now + AHEAD_US) {
        const list = [];
        const t0 = S[run.next].us;
        while (run.next + list.length < S.length && S[run.next + list.length].us < t0 + BATCH_US) list.push(S[run.next + list.length]);
        const data = await readPackets(this.file, list);
        if (gen !== this.gen) return;
        let o = 0;
        for (const s of list) {
          run.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.us, duration: Math.round((s.duration * 1e6) / this.track.timescale), data: data.subarray(o, o + s.size) }));
          o += s.size;
        }
        run.next += list.length;
      }
    } catch {
      if (gen === this.gen) this.stop();
    } finally {
      run.busy = false;
    }
  }

  // A decoded packet: an AudioBuffer, started at the time of its file time (the part before the
  // start of the playback, or that is already late, is cut off).
  schedule(run, gen, data) {
    if (gen === this.gen && run.wall === null) {
      run.queue.push(data); // the clock is not there yet
      return;
    }
    try {
      if (gen !== this.gen) return;
      const ctx = this.ctx;
      const n = data.numberOfFrames, ch = data.numberOfChannels, rate = data.sampleRate;
      if (!n) return;
      const buf = ctx.createBuffer(ch, n, rate);
      for (let c = 0; c < ch; c++) {
        const plane = new Float32Array(n);
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        buf.copyToChannel(plane, c);
      }
      this.sync(run);
      let at = this.ctxTime(run, data.timestamp);
      let skip = Math.max(0, (run.from - data.timestamp) / 1e6); // before the start of the playback
      const now = ctx.currentTime + 0.005;
      if (at + skip < now) skip = now - at; // late: the rest of it
      if (skip >= buf.duration) {
        // Not late: the packets before the start; and the first ones that the output latency of the
        // device cuts off (the first picture shows at once; its sound comes out that much later).
        const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
        if (data.timestamp + buf.duration * 1e6 <= run.from) return;
        if (data.timestamp < run.from + (lat + 0.03) * 1e6) this.stats.trimmed++;
        else this.stats.late++;
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      src.onended = () => {
        run.sources.delete(src);
        src.disconnect();
      };
      src.start(at + skip, skip);
      if (this.log) this.log.push({ us: data.timestamp, at: at + skip, now: ctx.currentTime }); // (tests)
      run.sources.add(src);
      this.stats.scheduled++;
    } finally {
      data.close();
    }
  }
}
