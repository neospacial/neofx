// The player (plan §6.2, §12.8): one decode worker for the preview, one for the timeline thumbnails.
// Each decoded frame goes into the frame store of the GPU engine (also the warm-up frames and the
// frames that playback drops), so the store always holds the frames before the playhead. A seek
// decodes only the frames of max(0, t - depth) .. t that are not in the store.

export function makeWorker(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const wk = new Worker(url);
  URL.revokeObjectURL(url);
  return wk;
}

// opts: {
//   consume(index, frame, show) -> Promise: put the frame into the store (show: also render it).
//     It must send the frame on at once (the order of the calls is the store order).
//   render(index) -> Promise: render a frame that is in the store.
//   onState(player), onThumb(i, index, bitmap), onError(message), onProgress(fraction | null) }
export class Player {
  constructor(workerSrc, opts) {
    this.src = workerSrc;
    this.opts = opts;
    this.wk = null;
    this.thumbWk = null;
    this.info = null;
    this.job = 0;
    this.current = -1; // the frame index on the preview
    this.playing = false;
    this.loop = false;
    this.inPoint = null;
    this.outPoint = null;
    this.depth = 0; // frames of history that the effect needs (Mode 1: Max delay)
    this.n = 0; // store layers
    this.have = new Int32Array(0); // the frame index in each store layer (mirror of the engine)
    this.busy = false; // a seek runs
    this.pendingSeek = null;
    this.queue = []; // playback: decoded frames, in display order
    this.raf = 0;
    this.clock = null; // { wall, us }
    this.stats = { shown: 0, dropped: 0, t0: 0, fps: 0, decodeJobs: 0 };
    this.log = []; // the presented frame indices of the last playback (for tests)
  }

  get frameCount() {
    return this.info ? this.info.times.length : 0;
  }

  // Open a file. Resolves with the info, or rejects with the message for the user.
  open(file) {
    this.close();
    this.wk = makeWorker(this.src);
    return new Promise((resolve, reject) => {
      this.wk.onmessage = (e) => {
        const m = e.data;
        if (m.cmd === 'info') {
          this.info = m;
          this.wk.onmessage = (ev) => this.onMessage(ev.data);
          this.startThumbs(file);
          resolve(m);
        } else if (m.cmd === 'error') {
          this.close();
          reject(new Error(m.message));
        }
      };
      this.wk.onerror = (e) => reject(new Error(e.message || 'Decode worker failed.'));
      this.wk.postMessage({ cmd: 'open', file });
    });
  }

  close() {
    this.pause();
    for (const w of [this.wk, this.thumbWk]) if (w) w.terminate();
    this.wk = this.thumbWk = null;
    this.info = null;
    this.current = -1;
    this.busy = false;
    this.pendingSeek = null;
    this.inPoint = this.outPoint = null;
  }

  // A new (empty) store of n layers: after the engine configure.
  setStore(n) {
    this.n = n;
    this.have = new Int32Array(n).fill(-1);
  }

  inStore(t) {
    return t >= 0 && this.n > 0 && this.have[t % this.n] === t;
  }

  startThumbs(file) {
    this.thumbWk = makeWorker(this.src);
    this.thumbWk.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'info') this.thumbWk.postMessage({ cmd: 'thumbs', job: 1, count: 50, width: 160 });
      else if (m.cmd === 'thumb' && this.opts.onThumb) this.opts.onThumb(m.i, m.index, m.bitmap);
      else if (m.cmd === 'done' || m.cmd === 'error') {
        this.thumbWk.terminate();
        this.thumbWk = null;
      }
    };
    this.thumbWk.postMessage({ cmd: 'open', file });
  }

  range() {
    const n = this.frameCount;
    const a = this.inPoint ?? 0, b = this.outPoint ?? n - 1;
    return [Math.min(a, b), Math.max(a, b)];
  }

  state() {
    if (this.opts.onState) this.opts.onState(this);
  }

  progress(f) {
    if (this.opts.onProgress) this.opts.onProgress(f);
  }

  // The history depth that the store can hold.
  get usableDepth() {
    return Math.max(0, Math.min(this.depth, this.n - 1));
  }

  // The first frame of from..t that is not in the store, or t + 1.
  firstMissing(from, t) {
    let m = from;
    while (m <= t && this.inStore(m)) m++;
    return m;
  }

  // Show frame t (frame-exact). Seeks that come while one runs are joined: only the last one runs.
  seek(t) {
    if (!this.info) return Promise.resolve();
    t = Math.max(0, Math.min(this.frameCount - 1, Math.round(t)));
    if (this.playing) this.pause();
    return new Promise((resolve) => {
      if (this.pendingSeek) this.pendingSeek.resolve();
      this.pendingSeek = { t, resolve };
      if (!this.busy) this.nextSeek();
    });
  }

  nextSeek() {
    const p = this.pendingSeek;
    if (!p) return;
    this.pendingSeek = null;
    this.busy = true;
    this.seekDone = p.resolve;
    this.target = p.t;
    const from = this.firstMissing(Math.max(0, p.t - this.usableDepth), p.t);
    if (from > p.t) {
      // All in the store: no decode.
      const job = ++this.job;
      this.opts.render(p.t).then(() => {
        if (job !== this.job) return;
        this.current = p.t;
        this.finishSeek();
      }, (e) => this.fail(e.message));
      return;
    }
    this.warm = { from, total: p.t - from + 1, done: 0 };
    this.stats.decodeJobs++;
    this.wk.postMessage({ cmd: 'seek', job: ++this.job, t: p.t, from });
  }

  finishSeek() {
    this.busy = false;
    this.progress(null);
    if (this.seekDone) this.seekDone();
    this.seekDone = null;
    this.nextSeek();
    this.state();
  }

  step(n) {
    const base = this.pendingSeek ? this.pendingSeek.t : this.busy ? this.target : this.current;
    return this.seek(Math.max(0, base) + n);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.info || this.playing) return;
    const [a, b] = this.range();
    let from = this.current + 1;
    if (from > b || from < a) from = a;
    // The decode starts at the first frame of the history of 'from' that is not in the store.
    const start = this.firstMissing(Math.max(0, from - this.usableDepth), from);
    this.playing = true;
    this.pendingSeek = null;
    this.busy = false;
    this.queue = [];
    this.clock = null;
    this.log = [];
    this.showFrom = from;
    this.stats = { ...this.stats, shown: 0, dropped: 0, t0: performance.now(), fps: 0 };
    this.playTo = b;
    this.stats.decodeJobs++;
    this.wk.postMessage({ cmd: 'play', job: ++this.job, from: Math.min(start, from), to: b });
    this.raf = requestAnimationFrame((now) => this.tick(now));
    this.state();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.wk) this.wk.postMessage({ cmd: 'stop' });
    this.job++;
    // The decoded frames after the playhead do not go into the store: in a small ring they would
    // take the place of the history of the frame on the preview.
    for (const q of this.queue) this.drop(q.frame);
    this.queue = [];
    this.state();
  }

  // A frame of a job that was cancelled.
  drop(frame) {
    frame.close();
    if (this.wk) this.wk.postMessage({ cmd: 'ack' });
  }

  // Into the store (and on the preview when show). The decode worker gets its ack after the upload.
  deliver(index, frame, show) {
    if (this.n) this.have[index % this.n] = index;
    if (show) this.current = index;
    const wk = this.wk;
    return this.opts.consume(index, frame, show).catch((e) => this.fail(e.message)).finally(() => {
      if (wk) wk.postMessage({ cmd: 'ack' });
    });
  }

  fail(message) {
    if (this.opts.onError) this.opts.onError(message);
  }

  onMessage(m) {
    if (m.cmd === 'frame') {
      if (m.job !== this.job) return this.drop(m.frame);
      if (this.playing) {
        if (m.index < this.showFrom) this.deliver(m.index, m.frame, false); // warm-up: no clock
        else this.queue.push({ index: m.index, frame: m.frame });
        return;
      }
      if (m.warm) {
        this.deliver(m.index, m.frame, false);
        this.warm.done++;
        if (this.warm.total > 1) this.progress(this.warm.done / this.warm.total);
        return;
      }
      this.deliver(m.index, m.frame, true);
      this.state();
    } else if (m.cmd === 'done') {
      if (m.job !== this.job || this.playing) return;
      this.finishSeek();
    } else if (m.cmd === 'error') {
      if (m.job !== undefined && m.job !== this.job) return;
      this.fail(m.message);
      if (this.playing) return this.pause();
      this.finishSeek();
    }
  }

  // Playback clock: the file time moves with the wall clock from the first shown frame. The newest
  // frame that is due is shown; older due frames go into the store without a render (dropped).
  // The frames before showFrom are the warm-up (history): into the store at once.
  tick(now) {
    if (!this.playing) return;
    const T = this.info.times;
    while (this.queue.length && this.queue[0].index < this.showFrom) {
      const q = this.queue.shift();
      this.deliver(q.index, q.frame, false);
    }
    if (this.queue.length) {
      const head = this.queue[0];
      if (!this.clock) this.clock = { wall: now, us: T[head.index] };
      const fileUs = this.clock.us + (now - this.clock.wall) * 1000;
      let k = -1;
      for (let i = 0; i < this.queue.length && T[this.queue[i].index] <= fileUs + 4000; i++) k = i;
      if (k >= 0) {
        for (let i = 0; i < k; i++) {
          this.stats.dropped++;
          this.deliver(this.queue[i].index, this.queue[i].frame, false);
        }
        const q = this.queue[k];
        this.queue.splice(0, k + 1);
        this.deliver(q.index, q.frame, true);
        this.log.push(q.index);
        this.stats.shown++;
        const sec = (now - this.stats.t0) / 1000;
        if (sec > 0.5) this.stats.fps = this.stats.shown / sec;
        this.state();
      }
    }
    if (this.current >= this.playTo && !this.queue.length) {
      if (this.loop) {
        this.playing = false;
        this.current = -1;
        this.play();
        return;
      }
      this.pause();
      return;
    }
    this.raf = requestAnimationFrame((n) => this.tick(n));
  }
}
